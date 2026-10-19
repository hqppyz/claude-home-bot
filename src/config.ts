import { isAbsolute } from "node:path";

const CONFIG_PATH = "data/config.yaml";

interface PathBase {
  readonly path: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export type PathConfig =
  | (PathBase & { readonly mode: "auto"; readonly categoryId: string })
  | (PathBase & { readonly mode: "manual" });

export interface Config {
  readonly paths: readonly PathConfig[];
  readonly discord: {
    readonly token: string;
    readonly serverId: string;
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
    if (!allowed.includes(key)) fail(`${where}.${key}`, "unknown key");
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

function parsePath(entry: unknown, where: string): PathConfig {
  if (!isRecord(entry) || Object.keys(entry).length !== 1) {
    fail(where, "expected a single `<path>: { ... }` mapping");
  }
  const [path, opts] = Object.entries(entry)[0]!;
  where = `${where} (${path})`;
  if (!isAbsolute(path)) fail(where, "path must be absolute");
  if (!isRecord(opts)) fail(where, "expected a mapping");
  checkKeys(opts, ["mode", "category_id", "include", "exclude"], where);

  const include = patterns(opts.include, `${where}.include`);
  const exclude = patterns(opts.exclude, `${where}.exclude`);

  switch (opts.mode) {
    case "auto":
      return { path, mode: "auto", categoryId: snowflake(opts.category_id, `${where}.category_id`), include, exclude };
    case "manual":
      if (opts.category_id !== undefined) fail(`${where}.category_id`, "only valid in auto mode");
      return { path, mode: "manual", include, exclude };
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

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(CONFIG_PATH);
  const raw: unknown = (await file.exists()) ? (Bun.YAML.parse(await file.text()) ?? {}) : {};
  if (!isRecord(raw)) fail(CONFIG_PATH, "expected a mapping at top level");
  checkKeys(raw, ["paths", "discord"], CONFIG_PATH);

  const discord = raw.discord ?? {};
  if (!isRecord(discord)) fail("discord", "expected a mapping");
  checkKeys(discord, ["token", "server-id"], "discord");

  // PATHS holds the whole list as YAML, e.g. PATHS='[{/home/me: {mode: manual}}]'
  let [paths, pathsWhere] = pick(raw, ["paths"]);
  if (pathsWhere === "PATHS") paths = Bun.YAML.parse(paths as string);
  if (!Array.isArray(paths) || paths.length === 0) fail(pathsWhere, "expected a non-empty list");

  return deepFreeze({
    paths: paths.map((p, i) => parsePath(p, `paths[${i}]`)),
    discord: {
      token: str(...pick(discord, ["discord", "token"])),
      serverId: snowflake(...pick(discord, ["discord", "server-id"])),
    },
  });
}
