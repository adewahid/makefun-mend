// runner.ts: the trial runner for mend.
//
// When main.ts runs with MAKEFUN_ENV_URL set, it hands over here. The
// runner reads the trial's checks (GET $MAKEFUN_ENV_URL/checks), runs
// `node main.ts` on each one in a fresh directory holding exactly the
// check's files, with the check's standard input and without
// MAKEFUN_ENV_URL, and posts what it did (POST $MAKEFUN_ENV_URL/results):
// its exit code, its stdout and every regular file in the directory
// afterwards. Each run has 10 seconds; one still running then is stopped
// and reported as exit 124.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

interface Check {
  id: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
}

interface Result {
  id: string;
  exit: number;
  stdout: string;
  files: Record<string, string>;
}

// Every regular file under a directory, paths relative to it, keys in
// byte order.
function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, prefix: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = prefix ? prefix + "/" + e.name : e.name;
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) out[rel] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir, "");
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(out).sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")))) {
    sorted[k] = out[k];
  }
  return sorted;
}

// One run of main.ts on one check. The child gets no MAKEFUN_ENV_URL, so
// it runs as the CLI instead of handing over again.
function runOne(mainTs: string, dir: string, check: Check): Promise<Result> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.MAKEFUN_ENV_URL;
    const child = spawn(process.execPath, [mainTs, ...check.argv], {
      cwd: dir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let done = false;
    const settle = (exit: number): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ id: check.id, exit, stdout, files: readTree(dir) });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(124);
    }, 10000);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    // A child that exits before reading its stdin closes the pipe; that
    // must not fail the runner.
    child.stdin.on("error", () => {});
    child.stdin.end(check.stdin ?? "");
    child.on("error", () => settle(1));
    child.on("close", (code) => settle(code ?? 1));
  });
}

export async function runRunner(botDir: string): Promise<void> {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
  if (envUrl === "") throw new Error("MAKEFUN_ENV_URL is not set");
  const mainTs = path.join(botDir, "main.ts");
  const res = await fetch(`${envUrl}/checks`);
  if (!res.ok) throw new Error(`GET /checks failed: ${res.status}`);
  const data = (await res.json()) as { checks: Check[] };
  const results: Result[] = [];
  for (const check of data.checks) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-check-"));
    try {
      for (const [rel, content] of Object.entries(check.files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, "utf8");
      }
      results.push(await runOne(mainTs, dir, check));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  for (let i = 0; i < results.length; i += 10) {
    const batch = results.slice(i, i + 10);
    const post = await fetch(`${envUrl}/results`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ results: batch }),
    });
    if (!post.ok) throw new Error(`POST /results failed: ${post.status} ${await post.text()}`);
  }
}
