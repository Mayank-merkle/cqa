import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate } from './types';

// Deterministic prep for the discovery-judgment pass. Unlike the static
// judgment pass, these candidates were AI-inferred with no existing rule to
// check against, so every one gets cited code context.

const CTX = 4;

const readJSON = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));

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

export function buildDiscoveryJudgmentInput(repoRoot: string, discovery: Candidate[]) {
  return discovery.map((c) => ({
    id: c.id,
    category: c.category,
    dimension: c.dimension,
    severity: c.severity,
    description: c.description,
    suggestedFix: c.suggestedFix,
    ref: `${c.evidence[0]?.file}:${c.evidence[0]?.line}`,
    context: fileContext(repoRoot, c.evidence[0]?.file ?? '', c.evidence[0]?.line ?? 0),
  }));
}

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');
  const discovery: Candidate[] = readJSON(join(dir, 'discovery-findings.json'));
  const items = buildDiscoveryJudgmentInput(repoRoot, discovery);

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'discovery-judgment-input.json'), JSON.stringify(items, null, 2));
  console.log(`[cqa] discovery-judgment-input.json: ${items.length} AI-found candidates prepared for skeptical review`);
}

main();
