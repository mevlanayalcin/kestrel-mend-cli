// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
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
  readonly moves: Array<[string, string]> = [];
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
type Tier = 0 | 1 | 2;

interface FileDoc {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

interface BodyOp {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

interface MatchResult {
  tier: Tier;
  positions: number[];
}

function splitFile(text: string): FileDoc {
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

function stripSpaces(s: string): string {
  return s.replace(/^ +| +$/g, '');
}

function normLine(s: string, tier: Tier): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

function leadingSpacesTabs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

function findOccurrences(
  fileLines: string[],
  needle: string[],
  strict: boolean,
  minPos = 0,
  requireEof = false,
): MatchResult | null {
  const k = needle.length;
  if (k === 0) return null;
  const maxPos = fileLines.length - k;
  if (maxPos < minPos) return null;
  const start = requireEof ? maxPos : minPos;
  const maxTier: Tier = strict ? 0 : 2;
  for (let tier = 0 as Tier; tier <= maxTier; tier = (tier + 1) as Tier) {
    const normNeedle = tier === 0 ? needle : needle.map((l) => normLine(l, tier));
    const normFile = tier === 0 ? fileLines : fileLines.map((l) => normLine(l, tier));
    const positions: number[] = [];
    for (let i = start; i <= maxPos; i += 1) {
      let ok = true;
      for (let j = 0; j < k; j += 1) {
        if (normFile[i + j] !== normNeedle[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function reindentLine(line: string, filePrefix: string, patchPrefix: string): string {
  if (blank(line)) return line;
  if (line.startsWith(patchPrefix)) return filePrefix + line.slice(patchPrefix.length);
  return line;
}

function buildReplacement(
  ops: BodyOp[],
  fileLines: string[],
  pos: number,
  oldFirstLine: string,
  tier: Tier,
): string[] {
  const fPrefix = tier === 2 ? leadingSpacesTabs(fileLines[pos]!) : '';
  const pPrefix = tier === 2 ? leadingSpacesTabs(oldFirstLine) : '';
  const out: string[] = [];
  let oIdx = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(fileLines[pos + oIdx]!);
      oIdx += 1;
    } else if (op.kind === 'del') {
      oIdx += 1;
    } else {
      out.push(tier === 2 ? reindentLine(op.text, fPrefix, pPrefix) : op.text);
    }
  }
  return out;
}

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

const HUNK_HDR = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

interface UnifiedHunk {
  oldStart: number;
  ops: BodyOp[];
  lastNewNoEol: boolean;
  addLines: string[];
  lastAddNoEol: boolean;
  hasAdd: boolean;
}

interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  hdrOld: string | null;
  hdrOldNull: boolean;
  hdrNew: string | null;
  hdrNewNull: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDelete: boolean;
  hunks: UnifiedHunk[];
}

function parseUnifiedPath(line: string): { path: string; isNull: boolean } {
  const raw = line.slice(4);
  const tab = raw.indexOf('\t');
  let p = stripSpaces(tab >= 0 ? raw.slice(0, tab) : raw);
  if (p === '/dev/null') return { path: '/dev/null', isNull: true };
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return { path: p, isNull: false };
}

function parseDiffGit(line: string): [string, string] | null {
  const trimmed = line.replace(/ +$/, '');
  if (!trimmed.startsWith('diff --git a/')) return null;
  const rest = trimmed.slice('diff --git a/'.length);
  let fallback: [string, string] | null = null;
  let idx = rest.indexOf(' b/');
  while (idx >= 0) {
    const x = rest.slice(0, idx);
    const y = rest.slice(idx + 3);
    if (x.trim() !== '' && y.trim() !== '') {
      if (x === y) return [x, y];
      if (fallback === null) fallback = [x, y];
    }
    idx = rest.indexOf(' b/', idx + 1);
  }
  return fallback;
}

function applyUnifiedHunks(doc: FileDoc, hunks: UnifiedHunk[], targetPath: string, strict: boolean): void {
  let drift = 0;
  for (const hunk of hunks) {
    const oldLines: string[] = [];
    for (const op of hunk.ops) {
      if (op.kind === 'ctx' || op.kind === 'del') oldLines.push(op.text);
    }
    if (oldLines.length === 0) {
      const addLines = hunk.ops.filter((op) => op.kind === 'add').map((op) => op.text);
      const pos = Math.max(0, Math.min(doc.lines.length, hunk.oldStart + drift));
      const atEnd = pos === doc.lines.length;
      doc.lines.splice(pos, 0, ...addLines);
      if (atEnd) doc.final = !hunk.lastNewNoEol;
      drift += addLines.length;
    } else {
      const res = findOccurrences(doc.lines, oldLines, strict);
      if (res === null) throw new Fail('no-match', targetPath);
      const target = hunk.oldStart - 1 + drift;
      let bestPos = res.positions[0]!;
      let bestDist = Math.abs(bestPos - target);
      for (let k = 1; k < res.positions.length; k += 1) {
        const pos = res.positions[k]!;
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          bestDist = dist;
          bestPos = pos;
        }
      }
      const atEnd = bestPos + oldLines.length === doc.lines.length;
      const rep = buildReplacement(hunk.ops, doc.lines, bestPos, oldLines[0]!, res.tier);
      doc.lines.splice(bestPos, oldLines.length, ...rep);
      if (atEnd) doc.final = !hunk.lastNewNoEol;
      drift += rep.length - oldLines.length;
    }
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const pair = parseDiffGit(line);
      if (pair === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        gitOld: pair[0],
        gitNew: pair[1],
        hdrOld: null,
        hdrOldNull: false,
        hdrNew: null,
        hdrNewNull: false,
        renameFrom: null,
        renameTo: null,
        isNew: false,
        isDelete: false,
        hunks: [],
      };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const hasPlus = i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ');
      if (cur !== null && cur.hunks.length === 0) {
        if (!hasPlus) throw new Exit2(`error: parse ${i + 2}`);
        const oldP = parseUnifiedPath(line);
        const newP = parseUnifiedPath(lines[i + 1]!);
        if (cur.hdrOld === null) {
          cur.hdrOld = oldP.path;
          cur.hdrOldNull = oldP.isNull;
          cur.hdrNew = newP.path;
          cur.hdrNewNull = newP.isNull;
        } else {
          cur = {
            gitOld: null,
            gitNew: null,
            hdrOld: oldP.path,
            hdrOldNull: oldP.isNull,
            hdrNew: newP.path,
            hdrNewNull: newP.isNull,
            renameFrom: null,
            renameTo: null,
            isNew: false,
            isDelete: false,
            hunks: [],
          };
          sections.push(cur);
        }
        i += 2;
        continue;
      }
      if (hasPlus) {
        const oldP = parseUnifiedPath(line);
        const newP = parseUnifiedPath(lines[i + 1]!);
        cur = {
          gitOld: null,
          gitNew: null,
          hdrOld: oldP.path,
          hdrOldNull: oldP.isNull,
          hdrNew: newP.path,
          hdrNewNull: newP.isNull,
          renameFrom: null,
          renameTo: null,
          isNew: false,
          isDelete: false,
          hunks: [],
        };
        sections.push(cur);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HDR.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const oldStart = Number(m[1]);
      i += 1;
      const rawBody: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl === 'diff --git' || bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          rawBody.push(bl);
          i += 1;
        } else {
          break;
        }
      }
      while (rawBody.length > 0 && rawBody[rawBody.length - 1] === '') rawBody.pop();
      const ops: BodyOp[] = [];
      const addLines: string[] = [];
      let lastKind: 'ctx' | 'del' | 'add' | null = null;
      let lastNewNoEol = false;
      let lastAddNoEol = false;
      let hasAdd = false;
      for (const bl of rawBody) {
        if (bl === '') {
          ops.push({ kind: 'ctx', text: '' });
          lastKind = 'ctx';
          lastNewNoEol = false;
        } else if (bl[0] === ' ') {
          ops.push({ kind: 'ctx', text: bl.slice(1) });
          lastKind = 'ctx';
          lastNewNoEol = false;
        } else if (bl[0] === '-') {
          ops.push({ kind: 'del', text: bl.slice(1) });
          lastKind = 'del';
        } else if (bl[0] === '+') {
          const t = bl.slice(1);
          ops.push({ kind: 'add', text: t });
          addLines.push(t);
          lastKind = 'add';
          lastNewNoEol = false;
          lastAddNoEol = false;
          hasAdd = true;
        } else {
          if (lastKind === 'ctx' || lastKind === 'add') lastNewNoEol = true;
          if (lastKind === 'add') lastAddNoEol = true;
          lastKind = null;
        }
      }
      cur.hunks.push({ oldStart, ops, lastNewNoEol, addLines, lastAddNoEol, hasAdd });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = stripSpaces(line.slice('rename from '.length));
      else if (line.startsWith('rename to ')) cur.renameTo = stripSpaces(line.slice('rename to '.length));
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.isNew = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.isDelete = true;
    }
    i += 1;
  }

  const edits: Edit[] = [];
  for (const sec of sections) {
    const oldPath = sec.hdrOld ?? sec.renameFrom ?? sec.gitOld ?? '';
    const newPath = sec.hdrNew ?? sec.renameTo ?? sec.gitNew ?? '';
    if (sec.hdrOldNull || sec.isNew) {
      const addLines: string[] = [];
      let lastAddNoEol = false;
      for (const h of sec.hunks) {
        if (h.hasAdd) {
          addLines.push(...h.addLines);
          lastAddNoEol = h.lastAddNoEol;
        }
      }
      edits.push((tree) => {
        if (!sec.hdrOldNull && oldPath !== '' && !safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        tree.now.set(newPath, joinFile({ br: '\n', lines: addLines, final: !lastAddNoEol }));
      });
    } else if (sec.hdrNewNull || sec.isDelete) {
      edits.push((tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!sec.hdrNewNull && newPath !== '' && !safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      });
    } else if (oldPath !== newPath) {
      const hunks = sec.hunks;
      edits.push((tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const doc = splitFile(before);
        applyUnifiedHunks(doc, hunks, oldPath, strict);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, joinFile(doc));
        tree.moves.push([oldPath, newPath]);
      });
    } else {
      const hunks = sec.hunks;
      edits.push((tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        const doc = splitFile(before);
        applyUnifiedHunks(doc, hunks, oldPath, strict);
        tree.now.set(oldPath, joinFile(doc));
      });
    }
  }
  return edits;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let lastEnd = -1;
  let lastPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let p = searchLine - 1; p > lastEnd; p -= 1) {
      const t = lines[p]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (lastPath !== null) path = lastPath;
      else throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    let sep = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      const m = lines[j]!.trimEnd();
      if (m === '=======') {
        sep = j;
        break;
      }
      if (m === '>>>>>>> REPLACE' || m === '<<<<<<< SEARCH') {
        throw new Exit2(`error: parse ${searchLine + 1}`);
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      const m = lines[j]!.trimEnd();
      if (m === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (m === '<<<<<<< SEARCH') {
        throw new Exit2(`error: parse ${searchLine + 1}`);
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const targetPath = path;
    lastPath = targetPath;
    lastEnd = end;
    i = end + 1;

    edits.push((tree) => {
      if (!safe(targetPath)) throw new Fail('unsafe', targetPath);
      if (oldLines.length === 0) {
        if (tree.get(targetPath) !== null) throw new Fail('exists', targetPath);
        tree.now.set(targetPath, joinFile({ br: '\n', lines: newLines, final: true }));
        return;
      }
      const before = tree.get(targetPath);
      if (before === null) throw new Fail('missing', targetPath);
      const doc = splitFile(before);
      const res = findOccurrences(doc.lines, oldLines, strict);
      if (res === null) throw new Fail('no-match', targetPath);
      if (res.positions.length > 1) throw new Fail('ambiguous', targetPath);
      const pos = res.positions[0]!;
      let rep: string[];
      if (res.tier === 2) {
        const fPrefix = leadingSpacesTabs(doc.lines[pos]!);
        const pPrefix = leadingSpacesTabs(oldLines[0]!);
        rep = newLines.map((l) => reindentLine(l, fPrefix, pPrefix));
      } else {
        rep = newLines;
      }
      doc.lines.splice(pos, oldLines.length, ...rep);
      tree.now.set(targetPath, joinFile(doc));
    });
  }
  return edits;
}

interface V4aChunk {
  anchor: string;
  ops: BodyOp[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  type SecKind = 'add' | 'delete' | 'update';
  interface RawSec {
    kind: SecKind;
    path: string;
    headerLineNo: number;
    body: Array<{ text: string; lineNo: number }>;
  }
  const sections: RawSec[] = [];
  let cur: RawSec | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ')) {
      cur = { kind: 'add', path: stripSpaces(l.slice('*** Add File: '.length)), headerLineNo: i + 1, body: [] };
      sections.push(cur);
    } else if (l.startsWith('*** Delete File: ')) {
      cur = { kind: 'delete', path: stripSpaces(l.slice('*** Delete File: '.length)), headerLineNo: i + 1, body: [] };
      sections.push(cur);
    } else if (l.startsWith('*** Update File: ')) {
      cur = { kind: 'update', path: stripSpaces(l.slice('*** Update File: '.length)), headerLineNo: i + 1, body: [] };
      sections.push(cur);
    } else if (cur === null) {
      if (!blank(l)) throw new Exit2(`error: parse ${i + 1}`);
    } else {
      cur.body.push({ text: l, lineNo: i + 1 });
    }
  }

  const edits: Edit[] = [];
  for (const sec of sections) {
    while (sec.body.length > 0 && blank(sec.body[sec.body.length - 1]!.text)) {
      sec.body.pop();
    }
    if (sec.kind === 'add') {
      const addLines: string[] = [];
      for (const item of sec.body) {
        if (item.text.startsWith('+')) addLines.push(item.text.slice(1));
        else if (item.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${item.lineNo}`);
      }
      const targetPath = sec.path;
      edits.push((tree) => {
        if (!safe(targetPath)) throw new Fail('unsafe', targetPath);
        if (tree.get(targetPath) !== null) throw new Fail('exists', targetPath);
        tree.now.set(targetPath, joinFile({ br: '\n', lines: addLines, final: true }));
      });
    } else if (sec.kind === 'delete') {
      if (sec.body.length > 0) throw new Exit2(`error: parse ${sec.body[0]!.lineNo}`);
      const targetPath = sec.path;
      edits.push((tree) => {
        if (!safe(targetPath)) throw new Fail('unsafe', targetPath);
        if (tree.get(targetPath) === null) throw new Fail('missing', targetPath);
        tree.now.set(targetPath, null);
      });
    } else {
      let idx = 0;
      let moveTo: string | null = null;
      if (idx < sec.body.length && sec.body[idx]!.text.startsWith('*** Move to: ')) {
        moveTo = stripSpaces(sec.body[idx]!.text.slice('*** Move to: '.length));
        idx += 1;
      }
      const chunks: V4aChunk[] = [];
      let curChunk: V4aChunk | null = null;
      for (; idx < sec.body.length; idx += 1) {
        const { text: l, lineNo } = sec.body[idx]!;
        if (l.startsWith('@@')) {
          const anchor = stripSpaces(l.slice(2));
          curChunk = { anchor, ops: [], eof: false };
          chunks.push(curChunk);
        } else if (l.trimEnd() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${lineNo}`);
          curChunk.eof = true;
          curChunk = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (curChunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
            curChunk = { anchor: '', ops: [], eof: false };
            chunks.push(curChunk);
          }
          if (l === '') curChunk.ops.push({ kind: 'ctx', text: '' });
          else if (l[0] === ' ') curChunk.ops.push({ kind: 'ctx', text: l.slice(1) });
          else if (l[0] === '-') curChunk.ops.push({ kind: 'del', text: l.slice(1) });
          else curChunk.ops.push({ kind: 'add', text: l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${lineNo}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${sec.headerLineNo}`);
      }
      const oldPath = sec.path;
      const newPath = moveTo;
      edits.push((tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (newPath !== null && tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const doc = splitFile(before);
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== '') {
            const aRes = findOccurrences(doc.lines, [chunk.anchor], strict, cursor, false);
            if (aRes === null) throw new Fail('no-match', oldPath);
            cursor = aRes.positions[0]! + 1;
          }
          const oldLines: string[] = [];
          for (const op of chunk.ops) {
            if (op.kind === 'ctx' || op.kind === 'del') oldLines.push(op.text);
          }
          if (oldLines.length === 0) {
            const pos = chunk.eof ? doc.lines.length : cursor;
            const rep = chunk.ops.filter((op) => op.kind === 'add').map((op) => op.text);
            doc.lines.splice(pos, 0, ...rep);
            cursor = pos + rep.length;
          } else {
            const res = findOccurrences(doc.lines, oldLines, strict, cursor, chunk.eof);
            if (res === null) throw new Fail('no-match', oldPath);
            const pos = res.positions[0]!;
            const rep = buildReplacement(chunk.ops, doc.lines, pos, oldLines[0]!, res.tier);
            doc.lines.splice(pos, oldLines.length, ...rep);
            cursor = pos + rep.length;
          }
        }
        const out = joinFile(doc);
        if (newPath !== null) {
          tree.now.set(oldPath, null);
          tree.now.set(newPath, out);
          tree.moves.push([oldPath, newPath]);
        } else {
          tree.now.set(oldPath, out);
        }
      });
    }
  }
  return edits;
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const usedD = new Set<string>();
  const usedA = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [oldPath, newPath] of tree.moves) {
    if (
      !usedD.has(oldPath) &&
      !usedA.has(newPath) &&
      tree.original(oldPath) !== null &&
      tree.get(oldPath) === null &&
      tree.original(newPath) === null &&
      tree.get(newPath) !== null
    ) {
      usedD.add(oldPath);
      usedA.add(newPath);
      rows.push({ key: newPath, line: `R ${oldPath} -> ${newPath}` });
    }
  }
  const changed: Array<{ p: string; was: string | null; now: string | null }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ p, was, now });
    if (was === null) {
      if (!usedA.has(p)) rows.push({ key: p, line: `A ${p}` });
    } else if (now === null) {
      if (!usedD.has(p)) rows.push({ key: p, line: `D ${p}` });
    } else {
      rows.push({ key: p, line: `M ${p}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const c of changed) {
      if (c.now === null) {
        rmSync(c.p, { force: true });
        let dir = dirname(c.p);
        while (dir !== '.' && dir !== '') {
          try {
            rmdirSync(dir);
          } catch {
            break;
          }
          dir = dirname(dir);
        }
      }
    }
    for (const c of changed) {
      if (c.now !== null) {
        mkdirSync(dirname(c.p), { recursive: true });
        writeFileSync(c.p, c.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
