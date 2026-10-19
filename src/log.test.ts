import { expect, test } from "bun:test";
import type { Message } from "discord.js";
import { statusFor } from "./presence";
import { chunks, cost, describe, effortSet, isThinking, LiveReply, session, usage } from "./log";

test("shows Claude's text as is and tool calls as small text", () => {
  const event = {
    type: "assistant",
    message: { content: [{ type: "text", text: "on\n**it**" }, { type: "tool_use", name: "Bash", input: { command: "echo `hi`" } }] },
  };
  expect(describe(event)).toEqual(["on\n**it**", "-# tool Bash · echo \\`hi\\`"]);
});

test("hides questions the bot asks in their own message", () => {
  const ask = (input: object) => ({ type: "assistant", message: { content: [{ type: "tool_use", name: "AskUserQuestion", input }] } });
  expect(describe(ask({ questions: [] }))).toEqual([]);
  expect(describe(ask({}))).toEqual(["-# tool AskUserQuestion · {}"]);
  const asked = new Set<string>();
  expect(describe({ type: "assistant", message: { content: [{ type: "tool_use", id: "q", name: "AskUserQuestion", input: { questions: [] } }] } }, asked)).toEqual([]);
  expect(describe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "q", content: "answered" }] } }, asked)).toEqual([]);
  expect(describe({ type: "control_request", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion" } })).toEqual([]);
});

test("leaves a turn's cost to the topic", () => {
  const event = {
    type: "result",
    subtype: "success",
    duration_ms: 2908,
    num_turns: 2,
    total_cost_usd: 0.0956,
    usage: { input_tokens: 4, cache_creation_input_tokens: 11081, cache_read_input_tokens: 26917, output_tokens: 78 },
  };
  expect(describe(event)).toEqual([]);
  expect(cost(event)).toBe("26.9k cache read · 11.1k cache write · 4 in · 78 out · $0.096");
  expect(cost({ type: "result", duration_ms: 251, local_command: "clear" })).toBeUndefined();
});

test("names events it has no summary for", () => {
  expect(describe({ type: "system", subtype: "status" })).toEqual(["-# system/status"]);
});

test("tells thinking from other events", () => {
  const assistant = (...types: string[]) => ({ type: "assistant", message: { content: types.map((type) => ({ type })) } });
  const tokens = { type: "system", subtype: "thinking_tokens" };
  expect(isThinking(tokens)).toBe(true);
  expect(describe(tokens)).toEqual([]);
  expect(isThinking(assistant("thinking"))).toBe(true);
  expect(describe(assistant("thinking", "redacted_thinking"))).toEqual([]);
  expect(isThinking(assistant("thinking", "text"))).toBe(false);
  expect(isThinking(assistant())).toBe(false);
  expect(isThinking({ type: "system", subtype: "status" })).toBe(false);
});

test("names the session's model and mode", () => {
  expect(describe({ type: "system", subtype: "init" })).toEqual([]);
  expect(session({ model: "claude-opus-5-5", permissionMode: "auto" })).toEqual({ model: "claude-opus-5-5", mode: "auto" });
});

test("reads the effort an /effort command set", () => {
  const result = (local_command: string, text: string) => ({ type: "result", local_command, result: text });
  expect(effortSet(result("effort", "Set effort level to low (this session only): Quick, straightforward implementation"))).toBe("low");
  expect(effortSet(result("clear", "Set effort level to low"))).toBeUndefined();
  expect(effortSet(result("effort", "Usage: /effort <level>"))).toBeUndefined();
});

test("shows what's left of the 5-hour window", () => {
  const now = 1_000_000_000_000;
  const at = (minutes: number) => (now + minutes * 60_000) / 1000;
  const event = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      unifiedWindows: { five_hour: { utilization: 0.51, resetsAt: at(125) }, seven_day: { utilization: 0.59, resetsAt: at(6840) } },
    },
  };
  expect(statusFor(event)).toBe("idle");
  expect(usage(event, now)).toEqual({ percent: 49, reset: "2h05m" });
  expect(describe(event)).toEqual([]);
  expect(describe({ ...event, rate_limit_info: { ...event.rate_limit_info, status: "allowed_warning" } })).toEqual([
    "-# rate limit · allowed\\_warning · five\\_hour 51% · seven\\_day 59%",
  ]);
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
  live.add({ type: "system", subtype: "status" });
  live.add({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(1990) }] } });
  await live.finish({ text: "x".repeat(1990), isError: false });
  // The first message is full, so the text starts a second one
  expect(calls).toEqual(["send 0 16", "send 1 1990"]);
});
