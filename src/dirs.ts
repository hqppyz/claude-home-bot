import { stat } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, type PathConfig } from "./config";

// Globs are relative to the entry's path; "." is the path itself.
const SELF = ".";

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function expand(root: string, pattern: string): Promise<string[]> {
  if (pattern === SELF) return [SELF];
  const found: string[] = [];
  for await (const rel of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: false })) {
    if (await isDir(join(root, rel))) found.push(rel);
  }
  return found;
}

function excluded(rel: string, patterns: readonly string[]): boolean {
  // Bun.Glob("*").match(".") is true, so only a literal "." excludes self
  if (rel === SELF) return patterns.includes(SELF);
  return patterns.some((p) => new Bun.Glob(p).match(rel));
}

// include - exclude, in both modes. Only a literal "." matches the path
// itself, "*" matches direct children. Returns sorted absolute paths.
export async function resolveDirs(entry: PathConfig): Promise<string[]> {
  if (!(await isDir(entry.path))) throw new ConfigError(`${entry.path}: not a directory`);

  const rels = new Set<string>();
  for (const pattern of entry.include) {
    for (const rel of await expand(entry.path, pattern)) rels.add(rel);
  }

  return [...rels]
    .filter((rel) => !excluded(rel, entry.exclude))
    .map((rel) => (rel === SELF ? entry.path : join(entry.path, rel)))
    .sort();
}
