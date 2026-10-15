import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { detectWorkspaces, detectVersions } from './config';
import { enumerate } from './enumerate';
import type { EnumerateConfig } from './enumerate';
import { runPipeline } from './index';
import { findDuplicateBlocks } from './duplication';
import type { DuplicateBlock, FileInput as DuplicationFileInput } from './duplication';
import { findCrossServiceEdges } from './cross-service';
import type { CrossServiceEdge, WorkspaceFileInput } from './cross-service';
import type { Candidate, Dimension } from './types';

// Orchestrates the fleet-level (cross-workspace) view of a monorepo:
// detects every workspace (matched or not), drives the existing
// single-workspace pipeline for the ones that matched an adapter, and runs
// duplication/cross-service detection across EVERY workspace's files —
// deliberately not scoped to adapter-matched workspaces only, since those
// two detectors need nothing from an AdapterConfig beyond "which files are
// source," and a workspace with no matching adapter (e.g. a standalone
// Contentful-migration script directory) is still real code that can
// duplicate logic with, or share config with, the rest of the fleet. It
// just doesn't get the full per-workspace AI pipeline, which genuinely
// needs entryMatchers/eslintCmd/etc. — that gap is recorded explicitly in
// its WorkspaceSummary, not silently dropped.

function workspaceId(repoRoot: string, workspaceRoot: string): string {
  const rel = relative(repoRoot, workspaceRoot).split(sep).join('/');
  return rel || '.';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A CDK-app-root workspace's own srcDir is '.' (config.ts's awsLambdaCdk
// adapter — these workspaces have no src/ of their own), which recursively
// walks EVERYTHING under it, including nested lambda packages that
// detectWorkspaces() also discovers as their own separate, independently-
// reviewed workspaces (e.g. `hotel-api/cdk` and `hotel-api/cdk/lambdas/
// hotelProcessor` are both real, separate entries). Without this exclusion,
// a nested lambda's files get enumerated AND reviewed twice: once under
// its own workspace identity, once again under its CDK-root parent's —
// doubling AI spend on every CDK-root workspace and corrupting
// duplication.ts's output with bogus 100%-self-duplicate blocks (the exact
// symptom that surfaced this bug during the Phase A checkpoint run against
// the real DotcomV2-AppSync repo).
export function excludeNestedWorkspaces<T extends { skip: { pattern: RegExp; reason: string }[] }>(
  cfg: T,
  workspaceRoot: string,
  allWorkspaceRoots: string[]
): T {
  const nestedSkips = allWorkspaceRoots
    .filter((r) => r !== workspaceRoot) // not itself
    .map((r) => relative(workspaceRoot, r).split(sep).join('/'))
    .filter((rel) => rel && !rel.startsWith('..')) // a true descendant, not a sibling/ancestor
    .map((rel) => ({ pattern: new RegExp(`^${escapeRegExp(rel)}/`), reason: 'nested workspace — reviewed independently' }));
  if (!nestedSkips.length) return cfg;
  return { ...cfg, skip: [...cfg.skip, ...nestedSkips] };
}

const GENERIC_FALLBACK: EnumerateConfig = {
  srcDir: '.',
  skip: [
    { pattern: /node_modules\//, reason: 'dependency' },
    { pattern: /dist\//, reason: 'build output' },
    { pattern: /build\//, reason: 'build output' },
    { pattern: /coverage\//, reason: 'test coverage output' },
    { pattern: /cdk\.out\//, reason: 'cdk synth output' },
    { pattern: /\.git\//, reason: 'vcs metadata' },
    { pattern: /\.d\.ts$/, reason: 'type declaration' },
  ],
  entryMatchers: [],
  notMeasured: ['No adapter matched this workspace — mechanical duplication/cross-service scanning only, no AI review'],
};

export interface WorkspaceSummary {
  workspace: string; // id, repo-relative path with forward slashes
  root: string;
  adapterId: string | null; // null = no adapter matched, see `reason`
  reason?: string;
  sourceFiles: number;
  workUnits?: number; // only set for adapter-matched workspaces
  candidates?: number; // only set for adapter-matched workspaces
}

export interface DependencyDriftEntry {
  package: string;
  versions: { version: string; workspaces: string[] }[];
}

export interface FleetPostureEntry {
  workspace: string;
  candidatesByDimension: Partial<Record<Dimension, number>>;
  testCoverage?: { ran: boolean; overallPct?: number };
}

export interface MonorepoManifest {
  generatedAt: string;
  repoRoot: string;
  workspaces: WorkspaceSummary[];
  duplication: DuplicateBlock[];
  crossService: CrossServiceEdge[];
  dependencyDrift: DependencyDriftEntry[];
  fleetPosture: FleetPostureEntry[];
}

// --- pure aggregation (unit-testable without touching the filesystem) ---

export interface WorkspaceVersions {
  workspace: string;
  versions: Record<string, string>; // package -> version, 'unknown' entries ignored
}

// Only packages actually at >1 distinct real version across the fleet are
// "drift" — a package at the same version everywhere, or only detected in
// one workspace, isn't worth a fleet-level callout.
export function aggregateDependencyDrift(perWorkspace: WorkspaceVersions[]): DependencyDriftEntry[] {
  const byPackage = new Map<string, Map<string, Set<string>>>();
  for (const ws of perWorkspace) {
    for (const [pkg, version] of Object.entries(ws.versions)) {
      if (!version || version === 'unknown') continue;
      const byVersion = byPackage.get(pkg) ?? new Map<string, Set<string>>();
      const workspaces = byVersion.get(version) ?? new Set<string>();
      workspaces.add(ws.workspace);
      byVersion.set(version, workspaces);
      byPackage.set(pkg, byVersion);
    }
  }
  const drift: DependencyDriftEntry[] = [];
  for (const [pkg, byVersion] of byPackage) {
    if (byVersion.size < 2) continue;
    drift.push({ package: pkg, versions: [...byVersion.entries()].map(([version, ws]) => ({ version, workspaces: [...ws] })) });
  }
  return drift.sort((a, b) => b.versions.length - a.versions.length);
}

export interface WorkspacePostureInput {
  workspace: string;
  candidates: Candidate[];
  testCoverage?: { ran: boolean; overallPct?: number };
}

export function aggregateFleetPosture(perWorkspace: WorkspacePostureInput[]): FleetPostureEntry[] {
  return perWorkspace.map((ws) => {
    const byDimension: Partial<Record<Dimension, number>> = {};
    for (const c of ws.candidates) byDimension[c.dimension] = (byDimension[c.dimension] ?? 0) + 1;
    return { workspace: ws.workspace, candidatesByDimension: byDimension, testCoverage: ws.testCoverage };
  });
}

// --- I/O orchestration ---

function readJSONSafe(p: string): any {
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}

function readScannedFileTexts(workspaceRoot: string, cfg: EnumerateConfig): { path: string; text: string }[] {
  const { files } = enumerate(workspaceRoot, cfg);
  const out: { path: string; text: string }[] = [];
  for (const f of files) {
    if (!f.scanned) continue;
    try {
      out.push({ path: f.path, text: readFileSync(join(workspaceRoot, f.path), 'utf8') });
    } catch {
      continue;
    }
  }
  return out;
}

export function runMonorepoScan(repoRoot: string): MonorepoManifest {
  const targets = detectWorkspaces(repoRoot);

  const workspaces: WorkspaceSummary[] = [];
  const dupInputs: DuplicationFileInput[] = [];
  const edgeInputs: WorkspaceFileInput[] = [];
  const versionsPerWorkspace: WorkspaceVersions[] = [];
  const postureInputs: WorkspacePostureInput[] = [];

  const allRoots = targets.map((t) => t.root);

  for (const target of targets) {
    const id = workspaceId(repoRoot, target.root);

    if (target.adapter) {
      const scopedAdapter = excludeNestedWorkspaces(target.adapter, target.root, allRoots);
      console.log(`[cqa] [monorepo] running pipeline for ${id} (${target.adapter.id})`);
      const { manifest, candidateCount } = runPipeline(target.root, scopedAdapter);
      workspaces.push({
        workspace: id,
        root: target.root,
        adapterId: target.adapter.id,
        sourceFiles: manifest.coverage.sourceFiles,
        workUnits: manifest.workUnits.length,
        candidates: candidateCount,
      });

      for (const f of readScannedFileTexts(target.root, scopedAdapter)) {
        dupInputs.push({ workspace: id, file: f.path, text: f.text });
        edgeInputs.push({ workspace: id, workspaceRoot: target.root, file: f.path, text: f.text });
      }

      versionsPerWorkspace.push({ workspace: id, versions: detectVersions(target.root, target.adapter.versionRelevantPackages) });

      const candidates: Candidate[] = readJSONSafe(join(target.root, '.claude', 'cqa', 'candidates.json')) ?? [];
      const coverage = readJSONSafe(join(target.root, '.claude', 'cqa', 'coverage-summary.json'));
      postureInputs.push({
        workspace: id,
        candidates,
        testCoverage: coverage ? { ran: !!coverage.ran, overallPct: coverage.overallPct } : undefined,
      });
    } else {
      console.log(`[cqa] [monorepo] no adapter matched ${id} — mechanical scanning only (${target.reason ?? 'unknown reason'})`);
      const scopedFallback = excludeNestedWorkspaces(GENERIC_FALLBACK, target.root, allRoots);
      const scannedFiles = readScannedFileTexts(target.root, scopedFallback);
      workspaces.push({ workspace: id, root: target.root, adapterId: null, reason: target.reason, sourceFiles: scannedFiles.length });
      for (const f of scannedFiles) {
        dupInputs.push({ workspace: id, file: f.path, text: f.text });
        edgeInputs.push({ workspace: id, workspaceRoot: target.root, file: f.path, text: f.text });
      }
    }
  }

  const duplication = findDuplicateBlocks(dupInputs);
  const crossService = findCrossServiceEdges(edgeInputs);
  const dependencyDrift = aggregateDependencyDrift(versionsPerWorkspace);
  const fleetPosture = aggregateFleetPosture(postureInputs);

  const manifest: MonorepoManifest = {
    generatedAt: new Date().toISOString(),
    repoRoot,
    workspaces,
    duplication,
    crossService,
    dependencyDrift,
    fleetPosture,
  };

  const outDir = join(repoRoot, '.claude', 'cqa');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'system-manifest.json'), JSON.stringify(manifest, null, 2));

  const matchedCount = workspaces.filter((w) => w.adapterId).length;
  console.log(`[cqa] monorepo scan complete: ${matchedCount}/${workspaces.length} workspaces matched an adapter (${workspaces.length - matchedCount} scanned mechanically only, no adapter)`);
  console.log(`[cqa] duplication: ${duplication.length} duplicate block(s) found across the fleet`);
  console.log(`[cqa] cross-service edges: ${crossService.length}`);
  console.log(`[cqa] dependency drift: ${dependencyDrift.length} package(s) at inconsistent versions across workspaces`);
  console.log(`[cqa] wrote ${outDir}/system-manifest.json`);

  return manifest;
}

function main() {
  const target = process.argv[2] ?? process.cwd();
  runMonorepoScan(target);
}

if (require.main === module) {
  main();
}
