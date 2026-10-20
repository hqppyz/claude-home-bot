import { escapeMarkdown, type Message } from "discord.js";
import type { Reply } from "./claude";

// Discord's message length limit
const MAX_MESSAGE = 2000;

// Longest detail on one line of the log
const MAX_DETAIL = 120;

// Longest command shown in a Bash call's code block
const MAX_COMMAND = 1500;

// Most of a Bash call's output shown under its command, from the end, in lines and
// characters; with the longest command it still fits one message
const MAX_OUTPUT_LINES = 10;
const MAX_OUTPUT = 400;

// Terminal color and cursor codes, which a code block shows as is
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

// A stream-json event as it comes, read only to describe it
export type RawEvent = Record<string, any>;

// A line of the log; one with an id replaces the earlier one with the same id, as
// a Bash call's output joins its command
export type Entry = string | { id: string; text: string };

// Splits at the last newline that fits, or hard at the limit
export function chunks(text: string): string[] {
  const out: string[] = [];
  while (text.length > MAX_MESSAGE) {
    const cut = text.lastIndexOf("\n", MAX_MESSAGE);
    const at = cut > 0 ? cut : MAX_MESSAGE;
    out.push(text.slice(0, at));
    text = text.slice(at).replace(/^\n/, "");
  }
  if (text) out.push(text);
  return out;
}

// One line, cut to fit
function short(text: unknown): string {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 1)}…` : line;
}

// A log line, in small text so Claude's own text stands out
const note = (line: string) => `-# ${escapeMarkdown(line)}`;

// The line between log lines and Claude's text, since Discord's markdown has no divider
export const RULE = `-# ${"─".repeat(24)}`;

// Whether an entry is a log line, not Claude's text; text that starts like a note counts as one
const isLog = (entry: Entry) => typeof entry !== "string" || entry.startsWith("-# ");

// A Bash call in a code block, under a note naming it: its command, then the end of
// its output once it comes; a zero-width space keeps backticks from closing the block
function bash(command: string, output = ""): string {
  const cut = command.length > MAX_COMMAND ? `${command.slice(0, MAX_COMMAND - 1)}…` : command;
  const body = output ? `$ ${cut}\n${output}` : `$ ${cut}`;
  return `${note("bash")}\n\`\`\`bash\n${body.replace(/```/g, "`\u200b``")}\n\`\`\``;
}

// The end of a Bash call's output, where errors and summaries go, marked when cut
function tail(output: string): string {
  const all = output.replace(ANSI, "").trimEnd();
  const kept = all.split("\n").slice(-MAX_OUTPUT_LINES).join("\n").slice(-MAX_OUTPUT);
  return kept.length < all.length ? `…\n${kept}` : kept;
}

// A tool result's text; parts that aren't text show as their type
const resultText = (content: RawEvent): string =>
  Array.isArray(content.content)
    ? content.content.map((part: RawEvent) => part.text ?? `[${part.type}]`).join(" ")
    : String(content.content ?? "");

// Whether a tool call is a question the bot asks in its own message
const isQuestion = (call: RawEvent | undefined) => call?.name === "AskUserQuestion" && Array.isArray(call.input?.questions);

const count = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// Each kind of token apart, since they're priced apart: cache reads cost a
// tenth of fresh input, cache writes more than it
function tokens(usage: RawEvent | undefined): string {
  const kinds: [string, string][] = [
    ["cache_read_input_tokens", "cache read"],
    ["cache_creation_input_tokens", "cache write"],
    ["input_tokens", "in"],
    ["output_tokens", "out"],
  ];
  return kinds.map(([key, label]) => `${count(usage?.[key] ?? 0)} ${label}`).join(" · ");
}

// What a content block of an assistant or user message did; Claude's text goes as is
function block(content: RawEvent, calls: Map<string, RawEvent>): Entry[] {
  switch (content.type) {
    case "text":
      return [content.text];
    // The typing indicator shows thinking instead
    case "thinking":
    case "redacted_thinking":
      return [];
    case "tool_use": {
      const input = content.input ?? {};
      calls.set(content.id, content);
      // The bot asks these questions in their own message
      if (isQuestion(content)) return [];
      if (content.name === "Bash" && typeof input.command === "string") return [{ id: content.id, text: bash(input.command) }];
      // The field a person would recognize the call by, else the whole input
      const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.prompt ?? JSON.stringify(input);
      return [note(`tool ${content.name} · ${short(detail)}`)];
    }
    case "tool_result": {
      const call = calls.get(content.tool_use_id);
      // The answers show on the question's own message
      if (isQuestion(call)) return [];
      const command = call?.name === "Bash" ? call.input?.command : undefined;
      if (typeof command === "string") return [{ id: call!.id, text: bash(command, tail(resultText(content))) }];
      return [note(`${content.is_error ? "tool error" : "tool result"} · ${short(resultText(content))}`)];
    }
    default:
      return [note(String(content.type))];
  }
}

// A turn's tokens and cost, for the channel topic; local commands have none
export const cost = (event: RawEvent) =>
  event.local_command ? undefined : `${tokens(event.usage)} · $${(event.total_cost_usd ?? 0).toFixed(3)}`;

// The session's model and permission mode, from its init event
export const session = (event: RawEvent) => ({ model: String(event.model), mode: String(event.permissionMode) });

// The effort a turn's /effort command set; the result's text is the only place it shows
export const effortSet = (event: RawEvent): string | undefined =>
  event.local_command === "effort" ? /effort level to (\w+)/i.exec(String(event.result ?? ""))?.[1]?.toLowerCase() : undefined;

// Time left as its two largest units: 45m, 2h05m, 4d18h
function left(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const [d, h, m] = [Math.floor(minutes / 1440), Math.floor(minutes / 60) % 24, minutes % 60];
  if (d > 0) return `${d}d${String(h).padStart(2, "0")}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

// What's left of the 5-hour window of a rate limit event, in percent, and the time to its reset
export function usage(event: RawEvent, now = Date.now()): { percent: number; reset?: string } | undefined {
  const w: { utilization?: number; resetsAt?: number } | undefined = event.rate_limit_info?.unifiedWindows?.five_hour;
  if (!w) return undefined;
  const percent = Math.round((1 - (w.utilization ?? 0)) * 100);
  return { percent, reset: w.resetsAt ? left(w.resetsAt * 1000 - now) : undefined };
}

// Whether an event is Claude thinking: progress frames, or a message of thinking blocks only
export function isThinking(event: RawEvent): boolean {
  if (event.type === "system") return event.subtype === "thinking_tokens";
  const content = event.message?.content;
  return (
    event.type === "assistant" &&
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((c: RawEvent) => c.type === "thinking" || c.type === "redacted_thinking")
  );
}

// What one event adds to the turn's messages; message events add one entry per content block.
// calls collects the turn's tool calls by id, which their results are shown with.
export function describe(event: RawEvent, calls = new Map<string, RawEvent>()): Entry[] {
  switch (event.type) {
    case "system":
      // The channel topic shows the session's model and mode instead
      if (event.subtype === "init") return [];
      // The typing indicator shows thinking instead
      if (event.subtype === "thinking_tokens") return [];
      break;
    case "assistant":
    case "user": {
      const content = event.message?.content;
      if (typeof content === "string") return [note(`${event.type} · ${short(content)}`)];
      if (Array.isArray(content)) return content.flatMap((c: RawEvent) => block(c, calls));
      break;
    }
    case "control_request":
      // Permission prompts, like the questions, which the bot asks in their own message
      return [];
    case "conversation_reset":
      return [note(`conversation reset · ${event.trigger}`)];
    case "rate_limit_event": {
      const info = event.rate_limit_info ?? {};
      // The bot's status shows usage; the log only shows a limit getting close or hit
      if (info.status === "allowed") return [];
      const windows = Object.entries(info.unifiedWindows ?? {}).map(
        ([window, w]: [string, any]) => `${window} ${Math.round((w.utilization ?? 0) * 100)}%`,
      );
      return [note(`rate limit · ${[info.status, ...windows].join(" · ")}`)];
    }
    case "result":
      // The channel topic shows the turn's cost instead
      return [];
  }
  return [note(event.subtype ? `${event.type}/${event.subtype}` : String(event.type))];
}

// Where a turn's messages go
export interface Outlet {
  // index is the message's place in the turn; the first one answers the input
  send(content: string, index: number): Promise<Message>;
  edit(message: Message, content: string, index: number): Promise<unknown>;
  // A plain message in the channel, for when sending or editing fails
  report(content: string): Promise<unknown>;
}

// A turn's events and reply as they happen: the first event sends a message,
// later ones edit it, and text past Discord's limit goes on in new messages.
// Edits never overlap; events that arrive during one go out together.
export class LiveReply {
  private readonly entries: string[] = [];
  // Where each entry with an id is, for its replacement
  private readonly ids = new Map<string, number>();
  private readonly messages: Message[] = [];
  private readonly sent: string[] = [];
  private flushing: Promise<void> | undefined;
  private dirty = false;
  private hasText = false;
  // Whether the last entry was a log line, to put a rule where log and text meet
  private lastLog: boolean | undefined;
  // Whether a failure has been reported in the channel, which happens once per reply
  private reported = false;

  // calls is shared by the turn's replies, since a question's result comes after it splits them
  constructor(
    private readonly outlet: Outlet,
    private readonly calls = new Map<string, RawEvent>(),
  ) {}

  add(event: RawEvent) {
    if (event.type === "assistant" && event.message?.content?.some?.((c: RawEvent) => c.type === "text")) this.hasText = true;
    this.push(...describe(event, this.calls));
  }

  // Adds what the events didn't show: an error, or the output of a local
  // command, which has no assistant text. Resolves once every message is up to date.
  async finish(reply: Reply) {
    if (reply.isError) this.push(`Claude failed: ${reply.text}`);
    else if (!this.hasText && reply.text) this.push(reply.text);
    else if (this.entries.length === 0) this.push("(empty reply)");
    await this.flushing;
  }

  // Resolves once every message is up to date, for when later output goes elsewhere
  async settle() {
    while (this.flushing) await this.flushing;
  }

  // An entry whose id is in an earlier reply of the turn goes at the end of this one
  private push(...entries: Entry[]) {
    for (const entry of entries) {
      const replaces = typeof entry !== "string" && this.ids.has(entry.id);
      if (!replaces) {
        // A blank line under the rule spaces Claude's text from it; a code block keeps its own margin
        if (this.lastLog !== undefined && this.lastLog !== isLog(entry)) this.entries.push(...(isLog(entry) ? [RULE] : [RULE, ""]));
        this.lastLog = isLog(entry);
      }
      if (typeof entry === "string") this.entries.push(entry);
      else {
        const at = this.ids.get(entry.id);
        if (at === undefined) this.ids.set(entry.id, this.entries.push(entry.text) - 1);
        else this.entries[at] = entry.text;
      }
    }
    this.dirty = true;
    this.flushing ??= this.flush().finally(() => (this.flushing = undefined));
  }

  private async flush() {
    while (this.dirty) {
      this.dirty = false;
      for (const [i, content] of chunks(this.entries.join("\n")).entries()) {
        if (this.sent[i] === content) continue;
        try {
          if (this.messages[i]) await this.outlet.edit(this.messages[i]!, content, i);
          else this.messages.push(await this.outlet.send(content, i));
          this.sent[i] = content;
        } catch (e) {
          console.error("failed to update the turn's messages:", e);
          this.report(e);
          break;
        }
      }
    }
  }

  // A reply needs more than a plain message (Read Message History, for one), so
  // a plain message can still tell why the reply is missing
  private report(e: unknown) {
    if (this.reported) return;
    this.reported = true;
    const reason = e instanceof Error ? e.message : String(e);
    this.outlet.report(`Failed to send Claude's reply: ${reason}`).catch((e) => console.error("failed to report the failure:", e));
  }
}
