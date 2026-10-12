import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterConfig } from './config';
import { detectAdapter } from './config';
import { enumerate } from './enumerate';

// Deterministic prep for the Storybook coverage pass (code, no AI). This is a
// COVERAGE-GAP check — does every prop a component declares get exercised by
// at least one story — not a "is this a good story" quality opinion. The
// regex-based extraction below is necessarily heuristic (no type-checker, no
// JSX runtime), so it only produces CANDIDATE gaps; STORYBOOK_COVERAGE.md (the
// AI pass) reads the real source for each pair and decides which are genuine
// before anything is reported.

const BATCH_SIZE = 10;

// Standard passthrough props every component accepts whether or not a story
// bothers to set them explicitly — flagging these as "uncovered" would just
// be noise, not a real coverage gap.
const IGNORED_PROPS = new Set(['className', 'style', 'children', 'id', 'key', 'ref', 'data-testid', 'testID']);

export interface StorybookPair {
  pairId: string;
  component: string; // repo-relative
  story: string; // repo-relative
}

// A story file `Foo.stories.tsx` is paired with its sibling component file
// (same base name, same directory) if that component file was also enumerated
// as application source. No pairing is attempted across directories — a
// colocated story is the only convention this adapter assumes.
export function findStorybookPairs(repoRoot: string, cfg: AdapterConfig): StorybookPair[] {
  const { files } = enumerate(repoRoot, cfg);
  const sourceByPath = new Set(files.filter((f) => f.role === 'source' || f.role === 'entry').map((f) => f.path));
  const stories = files.filter((f) => f.role === 'story');

  const pairs: StorybookPair[] = [];
  for (const story of stories) {
    const componentPath = story.path.replace(/\.stories(\.(t|j)sx?)$/, '$1');
    if (componentPath === story.path) continue; // didn't match the expected suffix
    if (!sourceByPath.has(componentPath)) continue;
    pairs.push({ pairId: `pair-${pairs.length}`, component: componentPath, story: story.path });
  }
  return pairs;
}

// Finds the first `interface <X>Props { ... }` or `type <X>Props = { ... }`
// block and extracts its top-level member names. Brace-counting (not a single
// regex) because prop types are commonly nested objects/unions.
export function extractPropsFromComponent(text: string): string[] {
  const declMatch = text.match(/(?:interface|type)\s+\w*Props\b[^{]*\{/);
  if (!declMatch || declMatch.index === undefined) return [];

  const start = declMatch.index + declMatch[0].length;
  let depth = 1;
  let end = start;
  for (; end < text.length && depth > 0; end++) {
    if (text[end] === '{') depth++;
    else if (text[end] === '}') depth--;
  }
  const body = text.slice(start, end - 1);

  // Members are commonly separated by `;`/`,` on a single line as often as by
  // newlines (both `interface Foo { a: string; b: string }` and the
  // one-per-line style appear in practice) — match on either delimiter rather
  // than assuming one member per line.
  const props = new Set<string>();
  const memberRe = /(?:^|[{;,])\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = memberRe.exec(body))) props.add(m[1]);
  return [...props];
}

// Extracts the union of prop keys set in any `args: { ... }` block across all
// CSF3 stories in the file, plus a rough count of how many stories exist.
export function extractExercisedPropsFromStory(text: string): { exercisedProps: string[]; variantCount: number } {
  const exercised = new Set<string>();
  const argsBlockRe = /\bargs\s*:\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = argsBlockRe.exec(text))) {
    const keyRe = /([A-Za-z_$][\w$]*)\s*:/g;
    let k: RegExpExecArray | null;
    while ((k = keyRe.exec(m[1]))) exercised.add(k[1]);
  }
  const variantCount = (text.match(/^\s*export const \w+/gm) ?? []).length;
  return { exercisedProps: [...exercised], variantCount };
}

export interface StorybookCoverageCandidate extends StorybookPair {
  declaredProps: string[];
  exercisedProps: string[];
  uncoveredProps: string[];
  variantCount: number;
}

export interface StorybookCoverageBatch {
  batchId: string;
  pairIds: string[];
}

export interface StorybookCoverageInput {
  pairsWithGaps: StorybookCoverageCandidate[];
  batches: StorybookCoverageBatch[];
  pairsScanned: number;
}

export function buildStorybookCoverageInput(repoRoot: string, cfg: AdapterConfig): StorybookCoverageInput {
  const pairs = findStorybookPairs(repoRoot, cfg);
  const candidates: StorybookCoverageCandidate[] = [];

  for (const pair of pairs) {
    let componentText: string;
    let storyText: string;
    try {
      componentText = readFileSync(join(repoRoot, pair.component), 'utf8');
      storyText = readFileSync(join(repoRoot, pair.story), 'utf8');
    } catch {
      continue; // listed by enumerate but unreadable now — skip rather than fail the whole prep
    }

    const declaredProps = extractPropsFromComponent(componentText).filter((p) => !IGNORED_PROPS.has(p));
    if (!declaredProps.length) continue; // no Props type found — nothing to compare

    const { exercisedProps, variantCount } = extractExercisedPropsFromStory(storyText);
    const exercisedSet = new Set(exercisedProps);
    const uncoveredProps = declaredProps.filter((p) => !exercisedSet.has(p));
    if (!uncoveredProps.length) continue; // fully covered — nothing for the AI pass to judge

    candidates.push({ ...pair, declaredProps, exercisedProps, uncoveredProps, variantCount });
  }

  const batches: StorybookCoverageBatch[] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    batches.push({ batchId: `storybook-batch-${batches.length}`, pairIds: candidates.slice(i, i + BATCH_SIZE).map((c) => c.pairId) });
  }

  return { pairsWithGaps: candidates, batches, pairsScanned: pairs.length };
}

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');
  const cfg: AdapterConfig = detectAdapter(repoRoot);

  const input = buildStorybookCoverageInput(repoRoot, cfg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'storybook-coverage-input.json'), JSON.stringify(input, null, 2));
  console.log(
    `[cqa] storybook-coverage-input.json: ${input.pairsScanned} component/story pair(s) found, ${input.pairsWithGaps.length} with a candidate prop gap, batched into ${input.batches.length} group(s)`
  );
}

if (require.main === module) {
  main();
}
