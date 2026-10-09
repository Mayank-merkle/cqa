import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate, Severity } from './types';
import { coerceDimension } from './types';

// Aggregates per-unit discovery output (code, deterministic). Reads every
// .claude/cqa/units/*.findings.json the subagents wrote, normalizes the
// semantic findings into the common schema, and collects the unit summaries
// that feed the holistic pass.

const readJSON = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}


function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');
  const unitsDir = join(dir, 'units');
  if (!existsSync(unitsDir)) {
    console.error('[cqa] no .claude/cqa/units dir — run the discovery pass in Claude Code first');
    process.exit(1);
  }

  const files = readdirSync(unitsDir).filter((f) => f.endsWith('.findings.json'));
  const candidates: Candidate[] = [];
  const summaries: Record<string, string> = {};

  for (const f of files) {
    let data: any;
    try {
      data = readJSON(join(unitsDir, f));
    } catch {
      continue;
    }
    if (data?.unitId) summaries[data.unitId] = data.summary ?? '';
    for (const fd of data?.findings ?? []) {
      if (!fd?.file || !fd?.line) continue; // no anchor, no finding
      const loc = `${fd.file}:${fd.line}`;
      const slug = String(fd.category ?? 'finding').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      candidates.push({
        id: `semantic:${hash((fd.category ?? '') + loc)}`,
        ruleId: `semantic:${slug}`,
        category: fd.category ?? 'Semantic finding',
        dimension: coerceDimension(fd.dimension, 'Maintainability'),
        severity: (fd.severity ?? 'Medium') as Severity,
        source: 'semantic',
        collector: 'discovery',
        occurrences: 1,
        evidence: [{ file: fd.file, line: fd.line, snippet: String(fd.snippet ?? '').slice(0, 200) }],
        description: fd.description ?? '',
        suggestedFix: fd.suggestedFix ?? '',
      });
    }
  }

  const rank: Record<Severity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  candidates.sort((a, b) => rank[a.severity] - rank[b.severity]);

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'discovery-findings.json'), JSON.stringify(candidates, null, 2));
  writeFileSync(join(dir, 'unit-summaries.json'), JSON.stringify(summaries, null, 2));
  console.log(`[cqa] discovery: ${candidates.length} semantic findings from ${files.length} units`);
  console.log('[cqa] note: discovery findings are AI-inferred (source: semantic). Eyeball before the report — same sign-off gate as everything else.');
}

main();
