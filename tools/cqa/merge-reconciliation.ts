import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate, Severity } from './types';
import { coerceDimension } from './types';

const readJSON = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function normalizeReconciliationFindings(raw: any[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const fd of raw ?? []) {
    if (!fd?.file || !fd?.line) continue;
    const loc = `${fd.file}:${fd.line}`;
    const slug = String(fd.category ?? 'finding').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    candidates.push({
      id: `reconciliation:${hash((fd.category ?? '') + loc)}`,
      ruleId: `reconciliation:${slug}`,
      category: fd.category ?? 'Cross-cutting finding',
      dimension: coerceDimension(fd.dimension, 'Reliability'),
      severity: (fd.severity ?? 'Medium') as Severity,
      source: 'semantic',
      collector: 'reconciliation',
      occurrences: 1,
      evidence: [{ file: fd.file, line: fd.line, snippet: String(fd.snippet ?? '').slice(0, 200) }],
      description: fd.description ?? '',
      suggestedFix: fd.suggestedFix ?? '',
    });
  }
  return candidates;
}

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');
  const raw = existsSync(join(dir, 'reconciliation.json')) ? readJSON(join(dir, 'reconciliation.json')) : { findings: [] };
  const candidates = normalizeReconciliationFindings(raw.findings);

  writeFileSync(join(dir, 'reconciliation-findings.json'), JSON.stringify(candidates, null, 2));
  console.log(`[cqa] reconciliation: ${candidates.length} cross-cutting findings`);
}

// Guard so importing normalizeReconciliationFindings (e.g. from a test)
// doesn't also run main() and hit the filesystem — main() only runs when
// this file is executed directly (matches apply-discovery-verdicts.ts /
// prepare-reconciliation.ts).
if (require.main === module) {
  main();
}
