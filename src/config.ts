import { isAbsolute, join, relative, resolve } from "node:path";

// auto: one channel per directory matched by include - exclude, under a category
// or, without one, at the top of the server.
// manual: the path itself, linked to an existing channel.
// permissions, when set, replaces claude.permissions for the entry's sessions.
export type PathConfig = { readonly path: string; readonly permissions?: PermissionMode } & (
  | {
      readonly mode: "auto";
      readonly categoryId?: string;
      readonly include: readonly string[];
      readonly exclude: readonly string[];
    }
  | { readonly mode: "manual"; readonly channelId: string }
);

export type AutoEntry = Extract<PathConfig, { mode: "auto" }>;

// Claude's effort levels, as `claude --effort` takes them
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

// Claude's permission modes, as `claude --permission-mode` takes them
export const PERMISSION_MODES = ["manual", "acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface Config {
  // Absolute; holds config.yaml and the bot's Claude home
  readonly dataDir: string;
  readonly paths: readonly PathConfig[];
  readonly discord: {
    readonly token: string;
    readonly serverId: string;
    // Users who can manage the bot; doesn't limit activity in channels
    readonly adminIds: readonly string[];
    // Whether the bot ignores everyone but the admins
    readonly adminOnly: boolean;
  };
  readonly claude: {
    // Each session starts at this effort; /effort changes it until the session ends
    readonly effort: Effort;
    // Each session's permission mode
    readonly permissions: PermissionMode;
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

// Optional, false by default. From env, "true" or "false".
function bool(v: unknown, where: string): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string" && where.startsWith("DISCORD_")) v = { true: true, false: false }[v.trim().toLowerCase()] ?? v;
  if (typeof v !== "boolean") fail(where, "expected true or false");
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

function effort(v: unknown, where: string): Effort {
  if (v === undefined || v === null) return "low";
  if (!EFFORTS.includes(v as Effort)) fail(where, `expected one of ${EFFORTS.join(", ")}`);
  return v as Effort;
}

function permissionMode(v: unknown, where: string): PermissionMode {
  if (v === undefined || v === null) return "manual";
  if (!PERMISSION_MODES.includes(v as PermissionMode)) fail(where, `expected one of ${PERMISSION_MODES.join(", ")}`);
  return v as PermissionMode;
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
  const permissions = opts.permissions == null ? undefined : permissionMode(opts.permissions, `${where}.permissions`);

  switch (opts.mode) {
    case "auto":
      checkKeys(opts, ["mode", "category_id", "include", "exclude", "permissions"], where);
      return {
        path,
        permissions,
        mode: "auto",
        categoryId: opts.category_id == null ? undefined : snowflake(opts.category_id, `${where}.category_id`),
        include: patterns(opts.include, `${where}.include`),
        exclude: patterns(opts.exclude, `${where}.exclude`),
      };
    case "manual":
      checkKeys(opts, ["mode", "channel_id", "permissions"], where);
      return { path, permissions, mode: "manual", channelId: snowflake(opts.channel_id, `${where}.channel_id`) };
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
  checkKeys(raw, ["paths", "discord", "claude"], configPath);

  const discord = raw.discord ?? {};
  if (!isRecord(discord)) fail("discord", "expected a mapping");
  checkKeys(discord, ["token", "server-id", "admin-id", "admin-only"], "discord");

  const claude = raw.claude ?? {};
  if (!isRecord(claude)) fail("claude", "expected a mapping");
  checkKeys(claude, ["effort", "permissions"], "claude");

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
      adminOnly: bool(...pick(discord, ["discord", "admin-only"])),
    },
    claude: {
      effort: effort(...pick(claude, ["claude", "effort"])),
      permissions: permissionMode(...pick(claude, ["claude", "permissions"])),
    },
  });
}

// The permission mode for a session in dir: that of the deepest entry holding
// it, falling back to claude.permissions
export function permissionsFor(config: Config, dir: string): PermissionMode {
  const holds = (entry: PathConfig) => !relative(entry.path, dir).startsWith("..");
  const entry = config.paths.filter(holds).sort((a, b) => b.path.length - a.path.length)[0];
  return entry?.permissions ?? config.claude.permissions;
}
