import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Aggregates per-batch Storybook coverage output (code, deterministic). Reads
// every .claude/cqa/storybook-units/*.findings.json the subagents wrote and
// normalizes them into one flat list. These are reported alongside
// coverage.reviewedPct, never severity-weighted — see the TestCoverageResult
// comment in collectors.ts for why a coverage-gap check doesn't belong in the
// defect-density score the same way a security bug would.

export interface StorybookCoverageFinding {
  component: string;
  prop: string;
  description: string;
  suggestedFix?: string;
}

export function normalizeStorybookFindings(raw: any[]): StorybookCoverageFinding[] {
  const findings: StorybookCoverageFinding[] = [];
  for (const fd of raw ?? []) {
    if (!fd?.component || !fd?.prop) continue; // no anchor, no finding
    findings.push({
      component: String(fd.component),
      prop: String(fd.prop),
      description: String(fd.description ?? ''),
      suggestedFix: fd.suggestedFix ? String(fd.suggestedFix) : undefined,
    });
  }
  return findings;
}

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');
  const unitsDir = join(dir, 'storybook-units');

  let findings: StorybookCoverageFinding[] = [];
  let batchCount = 0;
  if (existsSync(unitsDir)) {
    const files = readdirSync(unitsDir).filter((f) => f.endsWith('.findings.json'));
    batchCount = files.length;
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(join(unitsDir, f), 'utf8'));
        findings = findings.concat(normalizeStorybookFindings(data?.findings));
      } catch {
        continue;
      }
    }
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'storybook-coverage-findings.json'), JSON.stringify(findings, null, 2));
  console.log(`[cqa] storybook-coverage-findings.json: ${findings.length} prop coverage gap(s) from ${batchCount} batch(es)`);
}

if (require.main === module) {
  main();
}
