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

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function tokens(usage: RawEvent | undefined): string {
  if (!usage) return "0";
  const total = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"].reduce(
    (sum, key) => sum + (usage[key] ?? 0),
    0,
  );
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
}

// What a content block of an assistant or user message did; Claude's text goes as is
function block(content: RawEvent): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "thinking":
      return note(`thinking · ${short(content.thinking)}`);
    case "tool_use": {
      const input = content.input ?? {};
      // The field a person would recognize the call by, else the whole input
      const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.prompt ?? JSON.stringify(input);
      return note(`tool ${content.name} · ${short(detail)}`);
    }
    case "tool_result": {
      const result = Array.isArray(content.content)
        ? content.content.map((part: RawEvent) => part.text ?? `[${part.type}]`).join(" ")
        : content.content;
      return note(`${content.is_error ? "tool error" : "tool result"} · ${short(result)}`);
    }
    default:
      return note(String(content.type));
  }
}

// What one event adds to the turn's messages; message events add one entry per content block
export function describe(event: RawEvent): string[] {
  switch (event.type) {
    case "system":
      if (event.subtype === "init") return [note(`init · ${event.model} · ${event.permissionMode}`)];
      break;
    case "assistant":
    case "user": {
      const content = event.message?.content;
      if (typeof content === "string") return [note(`${event.type} · ${short(content)}`)];
      if (Array.isArray(content)) return content.map(block);
      break;
    }
    case "conversation_reset":
      return [note(`conversation reset · ${event.trigger}`)];
    case "rate_limit_event": {
      const info = event.rate_limit_info ?? {};
      const windows = Object.entries(info.unifiedWindows ?? {}).map(
        ([window, w]: [string, any]) => `${window} ${Math.round((w.utilization ?? 0) * 100)}%`,
      );
      return [note(`rate limit · ${[info.status, ...windows].join(" · ")}`)];
    }
    case "result": {
      const parts = [event.is_error ? "failed" : "done", seconds(event.duration_ms ?? 0)];
      if (event.local_command) parts.push(`/${event.local_command}`);
      else parts.push(`${event.num_turns} turns`, `${tokens(event.usage)} tokens`, `$${(event.total_cost_usd ?? 0).toFixed(3)}`);
      return [note(parts.join(" · "))];
    }
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

  constructor(private readonly outlet: Outlet) {}

  add(event: RawEvent) {
    if (event.type === "assistant" && event.message?.content?.some?.((c: RawEvent) => c.type === "text")) this.hasText = true;
    this.push(...describe(event));
  }

  // Adds what the events didn't show: an error, or the output of a local
  // command, which has no assistant text. Resolves once every message is up to date.
  async finish(reply: Reply) {
    if (reply.isError) this.push(`Claude failed: ${reply.text}`);
    else if (!this.hasText && reply.text) this.push(reply.text);
    else if (this.entries.length === 0) this.push("(empty reply)");
    await this.flushing;
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
