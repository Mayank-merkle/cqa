import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate, JudgedFinding, Manifest } from './types';
import { scoreFindings } from './scoring';

const readJSON = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const tryJSON = (p: string, fallback: any): any => (existsSync(p) ? readJSON(p) : fallback);

interface RefuteResult {
  stands: string[];
  refuted: { id: string; rationale: string }[];
}

export function collectScorableFindings(input: {
  staticConfirmed: JudgedFinding[];
  discoveryConfirmed: JudgedFinding[];
  reconciliation: Candidate[];
  refutedIds: Set<string>;
}): JudgedFinding[] {
  const all: JudgedFinding[] = [
    ...input.staticConfirmed,
    ...input.discoveryConfirmed,
    ...input.reconciliation.map((c) => ({ ...c, verdict: 'CONFIRMED' as const, rationale: 'Reconciliation pass finding.' })),
  ];
  return all.filter((f) => !input.refutedIds.has(f.id));
}

export function countSourceLines(repoRoot: string, relativePaths: string[]): number {
  let total = 0;
  for (const p of relativePaths) {
    try {
      const content = readFileSync(join(repoRoot, p), 'utf8');
      total += content.split(/\r?\n/).length;
    } catch {
      // File listed in the manifest but unreadable now (moved/deleted since the
      // run) — skip rather than fail the whole score.
    }
  }
  return total;
}

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');

  const manifest: Manifest = readJSON(join(dir, 'manifest.json'));
  const staticFindings = tryJSON(join(dir, 'findings.json'), { confirmed: [], needsContext: [] });
  const discoveryFindings = tryJSON(join(dir, 'discovery-findings.judged.json'), { confirmed: [], needsContext: [] });
  const reconciliation: Candidate[] = tryJSON(join(dir, 'reconciliation-findings.json'), []);
  const refuteResult: RefuteResult = tryJSON(join(dir, 'refute-result.json'), { stands: [], refuted: [] });
  // Coverage (Jest % and Storybook prop/variant gaps) is reported, never
  // severity-weighted — see the comment on TestCoverageResult in collectors.ts
  // for why a continuous metric doesn't belong in the defect-density score.
  const testCoverage = tryJSON(join(dir, 'coverage-summary.json'), undefined);
  const storybookCoverage = tryJSON(join(dir, 'storybook-coverage-findings.json'), undefined);

  const refutedIds = new Set(refuteResult.refuted.map((r) => r.id));
  const scorable = collectScorableFindings({
    staticConfirmed: staticFindings.confirmed,
    discoveryConfirmed: discoveryFindings.confirmed,
    reconciliation,
    refutedIds,
  });

  const sourceFiles = manifest.workUnits.flatMap((u) => u.files);
  const totalLines = countSourceLines(repoRoot, sourceFiles);

  const result = scoreFindings(scorable, totalLines);

  const output = {
    generatedAt: new Date().toISOString(),
    ...result,
    excludedFromScore: {
      refuted: refutedIds.size,
      needsContext: (staticFindings.needsContext?.length ?? 0) + (discoveryFindings.needsContext?.length ?? 0),
    },
    // Reported, not scored — see the comment above where these are read.
    coverage: {
      testCoverage: testCoverage ?? null,
      storybookGaps: Array.isArray(storybookCoverage) ? storybookCoverage.length : null,
    },
  };

  writeFileSync(join(dir, 'score.json'), JSON.stringify(output, null, 2));
  console.log(`[cqa] score.json: overall grade ${output.overall.grade} (${output.overall.pointsPerKloc.toFixed(2)} pts/KLOC across ${output.overall.kloc.toFixed(1)} KLOC)`);
}

if (require.main === module) {
  main();
}
