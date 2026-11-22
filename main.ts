// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made, in order: used to print `R` lines (section 2). */
  readonly moves: Array<{ old: string; nu: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 5: matching lines at three tiers, and the file line model  */
/* ------------------------------------------------------------------ */

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function normAt(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? trimEndWS(s) : trimWS(s);
}

/** Every position where O occurs in `file` at `tier` (occurrences may overlap). */
function occurrencesAt(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > file.length) return out;
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normAt(file[i + j]!, tier) !== normAt(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs, with its positions, or null when it never does. */
function findTier(file: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(file, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** A file's text as its lines, its line break and whether it ends with one (section 3). */
function fileParts(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(br: string, lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** One line of N: a context line (taken from the file, at O index `ctx`) or an added line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** N with context lines taken from the file and added lines re-indented at tier 2 (section 5). */
function buildNew(nParts: NewLine[], file: string[], pos: number, o: string[], tier: number): string[] {
  const f = tier === 2 && o.length > 0 ? leadWS(file[pos] ?? '') : '';
  const p = tier === 2 && o.length > 0 ? leadWS(o[0]!) : '';
  return nParts.map((nl) => {
    if (nl.ctx !== null) return file[pos + nl.ctx]!;
    const t = nl.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

/** One body line of a unified hunk or a V4A chunk: context, old, new, or a `\` marker. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
}

/** A body split into O (context and old lines) and N (context and new lines), in body order. */
function splitBody(body: BodyLine[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === 'old') o.push(b.text);
    else if (b.kind === 'new') n.push({ text: b.text, ctx: null });
  }
  return { o, n };
}

/** One hunk of a unified diff (section 6). */
interface Hunk {
  a: number;
  body: BodyLine[];
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoNL(h: Hunk): boolean {
  let last = -1;
  h.body.forEach((b, i) => {
    if (b.kind === 'ctx' || b.kind === 'new') last = i;
  });
  return last >= 0 && h.body[last + 1]?.kind === 'mark';
}

/**
 * Apply one hunk to the working lines. `d` is the drift of this section's hunks so far
 * (sum of N length minus O length). Returns the new final-break flag and drift.
 */
function applyHunk(cur: string[], fin: boolean, h: Hunk, d: number, strict: boolean, path: string): { fin: boolean; d: number } {
  const { o, n } = splitBody(h.body);
  if (o.length === 0) {
    const at = Math.min(Math.max(h.a + d, 0), cur.length);
    const atEnd = at === cur.length;
    const ins = n.map((x) => x.text);
    cur.splice(at, 0, ...ins);
    return { fin: atEnd ? !hunkNoNL(h) : fin, d: d + ins.length };
  }
  const found = findTier(cur, o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  for (const pos of found.occ) {
    if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
  }
  const runsToEnd = best + o.length === cur.length;
  const rep = buildNew(n, cur, best, o, found.tier);
  cur.splice(best, o.length, ...rep);
  return { fin: runsToEnd ? !hunkNoNL(h) : fin, d: d + rep.length - o.length };
}

/** Apply a section's hunks in order to a file's text. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const { br, lines, final } = fileParts(before);
  const cur = [...lines];
  let fin = final;
  let d = 0;
  for (const h of hunks) {
    const r = applyHunk(cur, fin, h, d, strict, path);
    fin = r.fin;
    d = r.d;
  }
  return joinFile(br, cur, fin);
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                           */
/* ------------------------------------------------------------------ */

const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface Section {
  oldPath: string | null;
  newPath: string | null;
  oldDevNull: boolean;
  newDevNull: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newSection(oldPath: string | null, newPath: string | null): Section {
  return { oldPath, newPath, oldDevNull: false, newDevNull: false, newFile: false, deletedFile: false, hunks: [] };
}

/** The path a `---`/`+++` line names: up to the first tab, surrounding spaces removed. */
function pairPath(raw: string): { path: string | null; devNull: boolean } {
  const t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return { path: null, devNull: true };
  return { path: t.replace(/^[ab]\//, ''), devNull: false };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec = newSection(m[1]!, m[2]!);
      i = parseSection(lines, i + 1, sec);
      edits.push(unifiedEdit(sec, strict));
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec = newSection(null, null);
      i = parseSection(lines, i, sec);
      edits.push(unifiedEdit(sec, strict));
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return edits;
}

/** Parse one section's header and hunks, starting at `i`; returns where the next section starts. */
function parseSection(lines: string[], i: number, sec: Section): number {
  const n = lines.length;
  let inHeader = true;
  let hasPair = false;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renOld: string | null = null;
  let renNew: string | null = null;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (inHeader) {
        const o = pairPath(line.slice(4));
        const w = pairPath(lines[i + 1]!.slice(4));
        hasPair = true;
        pairOld = o.path;
        sec.oldDevNull = o.devNull;
        pairNew = w.path;
        sec.newDevNull = w.devNull;
        i += 2;
        continue;
      }
      break;
    }
    if (inHeader && line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      i++;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          hunk.body.push(
            b === '' ? { kind: 'ctx', text: '' }
            : b[0] === ' ' ? { kind: 'ctx', text: b.slice(1) }
            : b[0] === '-' ? { kind: 'old', text: b.slice(1) }
            : b[0] === '+' ? { kind: 'new', text: b.slice(1) }
            : { kind: 'mark', text: b.slice(1) },
          );
          i++;
        } else break;
      }
      while (hunk.body.length > 0) {
        const lastB = hunk.body[hunk.body.length - 1]!;
        if (lastB.kind === 'ctx' && lastB.text === '') hunk.body.pop();
        else break;
      }
      sec.hunks.push(hunk);
      continue;
    }
    if (inHeader) {
      if (line.startsWith('rename from ')) {
        renOld = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        renNew = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (hasPair) {
    sec.oldPath = pairOld;
    sec.newPath = pairNew;
  } else {
    if (renOld !== null) sec.oldPath = renOld;
    if (renNew !== null) sec.newPath = renNew;
  }
  return i;
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    if (sec.newFile || sec.oldDevNull) {
      const p = sec.newPath ?? sec.oldPath;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlus: { hunk: Hunk; idx: number } | null = null;
      for (const h of sec.hunks) {
        h.body.forEach((b, bi) => {
          if (b.kind === 'new') {
            plus.push(b.text);
            lastPlus = { hunk: h, idx: bi };
          }
        });
      }
      let fin = true;
      if (lastPlus !== null) fin = lastPlus.hunk.body[lastPlus.idx + 1]?.kind !== 'mark';
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (sec.deletedFile || sec.newDevNull) {
      const p = sec.oldPath ?? sec.newPath;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const result = applyHunks(before, sec.hunks, strict, oldP);
      tree.now.set(newP, result);
      tree.now.set(oldP, null);
      tree.moves.push({ old: oldP, nu: newP });
      return;
    }
    const p = oldP ?? newP;
    if (p === null) return;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                   */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    let j = i + 1;
    while (j < n) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      j++;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    let k = eq + 1;
    while (k < n) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      k++;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let p = searchLine - 1; p > prevEnd; p--) {
      const t = lines[p]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const { br, lines, final } = fileParts(before);
    const found = findTier(lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const rep = buildNew(
      newLines.map((t) => ({ text: t, ctx: null })),
      lines,
      pos,
      oldLines,
      found.tier,
    );
    lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(br, lines, final));
  };
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                             */
/* ------------------------------------------------------------------ */

const trimSpaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');

interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function isV4ASectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (!isV4ASectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'del' : 'upd';
    const prefixLen = kind === 'add' ? '*** Add File: '.length : '*** Delete File: '.length;
    const path = trimSpaces(line.slice(prefixLen));
    const startLine = i + 1;
    i++;
    const raw: Array<{ t: string; ln: number }> = [];
    while (i < last) {
      const b = lines[i]!;
      if (isV4ASectionStart(b)) break;
      raw.push({ t: b, ln: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.t === '') addLines.push('');
        else if (r.t.startsWith('+')) addLines.push(r.t.slice(1));
        else throw new Exit2(`error: parse ${r.ln}`);
      }
      edits.push(v4aAddEdit(path, addLines));
    } else if (kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.ln}`);
      edits.push(v4aDelEdit(path));
    } else {
      let moveTo: string | null = null;
      let j = 0;
      if (raw.length > 0 && raw[0]!.t.startsWith('*** Move to: ')) {
        moveTo = trimSpaces(raw[0]!.t.slice('*** Move to: '.length));
        j = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let sawChunk = false;
      for (; j < raw.length; j++) {
        const r = raw[j]!;
        const t = r.t;
        if (t.startsWith('@@')) {
          const anchor = trimSpaces(t.slice(2));
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(cur);
          sawChunk = true;
        } else if (t.trim() === '*** End of File') {
          if (cur !== null) {
            cur.eof = true;
            cur = null;
          } else {
            chunks.push({ anchor: null, body: [], eof: true });
            sawChunk = true;
          }
        } else if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
          if (cur === null) {
            if (!sawChunk) {
              cur = { anchor: null, body: [], eof: false };
              chunks.push(cur);
              sawChunk = true;
            } else {
              throw new Exit2(`error: parse ${r.ln}`);
            }
          }
          cur.body.push(t === '' ? { kind: 'ctx', text: '' } : t[0] === ' ' ? { kind: 'ctx', text: t.slice(1) } : t[0] === '-' ? { kind: 'old', text: t.slice(1) } : { kind: 'new', text: t.slice(1) });
        } else {
          throw new Exit2(`error: parse ${r.ln}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

function v4aAddEdit(path: string, addLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
  };
}

function v4aDelEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** The first line at or after `cursor` equal to `anchor` at the first tier with one, or -1. */
function findAnchor(file: string[], anchor: string, cursor: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i < file.length; i++) {
      if (normAt(file[i]!, t) === normAt(anchor, t)) return i;
    }
  }
  return -1;
}

/**
 * The first occurrence of O at or after `cursor`, at the first tier with one; an end-of-file
 * chunk takes only an occurrence ending at the file's last line. Null when there is none.
 */
function findFrom(file: string[], o: string[], cursor: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (const pos of occurrencesAt(file, o, t)) {
      if (pos < cursor) continue;
      if (eof && pos + o.length !== file.length) continue;
      return { tier: t, pos };
    }
  }
  return null;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const { br, lines, final } = fileParts(before);
    const cur = [...lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(cur, ch.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = splitBody(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? cur.length : cursor;
        const ins = n.map((x) => x.text);
        cur.splice(at, 0, ...ins);
        cursor = at + ins.length;
      } else {
        const found = findFrom(cur, o, cursor, strict, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const rep = buildNew(n, cur, found.pos, o, found.tier);
        cur.splice(found.pos, o.length, ...rep);
        cursor = found.pos + rep.length;
      }
    }
    const result = joinFile(br, cur, final);
    if (moveTo !== null) {
      tree.now.set(moveTo, result);
      tree.now.set(path, null);
      tree.moves.push({ old: path, nu: moveTo });
    } else {
      tree.now.set(path, result);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines, strict) : kind === 'search-replace' ? parseSearchReplace(lines, strict) : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const sortedNow = [...tree.now.keys()].sort(byteCmp);
  // A move whose old path existed before the patch and is gone after it, and whose new path did not
  // exist before it and does after it, is one `R` line (section 2) instead of a `D` and an `A`.
  const rByNew = new Map<string, string>();
  const rOld = new Set<string>();
  for (const m of tree.moves) {
    if (rByNew.has(m.nu) || rOld.has(m.old)) continue;
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.nu) === null && tree.get(m.nu) !== null) {
      rByNew.set(m.nu, m.old);
      rOld.add(m.old);
    }
  }
  const out: Array<{ key: string; line: string }> = [];
  for (const p of sortedNow) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOld.has(p)) continue;
    if (rByNew.has(p)) out.push({ key: p, line: `R ${rByNew.get(p)} -> ${p}` });
    else out.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  out.sort((a, b) => byteCmp(a.key, b.key));
  const rows = out.map((r) => r.line);
  if (!check) {
    for (const p of sortedNow) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
