import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import ts from 'typescript';
import type { AdapterConfig } from './config';
import type { FileRecord, WorkUnit, CrossClusterEdge } from './types';

// Build an import graph using the real TypeScript compiler (not regex) and
// group files into work units. Using the compiler means path aliases
// (tsconfig `paths`), barrel re-exports, and dynamic import() resolve exactly
// the way the project's own build resolves them — a regex can mistake a
// string that merely looks like an import (inside a comment or a template
// literal) for a real one; the compiler only walks actual import/export
// syntax.

function rel(repoRoot: string, abs: string): string {
  return relative(repoRoot, abs).split(sep).join('/');
}

function loadCompilerOptions(repoRoot: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) return {};
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config, ts.sys, dirname(configPath)).options;
}

function collectSpecifiers(sf: ts.SourceFile): string[] {
  const specs: string[] = [];
  const visit = (node: ts.Node) => {
    const literalArg =
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
        ? (node.arguments[0] as ts.StringLiteral).text
        : undefined;
    const declSpecifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : undefined;
    const spec = literalArg ?? declSpecifier;
    if (spec) specs.push(spec);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

// Resolve every file's imports with the project's own compiler settings, so
// what the analyzer sees matches what actually builds.
export function buildImportIndex(repoRoot: string, absFilePaths: string[]): Map<string, string[]> {
  const options = loadCompilerOptions(repoRoot);
  const program = ts.createProgram(absFilePaths, options);
  const known = new Set(absFilePaths.map((p) => rel(repoRoot, p)));
  const index = new Map<string, string[]>();

  for (const abs of absFilePaths) {
    const relPath = rel(repoRoot, abs);
    const sf = program.getSourceFile(abs);
    if (!sf) {
      index.set(relPath, []);
      continue;
    }
    const deps = new Set<string>();
    for (const spec of collectSpecifiers(sf)) {
      const resolved = ts.resolveModuleName(spec, abs, options, ts.sys).resolvedModule;
      if (!resolved || resolved.isExternalLibraryImport) continue;
      const depRel = rel(repoRoot, resolved.resolvedFileName);
      if (depRel !== relPath && known.has(depRel)) deps.add(depRel);
    }
    index.set(relPath, [...deps]);
  }
  return index;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// Default fan-in above which a file is treated as a "hub" (shared types,
// hooks, design tokens) and excluded from union-merging its importers.
//
// Tuned empirically against this repo's real src/ tree (938 scannable
// files). Fan-in decays gradually here rather than splitting cleanly into
// "a few hubs" vs "everything else" (98.9% of files have fan-in <= 2), so no
// threshold fully isolates the codebase into small clusters — but 3 is the
// floor that still keeps a hook-with-two-consumers pattern (fan-in 2) merged
// as one cluster, and it's also empirically the best available:
//   no exclusion (baseline): largest cluster 928/938 files (98.9%)
//   threshold 3:             largest cluster 553/938 files (59.0%), 180 clusters
//   threshold 5:             largest cluster 736/938 files (78.5%)
//   threshold 15:            largest cluster 824/938 files (87.8%)
// Lower thresholds (e.g. 2) fragment further (largest cluster 7.0%) but
// start excluding fan-in-2 files, which breaks the "shared hook + its
// consumers" grouping this feature exists to preserve. The remaining ~59%
// cluster at threshold 3 reflects genuine transitive coupling through many
// low/mid fan-in files, not a single fixable hub — that residual coupling is
// exactly what the reconciliation pass (a later task) is designed to examine
// via the cross-cluster edges annotateCrossClusterEdges records.
const DEFAULT_HUB_THRESHOLD = 3;

// Group files into clusters by actual coupling (undirected connectivity in
// the import graph) rather than directory structure or packing order — a
// hook imported by six components across four folders lands in the same
// cluster as those consumers.
//
// A file imported by a huge number of unrelated consumers (shared types,
// design tokens, a top-level hook) is excluded from acting as a merge
// bridge: it still gets clustered (typically as its own singleton), but its
// importers are NOT unioned together through it. Without this, high-fan-in
// "hub" files transitively fuse nearly the entire codebase into one giant
// cluster, defeating the point of clustering. Those hub edges are not lost —
// annotateCrossClusterEdges records them as cross-cluster edges for the
// reconciliation pass to examine.
export function clusterFiles(
  adj: Map<string, string[]>,
  allFiles: string[],
  hubThreshold: number = DEFAULT_HUB_THRESHOLD
): string[][] {
  const fanIn = new Map<string, number>();
  for (const [, deps] of adj) {
    for (const dep of deps) fanIn.set(dep, (fanIn.get(dep) ?? 0) + 1);
  }

  const uf = new UnionFind();
  for (const f of allFiles) uf.find(f);
  for (const [file, deps] of adj) {
    for (const dep of deps) {
      if ((fanIn.get(dep) ?? 0) >= hubThreshold) continue;
      uf.union(file, dep);
    }
  }
  const groups = new Map<string, string[]>();
  for (const f of allFiles) {
    const root = uf.find(f);
    const g = groups.get(root) ?? [];
    g.push(f);
    groups.set(root, g);
  }
  return [...groups.values()];
}

// Pack whole clusters into token-bounded units. Clusters containing an entry
// point go first, in entry order. A cluster too large for one unit is split
// internally as a fallback — with hub exclusion in clusterFiles this should
// only hit a genuinely large, tightly-coupled cluster (e.g. one feature
// area), not most of the codebase; before hub exclusion existed this path
// was silently dominant (~98% of files in one repo we measured), which is
// exactly what hub exclusion fixes.
export function packClusters(
  clusters: string[][],
  entryOrder: string[],
  tokensOf: (path: string) => number,
  budget: number
): WorkUnit[] {
  const entryIndex = new Map(entryOrder.map((f, i) => [f, i]));
  const rank = (cluster: string[]) =>
    cluster.reduce((m, f) => Math.min(m, entryIndex.get(f) ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  const sorted = [...clusters].sort((a, b) => rank(a) - rank(b));

  const units: WorkUnit[] = [];
  let cur: string[] = [];
  let curTokens = 0;
  const nextId = () => `unit-${String(units.length + 1).padStart(3, '0')}`;
  const flush = () => {
    if (cur.length) {
      units.push({ id: nextId(), files: cur, approxTokens: curTokens });
      cur = [];
      curTokens = 0;
    }
  };

  for (const cluster of sorted) {
    const clusterTokens = cluster.reduce((sum, f) => sum + tokensOf(f), 0);
    if (clusterTokens > budget) {
      flush();
      let sub: string[] = [];
      let subTokens = 0;
      for (const f of cluster) {
        const t = tokensOf(f);
        if (t > budget) {
          units.push({ id: nextId(), files: [f], approxTokens: t, oversizedFile: f });
          continue;
        }
        if (subTokens + t > budget) {
          units.push({ id: nextId(), files: sub, approxTokens: subTokens });
          sub = [];
          subTokens = 0;
        }
        sub.push(f);
        subTokens += t;
      }
      if (sub.length) units.push({ id: nextId(), files: sub, approxTokens: subTokens });
      continue;
    }
    if (curTokens + clusterTokens > budget) flush();
    cur.push(...cluster);
    curTokens += clusterTokens;
  }
  flush();
  return units;
}

// Every import that crosses a unit boundary, recorded on both the exporting
// and importing unit — this is what the reconciliation pass consumes.
export function annotateCrossClusterEdges(units: WorkUnit[], adj: Map<string, string[]>): WorkUnit[] {
  const unitOf = new Map<string, string>();
  for (const u of units) for (const f of u.files) unitOf.set(f, u.id);

  const edgesByUnit = new Map<string, CrossClusterEdge[]>();
  const push = (unitId: string, edge: CrossClusterEdge) => {
    const list = edgesByUnit.get(unitId) ?? [];
    list.push(edge);
    edgesByUnit.set(unitId, list);
  };

  for (const [from, deps] of adj) {
    const fromUnit = unitOf.get(from);
    if (!fromUnit) continue;
    for (const to of deps) {
      const toUnit = unitOf.get(to);
      if (!toUnit || toUnit === fromUnit) continue;
      const edge: CrossClusterEdge = { from, to, fromUnit, toUnit };
      push(fromUnit, edge);
      push(toUnit, edge);
    }
  }
  return units.map((u) => ({ ...u, crossClusterEdges: edgesByUnit.get(u.id) ?? [] }));
}

export function buildUnits(
  repoRoot: string,
  cfg: AdapterConfig,
  files: FileRecord[]
): { units: WorkUnit[]; orphans: string[]; texts: Map<string, string> } {
  const scannable = files.filter((f) => f.scanned);
  const byPath = new Map(scannable.map((f) => [f.path, f]));
  const texts = new Map<string, string>();
  const readText = (relPath: string): string => {
    if (texts.has(relPath)) return texts.get(relPath)!;
    let t = '';
    try {
      t = readFileSync(join(repoRoot, relPath), 'utf8');
    } catch {
      t = '';
    }
    texts.set(relPath, t);
    return t;
  };

  const adj = buildImportIndex(repoRoot, scannable.map((f) => join(repoRoot, f.path)));

  // Reachability from entry points, purely to identify true orphans.
  const entries = scannable.filter((f) => f.role === 'entry').map((f) => f.path).sort();
  const visited = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const dep of adj.get(cur) ?? []) if (!visited.has(dep)) queue.push(dep);
  }
  const allPaths = scannable.map((f) => f.path);
  const orphans = allPaths.filter((p) => !visited.has(p));

  const tokensOf = (p: string) => Math.ceil((byPath.get(p)?.bytes ?? readText(p).length) / cfg.charsPerToken);
  const clusters = clusterFiles(adj, allPaths);
  const packed = packClusters(clusters, entries, tokensOf, cfg.unitTokenBudget);
  const units = annotateCrossClusterEdges(packed, adj);

  return { units, orphans, texts };
}
