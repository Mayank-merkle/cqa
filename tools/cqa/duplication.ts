// Exact/near-duplicate code block detection. Closes the `notMeasured:
// 'Exact duplication %'` gap that has existed in every stack's AdapterConfig
// since the scorer was written — this module is what actually measures it.
//
// Works identically for a single workspace (pass its own files) and across
// an entire monorepo (pass every matched workspace's files, tagged with
// `workspace`) — there is no separate "cross-workspace" algorithm, just a
// different input set. `monorepo.ts` is what supplies the multi-workspace
// input; a single-package run can call this directly with one workspace's
// files (not yet wired into the single-package pipeline — see PLAN.md).
//
// Deliberately exact-text matching (post-normalization), not semantic/
// renamed-identifier matching — "Exact duplication %" is the term already
// used in config.ts's `notMeasured`, and a simple hash-of-normalized-lines
// approach is enough to catch copy-pasted blocks, which is the common case
// worth flagging. A renamed-variable near-duplicate is a different, harder
// problem left for a future version.

export interface FileInput {
  workspace?: string; // omitted for a single-workspace run
  file: string; // repo- or workspace-relative path
  text: string; // raw file contents
}

export interface DuplicateLocation {
  workspace?: string;
  file: string;
  startLine: number; // 1-indexed, inclusive
  endLine: number; // 1-indexed, inclusive
}

export interface DuplicateBlock {
  lines: number; // length of the duplicated span (equal on both sides, by construction)
  locations: [DuplicateLocation, DuplicateLocation];
}

const DEFAULT_WINDOW = 6;
// Caps how many locations a single hash is allowed to fan out into pairwise
// comparisons. A hash this common is almost always trivial boilerplate
// (e.g. a run of closing braces) rather than a meaningful duplicate — without
// this cap, a hash shared by H locations produces O(H^2) pairs, which is
// also a real performance cliff on a large monorepo's worth of files.
const MAX_LOCATIONS_PER_HASH = 50;

// Lines common enough across unrelated files that treating them as
// duplication evidence would be pure noise (import blocks, bare braces,
// directive prologues) rather than the copy-pasted logic this exists to
// surface. Best-effort denylist, not exhaustive.
const BOILERPLATE_LINE = /^(import\s|export\s+\*\s+from\s|['"]use strict['"];?$|[{}();,]+$)/;

function isCommentLine(line: string): boolean {
  return line.startsWith('//') || line.startsWith('*') || line.startsWith('/*');
}

interface NormalizedLine {
  text: string;
  originalLine: number; // 1-indexed line number in the source file
}

function normalize(text: string): NormalizedLine[] {
  const raw = text.split(/\r?\n/);
  const out: NormalizedLine[] = [];
  for (let i = 0; i < raw.length; i++) {
    const trimmed = raw[i].trim();
    if (!trimmed || isCommentLine(trimmed) || BOILERPLATE_LINE.test(trimmed)) continue;
    out.push({ text: trimmed, originalLine: i + 1 });
  }
  return out;
}

// Same djb2-style hash as collectors.ts's `hash()` — not shared/imported
// across the two files since each is a tiny, self-contained pure function
// and the two call sites have no other coupling worth introducing.
function hashLines(lines: string[]): string {
  const s = lines.join('\n');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

interface WindowLocation {
  fileIdx: number;
  windowStart: number; // index into that file's normalized-line array
}

interface PairMatch {
  aIdx: number;
  aStart: number;
  bIdx: number;
  bStart: number;
}

// Every pairwise co-occurrence implied by the hash index. A hash shared by
// 3+ locations (an N-way duplicate) is reported as multiple pairwise blocks
// (A-B, A-C, B-C) rather than one N-location block — simpler and still
// fully actionable; true N-way unification is a documented known limit.
function collectPairMatches(byHash: Map<string, WindowLocation[]>): PairMatch[] {
  const pairs: PairMatch[] = [];
  for (const locs of byHash.values()) {
    if (locs.length < 2 || locs.length > MAX_LOCATIONS_PER_HASH) continue;
    for (let i = 0; i < locs.length; i++) {
      for (let j = i + 1; j < locs.length; j++) {
        const a = locs[i];
        const b = locs[j];
        if (a.fileIdx === b.fileIdx && a.windowStart === b.windowStart) continue;
        const swap = b.fileIdx < a.fileIdx || (a.fileIdx === b.fileIdx && b.windowStart < a.windowStart);
        const [first, second] = swap ? [b, a] : [a, b];
        pairs.push({ aIdx: first.fileIdx, aStart: first.windowStart, bIdx: second.fileIdx, bStart: second.windowStart });
      }
    }
  }
  return pairs;
}

interface Run {
  aIdx: number;
  bIdx: number;
  aStart: number;
  aEnd: number; // inclusive, in window-index space
  bStart: number;
}

// Merges consecutive matching windows between the same pair of locations
// (same two files, same offset, window start advancing by exactly 1 on both
// sides) into one contiguous run, so a 40-line duplicated function reports
// as one block instead of ~35 overlapping 6-line windows.
function mergeRuns(pairs: PairMatch[]): Run[] {
  const byKey = new Map<string, PairMatch[]>();
  for (const p of pairs) {
    const key = `${p.aIdx}:${p.bIdx}:${p.aStart - p.bStart}`;
    const list = byKey.get(key) ?? [];
    list.push(p);
    byKey.set(key, list);
  }

  const runs: Run[] = [];
  for (const list of byKey.values()) {
    list.sort((x, y) => x.aStart - y.aStart);
    let runStartA = list[0].aStart;
    let runStartB = list[0].bStart;
    let prevA = list[0].aStart;
    const flush = (endA: number) => runs.push({ aIdx: list[0].aIdx, bIdx: list[0].bIdx, aStart: runStartA, aEnd: endA, bStart: runStartB });
    for (let k = 1; k < list.length; k++) {
      if (list[k].aStart === prevA + 1) {
        prevA = list[k].aStart;
        continue;
      }
      flush(prevA);
      runStartA = list[k].aStart;
      runStartB = list[k].bStart;
      prevA = list[k].aStart;
    }
    flush(prevA);
  }
  return runs;
}

export function findDuplicateBlocks(files: FileInput[], windowSize: number = DEFAULT_WINDOW): DuplicateBlock[] {
  const indexed = files.map((f) => {
    const norm = normalize(f.text);
    const hashes: string[] = [];
    for (let i = 0; i + windowSize <= norm.length; i++) {
      hashes.push(hashLines(norm.slice(i, i + windowSize).map((l) => l.text)));
    }
    return { input: f, norm, hashes };
  });

  const byHash = new Map<string, WindowLocation[]>();
  indexed.forEach((fi, fileIdx) => {
    fi.hashes.forEach((h, windowStart) => {
      const list = byHash.get(h) ?? [];
      list.push({ fileIdx, windowStart });
      byHash.set(h, list);
    });
  });

  const runs = mergeRuns(collectPairMatches(byHash));

  const toLocation = (fileIdx: number, windowStart: number, windowEnd: number): DuplicateLocation => {
    const fi = indexed[fileIdx];
    return {
      workspace: fi.input.workspace,
      file: fi.input.file,
      startLine: fi.norm[windowStart].originalLine,
      endLine: fi.norm[windowEnd + windowSize - 1].originalLine,
    };
  };

  const blocks: DuplicateBlock[] = runs.map((r) => {
    const bEnd = r.bStart + (r.aEnd - r.aStart);
    const locA = toLocation(r.aIdx, r.aStart, r.aEnd);
    const locB = toLocation(r.bIdx, r.bStart, bEnd);
    return { lines: locA.endLine - locA.startLine + 1, locations: [locA, locB] };
  });

  blocks.sort((a, b) => b.lines - a.lines);
  return blocks;
}
