import { expect, test } from "bun:test";
import type { Message } from "discord.js";
import { chunks, describe, LiveReply } from "./log";

test("shows Claude's text as is and tool calls as small text", () => {
  const event = {
    type: "assistant",
    message: { content: [{ type: "text", text: "on\n**it**" }, { type: "tool_use", name: "Bash", input: { command: "echo `hi`" } }] },
  };
  expect(describe(event)).toEqual(["on\n**it**", "-# tool Bash · echo \\`hi\\`"]);
});

test("summarizes a turn's result", () => {
  const event = {
    type: "result",
    subtype: "success",
    duration_ms: 2908,
    num_turns: 2,
    total_cost_usd: 0.0956,
    usage: { input_tokens: 4, cache_creation_input_tokens: 11081, cache_read_input_tokens: 26917, output_tokens: 78 },
  };
  expect(describe(event)).toEqual(["-# done · 2.9s · 2 turns · 38.1k tokens · $0.096"]);
  expect(describe({ type: "result", duration_ms: 251, local_command: "clear" })).toEqual(["-# done · 0.3s · /clear"]);
});

test("names events it has no summary for", () => {
  expect(describe({ type: "system", subtype: "status" })).toEqual(["-# system/status"]);
});

test("splits text past the message limit at a newline", () => {
  const parts = chunks(`${"a".repeat(1500)}\n${"b".repeat(1500)}`);
  expect(parts).toEqual(["a".repeat(1500), "b".repeat(1500)]);
});

test("edits the last message and sends a new one when it overflows", async () => {
  const calls: string[] = [];
  const live = new LiveReply({
    send: async (content, i) => (calls.push(`send ${i} ${content.length}`), {} as Message),
    edit: async (_, content, i) => calls.push(`edit ${i} ${content.length}`),
  });
  live.add({ type: "system", subtype: "init", model: "m", permissionMode: "p" });
  live.add({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(1990) }] } });
  await live.finish({ text: "x".repeat(1990), isError: false });
  // The first message is full, so the text starts a second one
  expect(calls).toEqual(["send 0 15", "send 1 1990"]);
});
