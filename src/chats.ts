import { join } from "node:path";
import { Message, type ChatInputCommandInteraction, type SendableChannels } from "discord.js";
import { Asking } from "./ask";
import { claudeHome, Session, type Ask, type Reply } from "./claude";
import type { Config } from "./config";
import { LiveReply, type Outlet, type RawEvent } from "./log";

// A session with no turn for this long exits; the next message resumes the chat
const IDLE_MS = 5 * 60_000;

// A typing indicator lasts about 10 seconds, so it's renewed before that
const TYPING_MS = 8_000;

// An interaction can be answered for 15 minutes; later replies go to the channel
const INTERACTION_MS = 14 * 60_000;

// A slash command run in the channel, with the prompt that runs it in Claude
export interface Command {
  readonly interaction: ChatInputCommandInteraction;
  readonly prompt: string;
}

type Input = Message | Command;

const idOf = (input: Input) => (input instanceof Message ? input.id : input.interaction.id);

const channelOf = (input: Input) => (input instanceof Message ? input.channel : input.interaction.channel) as SendableChannels;

interface Saved {
  readonly dir: string;
  readonly sessionId?: string;
  // The newest message Claude has answered; later ones are caught up on at startup
  readonly lastMessageId?: string;
}

const byId = (a: Input, b: Input) => {
  const [x, y] = [BigInt(idOf(a)), BigInt(idOf(b))];
  return x < y ? -1 : x > y ? 1 : 0;
};

// One message or command goes as is; several messages get their authors so
// Claude can tell them apart
function merge(batch: readonly Input[]): string {
  if (batch.length === 1) return batch[0] instanceof Message ? batch[0].content : batch[0]!.prompt;
  return (batch as Message[]).map((m) => `${m.author.displayName}: ${m.content}`).join("\n\n");
}

// Shows "typing" in the channel until the returned function is called
function typing(channel: SendableChannels): () => void {
  const send = () => channel.sendTyping().catch(() => {});
  send();
  const timer = setInterval(send, TYPING_MS);
  return () => clearInterval(timer);
}

// The turn's messages answer the input: a message gets a reply, a command its
// deferred reply while the interaction lasts. Later messages go to the channel.
function outlet(to: Input): Outlet {
  if (to instanceof Message) {
    const channel = to.channel as SendableChannels;
    return {
      send: (content, i) => channel.send({ content, ...(i === 0 ? { reply: { messageReference: to.id, failIfNotExists: false } } : {}) }),
      edit: (message, content) => message.edit(content),
    };
  }
  const { interaction } = to;
  const channel = interaction.channel as SendableChannels;
  const fresh = () => Date.now() - interaction.createdTimestamp < INTERACTION_MS;
  return {
    send: (content, i) => (i === 0 && fresh() ? interaction.editReply(content) : channel.send(content)),
    edit: (message, content, i) => (i === 0 && fresh() ? interaction.editReply(content) : message.edit(content)),
  };
}

// Plain messages in the channel, for a turn's output after a question
function channelOutlet(channel: SendableChannels): Outlet {
  return {
    send: (content) => channel.send(content),
    edit: (message, content) => message.edit(content),
  };
}

// Every channel's chat, kept in <data>/chats.json so a restart picks each one up
export class Chats {
  private readonly chats = new Map<string, Chat>();
  private writing: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly config: Config,
    private readonly path: string,
    private readonly saved: Map<string, Saved>,
    // Turns wait for this, so messages sent before Claude is logged in queue up
    readonly ready: Promise<unknown>,
  ) {}

  static async load(config: Config, ready: Promise<unknown>): Promise<Chats> {
    const path = join(config.dataDir, "chats.json");
    const file = Bun.file(path);
    const saved: Record<string, Saved> = (await file.exists()) ? await file.json() : {};
    return new Chats(config, path, new Map(Object.entries(saved)), ready);
  }

  get(channelId: string): Saved | undefined {
    return this.saved.get(channelId);
  }

  // Channels Claude has answered in before, which can have missed messages
  answered(): string[] {
    return [...this.saved].filter(([, s]) => s.lastMessageId).map(([id]) => id);
  }

  save(channelId: string, saved: Saved) {
    this.saved.set(channelId, saved);
    const json = JSON.stringify(Object.fromEntries(this.saved), null, 2);
    this.writing = this.writing.then(() => Bun.write(this.path, json)).catch((e) => console.error("failed to save chats:", e));
  }

  chat(channelId: string, dir: string): Chat {
    let chat = this.chats.get(channelId);
    if (!chat) this.chats.set(channelId, (chat = new Chat(this, channelId, dir, claudeHome(this.config))));
    return chat;
  }
}

// A channel's conversation. Messages that arrive while Claude works go out
// merged into the next turn; commands always get a turn of their own.
export class Chat {
  private readonly seen = new Set<string>();
  private pending: Input[] = [];
  private session: Session | undefined;
  // A question Claude asked; the next message answers it instead of starting a
  // turn, and a command interrupts the turn so it can run
  private asking: Asking | undefined;
  private draining = false;
  private idle: Timer | undefined;

  constructor(
    private readonly chats: Chats,
    readonly channelId: string,
    readonly dir: string,
    private readonly home: string,
  ) {}

  // Skips messages already answered or queued, so catch-up and live messages can overlap
  add(inputs: readonly Input[]) {
    const last = this.chats.get(this.channelId)?.lastMessageId;
    for (const input of inputs) {
      const id = idOf(input);
      if (this.seen.has(id) || (last && BigInt(id) <= BigInt(last))) continue;
      this.seen.add(id);
      if (this.asking && input instanceof Message) {
        this.asking.type(input.content);
        continue;
      }
      if (this.asking) this.session?.interrupt();
      this.pending.push(input);
    }
    this.pending.sort(byId);
    this.drain().catch((e) => console.error(`chat in ${this.dir} failed:`, e));
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    clearTimeout(this.idle);
    try {
      await this.chats.ready;
      while (this.pending.length > 0) {
        // Messages up to the next command, or the command alone
        const command = this.pending.findIndex((input) => !(input instanceof Message));
        const batch = this.pending.splice(0, command === 0 ? 1 : command === -1 ? this.pending.length : command);
        const last = batch.at(-1)!;
        // A deferred command already shows that the bot is thinking
        const stopTyping = last instanceof Message ? typing(channelOf(last)) : () => {};
        // A question ends the turn's messages so far; what follows goes in new ones below it
        let live = new LiveReply(outlet(last));
        try {
          const ask: Ask = async (questions, signal) => {
            await live.settle();
            const channel = channelOf(last);
            const asking = (this.asking = await Asking.post(channel, questions, signal));
            live = new LiveReply(channelOutlet(channel));
            try {
              return await asking.answered;
            } finally {
              this.asking = undefined;
            }
          };
          const reply = await this.turn(merge(batch), (event) => live.add(event), ask);
          await live.finish(reply);
        } finally {
          stopTyping();
        }
        this.chats.save(this.channelId, { ...this.chats.get(this.channelId)!, lastMessageId: idOf(last) });
      }
    } finally {
      this.draining = false;
    }
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
  }

  private async turn(prompt: string, onEvent: (event: RawEvent) => void, ask: Ask): Promise<Reply> {
    const saved = this.chats.get(this.channelId);
    // Claude keeps conversations per project directory, so a new directory starts over
    this.session ??= await Session.start(this.dir, this.home, saved?.dir === this.dir ? saved.sessionId : undefined);
    const session = this.session;
    const reply = await session.send(prompt, onEvent, ask);
    if (session.dead) {
      this.session = undefined;
      // A resume that dies before starting means the conversation is gone
      if (session.resumed && !session.started) {
        console.error(`chat in ${this.dir} could not resume, starting over: ${reply.text}`);
        this.chats.save(this.channelId, { dir: this.dir, lastMessageId: saved?.lastMessageId });
        return this.turn(prompt, onEvent, ask);
      }
    }
    this.chats.save(this.channelId, { ...saved, dir: this.dir, sessionId: session.sessionId });
    return reply;
  }

  private stop() {
    this.session?.close();
    this.session = undefined;
  }
}
