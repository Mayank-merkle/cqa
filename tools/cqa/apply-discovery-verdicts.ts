import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate, Verdict, JudgedFinding, Severity } from './types';

const readJSON = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));

export function applyDiscoveryVerdicts(candidates: Candidate[], verdicts: Verdict[]) {
  const vMap = new Map(verdicts.map((v) => [v.id, v]));
  const confirmed: JudgedFinding[] = [];
  const needsContext: JudgedFinding[] = [];
  let dropped = 0;

  for (const c of candidates) {
    const v = vMap.get(c.id);
    if (!v) {
      needsContext.push({ ...c, verdict: 'NEEDS_CONTEXT', rationale: 'No verdict produced for this candidate.' });
      continue;
    }
    const finding: JudgedFinding = { ...c, severity: v.severity ?? c.severity, verdict: v.verdict, rationale: v.rationale };
    if (v.verdict === 'CONFIRMED') confirmed.push(finding);
    else if (v.verdict === 'NEEDS_CONTEXT') needsContext.push(finding);
    else dropped++;
  }

  const sevRank: Record<Severity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  confirmed.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
  return { confirmed, needsContext, dropped };
}

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');
  const candidates: Candidate[] = readJSON(join(dir, 'discovery-findings.json'));
  const verdicts: Verdict[] = readJSON(join(dir, 'discovery-verdicts.json'));
  const { confirmed, needsContext, dropped } = applyDiscoveryVerdicts(candidates, verdicts);

  const result = {
    generatedAt: new Date().toISOString(),
    summary: { confirmed: confirmed.length, needsContext: needsContext.length, falsePositivesDropped: dropped },
    confirmed,
    needsContext,
  };
  writeFileSync(join(dir, 'discovery-findings.judged.json'), JSON.stringify(result, null, 2));
  console.log(`[cqa] discovery-findings.judged.json: ${confirmed.length} confirmed, ${needsContext.length} need context, ${dropped} false positives dropped`);
}

// Guard so importing applyDiscoveryVerdicts (e.g. from a test) doesn't also
// run main() and hit the filesystem — main() only runs when this file is
// executed directly (matches how apply-verdicts.ts is invoked, via tsx).
if (require.main === module) {
  main();
}
