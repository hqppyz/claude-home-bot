import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config, Effort, PermissionMode } from "./config";
import type { RawEvent } from "./log";

// Claude Code keeps settings, credentials and transcripts under CLAUDE_CONFIG_DIR,
// so pointing it into the data dir keeps the bot's sessions out of the user's ~/.claude.
export function claudeHome(config: Config): string {
  return join(config.dataDir, ".claude");
}

// Whether credentials exist in the bot's Claude home. Doesn't validate them,
// but never starts a session.
export async function checkAuth(config: Config): Promise<boolean> {
  const home = claudeHome(config);
  await mkdir(home, { recursive: true });
  const proc = Bun.spawn(["claude", "auth", "status", "--json"], {
    env: { ...Bun.env, CLAUDE_CONFIG_DIR: home },
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(stdout).loggedIn === true;
  } catch {
    return false;
  }
}

// `claude auth login` without a TTY prints the URL and waits for the code on
// stdin; the callback page shows the code, so any machine can do the login.
export class Login {
  private submitting: Promise<boolean> | undefined;

  private constructor(
    private readonly config: Config,
    private readonly proc: Bun.Subprocess<"pipe", "pipe", "ignore">,
    readonly url: string,
  ) {}

  static async start(config: Config): Promise<Login> {
    const home = claudeHome(config);
    await mkdir(home, { recursive: true });
    const proc = Bun.spawn(["claude", "auth", "login"], {
      // BROWSER=true makes the browser launch a no-op on the server
      env: { ...Bun.env, CLAUDE_CONFIG_DIR: home, BROWSER: "true" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });

    // A reader, not for-await: breaking out of that would cancel stdout
    // and the process could die writing to it later
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
      const url = output.match(/https:\/\/\S+/)?.[0];
      // The prompt follows the URL, so the URL is complete once it shows
      if (url && output.includes("Paste code")) {
        reader.releaseLock();
        return new Login(config, proc, url);
      }
    }
    throw new Error(`claude auth login exited without a URL: ${output.trim()}`);
  }

  // Resolves to whether the bot is authenticated afterwards. The login
  // process takes one code, so later calls share the first one's result.
  submit(code: string): Promise<boolean> {
    this.submitting ??= this.finish(code);
    return this.submitting;
  }

  cancel() {
    this.proc.kill();
  }

  private async finish(code: string): Promise<boolean> {
    this.proc.stdin.write(`${code.trim()}\n`);
    await this.proc.stdin.end();
    const timeout = setTimeout(() => this.proc.kill(), 30_000);
    await this.proc.exited;
    clearTimeout(timeout);
    return checkAuth(this.config);
  }
}

export interface Reply {
  readonly text: string;
  readonly isError: boolean;
}

export interface ClaudeCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint: string;
  readonly builtin?: boolean;
}

// A question of AskUserQuestion's input
export interface Question {
  readonly question: string;
  readonly header: string;
  readonly options: readonly { label: string; description?: string }[];
  readonly multiSelect: boolean;
}

// Asks the person the questions; resolves to each question's answer, keyed by
// its text. The signal aborts when Claude stops waiting for the answers.
export type Ask = (questions: readonly Question[], signal: AbortSignal) => Promise<Record<string, string>>;

// The subset of stream-json events the bot reads
interface Event {
  type?: string;
  subtype?: string;
  session_id?: string;
  request_id?: string;
  request?: { subtype?: string; tool_name?: string; input?: { questions?: Question[] } };
  result?: string;
  is_error?: boolean;
  errors?: string[];
  response?: {
    subtype?: string;
    request_id?: string;
    error?: string;
    response?: { commands?: ClaudeCommand[] };
  };
}

// The stream-json events in a process's stdout, skipping lines that aren't JSON
async function* events(stdout: ReadableStream<Uint8Array>): AsyncGenerator<Event> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      try {
        yield JSON.parse(line);
      } catch {}
    }
  }
}

// The slash commands a session in dir can run. The initialize control request
// answers without starting a turn, so this costs no tokens.
export async function listCommands(dir: string, home: string): Promise<ClaudeCommand[]> {
  await mkdir(home, { recursive: true });
  const proc = Bun.spawn(["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], {
    cwd: dir,
    env: { ...Bun.env, CLAUDE_CONFIG_DIR: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    proc.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "commands", request: { subtype: "initialize" } })}\n`);
    proc.stdin.flush();
    for await (const event of events(proc.stdout)) {
      const { response } = event;
      if (event.type !== "control_response" || response?.request_id !== "commands") continue;
      if (response.subtype !== "success") throw new Error(`claude refused to list its commands: ${response.error}`);
      return response.response?.commands ?? [];
    }
    throw new Error("claude exited without listing its commands");
  } finally {
    proc.kill();
  }
}

// Settings that keep each request small: no skills synced from claude.ai, and
// built-in skills a chat has little use for kept out of Claude's listing,
// though they still run as slash commands
const SETTINGS = {
  syncClaudeAiSkills: false,
  syncClaudeAiPlugins: false,
  skillOverrides: Object.fromEntries(
    [
      "dataviz",
      "claude-api",
      "run",
      "plugin-authoring",
      "security-review",
      "keybindings-help",
      "fewer-permission-prompts",
      "update-config",
      "loop",
    ].map((name) => [name, "user-invocable-only"]),
  ),
};

// One running `claude` process. It reads turns from stdin until it's closed, so
// the conversation stays loaded between messages; --resume continues an
// earlier one in a new process.
export class Session {
  sessionId: string | undefined;
  // Set by the first init event, which a failed resume never sends
  started = false;
  dead = false;
  // Set by close(), so a process killed on purpose isn't taken for a failed resume
  closed = false;
  private turn: PromiseWithResolvers<Reply> | undefined;
  private onEvent: (event: RawEvent) => void = () => {};
  private ask: Ask | undefined;
  // Permission prompts waiting for an answer, by request id
  private readonly prompts = new Map<string, AbortController>();
  private interrupted = false;
  private readonly stderr: Promise<string>;

  private constructor(
    private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
    readonly resumed: string | undefined,
  ) {
    this.sessionId = resumed;
    // Drained alongside stdout, so a full stderr pipe can't stall the process
    this.stderr = new Response(proc.stderr).text();
    this.read().catch((e) => console.error("failed to read claude output:", e));
  }

  static async start(dir: string, home: string, effort: Effort, mode: PermissionMode, resume?: string): Promise<Session> {
    await mkdir(home, { recursive: true });
    // Tool calls the mode doesn't approve come to stdin as can_use_tool
    // requests, which is how AskUserQuestion is answered
    const args = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
    args.push("--permission-mode", mode, "--permission-prompt-tool", "stdio");
    // Tools a chat in Discord has no use for, left out to keep each request small
    args.push("--disallowedTools", "ReportFindings", "ListAgents", "ScheduleWakeup");
    args.push("--settings", JSON.stringify(SETTINGS));
    args.push("--effort", effort);
    if (resume) args.push("--resume", resume);
    const proc = Bun.spawn(args, {
      cwd: dir,
      // The claude.ai connectors (Claude Docs and the like) ride along on every request otherwise
      env: { ...Bun.env, CLAUDE_CONFIG_DIR: home, ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    return new Session(proc, resume);
  }

  // One turn at a time; resolves with the turn's result, or an error if the
  // process dies. onEvent sees every event of the turn, the result included;
  // ask answers the turn's AskUserQuestion calls.
  send(prompt: string, onEvent: (event: RawEvent) => void = () => {}, ask?: Ask): Promise<Reply> {
    if (this.turn) throw new Error("a turn is already running");
    if (this.dead) return Promise.resolve({ text: "claude is not running", isError: true });
    this.turn = Promise.withResolvers();
    this.onEvent = onEvent;
    this.ask = ask;
    this.write({ type: "user", message: { role: "user", content: prompt } });
    return this.turn.promise;
  }

  close() {
    this.closed = true;
    this.proc.kill();
  }

  // Ends the running turn, as Esc does in the terminal. Claude cancels any
  // permission prompt the turn is waiting on.
  interrupt() {
    if (!this.turn || this.interrupted) return;
    this.interrupted = true;
    this.write({ type: "control_request", request_id: crypto.randomUUID(), request: { subtype: "interrupt" } });
  }

  private write(message: object) {
    try {
      this.proc.stdin.write(`${JSON.stringify(message)}\n`);
      this.proc.stdin.flush();
    } catch {
      // The process is exiting; read() ends the turn once it has
    }
  }

  // Answers a permission prompt. Only AskUserQuestion is answered; anything
  // else the mode didn't approve is denied, as nobody is there to review it.
  private async permit(request_id: string, request: NonNullable<Event["request"]>) {
    let response: object;
    const questions = request.input?.questions;
    if (request.tool_name === "AskUserQuestion" && questions && this.ask) {
      const controller = new AbortController();
      this.prompts.set(request_id, controller);
      try {
        response = { behavior: "allow", updatedInput: { ...request.input, answers: await this.ask(questions, controller.signal) } };
      } catch (e) {
        response = { behavior: "deny", message: `the question could not be asked: ${e}` };
      } finally {
        this.prompts.delete(request_id);
      }
      // A cancelled prompt takes no answer
      if (controller.signal.aborted) return;
    } else {
      response = { behavior: "deny", message: "nobody is available to approve this" };
    }
    this.write({ type: "control_response", response: { subtype: "success", request_id, response } });
  }

  private async read() {
    for await (const event of events(this.proc.stdout)) this.handle(event);
    const code = await this.proc.exited;
    this.dead = true;
    // Questions still waiting can't be answered anymore
    for (const prompt of this.prompts.values()) prompt.abort();
    const stderr = (await this.stderr).trim();
    if (this.closed) this.finish({ text: "Session closed.", isError: false });
    else this.finish({ text: stderr || `claude exited with code ${code}`, isError: true });
  }

  private handle(event: Event) {
    if (this.turn) this.onEvent(event);
    if (event.type === "control_request" && event.request?.subtype === "can_use_tool") {
      this.permit(event.request_id!, event.request).catch((e) => console.error("failed to answer a permission prompt:", e));
    } else if (event.type === "control_cancel_request") {
      this.prompts.get(event.request_id!)?.abort();
    } else if (event.type === "system" && event.subtype === "init") {
      this.started = true;
      this.sessionId = event.session_id;
    } else if (event.type === "result") {
      const text = event.result ?? event.errors?.join("\n") ?? "";
      // An interrupted turn ends in an error that only carries diagnostics
      this.finish(this.interrupted ? { text: "Interrupted.", isError: false } : { text, isError: event.is_error ?? false });
    }
  }

  private finish(reply: Reply) {
    this.turn?.resolve(reply);
    this.turn = undefined;
    this.interrupted = false;
  }
}
