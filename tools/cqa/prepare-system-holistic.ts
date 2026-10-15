import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MonorepoManifest } from './monorepo';

// Builds the compressed input for SYSTEM_HOLISTIC.md (code, deterministic),
// the same role prepare-holistic.ts plays for the per-workspace HOLISTIC.md
// pass: compress everything down to summaries/digests, never raw source, so
// one AI pass can reason across the whole fleet without holding it in context.

const readJSON = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const tryJSON = (p: string, fallback: any): any => {
  try {
    return existsSync(p) ? readJSON(p) : fallback;
  } catch {
    return fallback;
  }
};

interface UnitSummaryEntry {
  workspace: string;
  unitId: string;
  summary: string;
}

function collectUnitSummaries(manifest: MonorepoManifest): UnitSummaryEntry[] {
  const entries: UnitSummaryEntry[] = [];
  for (const ws of manifest.workspaces) {
    if (!ws.adapterId) continue; // no per-workspace Discovery pass ran, so no unit-summaries.json to read
    const summaries: Record<string, string> = tryJSON(join(ws.root, '.claude', 'cqa', 'unit-summaries.json'), {});
    for (const [unitId, summary] of Object.entries(summaries)) {
      entries.push({ workspace: ws.workspace, unitId, summary: summary as string });
    }
  }
  return entries;
}

// Cross-service edges can be numerous on a large fleet; cap rather than
// truncate silently mid-array so the count discrepancy is visible in the
// written input file itself.
const MAX_CROSS_SERVICE_EDGES = 150;
const MAX_DUPLICATION_BLOCKS = 40;

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');

  const manifest: MonorepoManifest | undefined = tryJSON(join(dir, 'system-manifest.json'), undefined);
  if (!manifest) {
    console.error('[cqa] system-manifest.json not found — run monorepo.ts first.');
    process.exit(1);
  }

  const input = {
    workspaces: manifest.workspaces.map((w) => ({
      workspace: w.workspace,
      adapterId: w.adapterId,
      reason: w.reason,
      sourceFiles: w.sourceFiles,
      workUnits: w.workUnits,
      candidates: w.candidates,
    })),
    unitSummaries: collectUnitSummaries(manifest),
    duplication: manifest.duplication.slice(0, MAX_DUPLICATION_BLOCKS),
    duplicationTotalCount: manifest.duplication.length,
    crossService: manifest.crossService.slice(0, MAX_CROSS_SERVICE_EDGES),
    crossServiceTotalCount: manifest.crossService.length,
    dependencyDrift: manifest.dependencyDrift,
    fleetPosture: manifest.fleetPosture,
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'system-holistic-input.json'), JSON.stringify(input, null, 2));
  console.log(
    `[cqa] system-holistic-input.json: ${input.workspaces.length} workspaces (${input.workspaces.filter((w) => w.adapterId).length} matched), ` +
      `${input.unitSummaries.length} unit summaries, ${input.duplication.length}/${input.duplicationTotalCount} duplication blocks, ` +
      `${input.crossService.length}/${input.crossServiceTotalCount} cross-service edges`
  );
}

if (require.main === module) {
  main();
}
