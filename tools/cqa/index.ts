import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectAdapter, detectVersions } from './config';
import { enumerate } from './enumerate';
import { buildUnits } from './graph';
import rules from './patterns';
import {
  collectRegex,
  collectEslint,
  collectNpmAudit,
  collectOrphans,
  mergeCandidates,
} from './collectors';
import type { Manifest, CollectorStatus } from './types';

// Deterministic driver. No AI. Run from the repo root (or pass it as argv[2]).
// Gathers candidates from multiple collectors — first-party regex, eslint,
// npm audit, and the import graph — and writes the manifest + candidates that
// the AI judgment pass consumes.
//
//   npx tsx tools/cqa/index.ts
//   npx tsx tools/cqa/index.ts C:/lhw/dotcomV2

const RULES_VERSION = '2';

function main() {
  const repoRoot = process.argv[2] ? process.argv[2] : process.cwd();
  const cfg = detectAdapter(repoRoot);
  console.log(`[cqa] scanning ${repoRoot} (${cfg.id})`);

  const { files, coverage } = enumerate(repoRoot, cfg);
  const { units, orphans, texts } = buildUnits(repoRoot, cfg, files);

  const lists = [];
  const statuses: CollectorStatus[] = [];

  if (cfg.collectors.regex) {
    const r = collectRegex(repoRoot, files, rules, texts);
    lists.push(r.candidates);
    statuses.push(r.status);
  }
  if (cfg.collectors.eslint) {
    console.log('[cqa] running eslint (this can take a minute)...');
    const r = collectEslint(repoRoot, cfg);
    lists.push(r.candidates);
    statuses.push(r.status);
  }
  if (cfg.collectors.npmAudit) {
    console.log('[cqa] running npm audit...');
    const r = collectNpmAudit(repoRoot, cfg);
    lists.push(r.candidates);
    statuses.push(r.status);
  }
  if (cfg.collectors.orphans) {
    const r = collectOrphans(orphans);
    lists.push(r.candidates);
    statuses.push(r.status);
  }

  const candidates = mergeCandidates(lists);

  // A dimension is "not measured" only if no collector produced anything for it.
  const covered = new Set(candidates.map((c) => c.dimension));
  if (covered.has('Security')) {
    coverage.notMeasured = coverage.notMeasured.filter((n) => !/CVE|dependency/i.test(n));
  }

  const manifest: Manifest = {
    stack: cfg.id,
    detectedVersions: detectVersions(repoRoot),
    generatedAt: new Date().toISOString(),
    rulesVersion: RULES_VERSION,
    coverage,
    collectors: statuses,
    workUnits: units,
  };

  const outDir = join(repoRoot, '.claude', 'cqa');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(outDir, 'candidates.json'), JSON.stringify(candidates, null, 2));

  const bySev = (s: string) => candidates.filter((c) => c.severity === s).length;
  console.log(`[cqa] files: ${coverage.totalFiles} total, ${coverage.sourceFiles} source reviewed, ${coverage.excludedFiles} excluded (${coverage.reviewedPct}% of repo is source)`);
  console.log(`[cqa] work units: ${units.length}; orphans: ${orphans.length}`);
  for (const s of statuses) console.log(`[cqa]   collector ${s.id}: ${s.ran ? s.candidates + ' groups' + (s.note ? ' — ' + s.note : '') : 'skipped — ' + (s.note ?? '')}`);
  console.log(`[cqa] candidates: ${candidates.length} groups — Critical ${bySev('Critical')}, High ${bySev('High')}, Medium ${bySev('Medium')}, Low ${bySev('Low')}`);
  console.log(`[cqa] wrote .claude/cqa/manifest.json and candidates.json`);
}

main();
