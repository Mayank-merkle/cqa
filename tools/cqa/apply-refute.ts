import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface RefuteVerdict {
  id: string;
  result: 'STANDS' | 'REFUTED';
  rationale: string;
}

const readJSON = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));

export function partitionByRefutation(ids: string[], verdicts: RefuteVerdict[]) {
  const vMap = new Map(verdicts.map((v) => [v.id, v]));
  const stands: string[] = [];
  const refuted: { id: string; rationale: string }[] = [];
  for (const id of ids) {
    const v = vMap.get(id);
    if (v?.result === 'REFUTED') refuted.push({ id, rationale: v.rationale });
    else stands.push(id); // no verdict or STANDS — doubt favors keeping it
  }
  return { stands, refuted };
}

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');
  const input: { id: string }[] = readJSON(join(dir, 'refute-input.json'));
  const verdicts: RefuteVerdict[] = readJSON(join(dir, 'refute-verdicts.json'));

  const { stands, refuted } = partitionByRefutation(input.map((i) => i.id), verdicts);

  writeFileSync(join(dir, 'refute-result.json'), JSON.stringify({ stands, refuted }, null, 2));
  console.log(`[cqa] refutation: ${stands.length} stand, ${refuted.length} refuted and should be downgraded/dropped from the report`);
}

// Guard so importing partitionByRefutation (e.g. from a test) doesn't also
// run main() and hit the filesystem — main() only runs when this file is
// executed directly (matches the pattern in apply-discovery-verdicts.ts).
if (require.main === module) {
  main();
}
