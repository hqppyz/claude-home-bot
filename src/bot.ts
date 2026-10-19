import { Client, Events, GatewayIntentBits, type Guild, type Message } from "discord.js";
import { CategorySync } from "./channels";
import { authenticate } from "./auth";
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

  client.on(Events.MessageCreate, async (message) => {
    if (!accepting(message)) return;
    await message.reply("Hi");
  });

  await client.login(token);
  const guild = await ready;
  // Runs alongside the channel sync; interactions arrive without a DM intent
  authenticate(client, config).catch((e) => console.error("claude login failed:", e));
  return eventLoop(config, guild);
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
