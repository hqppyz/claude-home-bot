import { join } from "node:path";
import type { Message, SendableChannels } from "discord.js";
import { claudeHome, Session, type Reply } from "./claude";
import type { Config } from "./config";

// A session with no turn for this long exits; the next message resumes the chat
const IDLE_MS = 5 * 60_000;

// Discord's message length limit
const MAX_MESSAGE = 2000;

// A typing indicator lasts about 10 seconds, so it's renewed before that
const TYPING_MS = 8_000;

interface Saved {
  readonly dir: string;
  readonly sessionId?: string;
  // The newest message Claude has answered; later ones are caught up on at startup
  readonly lastMessageId?: string;
}

const byId = (a: Message, b: Message) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);

// One message goes as is; several get their authors so Claude can tell them apart
function merge(batch: readonly Message[]): string {
  if (batch.length === 1) return batch[0]!.content;
  return batch.map((m) => `${m.author.displayName}: ${m.content}`).join("\n\n");
}

// Splits at the last newline that fits, or hard at the limit
function chunks(text: string): string[] {
  const out: string[] = [];
  while (text.length > MAX_MESSAGE) {
    const cut = text.lastIndexOf("\n", MAX_MESSAGE);
    const at = cut > 0 ? cut : MAX_MESSAGE;
    out.push(text.slice(0, at));
    text = text.slice(at).replace(/^\n/, "");
  }
  if (text) out.push(text);
  return out;
}

// Shows "typing" in the channel until the returned function is called
function typing(channel: SendableChannels): () => void {
  const send = () => channel.sendTyping().catch(() => {});
  send();
  const timer = setInterval(send, TYPING_MS);
  return () => clearInterval(timer);
}

async function sendReply(to: Message, reply: Reply) {
  const text = reply.isError ? `Claude failed: ${reply.text}` : reply.text || "(empty reply)";
  const channel = to.channel as SendableChannels;
  for (const [i, content] of chunks(text).entries()) {
    const reference = i === 0 ? { reply: { messageReference: to.id, failIfNotExists: false } } : {};
    await channel.send({ content, ...reference });
  }
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
// merged into the next turn.
export class Chat {
  private readonly seen = new Set<string>();
  private pending: Message[] = [];
  private session: Session | undefined;
  private draining = false;
  private idle: Timer | undefined;

  constructor(
    private readonly chats: Chats,
    readonly channelId: string,
    readonly dir: string,
    private readonly home: string,
  ) {}

  // Skips messages already answered or queued, so catch-up and live messages can overlap
  add(messages: readonly Message[]) {
    const last = this.chats.get(this.channelId)?.lastMessageId;
    for (const message of messages) {
      if (this.seen.has(message.id) || (last && BigInt(message.id) <= BigInt(last))) continue;
      this.seen.add(message.id);
      this.pending.push(message);
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
        const batch = this.pending.splice(0);
        const last = batch.at(-1)!;
        const stopTyping = typing(last.channel as SendableChannels);
        try {
          const reply = await this.turn(merge(batch));
          await sendReply(last, reply).catch((e) => console.error(`failed to reply in ${this.dir}:`, e));
        } finally {
          stopTyping();
        }
        this.chats.save(this.channelId, { ...this.chats.get(this.channelId)!, lastMessageId: last.id });
      }
    } finally {
      this.draining = false;
    }
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
  }

  private async turn(prompt: string): Promise<Reply> {
    const saved = this.chats.get(this.channelId);
    // Claude keeps conversations per project directory, so a new directory starts over
    this.session ??= await Session.start(this.dir, this.home, saved?.dir === this.dir ? saved.sessionId : undefined);
    const session = this.session;
    const reply = await session.send(prompt);
    if (session.dead) {
      this.session = undefined;
      // A resume that dies before starting means the conversation is gone
      if (session.resumed && !session.started) {
        console.error(`chat in ${this.dir} could not resume, starting over: ${reply.text}`);
        this.chats.save(this.channelId, { dir: this.dir, lastMessageId: saved?.lastMessageId });
        return this.turn(prompt);
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
