import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate, Verdict, JudgedFinding, Severity } from './types';

// Deterministic application of the AI's verdicts. Reads candidates.json +
// verdicts.json and writes findings.json: confirmed findings (with corrected
// severity), items needing client context, and how many false positives were
// dropped. Code does the merge; the AI only judged.

const readJSON = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');
  const candidates: Candidate[] = readJSON(join(dir, 'candidates.json'));
  const verdicts: Verdict[] = readJSON(join(dir, 'verdicts.json'));
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
  confirmed.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.occurrences - a.occurrences);

  const bySev = (s: string) => confirmed.filter((f) => f.severity === s).length;
  const result = {
    generatedAt: new Date().toISOString(),
    summary: {
      confirmed: confirmed.length,
      needsContext: needsContext.length,
      falsePositivesDropped: dropped,
      bySeverity: { Critical: bySev('Critical'), High: bySev('High'), Medium: bySev('Medium'), Low: bySev('Low') },
    },
    confirmed,
    needsContext,
  };
  writeFileSync(join(dir, 'findings.json'), JSON.stringify(result, null, 2));
  console.log(`[cqa] findings.json: ${confirmed.length} confirmed, ${needsContext.length} need context, ${dropped} false positives dropped`);
}

main();
