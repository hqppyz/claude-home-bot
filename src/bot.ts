import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type Channel,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
} from "discord.js";
import { CategorySync, dirOf } from "./channels";
import { authenticate } from "./auth";
import { Chats } from "./chats";
import { claudeHome, listCommands } from "./claude";
import { promptOf, toDiscord, type Registered } from "./commands";
import type { AutoEntry, Config, PathConfig } from "./config";
import { includeIndex } from "./dirs";
import { watchDirs } from "./watcher";

export async function startBot(config: Config): Promise<never> {
  const { serverId, token } = config.discord;

  // No DirectMessages intent, so DMs never reach the bot
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  // Single server bot: only messages from serverId, never from bots (including itself)
  const accepting = (message: Message) => message.guildId === serverId && !message.author.bot;

  const ready = new Promise<Guild>((resolve) => {
    client.once(Events.ClientReady, (c) => {
      const guild = c.guilds.cache.get(serverId);
      if (!guild) {
        console.error(`bot is not a member of server ${serverId}`);
        process.exit(1);
      }
      console.log(`logged in as ${c.user.tag}, serving ${guild.name}`);
      resolve(guild);
    });
  });

  // Manual channels map to their path; auto channels carry theirs in the topic,
  // trusted only inside a configured category
  const manual = new Map(config.paths.flatMap((entry) => (entry.mode === "manual" ? [[entry.channelId, entry.path]] : [])));
  const categories = new Set(config.paths.flatMap((entry) => (entry.mode === "auto" ? [entry.categoryId] : [])));
  const dirFor = (channel: Channel): string | undefined => {
    const dir = manual.get(channel.id);
    if (dir !== undefined) return dir;
    if (channel.type !== ChannelType.GuildText || !channel.parentId || !categories.has(channel.parentId)) return undefined;
    return dirOf(channel);
  };

  const { promise: authed, resolve: authDone } = Promise.withResolvers<void>();
  const chats = await Chats.load(config, authed);

  client.on(Events.MessageCreate, (message) => {
    if (!accepting(message)) return;
    const dir = dirFor(message.channel);
    if (dir !== undefined) chats.chat(message.channelId, dir).add([message]);
  });

  // Discord command name to Claude command, filled once they're registered
  let commands: Registered["names"] = new Map();
  const runCommand = async (interaction: ChatInputCommandInteraction) => {
    const command = commands.get(interaction.commandName);
    const dir = interaction.channel ? dirFor(interaction.channel) : undefined;
    if (command === undefined || dir === undefined) {
      const content = command === undefined ? "Unknown command." : "This channel has no directory.";
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      return;
    }
    // Deferring buys 15 minutes to answer instead of 3 seconds
    await interaction.deferReply();
    chats.chat(interaction.channelId, dir).add([{ interaction, prompt: promptOf(command, interaction) }]);
  };
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.guildId !== serverId) return;
    runCommand(interaction).catch((e) => console.error(`/${interaction.commandName} failed:`, e));
  });

  await client.login(token);
  const guild = await ready;
  // Runs alongside the channel sync; interactions arrive without a DM intent
  authenticate(client, config)
    .catch((e) => console.error("claude login failed:", e))
    .finally(authDone);
  // Listing needs a logged in Claude. Commands registered by an earlier run stay until then.
  authed
    .then(async () => {
      const registered = toDiscord(await listCommands(config.dataDir, claudeHome(config)));
      await guild.commands.set(registered.data);
      commands = registered.names;
      console.log(`registered ${registered.data.length} commands`);
    })
    .catch((e) => console.error("failed to register commands:", e));
  catchUp(guild, chats, dirFor, accepting).catch((e) => console.error("failed to catch up on missed messages:", e));
  return eventLoop(config, guild);
}

// Queues the messages sent while the bot was offline, which go out merged into one turn
async function catchUp(
  guild: Guild,
  chats: Chats,
  dirFor: (channel: Channel) => string | undefined,
  accepting: (message: Message) => boolean,
) {
  for (const channelId of chats.answered()) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    const dir = channel ? dirFor(channel) : undefined;
    if (!channel?.isTextBased() || dir === undefined) continue;

    const missed: Message[] = [];
    let after = chats.get(channelId)!.lastMessageId!;
    for (;;) {
      const page = await channel.messages.fetch({ after, limit: 100 });
      missed.push(...page.values());
      if (page.size < 100) break;
      after = page.reduce((max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max), after);
    }
    const accepted = missed.filter(accepting);
    if (accepted.length === 0) continue;
    console.log(`catching up on ${accepted.length} message(s) in ${dir}`);
    chats.chat(channelId, dir).add(accepted);
  }
}

async function eventLoop(config: Config, guild: Guild): Promise<never> {
  const autoEntries = config.paths.filter((entry): entry is AutoEntry => entry.mode === "auto");

  // One sync per category; several auto entries may share a category
  const syncs = new Map<string, CategorySync>();
  for (const { categoryId } of autoEntries) {
    if (!syncs.has(categoryId)) syncs.set(categoryId, await CategorySync.open(guild, categoryId));
  }

  const matched = new Map<PathConfig, Set<string>>(config.paths.map((entry) => [entry, new Set()]));

  // Wanted dirs in channel order: config entry order, then the first include
  // pattern matching each dir, then alphabetical
  const reconcile = async (categoryId: string) => {
    const wanted: string[] = [];
    for (const entry of autoEntries) {
      if (entry.categoryId !== categoryId) continue;
      const rank = (dir: string) => includeIndex(entry, dir);
      const dirs = [...matched.get(entry)!].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      for (const dir of dirs) if (!wanted.includes(dir)) wanted.push(dir);
    }
    const sync = syncs.get(categoryId)!;
    try {
      await sync.reconcile(wanted);
    } catch (e) {
      console.error(`failed to sync category ${sync.name}:`, e);
    }
  };

  // Reconciling waits for "ready", so a half-finished initial scan can't delete channels
  let synced = false;
  for await (const event of watchDirs(config.paths)) {
    if (event.type === "ready") {
      synced = true;
      for (const categoryId of syncs.keys()) await reconcile(categoryId);
      continue;
    }

    const { type, entry, dir } = event;
    console.log(`${type === "added" ? "+" : "-"} ${dir} (${entry.mode})`);
    if (type === "added") matched.get(entry)!.add(dir);
    else matched.get(entry)!.delete(dir);

    if (synced && entry.mode === "auto") await reconcile(entry.categoryId);
  }
  throw new Error("directory watcher stopped");
}
