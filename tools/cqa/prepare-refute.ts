import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { JudgedFinding, Candidate } from './types';

const readJSON = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const tryJSON = (p: string, fallback: any): any => (existsSync(p) ? readJSON(p) : fallback);
const CTX = 4;

function fileContext(repoRoot: string, file: string, line: number): string {
  try {
    const lines = readFileSync(join(repoRoot, file), 'utf8').split(/\r?\n/);
    const start = Math.max(0, line - 1 - CTX);
    const end = Math.min(lines.length, line + CTX);
    const out: string[] = [];
    for (let i = start; i < end; i++) out.push(`${i + 1}${i + 1 === line ? ' >' : '  '}| ${lines[i]}`);
    return out.join('\n');
  } catch {
    return '(could not read file)';
  }
}

// Collect every High/Critical finding that survived judgment, from every
// source layer, for one final adversarial pass before they reach the client.
export function collectHighSeverityFindings(sources: Candidate[][]): Candidate[] {
  return sources.flat().filter((f) => f.severity === 'High' || f.severity === 'Critical');
}

// Each source mints its own id namespace, so the same real-world issue
// flagged by two different sources (e.g. a static rule and reconciliation)
// produces two distinct ids at the same file:line. Collapse those down to
// one before staging for refutation, or the client report shows it twice.
export function dedupeByLocation(findings: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const f of findings) {
    const key = `${f.evidence[0]?.file}:${f.evidence[0]?.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');

  const staticFindings = (tryJSON(join(dir, 'findings.json'), { confirmed: [] }).confirmed ?? []) as JudgedFinding[];
  const discoveryFindings = (tryJSON(join(dir, 'discovery-findings.judged.json'), { confirmed: [] }).confirmed ?? []) as JudgedFinding[];
  const reconciliationFindings: Candidate[] = tryJSON(join(dir, 'reconciliation-findings.json'), []);

  const highSeverity = collectHighSeverityFindings([staticFindings, discoveryFindings, reconciliationFindings]);
  const deduped = dedupeByLocation(highSeverity);

  const items = deduped.map((f) => ({
    id: f.id,
    category: f.category,
    severity: f.severity,
    description: f.description,
    ref: `${f.evidence[0]?.file}:${f.evidence[0]?.line}`,
    context: fileContext(repoRoot, f.evidence[0]?.file ?? '', f.evidence[0]?.line ?? 0),
  }));

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'refute-input.json'), JSON.stringify(items, null, 2));
  console.log(`[cqa] refute-input.json: ${items.length} High/Critical findings staged for adversarial re-check`);
}

// Guard so importing collectHighSeverityFindings (e.g. from a test) doesn't
// also run main() and hit the filesystem — main() only runs when this file
// is executed directly (matches the pattern in apply-discovery-verdicts.ts).
if (require.main === module) {
  main();
}
