// mend: one patch tool for every AI edit format.
//
// Applies a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON edits) to the tree of text files in the working
// directory. SPEC.md is the whole contract: every file is changed or
// nothing is, and the output is exactly what SPEC.md says.
//
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// With MAKEFUN_ENV_URL set, this hands over to runner.ts, which runs the
// trial's checks through this file and posts the results.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Small types and helpers
// ---------------------------------------------------------------------------

class ParseError extends Error {
  readonly line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

type Tree = Map<string, string>; // path -> full text
type Moves = Map<string, string>; // move destination -> original source

interface Edit {
  run: (tree: Tree, moves: Moves, strict: boolean) => string | null;
}

// A path is safe when it is not empty, does not start with `/`, holds no
// `\`, and none of its `/`-separated segments is empty, `.` or `..`.
function isSafePath(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.includes("\\")) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

// Byte order of paths (UTF-8), for sorting output lines.
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// Patch lines: the text split at `\n`, each with one trailing `\r`
// removed, and without the empty piece after a final `\n`.
function patchLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith("\r")) parts[i] = parts[i].slice(0, -1);
  }
  if (text.endsWith("\n")) parts.pop();
  return parts;
}

// ---------------------------------------------------------------------------
// Files: lines, line break, final break
// ---------------------------------------------------------------------------

interface FileLines {
  lines: string[];
  brk: string; // "\n" or "\r\n"
  endsWith: boolean; // the text ends with its line break
}

function parseFile(text: string): FileLines {
  let brk = "\n";
  const firstLf = text.indexOf("\n");
  if (firstLf > 0 && text[firstLf - 1] === "\r") brk = "\r\n";
  if (text === "") return { lines: [], brk, endsWith: false };
  const parts = text.split(brk);
  let endsWith = false;
  if (text.endsWith(brk)) {
    endsWith = true;
    parts.pop();
  }
  return { lines: parts, brk, endsWith };
}

function serializeFile(f: FileLines): string {
  if (f.lines.length === 0) return "";
  return f.lines.join(f.brk) + (f.endsWith ? f.brk : "");
}

// The leading spaces and tabs of a line.
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : "";
}

// The surrounding spaces and tabs of a line removed (paths and anchors
// are read this way).
function trimSpaces(s: string): string {
  return s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

function stripTrailingWs(s: string): string {
  return s.replace(/[ \t]+$/, "");
}

function stripBothWs(s: string): string {
  return s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

// ---------------------------------------------------------------------------
// Matching lines at three tiers (SPEC section 5)
// ---------------------------------------------------------------------------

function lineEqAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingWs(a) === stripTrailingWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

// Every position where pat occurs in file at the given tier, at or after
// `from`. Occurrences may overlap.
function occurrences(file: string[], pat: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = from; i + pat.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (!lineEqAt(file[i + j], pat[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// The first tier (0, then 1, then 2; only 0 with --strict) at which pat
// occurs at least once at or after `from`, with its occurrences.
function findTier(
  file: string[],
  pat: string[],
  from: number,
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(file, pat, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Building the replacement lines
// ---------------------------------------------------------------------------

// One line of N: a context line (written as the file's own matched line,
// `ctx` is its index inside O) or a new line (`ctx` null).
interface NewLine {
  text: string;
  ctx: number | null;
}

// Turn N into the lines that replace the matched lines at `pos`. At tier 2
// every other line of N is re-indented from O's first line's leading
// whitespace to the file's first matched line's.
function buildNewLines(
  file: string[],
  pos: number,
  nLines: NewLine[],
  tier: number,
  oFirst: string,
): string[] {
  const out: string[] = [];
  let f = "";
  let p = "";
  if (tier === 2) {
    f = leadingWs(file[pos] ?? "");
    p = leadingWs(oFirst);
  }
  for (const nl of nLines) {
    if (nl.ctx !== null) {
      out.push(file[pos + nl.ctx]);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && t !== "" && !/^[ \t]+$/.test(t) && t.startsWith(p)) {
      t = f + t.slice(p.length);
    }
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

type BodyKind = "ctx" | "old" | "new" | "back";

interface BodyLine {
  kind: BodyKind;
  text: string;
  // True when the patch line itself was empty (an empty context line).
  // Empty lines at the end of a body are not part of it, while a context
  // line written as ` ` (a space) stays.
  rawEmpty: boolean;
}

interface Hunk {
  a: number; // the -A number of the header
  body: BodyLine[];
}

// A path source: undefined = absent, null = /dev/null (no file).
type PathSrc = string | null | undefined;

interface UniSection {
  pairOld: PathSrc;
  pairNew: PathSrc;
  renOld: PathSrc;
  renNew: PathSrc;
  gitOld: PathSrc;
  gitNew: PathSrc;
  pairSet: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newUniSection(): UniSection {
  return {
    pairOld: undefined,
    pairNew: undefined,
    renOld: undefined,
    renNew: undefined,
    gitOld: undefined,
    gitNew: undefined,
    pairSet: false,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

function isDiffGitLine(line: string): boolean {
  return line === "diff --git" || line.startsWith("diff --git ");
}

// The path after `--- ` / `+++ `: the text after the four characters, up
// to the first tab, with surrounding spaces removed; a leading a/ or b/
// removed; /dev/null means no file (null).
function headerPath(line: string): string | null {
  let p = trimSpaces(line.slice(4).split("\t")[0]);
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  if (p === "/dev/null") return null;
  return p;
}

function resolveUniPath(pair: PathSrc, ren: PathSrc, git: PathSrc): string | null {
  if (pair !== undefined) return pair;
  if (ren !== undefined) return ren;
  if (git !== undefined) return git;
  return null;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let curHunk: Hunk | null = null;

  const closeHunk = (): void => {
    if (!curHunk || !cur) return;
    // Empty lines at the end of a body are not part of it.
    while (curHunk.body.length > 0 && curHunk.body[curHunk.body.length - 1].rawEmpty) {
      curHunk.body.pop();
    }
    cur.hunks.push(curHunk);
    curHunk = null;
  };

  const closeSection = (): void => {
    closeHunk();
    if (cur) sections.push(cur);
    cur = null;
    inHeader = false;
  };

  const startHunk = (line: string, i: number): void => {
    const m = HUNK_RE.exec(line);
    if (!m) throw new ParseError(i + 1);
    curHunk = { a: parseInt(m[1], 10), body: [] };
    inHeader = false;
  };

  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (curHunk) {
      // Inside a hunk body.
      if (isDiffGitLine(line)) {
        closeHunk();
        continue; // reprocess: a new section, or a parse error
      }
      if (line.startsWith("--- ") && i + 1 < n && lines[i + 1].startsWith("+++ ")) {
        closeHunk();
        continue; // reprocess: a new section
      }
      if (line.startsWith("@@")) {
        closeHunk();
        continue; // reprocess: a new hunk, or a parse error
      }
      if (line === "") {
        curHunk.body.push({ kind: "ctx", text: "", rawEmpty: true });
        i++;
        continue;
      }
      if (line.startsWith(" ")) {
        curHunk.body.push({ kind: "ctx", text: line.slice(1), rawEmpty: false });
        i++;
        continue;
      }
      if (line.startsWith("-")) {
        curHunk.body.push({ kind: "old", text: line.slice(1), rawEmpty: false });
        i++;
        continue;
      }
      if (line.startsWith("+")) {
        curHunk.body.push({ kind: "new", text: line.slice(1), rawEmpty: false });
        i++;
        continue;
      }
      if (line.startsWith("\\")) {
        curHunk.body.push({ kind: "back", text: line, rawEmpty: false });
        i++;
        continue;
      }
      closeHunk();
      continue; // any other line ends the body; reprocess it
    }
    if (cur) {
      if (inHeader) {
        if (isDiffGitLine(line)) {
          const m = DIFF_GIT_RE.exec(line);
          if (!m) throw new ParseError(i + 1);
          closeSection();
          continue; // reprocess: start a new section
        }
        if (line.startsWith("--- ")) {
          if (i + 1 < n && lines[i + 1].startsWith("+++ ")) {
            if (cur.pairSet) {
              closeSection();
              continue; // reprocess: a new section from this pair
            }
            cur.pairOld = headerPath(line);
            cur.pairNew = headerPath(lines[i + 1]);
            cur.pairSet = true;
            i += 2;
            continue;
          }
          // A `--- ` line not followed by a `+++ ` line, inside a
          // section's header, is a parse error at the line after it.
          throw new ParseError(i + 2);
        }
        if (line.startsWith("@@")) {
          startHunk(line, i);
          i++;
          continue;
        }
        if (line.startsWith("rename from ")) {
          cur.renOld = trimSpaces(line.slice("rename from ".length));
          i++;
          continue;
        }
        if (line.startsWith("rename to ")) {
          cur.renNew = trimSpaces(line.slice("rename to ".length));
          i++;
          continue;
        }
        if (line.startsWith("new file mode")) {
          cur.newFile = true;
          i++;
          continue;
        }
        if (line.startsWith("deleted file mode")) {
          cur.deletedFile = true;
          i++;
          continue;
        }
        // `index`, `old mode`, `new mode`, `similarity index`,
        // `dissimilarity index`, `Index:` and any other line: ignored.
        i++;
        continue;
      }
      // Between hunks: a new hunk, a new section, or ignored prose.
      if (line.startsWith("@@")) {
        startHunk(line, i);
        i++;
        continue;
      }
      if (isDiffGitLine(line)) {
        const m = DIFF_GIT_RE.exec(line);
        if (!m) throw new ParseError(i + 1);
        closeSection();
        continue;
      }
      if (line.startsWith("--- ") && i + 1 < n && lines[i + 1].startsWith("+++ ")) {
        closeSection();
        continue;
      }
      i++;
      continue;
    }
    // No section yet.
    if (isDiffGitLine(line)) {
      const m = DIFF_GIT_RE.exec(line);
      if (!m) throw new ParseError(i + 1);
      cur = newUniSection();
      cur.gitOld = m[1];
      cur.gitNew = m[2];
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith("--- ") && i + 1 < n && lines[i + 1].startsWith("+++ ")) {
      cur = newUniSection();
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]);
      cur.pairSet = true;
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith("@@")) throw new ParseError(i + 1); // a hunk before any section
    i++; // prose, code fences and anything else: ignored
  }
  closeSection();

  return sections.map((sec) => ({ run: (tree, moves, strict) => applyUniSection(sec, tree, moves, strict) }));
}

// O is the hunk's context and `-` lines, N its context and `+` lines.
function hunkON(h: Hunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  let oIdx = 0;
  for (const b of h.body) {
    if (b.kind === "ctx") {
      o.push(b.text);
      n.push({ text: b.text, ctx: oIdx });
      oIdx++;
    } else if (b.kind === "old") {
      o.push(b.text);
      oIdx++;
    } else if (b.kind === "new") {
      n.push({ text: b.text, ctx: null });
    }
  }
  return { o, n };
}

// True when a `\` line follows the hunk's last context or `+` line.
function hunkNoBreak(h: Hunk): boolean {
  let last = -1;
  for (let k = 0; k < h.body.length; k++) {
    if (h.body[k].kind === "ctx" || h.body[k].kind === "new") last = k;
  }
  if (last === -1) return false;
  return last + 1 < h.body.length && h.body[last + 1].kind === "back";
}

// Apply a section's hunks, in order, to a file's text. Returns the new
// text, or "no-match" when a hunk's O is found at no tier.
function applyUniHunks(text: string, hunks: Hunk[], strict: boolean): string | null {
  const f = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h);
    if (o.length === 0) {
      const ins = Math.min(h.a + d, f.lines.length);
      const atEnd = ins === f.lines.length;
      const newLines = n.map((nl) => nl.text);
      f.lines.splice(ins, 0, ...newLines);
      if (atEnd) f.endsWith = !hunkNoBreak(h);
      d += n.length;
      continue;
    }
    const found = findTier(f.lines, o, 0, strict);
    if (!found) return null;
    const target = h.a - 1 + d;
    let best = found.occ[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + o.length === f.lines.length;
    const repl = buildNewLines(f.lines, best, n, found.tier, o[0]);
    f.lines.splice(best, o.length, ...repl);
    if (atEnd) f.endsWith = !hunkNoBreak(h);
    d += n.length - o.length;
  }
  return serializeFile(f);
}

function applyUniSection(sec: UniSection, tree: Tree, moves: Moves, strict: boolean): string | null {
  const oldPath = resolveUniPath(sec.pairOld, sec.renOld, sec.gitOld);
  const newPath = resolveUniPath(sec.pairNew, sec.renNew, sec.gitNew);
  // Every path an edit names is checked for safety before anything else.
  if (oldPath !== null && !isSafePath(oldPath)) return `error: unsafe ${oldPath}`;
  if (newPath !== null && !isSafePath(newPath)) return `error: unsafe ${newPath}`;
  const isCreate = oldPath === null || sec.newFile;
  const isDelete = !isCreate && (newPath === null || sec.deletedFile);
  if (isCreate) {
    const p = newPath ?? "";
    if (tree.has(p)) return `error: exists ${p}`;
    const plus: string[] = [];
    for (const h of sec.hunks) {
      for (const b of h.body) if (b.kind === "new") plus.push(b.text);
    }
    // The file ends with a line break unless a `\` line follows its
    // last `+` line.
    let noBreak = false;
    for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
      const h = sec.hunks[hi];
      let lastPlus = -1;
      for (let k = 0; k < h.body.length; k++) if (h.body[k].kind === "new") lastPlus = k;
      if (lastPlus !== -1) {
        noBreak = lastPlus + 1 < h.body.length && h.body[lastPlus + 1].kind === "back";
        break;
      }
    }
    tree.set(p, plus.length === 0 ? "" : plus.join("\n") + (noBreak ? "" : "\n"));
    return null;
  }
  if (isDelete) {
    const p = oldPath ?? "";
    if (!tree.has(p)) return `error: missing ${p}`;
    tree.delete(p);
    moves.delete(p);
    return null;
  }
  const isMove = oldPath !== newPath;
  if (isMove) {
    const op = oldPath ?? "";
    const np = newPath ?? "";
    if (!tree.has(op)) return `error: missing ${op}`;
    if (tree.has(np)) return `error: exists ${np}`;
    const out = applyUniHunks(tree.get(op) as string, sec.hunks, strict);
    if (out === null) return `error: no-match ${op}`;
    tree.delete(op);
    tree.set(np, out);
    if (moves.has(op)) {
      moves.set(np, moves.get(op) as string);
      moves.delete(op);
    } else {
      moves.set(np, op);
    }
    return null;
  }
  const p = oldPath ?? "";
  if (!tree.has(p)) return `error: missing ${p}`;
  const out = applyUniHunks(tree.get(p) as string, sec.hunks, strict);
  if (out === null) return `error: no-match ${p}`;
  tree.set(p, out);
  return null;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1; // index of the previous block's REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== "<<<<<<< SEARCH") {
      i++;
      continue;
    }
    const searchIdx = i;
    // The path is the nearest line before the SEARCH line, and after the
    // previous block's REPLACE line, that is not blank and does not start
    // with three backticks.
    let foundPath: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const t = lines[j].trim();
      if (t === "") continue;
      if (t.startsWith("```")) continue;
      foundPath = t;
      break;
    }
    if (foundPath === null) foundPath = prevPath;
    if (foundPath === null) throw new ParseError(searchIdx + 1);
    // A SEARCH line with no `=======` and then `>>>>>>> REPLACE` after
    // it is a parse error at the SEARCH line.
    let sep = -1;
    let k = searchIdx + 1;
    for (; k < lines.length; k++) {
      const t = lines[k].trimEnd();
      if (t === "=======") {
        sep = k;
        break;
      }
      if (t === ">>>>>>> REPLACE" || t === "<<<<<<< SEARCH") throw new ParseError(searchIdx + 1);
    }
    if (sep === -1) throw new ParseError(searchIdx + 1);
    let end = -1;
    for (k = sep + 1; k < lines.length; k++) {
      const t = lines[k].trimEnd();
      if (t === ">>>>>>> REPLACE") {
        end = k;
        break;
      }
      if (t === "<<<<<<< SEARCH") throw new ParseError(searchIdx + 1);
    }
    if (end === -1) throw new ParseError(searchIdx + 1);
    const block: SRBlock = {
      path: foundPath,
      oldLines: lines.slice(searchIdx + 1, sep),
      newLines: lines.slice(sep + 1, end),
    };
    edits.push({ run: (tree, _moves, strict) => applySRBlock(block, tree, strict) });
    prevPath = foundPath;
    prevReplaceEnd = end;
    i = end + 1;
  }
  return edits;
}

function applySRBlock(block: SRBlock, tree: Tree, strict: boolean): string | null {
  if (!isSafePath(block.path)) return `error: unsafe ${block.path}`;
  if (block.oldLines.length === 0) {
    if (tree.has(block.path)) return `error: exists ${block.path}`;
    tree.set(block.path, block.newLines.length === 0 ? "" : block.newLines.join("\n") + "\n");
    return null;
  }
  if (!tree.has(block.path)) return `error: missing ${block.path}`;
  const f = parseFile(tree.get(block.path) as string);
  const found = findTier(f.lines, block.oldLines, 0, strict);
  if (!found) return `error: no-match ${block.path}`;
  if (found.occ.length > 1) return `error: ambiguous ${block.path}`;
  const pos = found.occ[0];
  const nLines: NewLine[] = block.newLines.map((t) => ({ text: t, ctx: null }));
  const repl = buildNewLines(f.lines, pos, nLines, found.tier, block.oldLines[0]);
  f.lines.splice(pos, block.oldLines.length, ...repl);
  tree.set(block.path, serializeFile(f));
  return null;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null; // null: no anchor
  body: BodyLine[];
  eof: boolean; // ended by `*** End of File`
}

interface V4aSection {
  kind: "add" | "delete" | "update";
  path: string;
  moveTo: string | null;
  fileLines: string[]; // Add File: the section's lines
  chunks: V4aChunk[];
}

interface RawLine {
  text: string;
  no: number; // 1-based patch line number
}

function v4aBodyLine(text: string): BodyLine {
  if (text === "") return { kind: "ctx", text: "", rawEmpty: true };
  if (text.startsWith(" ")) return { kind: "ctx", text: text.slice(1), rawEmpty: false };
  if (text.startsWith("-")) return { kind: "old", text: text.slice(1), rawEmpty: false };
  return { kind: "new", text: text.slice(1), rawEmpty: false }; // starts with "+"
}

function finishV4aUpdate(path: string, raw: RawLine[], headerLine: number): V4aSection {
  const chunks: V4aChunk[] = [];
  let curChunk: V4aChunk | null = null;
  let moveTo: string | null = null;
  for (const { text, no } of raw) {
    if (text.trim() === "") {
      // A blank line inside a chunk is an empty context line; between
      // chunks it is ignored.
      if (curChunk) curChunk.body.push({ kind: "ctx", text: "", rawEmpty: true });
      continue;
    }
    if (text.startsWith("*** Move to: ")) {
      if (curChunk || chunks.length > 0 || moveTo !== null) throw new ParseError(no);
      moveTo = trimSpaces(text.slice("*** Move to: ".length));
      continue;
    }
    if (text === "*** End of File") {
      // A `*** End of File` line ends a chunk; with no chunk in progress
      // it is any other line, a parse error at its line.
      if (!curChunk) throw new ParseError(no);
      curChunk.eof = true;
      chunks.push(curChunk);
      curChunk = null;
      continue;
    }
    if (text.startsWith("@@")) {
      if (curChunk) chunks.push(curChunk);
      const anchorText = trimSpaces(text.slice(2));
      curChunk = { anchor: anchorText === "" ? null : anchorText, body: [], eof: false };
      continue;
    }
    if (text.startsWith(" ") || text.startsWith("-") || text.startsWith("+")) {
      if (!curChunk) {
        if (chunks.length > 0) throw new ParseError(no); // only the first chunk may start at a body line
        curChunk = { anchor: null, body: [], eof: false };
      }
      curChunk.body.push(v4aBodyLine(text));
      continue;
    }
    throw new ParseError(no); // any other line
  }
  if (curChunk) chunks.push(curChunk);
  if (chunks.length === 0 && moveTo === null) throw new ParseError(headerLine);
  return { kind: "update", path, moveTo, fileLines: [], chunks };
}

function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseError(1);
  if (lines[first].trim() !== "*** Begin Patch") throw new ParseError(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== "*** End Patch") throw new ParseError(lines.length + 1);

  const edits: Edit[] = [];
  let cur: { kind: "add" | "delete" | "update"; path: string; raw: RawLine[]; headerLine: number } | null = null;
  const closeSection = (): void => {
    if (!cur) return;
    // Blank lines at the end of a section are not part of it.
    while (cur.raw.length > 0 && cur.raw[cur.raw.length - 1].text.trim() === "") cur.raw.pop();
    if (cur.kind === "add") {
      const fileLines: string[] = [];
      for (const { text, no } of cur.raw) {
        if (text.startsWith("+")) fileLines.push(text.slice(1));
        else if (text === "") fileLines.push("");
        else throw new ParseError(no);
      }
      const sec: V4aSection = { kind: "add", path: cur.path, moveTo: null, fileLines, chunks: [] };
      edits.push({ run: (tree, moves, _strict) => applyV4aSection(sec, tree, moves) });
    } else if (cur.kind === "delete") {
      // A Delete File section has no lines: any line left in it (blank
      // lines at its end were already stripped) is a parse error.
      if (cur.raw.length > 0) throw new ParseError(cur.raw[0].no);
      const sec: V4aSection = { kind: "delete", path: cur.path, moveTo: null, fileLines: [], chunks: [] };
      edits.push({ run: (tree, moves, _strict) => applyV4aSection(sec, tree, moves) });
    } else {
      const sec = finishV4aUpdate(cur.path, cur.raw, cur.headerLine);
      edits.push({ run: (tree, moves, strict) => applyV4aSection(sec, tree, moves, strict) });
    }
    cur = null;
  };

  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === "") {
      if (cur) cur.raw.push({ text: line, no: i + 1 });
      i++;
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      closeSection();
      cur = { kind: "add", path: trimSpaces(line.slice("*** Add File: ".length)), raw: [], headerLine: i + 1 };
      i++;
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      closeSection();
      cur = { kind: "delete", path: trimSpaces(line.slice("*** Delete File: ".length)), raw: [], headerLine: i + 1 };
      i++;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      closeSection();
      cur = { kind: "update", path: trimSpaces(line.slice("*** Update File: ".length)), raw: [], headerLine: i + 1 };
      i++;
      continue;
    }
    if (!cur) throw new ParseError(i + 1); // any other line with no section open
    cur.raw.push({ text: line, no: i + 1 });
    i++;
  }
  closeSection();
  return edits;
}

// The first line at or after `from` equal to the anchor at the first tier
// where one is (both sides a single line).
function findAnchor(file: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < file.length; i++) {
      if (lineEqAt(file[i], anchor, t)) return i;
    }
  }
  return null;
}

function applyV4aSection(sec: V4aSection, tree: Tree, moves: Moves, strict = false): string | null {
  if (sec.kind === "add") {
    if (!isSafePath(sec.path)) return `error: unsafe ${sec.path}`;
    if (tree.has(sec.path)) return `error: exists ${sec.path}`;
    tree.set(sec.path, sec.fileLines.length === 0 ? "" : sec.fileLines.join("\n") + "\n");
    return null;
  }
  if (sec.kind === "delete") {
    if (!isSafePath(sec.path)) return `error: unsafe ${sec.path}`;
    if (!tree.has(sec.path)) return `error: missing ${sec.path}`;
    tree.delete(sec.path);
    moves.delete(sec.path);
    return null;
  }
  // Update File.
  if (!isSafePath(sec.path)) return `error: unsafe ${sec.path}`;
  if (sec.moveTo !== null && !isSafePath(sec.moveTo)) return `error: unsafe ${sec.moveTo}`;
  if (!tree.has(sec.path)) return `error: missing ${sec.path}`;
  if (sec.moveTo !== null && tree.has(sec.moveTo)) return `error: exists ${sec.moveTo}`;
  const f = parseFile(tree.get(sec.path) as string);
  let cursor = 0;
  for (const chunk of sec.chunks) {
    if (chunk.anchor !== null) {
      const a = findAnchor(f.lines, chunk.anchor, cursor, strict);
      if (a === null) return `error: no-match ${sec.path}`;
      cursor = a + 1;
    }
    const { o, n } = hunkON({ a: 0, body: chunk.body });
    if (o.length === 0) {
      const ins = chunk.eof ? f.lines.length : cursor;
      const newLines = n.map((nl) => nl.text);
      f.lines.splice(ins, 0, ...newLines);
      cursor = ins + newLines.length;
      continue;
    }
    // The first occurrence at or after the cursor, at the first tier
    // with one; an end-of-file chunk takes only an occurrence that ends
    // at the file's last line.
    let found: { tier: number; occ: number[] } | null = null;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const t of tiers) {
      let occ = occurrences(f.lines, o, t, cursor);
      if (chunk.eof) occ = occ.filter((p) => p + o.length === f.lines.length);
      if (occ.length > 0) {
        found = { tier: t, occ };
        break;
      }
    }
    if (!found) return `error: no-match ${sec.path}`;
    const pos = found.occ[0];
    const repl = buildNewLines(f.lines, pos, n, found.tier, o[0]);
    f.lines.splice(pos, o.length, ...repl);
    cursor = pos + repl.length;
  }
  const newText = serializeFile(f);
  if (sec.moveTo !== null) {
    tree.delete(sec.path);
    tree.set(sec.moveTo, newText);
    if (moves.has(sec.path)) {
      moves.set(sec.moveTo, moves.get(sec.path) as string);
      moves.delete(sec.path);
    } else {
      moves.set(sec.moveTo, sec.path);
    }
  } else {
    tree.set(sec.path, newText);
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

type JsonEdit =
  | { command: "create"; path: string; file_text: string }
  | { command: "str_replace"; path: string; old_str: string; new_str: string }
  | { command: "insert"; path: string; insert_line: number; new_str: string };

// A wrong command or a missing or mistyped key is a parse fault.
function validateJsonEdit(v: unknown): JsonEdit | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== "string") return null;
  if (typeof o.command !== "string") return null;
  if (o.command === "create") {
    if (typeof o.file_text !== "string") return null;
    return { command: "create", path: o.path, file_text: o.file_text };
  }
  if (o.command === "str_replace") {
    if (typeof o.old_str !== "string" || o.old_str === "") return null;
    if (o.new_str !== undefined && typeof o.new_str !== "string") return null;
    return {
      command: "str_replace",
      path: o.path,
      old_str: o.old_str,
      new_str: typeof o.new_str === "string" ? o.new_str : "",
    };
  }
  if (o.command === "insert") {
    if (typeof o.insert_line !== "number" || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== "string") return null;
    return { command: "insert", path: o.path, insert_line: o.insert_line, new_str: o.new_str };
  }
  return null;
}

function parseJson(lines: string[], rawText: string): Edit[] {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return [];
  if (lines[firstIdx].trimStart().startsWith("[")) {
    // Array form: any fault is a parse error at the line where the array starts.
    let arr: unknown;
    try {
      arr = JSON.parse(rawText);
    } catch {
      throw new ParseError(firstIdx + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(firstIdx + 1);
    const edits: Edit[] = [];
    for (const el of arr) {
      const e = validateJsonEdit(el);
      if (!e) throw new ParseError(firstIdx + 1);
      edits.push({ run: (tree, _moves, _strict) => applyJsonEdit(e, tree) });
    }
    return edits;
  }
  // JSON Lines: a line that does not hold one valid edit object is a
  // parse error at that line.
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      throw new ParseError(i + 1);
    }
    const e = validateJsonEdit(obj);
    if (!e) throw new ParseError(i + 1);
    edits.push({ run: (tree, _moves, _strict) => applyJsonEdit(e, tree) });
  }
  return edits;
}

// new_str's lines: split at `\n`, each with one trailing `\r` removed,
// without the empty piece after a final `\n`; an empty new_str has none.
function splitNewStr(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith("\r")) parts[i] = parts[i].slice(0, -1);
  }
  if (s.endsWith("\n")) parts.pop();
  return parts;
}

function applyJsonEdit(edit: JsonEdit, tree: Tree): string | null {
  if (!isSafePath(edit.path)) return `error: unsafe ${edit.path}`;
  if (edit.command === "create") {
    if (tree.has(edit.path)) return `error: exists ${edit.path}`;
    tree.set(edit.path, edit.file_text);
    return null;
  }
  if (edit.command === "str_replace") {
    if (!tree.has(edit.path)) return `error: missing ${edit.path}`;
    const text = tree.get(edit.path) as string;
    const firstLf = text.indexOf("\n");
    const crlf = firstLf > 0 && text[firstLf - 1] === "\r";
    let hay = text;
    let oldS = edit.old_str;
    let newS = edit.new_str;
    if (crlf) {
      hay = text.replace(/\r\n/g, "\n");
      oldS = oldS.replace(/\r\n/g, "\n");
      newS = newS.replace(/\r\n/g, "\n");
    }
    // Count occurrences; positions may overlap.
    let count = 0;
    let at = -1;
    let pos = 0;
    for (;;) {
      const j = hay.indexOf(oldS, pos);
      if (j === -1) break;
      count++;
      at = j;
      pos = j + 1;
    }
    if (count === 0) return `error: no-match ${edit.path}`;
    if (count > 1) return `error: ambiguous ${edit.path}`;
    let res = hay.slice(0, at) + newS + hay.slice(at + oldS.length);
    if (crlf) res = res.replace(/\n/g, "\r\n");
    tree.set(edit.path, res);
    return null;
  }
  // insert
  if (!tree.has(edit.path)) return `error: missing ${edit.path}`;
  const f = parseFile(tree.get(edit.path) as string);
  if (edit.insert_line < 0 || edit.insert_line > f.lines.length) return `error: no-match ${edit.path}`;
  const insLines = splitNewStr(edit.new_str);
  f.lines.splice(edit.insert_line, 0, ...insLines);
  tree.set(edit.path, serializeFile(f));
  return null;
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === "*** Begin Patch") return "v4a";
  const firstNonWs = lines[first].trimStart()[0];
  if (firstNonWs === "[" || firstNonWs === "{") return "json";
  for (const l of lines) {
    if (l.trimEnd() === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) return "unified";
    if (lines[i].startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) return "unified";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The tree and the run
// ---------------------------------------------------------------------------

// Every regular file under the working directory, paths relative to it.
function loadTree(root: string): Tree {
  const tree: Tree = new Map();
  const walk = (dir: string, prefix: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = prefix ? prefix + "/" + e.name : e.name;
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) tree.set(rel, fs.readFileSync(full, "utf8"));
    }
  };
  walk(root, "");
  return tree;
}

// Write the final tree over the initial one: changed and added files are
// written (directories created as files need them), removed files deleted.
function writeTree(initial: Tree, finalTree: Tree, root: string): void {
  for (const [rel, text] of finalTree) {
    if (initial.get(rel) === text) continue;
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, "utf8");
  }
  for (const rel of initial.keys()) {
    if (!finalTree.has(rel)) fs.unlinkSync(path.join(root, rel));
  }
}

// One output line per path whose state changed, in byte order of the
// paths (an R line sorts by its new path).
function changeLines(initial: Tree, finalTree: Tree, moves: Moves): string[] {
  const rows: { key: string; text: string }[] = [];
  const all = new Set<string>([...initial.keys(), ...finalTree.keys()]);
  for (const p of all) {
    const inInit = initial.has(p);
    const inFinal = finalTree.has(p);
    if (!inInit && inFinal) {
      const origin = moves.get(p);
      if (origin !== undefined && initial.has(origin) && !finalTree.has(origin)) {
        rows.push({ key: p, text: `R ${origin} -> ${p}` });
      } else {
        rows.push({ key: p, text: `A ${p}` });
      }
    } else if (inInit && !inFinal) {
      let covered = false;
      for (const [dest, orig] of moves) {
        if (orig === p && finalTree.has(dest) && !initial.has(dest)) {
          covered = true;
          break;
        }
      }
      if (!covered) rows.push({ key: p, text: `D ${p}` });
    } else if (inInit && inFinal && initial.get(p) !== finalTree.get(p)) {
      rows.push({ key: p, text: `M ${p}` });
    }
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  return rows.map((r) => r.text);
}

// ---------------------------------------------------------------------------
// Command line (SPEC sections 1 and 2)
// ---------------------------------------------------------------------------

interface CliArgs {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

// Returns null on a usage error.
function parseCliArgs(argv: string[]): CliArgs | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let patch: string | null = null;
  let noMoreOptions = false;
  for (const a of argv) {
    if (!noMoreOptions && a === "--") {
      noMoreOptions = true;
      continue;
    }
    if (!noMoreOptions && a.startsWith("-") && a !== "-") {
      if (a === "--check") {
        if (check) return null;
        check = true;
        continue;
      }
      if (a === "--strict") {
        if (strict) return null;
        strict = true;
        continue;
      }
      if (a.startsWith("--format=")) {
        if (format !== null) return null;
        const v = a.slice("--format=".length);
        if (v !== "unified" && v !== "search-replace" && v !== "v4a" && v !== "json" && v !== "auto") return null;
        format = v;
        continue;
      }
      return null; // an argument starting with `-` that is not an option
    }
    if (patch !== null) return null; // more than one positional argument
    patch = a;
  }
  return { format: format ?? "auto", check, strict, patch };
}

function runCli(): number {
  const lines: string[] = [];
  const say = (s: string): void => {
    lines.push(s);
  };
  const finish = (code: number): number => {
    if (lines.length > 0) process.stdout.write(lines.join("\n") + "\n");
    return code;
  };

  const args = parseCliArgs(process.argv.slice(2));
  if (!args) {
    say("error: usage");
    return finish(2);
  }

  let patchText: string;
  if (args.patch === null || args.patch === "-") {
    patchText = fs.readFileSync(0, "utf8");
  } else {
    try {
      patchText = fs.readFileSync(args.patch, "utf8");
    } catch {
      say("error: no-patch");
      return finish(2);
    }
  }
  const linesOfPatch = patchLines(patchText);

  let fmt = args.format;
  if (fmt === "auto") {
    const detected = detectFormat(linesOfPatch);
    if (!detected) {
      say("error: format");
      return finish(2);
    }
    fmt = detected;
  }

  let edits: Edit[];
  try {
    if (fmt === "unified") edits = parseUnified(linesOfPatch);
    else if (fmt === "search-replace") edits = parseSearchReplace(linesOfPatch);
    else if (fmt === "v4a") edits = parseV4a(linesOfPatch);
    else edits = parseJson(linesOfPatch, patchText);
  } catch (e) {
    if (e instanceof ParseError) {
      say(`error: parse ${e.line}`);
      return finish(2);
    }
    throw e;
  }
  // A patch in which the reader finds no edit at all is a parse error.
  if (edits.length === 0) {
    say("error: parse 1");
    return finish(2);
  }

  // Edits apply in the patch's order to the tree as earlier edits left
  // it. A failed edit changes nothing, and the edits after it still run.
  const initial = loadTree(process.cwd());
  const tree: Tree = new Map(initial);
  const moves: Moves = new Map();
  const failures: string[] = [];
  for (const edit of edits) {
    const err = edit.run(tree, moves, args.strict);
    if (err) failures.push(err);
  }
  if (failures.length > 0) {
    for (const f of failures) say(f);
    say(`failed: ${failures.length} of ${edits.length} edits`);
    return finish(1);
  }

  const changed = changeLines(initial, tree, moves);
  if (!args.check) writeTree(initial, tree, process.cwd());
  for (const c of changed) say(c);
  say(changed.length === 1 ? "ok: 1 file" : `ok: ${changed.length} files`);
  return finish(0);
}

async function main(): Promise<void> {
  // A trial hands over to the runner, which reads the trial's checks from
  // the env and runs this file on each one.
  if (process.env.MAKEFUN_ENV_URL) {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const runner = await import("./runner.ts");
    await runner.runRunner(dir);
    return;
  }
  try {
    process.exitCode = runCli();
  } catch (e) {
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exitCode = 2;
  }
}

await main();
