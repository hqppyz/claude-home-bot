import { escapeMarkdown, type Message } from "discord.js";
import type { Reply } from "./claude";

// Discord's message length limit
const MAX_MESSAGE = 2000;

// Longest detail on one line of the log
const MAX_DETAIL = 120;

// A stream-json event as it comes, read only to describe it
export type RawEvent = Record<string, any>;

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
function block(content: RawEvent, asked: Set<string>): string[] {
  switch (content.type) {
    case "text":
      return [content.text];
    // The typing indicator shows thinking instead
    case "thinking":
    case "redacted_thinking":
      return [];
    case "tool_use": {
      const input = content.input ?? {};
      // The bot asks these questions in their own message
      if (content.name === "AskUserQuestion" && Array.isArray(input.questions)) {
        asked.add(content.id);
        return [];
      }
      // The field a person would recognize the call by, else the whole input
      const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.prompt ?? JSON.stringify(input);
      return [note(`tool ${content.name} · ${short(detail)}`)];
    }
    case "tool_result": {
      // The answers show on the question's own message
      if (asked.has(content.tool_use_id)) return [];
      const result = Array.isArray(content.content)
        ? content.content.map((part: RawEvent) => part.text ?? `[${part.type}]`).join(" ")
        : content.content;
      return [note(`${content.is_error ? "tool error" : "tool result"} · ${short(result)}`)];
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
// asked collects the ids of the turn's questions, whose results stay hidden too.
export function describe(event: RawEvent, asked = new Set<string>()): string[] {
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
      if (Array.isArray(content)) return content.flatMap((c: RawEvent) => block(c, asked));
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
}

// A turn's events and reply as they happen: the first event sends a message,
// later ones edit it, and text past Discord's limit goes on in new messages.
// Edits never overlap; events that arrive during one go out together.
export class LiveReply {
  private readonly entries: string[] = [];
  private readonly messages: Message[] = [];
  private readonly sent: string[] = [];
  private flushing: Promise<void> | undefined;
  private dirty = false;
  private hasText = false;

  // asked is shared by the turn's replies, since a question's result comes after it splits them
  constructor(
    private readonly outlet: Outlet,
    private readonly asked = new Set<string>(),
  ) {}

  add(event: RawEvent) {
    if (event.type === "assistant" && event.message?.content?.some?.((c: RawEvent) => c.type === "text")) this.hasText = true;
    this.push(...describe(event, this.asked));
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

  private push(...entries: string[]) {
    this.entries.push(...entries);
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
          break;
        }
      }
    }
  }
}
