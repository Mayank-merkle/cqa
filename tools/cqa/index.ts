import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectAdapter, detectVersions, detectWorkspaces } from './config';
import type { AdapterConfig } from './config';
import { enumerate } from './enumerate';
import { buildUnits } from './graph';
import rules from './patterns';
import {
  collectRegex,
  collectEslint,
  collectNpmAudit,
  collectOrphans,
  collectTestCoverage,
  mergeCandidates,
} from './collectors';
import type { TestCoverageResult } from './collectors';
import type { Manifest, CollectorStatus } from './types';

// Deterministic driver. No AI. Run from the repo root (or pass it as argv[2]).
// Gathers candidates from multiple collectors — first-party regex, eslint,
// npm audit, and the import graph — and writes the manifest + candidates that
// the AI judgment pass consumes.
//
// Handles two shapes of target:
//   - a single package (has its own package.json): unchanged single-repo
//     behavior, one manifest written to <repoRoot>/.claude/cqa/.
//   - a monorepo with no root package.json (e.g. a collection of
//     independently-deployable Lambda/CDK services, each with its own
//     package.json at varying depth): the pipeline runs once per discovered
//     workspace via detectWorkspaces(), each writing its own manifest under
//     <workspaceRoot>/.claude/cqa/ (namespaced by directory rather than
//     merged into one manifest, since work-unit IDs like "unit-001" are only
//     unique within a single run and would collide if combined). A
//     <target>/.claude/cqa/workspaces.json index is also written, listing
//     every discovered workspace and whether it matched an adapter, so a
//     caller (e.g. run-cqa.md) can drive the AI passes per workspace without
//     re-walking the tree itself.
//
//   npx tsx tools/cqa/index.ts
//   npx tsx tools/cqa/index.ts C:/lhw/dotcomV2
//   npx tsx tools/cqa/index.ts C:/lhw/DotcomV2-AppSync   (monorepo)

const RULES_VERSION = '2';

function runPipeline(repoRoot: string, cfg: AdapterConfig): { manifest: Manifest; candidateCount: number } {
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

  let testCoverage: TestCoverageResult | undefined;
  if (cfg.collectors.testCoverage) {
    console.log('[cqa] running the test suite with coverage...');
    testCoverage = collectTestCoverage(repoRoot, cfg);
    statuses.push({ id: 'test-coverage', ran: testCoverage.ran, candidates: testCoverage.lowCoverageFiles.length, note: testCoverage.note });
    if (testCoverage.ran) {
      coverage.notMeasured = coverage.notMeasured.filter((n) => !/test coverage/i.test(n));
    }
  }

  const candidates = mergeCandidates(lists);

  // A dimension is "not measured" only if no collector produced anything for it.
  const covered = new Set(candidates.map((c) => c.dimension));
  if (covered.has('Security')) {
    coverage.notMeasured = coverage.notMeasured.filter((n) => !/CVE|dependency/i.test(n));
  }

  const manifest: Manifest = {
    stack: cfg.id,
    detectedVersions: detectVersions(repoRoot, cfg.versionRelevantPackages),
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
  if (testCoverage) writeFileSync(join(outDir, 'coverage-summary.json'), JSON.stringify(testCoverage, null, 2));

  const bySev = (s: string) => candidates.filter((c) => c.severity === s).length;
  console.log(`[cqa] files: ${coverage.totalFiles} total, ${coverage.sourceFiles} source reviewed, ${coverage.excludedFiles} excluded (${coverage.reviewedPct}% of repo is source)`);
  console.log(`[cqa] work units: ${units.length}; orphans: ${orphans.length}`);
  for (const s of statuses) console.log(`[cqa]   collector ${s.id}: ${s.ran ? s.candidates + ' groups' + (s.note ? ' — ' + s.note : '') : 'skipped — ' + (s.note ?? '')}`);
  console.log(`[cqa] candidates: ${candidates.length} groups — Critical ${bySev('Critical')}, High ${bySev('High')}, Medium ${bySev('Medium')}, Low ${bySev('Low')}`);
  console.log(`[cqa] wrote ${join(repoRoot, '.claude', 'cqa')}/manifest.json and candidates.json`);

  return { manifest, candidateCount: candidates.length };
}

interface WorkspaceSummaryEntry {
  root: string;
  stack: string | null;
  sourceFiles?: number;
  workUnits?: number;
  candidates?: number;
  reason?: string;
}

function main() {
  const target = process.argv[2] ? process.argv[2] : process.cwd();

  // Single-package repo: unchanged behavior — one manifest at the target's
  // own .claude/cqa/, detectAdapter() throws its usual clear error if nothing
  // matches rather than being swallowed into a workspace list of one.
  if (existsSync(join(target, 'package.json'))) {
    const cfg = detectAdapter(target);
    runPipeline(target, cfg);
    return;
  }

  // Monorepo with no root package.json: drive the pipeline once per
  // discovered workspace.
  console.log(`[cqa] ${target} has no root package.json — treating it as a monorepo and discovering workspaces...`);
  const workspaces = detectWorkspaces(target);
  if (!workspaces.length) {
    console.log(`[cqa] no package.json found anywhere under ${target} — nothing to scan.`);
    return;
  }

  const summary: WorkspaceSummaryEntry[] = [];
  for (const ws of workspaces) {
    if (!ws.adapter) {
      console.log(`[cqa] skipping ${ws.root}: ${ws.reason}`);
      summary.push({ root: ws.root, stack: null, reason: ws.reason });
      continue;
    }
    const { manifest, candidateCount } = runPipeline(ws.root, ws.adapter);
    summary.push({
      root: ws.root,
      stack: manifest.stack,
      sourceFiles: manifest.coverage.sourceFiles,
      workUnits: manifest.workUnits.length,
      candidates: candidateCount,
    });
  }

  const outDir = join(target, '.claude', 'cqa');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'workspaces.json'), JSON.stringify({ generatedAt: new Date().toISOString(), workspaces: summary }, null, 2));

  const matched = summary.filter((s) => s.stack);
  console.log(`[cqa] monorepo scan complete: ${matched.length}/${summary.length} workspaces matched an adapter`);
  console.log(`[cqa] wrote ${outDir}/workspaces.json`);
}

main();
