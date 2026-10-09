import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate } from './types';

// Deterministic prep for the judgment pass. Reads candidates.json and attaches
// just enough context for the AI to judge each one — cited code (+/- a few
// lines) for source findings, prod/dev scope for dependency findings, a capped
// file list for orphans. Keeps the AI's input small and bounded.

const MAX_SAMPLES = 6;
const CTX = 4;

const readJSON = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));

function depScope(pkg: any, name: string): 'prod' | 'dev' | 'unknown' {
  if (pkg?.dependencies?.[name]) return 'prod';
  if (pkg?.devDependencies?.[name]) return 'dev';
  return 'unknown';
}

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

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');
  const candidates: Candidate[] = readJSON(join(dir, 'candidates.json'));
  let pkg: any = {};
  try {
    pkg = readJSON(join(repoRoot, 'package.json'));
  } catch {}

  const items = candidates.map((c) => {
    const base = {
      id: c.id,
      ruleId: c.ruleId,
      category: c.category,
      dimension: c.dimension,
      severity: c.severity,
      collector: c.collector,
      occurrences: c.occurrences,
      description: c.description,
    };
    if (c.collector === 'npm-audit') {
      const name = c.ruleId.replace(/^npm-audit:/, '');
      return { ...base, scope: depScope(pkg, name), advisory: c.evidence[0]?.snippet ?? '' };
    }
    if (c.collector === 'graph') {
      return { ...base, sampleFiles: c.evidence.slice(0, 15).map((e) => e.file), totalFiles: c.occurrences };
    }
    return {
      ...base,
      samples: c.evidence.slice(0, MAX_SAMPLES).map((e) => ({
        ref: `${e.file}:${e.line}`,
        context: fileContext(repoRoot, e.file, e.line),
      })),
    };
  });

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'judgment-input.json'), JSON.stringify(items, null, 2));
  console.log(`[cqa] judgment-input.json: ${items.length} candidates prepared (small enough to judge in one pass)`);
}

main();
