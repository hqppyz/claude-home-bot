import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PathConfig } from "./config";
import { resolveDirs } from "./dirs";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dirs-test-"));
  for (const dir of ["a/x", "a/y", "b", "c", ".hidden"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "file"), "");
});

afterAll(() => rm(root, { recursive: true }));

const auto = (include: string[] = [], exclude: string[] = []): PathConfig =>
  ({ path: root, mode: "auto", categoryId: "1", include, exclude });
const manual = (include: string[] = [], exclude: string[] = []): PathConfig =>
  ({ path: root, mode: "manual", include, exclude });
const rel = (dirs: string[]) => dirs.map((d) => (d === root ? "." : d.slice(root.length + 1)));

test("no include: nothing, in both modes", async () => {
  expect(await resolveDirs(auto())).toEqual([]);
  expect(await resolveDirs(manual())).toEqual([]);
});

test("* is direct child dirs only: no self, files or hidden dirs", async () => {
  expect(rel(await resolveDirs(auto(["*"])))).toEqual(["a", "b", "c"]);
});

test(". includes self", async () => {
  expect(rel(await resolveDirs(manual(["."])))).toEqual(["."]);
  expect(rel(await resolveDirs(auto([".", "*"])))).toEqual([".", "a", "b", "c"]);
});

test("globs reach deeper", async () => {
  expect(rel(await resolveDirs(manual(["a/*"])))).toEqual(["a/x", "a/y"]);
});

test("exclude . removes self", async () => {
  expect(rel(await resolveDirs(auto([".", "*"], ["."])))).toEqual(["a", "b", "c"]);
});

test("exclude * keeps self", async () => {
  expect(rel(await resolveDirs(auto([".", "*"], ["*"])))).toEqual(["."]);
});

test("exclude wins over include", async () => {
  expect(rel(await resolveDirs(manual(["a/*"], ["a/x"])))).toEqual(["a/y"]);
});

test("missing path throws", async () => {
  expect(resolveDirs({ ...manual(), path: join(root, "nope") })).rejects.toThrow("not a directory");
});
