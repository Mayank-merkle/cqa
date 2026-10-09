import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest, CrossClusterEdge } from './types';

const readJSON = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const tryJSON = (p: string, fallback: any): any => (existsSync(p) ? readJSON(p) : fallback);

const FAN_THRESHOLD = 4;

export interface TargetGroup {
  file: string; // the imported ("to") side — read once per group, not once per edge
  importedByCount: number;
  incomingEdges: { from: string; fromUnit: string }[];
}

// Scope the reconciliation pass to exactly what it needs: every cross-cluster
// edge, grouped by its target file so the shared file is read once per group
// instead of once per edge (2392 raw edges collapse to ~370 unique targets on
// a real run — the actual review cost scales with unique targets, not edges).
// `targetGroups` is the exhaustive, batchable processing unit: every group
// must be reviewed, none pre-filtered out — a baseline audit's whole point is
// not silently skipping the majority of cross-cluster structure for cost.
// `highFanInFiles` is kept only as a priority hint for batch ordering (review
// the biggest fan-in groups first), not as a filter.
export function buildReconciliationInput(manifest: Manifest, summaries: Record<string, string>) {
  const allEdges: CrossClusterEdge[] = [];
  const seen = new Set<string>();
  for (const u of manifest.workUnits) {
    for (const e of u.crossClusterEdges ?? []) {
      const key = `${e.from}->${e.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allEdges.push(e);
    }
  }

  const byTarget = new Map<string, { from: string; fromUnit: string }[]>();
  for (const e of allEdges) {
    const list = byTarget.get(e.to) ?? [];
    list.push({ from: e.from, fromUnit: e.fromUnit });
    byTarget.set(e.to, list);
  }

  const targetGroups: TargetGroup[] = [...byTarget.entries()]
    .map(([file, incomingEdges]) => ({ file, importedByCount: incomingEdges.length, incomingEdges }))
    .sort((a, b) => b.importedByCount - a.importedByCount);

  const highFanIn = targetGroups
    .filter((g) => g.importedByCount >= FAN_THRESHOLD)
    .map((g) => ({ file: g.file, importedByCount: g.importedByCount }));

  return {
    crossClusterEdges: allEdges,
    targetGroups,
    highFanInFiles: highFanIn,
    unitSummaries: summaries,
  };
}

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');
  const manifest: Manifest = readJSON(join(dir, 'manifest.json'));
  const summaries = tryJSON(join(dir, 'unit-summaries.json'), {});

  const input = buildReconciliationInput(manifest, summaries);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'reconciliation-input.json'), JSON.stringify(input, null, 2));
  console.log(`[cqa] reconciliation-input.json: ${input.crossClusterEdges.length} cross-cluster edges across ${input.targetGroups.length} unique target files (${input.highFanInFiles.length} high fan-in) — review every target group, none pre-filtered`);
}

// Guard so importing buildReconciliationInput (e.g. from a test) doesn't also
// run main() and hit the filesystem — main() only runs when this file is
// executed directly (matches the pattern in apply-discovery-verdicts.ts).
if (require.main === module) {
  main();
}
