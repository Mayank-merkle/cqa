import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate } from './types';

// Builds the COMPRESSED input for the holistic pass (code, deterministic).
// The holistic pass must reason across the whole codebase without holding it
// in context — so it gets per-unit summaries + a digest of the findings, never
// raw source.

const readJSON = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const tryJSON = (p: string, fallback: any): any => {
  try {
    return existsSync(p) ? readJSON(p) : fallback;
  } catch {
    return fallback;
  }
};

function digest(c: Candidate) {
  return {
    category: c.category,
    dimension: c.dimension,
    severity: c.severity,
    where: c.evidence[0]?.file ?? '',
  };
}

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');

  const summaries: Record<string, string> = tryJSON(join(dir, 'unit-summaries.json'), {});
  const discovery: Candidate[] = tryJSON(join(dir, 'discovery-findings.json'), []);
  const judged = tryJSON(join(dir, 'findings.json'), { confirmed: [], needsContext: [] });

  const input = {
    unitCount: Object.keys(summaries).length,
    moduleMap: Object.entries(summaries).map(([unitId, summary]) => ({ unitId, summary })),
    semanticFindings: discovery.map(digest),
    confirmedFindings: (judged.confirmed ?? []).map((f: Candidate) => digest(f)),
    needsContext: (judged.needsContext ?? []).map((f: Candidate) => ({ category: f.category, where: f.evidence?.[0]?.file ?? '' })),
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'holistic-input.json'), JSON.stringify(input, null, 2));
  console.log(`[cqa] holistic-input.json: ${input.unitCount} unit summaries, ${input.semanticFindings.length} semantic + ${input.confirmedFindings.length} confirmed findings digested`);
}

main();
