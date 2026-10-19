import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";

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

// The subset of stream-json events the bot reads
interface Event {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  errors?: string[];
}

// One running `claude` process. It reads turns from stdin until it's closed, so
// the conversation stays loaded between messages; --resume continues an
// earlier one in a new process.
export class Session {
  sessionId: string | undefined;
  // Set by the first init event, which a failed resume never sends
  started = false;
  dead = false;
  private turn: PromiseWithResolvers<Reply> | undefined;
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

  static async start(dir: string, home: string, resume?: string): Promise<Session> {
    await mkdir(home, { recursive: true });
    const args = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
    if (resume) args.push("--resume", resume);
    const proc = Bun.spawn(args, {
      cwd: dir,
      env: { ...Bun.env, CLAUDE_CONFIG_DIR: home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    return new Session(proc, resume);
  }

  // One turn at a time; resolves with the turn's result, or an error if the process dies
  send(prompt: string): Promise<Reply> {
    if (this.turn) throw new Error("a turn is already running");
    if (this.dead) return Promise.resolve({ text: "claude is not running", isError: true });
    this.turn = Promise.withResolvers();
    try {
      this.proc.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`);
      this.proc.stdin.flush();
    } catch {
      // The process is exiting; read() ends the turn once it has
    }
    return this.turn.promise;
  }

  close() {
    this.proc.kill();
  }

  private async read() {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        let event: Event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        this.handle(event);
      }
    }
    const code = await this.proc.exited;
    this.dead = true;
    const stderr = (await this.stderr).trim();
    this.finish({ text: stderr || `claude exited with code ${code}`, isError: true });
  }

  private handle(event: Event) {
    if (event.type === "system" && event.subtype === "init") {
      this.started = true;
      this.sessionId = event.session_id;
    } else if (event.type === "result") {
      const text = event.result ?? event.errors?.join("\n") ?? "";
      this.finish({ text, isError: event.is_error ?? false });
    }
  }

  private finish(reply: Reply) {
    this.turn?.resolve(reply);
    this.turn = undefined;
  }
}
