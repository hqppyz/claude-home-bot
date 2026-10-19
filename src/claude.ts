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

// One Claude conversation per directory, resumed on every message.
export class ClaudeSession {
  private sessionId: string | undefined;
  // Messages to the same session run one at a time, so --resume never forks
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly home: string,
  ) {}

  send(prompt: string): Promise<Reply> {
    const reply = this.queue.then(() => this.run(prompt));
    this.queue = reply.catch(() => {});
    return reply;
  }

  private async run(prompt: string): Promise<Reply> {
    await mkdir(this.home, { recursive: true });
    const args = ["claude", "-p", prompt, "--output-format", "json"];
    if (this.sessionId) args.push("--resume", this.sessionId);

    const proc = Bun.spawn(args, {
      cwd: this.dir,
      env: { ...Bun.env, CLAUDE_CONFIG_DIR: this.home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    let out: { result?: string; session_id?: string; is_error?: boolean };
    try {
      out = JSON.parse(stdout);
    } catch {
      return { text: stderr.trim() || `claude exited with code ${code}`, isError: true };
    }
    if (out.session_id) this.sessionId = out.session_id;
    return { text: out.result ?? "", isError: out.is_error ?? code !== 0 };
  }
}

const sessions = new Map<string, ClaudeSession>();

export function sessionFor(config: Config, dir: string): ClaudeSession {
  let session = sessions.get(dir);
  if (!session) sessions.set(dir, (session = new ClaudeSession(dir, claudeHome(config))));
  return session;
}
