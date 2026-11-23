// check.ts: the practice set on your own machine.
//
//   node check.ts [practice.json] [family ...]
//
// Reads the kit's practice checks (program/generator/practice.json), runs
// main.ts on each one in a fresh directory holding exactly the check's
// files, with the check's standard input, and compares the exit code, the
// stdout and every file afterwards with what the house's reference did.
// It prints every check main.ts gets wrong, with what differed, and the
// practice score. With family names after the path it runs only those
// families (for example: node check.ts ../program/generator/practice.json
// u-offset s-basic).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const KIT_DIR = "/home/hatch/workspace/makefun/kits/hidden-spec-cli-01-run-20261122-kit";

const practicePath = process.argv[2] ?? path.join(KIT_DIR, "program/generator/practice.json");
const onlyFamilies = new Set(process.argv.slice(3));
const mainTs = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.ts");

interface PracticeCheck {
  key: string;
  group: string;
  family: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
  expect: { exit: number; stdout: string; changes: Record<string, string | null> };
}

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
  return out;
}

function sortedJson(o: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(o).sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")))) {
    sorted[k] = o[k];
  }
  return JSON.stringify(sorted);
}

const data = JSON.parse(fs.readFileSync(practicePath, "utf8")) as { checks: PracticeCheck[] };

let passed = 0;
let total = 0;
const byGroup = new Map<string, { pass: number; total: number }>();

for (const check of data.checks) {
  if (onlyFamilies.size > 0 && !onlyFamilies.has(check.family)) continue;
  total++;
  const g = byGroup.get(check.group) ?? { pass: 0, total: 0 };
  g.total++;
  byGroup.set(check.group, g);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-practice-"));
  try {
    for (const [rel, content] of Object.entries(check.files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
    }
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.MAKEFUN_ENV_URL;
    const r = spawnSync(process.execPath, [mainTs, ...check.argv], {
      cwd: dir,
      env,
      input: check.stdin ?? "",
      encoding: "utf8",
      timeout: 10000,
    });
    const gotFiles = readTree(dir);
    const wantFiles: Record<string, string> = { ...check.files };
    for (const [k, v] of Object.entries(check.expect.changes)) {
      if (v === null) delete wantFiles[k];
      else wantFiles[k] = v;
    }
    const exitOk = (r.status ?? -1) === check.expect.exit;
    const outOk = r.stdout === check.expect.stdout;
    const filesOk = sortedJson(gotFiles) === sortedJson(wantFiles);
    if (exitOk && outOk && filesOk) {
      passed++;
      g.pass++;
      continue;
    }
    console.log(`FAIL ${check.family} argv=${JSON.stringify(check.argv)}`);
    if (!exitOk) console.log(`  exit: got ${r.status}, want ${check.expect.exit}`);
    if (!outOk) {
      console.log(`  stdout: got ${JSON.stringify(r.stdout)}`);
      console.log(`  stdout: want ${JSON.stringify(check.expect.stdout)}`);
    }
    if (!filesOk) {
      const keys = new Set([...Object.keys(gotFiles), ...Object.keys(wantFiles)]);
      for (const k of keys) {
        if (gotFiles[k] !== wantFiles[k]) {
          const got = gotFiles[k] === undefined ? "<absent>" : JSON.stringify(gotFiles[k]).slice(0, 400);
          const want = wantFiles[k] === undefined ? "<absent>" : JSON.stringify(wantFiles[k]).slice(0, 400);
          console.log(`  file ${k}:\n    got  ${got}\n    want ${want}`);
        }
      }
    }
    if (r.stderr) console.log(`  stderr: ${String(r.stderr).slice(0, 400)}`);
    if (r.error) console.log(`  spawn error: ${String(r.error).slice(0, 200)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\npassed ${passed}/${total} (score ${total === 0 ? 0 : Math.round((1000 * passed) / total)})`);
for (const [group, v] of [...byGroup.entries()].sort()) {
  console.log(`  ${group}: ${v.pass}/${v.total}`);
}
process.exitCode = passed === total ? 0 : 1;
