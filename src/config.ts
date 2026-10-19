import { isAbsolute, join, resolve } from "node:path";

// auto: one channel per directory matched by include - exclude, under a category.
// manual: the path itself, linked to an existing channel.
export type PathConfig =
  | {
      readonly path: string;
      readonly mode: "auto";
      readonly categoryId: string;
      readonly include: readonly string[];
      readonly exclude: readonly string[];
    }
  | { readonly path: string; readonly mode: "manual"; readonly channelId: string };

export type AutoEntry = Extract<PathConfig, { mode: "auto" }>;

export interface Config {
  // Absolute; holds config.yaml and the bot's Claude home
  readonly dataDir: string;
  readonly paths: readonly PathConfig[];
  readonly discord: {
    readonly token: string;
    readonly serverId: string;
    // Users who can manage the bot; doesn't limit activity in channels
    readonly adminIds: readonly string[];
  };
}

export class ConfigError extends Error {}

function fail(where: string, msg: string): never {
  throw new ConfigError(`${where}: ${msg}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`${where}.${key}`, `unknown key${obj.mode ? ` in ${obj.mode} mode` : ""}`);
  }
}

// discord.server-id -> DISCORD_SERVER_ID
function envName(keys: readonly string[]): string {
  return keys.join("_").toUpperCase().replaceAll("-", "_");
}

// Env var wins over the file value. Returns the value and a label for errors.
function pick(file: Record<string, unknown>, keys: readonly string[]): [unknown, string] {
  const name = envName(keys);
  const fromEnv = Bun.env[name];
  if (fromEnv) return [fromEnv, name];
  return [file[keys.at(-1)!], `${keys.join(".")} (or ${name})`];
}

function str(v: unknown, where: string): string {
  if (v === undefined || v === null) fail(where, "required");
  if (typeof v !== "string" || v === "") fail(where, "expected a non-empty string");
  return v;
}

function snowflake(v: unknown, where: string): string {
  if (v === undefined || v === null) fail(where, "required");
  if (typeof v === "number") {
    // YAML parses unquoted IDs as floats, which can't hold 19-digit snowflakes
    if (!Number.isSafeInteger(v)) fail(where, "ID too large for an unquoted number, wrap it in quotes");
    v = String(v);
  }
  if (typeof v !== "string" || !/^\d+$/.test(v)) fail(where, "expected a Discord ID");
  return v;
}

function patterns(v: unknown, where: string): readonly string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return [str(v, where)];
  return v.map((p, i) => str(p, `${where}[${i}]`));
}

// Optional; a single ID or a list. From env, a comma-separated list.
function snowflakes(v: unknown, where: string): readonly string[] {
  if (v === undefined || v === null) return [];
  if (where.startsWith("DISCORD_") && typeof v === "string") v = v.split(",").map((id) => id.trim());
  if (!Array.isArray(v)) return [snowflake(v, where)];
  return v.map((id, i) => snowflake(id, `${where}[${i}]`));
}

function parsePath(entry: unknown, where: string): PathConfig {
  if (!isRecord(entry) || Object.keys(entry).length !== 1) {
    fail(where, "expected a single `<path>: { ... }` mapping");
  }
  const [path, opts] = Object.entries(entry)[0]!;
  where = `${where} (${path})`;
  if (!isAbsolute(path)) fail(where, "path must be absolute");
  if (!isRecord(opts)) fail(where, "expected a mapping");

  switch (opts.mode) {
    case "auto":
      checkKeys(opts, ["mode", "category_id", "include", "exclude"], where);
      return {
        path,
        mode: "auto",
        categoryId: snowflake(opts.category_id, `${where}.category_id`),
        include: patterns(opts.include, `${where}.include`),
        exclude: patterns(opts.exclude, `${where}.exclude`),
      };
    case "manual":
      checkKeys(opts, ["mode", "channel_id"], where);
      return { path, mode: "manual", channelId: snowflake(opts.channel_id, `${where}.channel_id`) };
    default:
      fail(`${where}.mode`, 'expected "auto" or "manual"');
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export async function loadConfig(dataDir: string): Promise<Config> {
  dataDir = resolve(dataDir);
  const configPath = join(dataDir, "config.yaml");
  const file = Bun.file(configPath);
  const raw: unknown = (await file.exists()) ? (Bun.YAML.parse(await file.text()) ?? {}) : {};
  if (!isRecord(raw)) fail(configPath, "expected a mapping at top level");
  checkKeys(raw, ["paths", "discord"], configPath);

  const discord = raw.discord ?? {};
  if (!isRecord(discord)) fail("discord", "expected a mapping");
  checkKeys(discord, ["token", "server-id", "admin-id"], "discord");

  // PATHS holds the whole list as YAML, e.g. PATHS='[{/home/me: {mode: manual}}]'
  let [paths, pathsWhere] = pick(raw, ["paths"]);
  if (pathsWhere === "PATHS") paths = Bun.YAML.parse(paths as string);
  if (!Array.isArray(paths) || paths.length === 0) fail(pathsWhere, "expected a non-empty list");

  return deepFreeze({
    dataDir,
    paths: paths.map((p, i) => parsePath(p, `paths[${i}]`)),
    discord: {
      token: str(...pick(discord, ["discord", "token"])),
      serverId: snowflake(...pick(discord, ["discord", "server-id"])),
      adminIds: snowflakes(...pick(discord, ["discord", "admin-id"])),
    },
  });
}
