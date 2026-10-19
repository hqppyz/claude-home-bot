import { basename } from "node:path";
import { ChannelType, type CategoryChannel, type Guild, type TextChannel } from "discord.js";

// Managed channels carry their directory on a marker line in the topic.
// Unmarked channels are never deleted, so the category can hold other
// channels too; one whose name matches a new directory is adopted instead.
const MARKER = "claude-home-bot:";

const markerFor = (dir: string) => `${MARKER} ${dir}`;

function dirOf(channel: TextChannel): string | undefined {
  const line = (channel.topic ?? "").split("\n").find((l) => l.startsWith(MARKER));
  return line?.slice(MARKER.length).trim();
}

// Discord text channel names: lowercase, no spaces, at most 100 characters
function channelName(dir: string): string {
  const name = basename(dir).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (name || "root").slice(0, 100);
}

// Keeps the managed text channels of one category in line with a set of directories.
export class CategorySync {
  private constructor(
    private readonly guild: Guild,
    private readonly category: CategoryChannel,
  ) {}

  static async open(guild: Guild, categoryId: string): Promise<CategorySync> {
    const category = await guild.channels.fetch(categoryId).catch(() => null);
    if (category?.type !== ChannelType.GuildCategory) {
      throw new Error(`category ${categoryId} not found in server ${guild.name}`);
    }
    return new CategorySync(guild, category);
  }

  get name(): string {
    return this.category.name;
  }

  private textChannels(): TextChannel[] {
    return [...this.guild.channels.cache.values()]
      .filter((c): c is TextChannel => c.parentId === this.category.id && c.type === ChannelType.GuildText)
      .sort((a, b) => a.position - b.position);
  }

  // Adopts or creates channels for missing directories, deletes managed
  // channels whose directory is no longer wanted (including duplicates), then
  // orders managed channels like wanted.
  async reconcile(wanted: readonly string[]): Promise<void> {
    const seen = new Set<string>();
    const unmarked: TextChannel[] = [];
    for (const channel of this.textChannels()) {
      const dir = dirOf(channel);
      if (dir === undefined) {
        unmarked.push(channel);
        continue;
      }
      if (wanted.includes(dir) && !seen.has(dir)) {
        seen.add(dir);
        continue;
      }
      await channel.delete(`directory gone: ${dir}`);
      console.log(`deleted #${channel.name} (${dir})`);
    }

    for (const dir of wanted) {
      if (seen.has(dir)) continue;
      const name = channelName(dir);

      const existing = unmarked.findIndex((channel) => channel.name === name);
      if (existing !== -1) {
        const [channel] = unmarked.splice(existing, 1) as [TextChannel];
        await channel.setTopic(channel.topic ? `${channel.topic}\n${markerFor(dir)}` : markerFor(dir));
        console.log(`adopted #${channel.name} (${dir})`);
        continue;
      }

      const channel = await this.guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: this.category.id,
        topic: markerFor(dir),
        reason: `directory found: ${dir}`,
      });
      console.log(`created #${channel.name} (${dir})`);
    }

    await this.order(wanted);
  }

  // Managed channels take the slots managed channels already occupy, in wanted
  // order; unmarked channels keep their place.
  private async order(wanted: readonly string[]): Promise<void> {
    const current = this.textChannels();
    const managed = new Map<string, TextChannel>();
    for (const channel of current) {
      const dir = dirOf(channel);
      if (dir !== undefined) managed.set(dir, channel);
    }

    const queue = wanted.flatMap((dir) => managed.get(dir) ?? []);
    const target = current.map((channel) => (dirOf(channel) === undefined ? channel : queue.shift()!));
    if (target.every((channel, i) => channel === current[i])) return;

    await this.guild.channels.setPositions(target.map((channel, position) => ({ channel, position })));
    console.log(`ordered ${this.category.name}: ${target.map((c) => `#${c.name}`).join(" ")}`);
  }
}
