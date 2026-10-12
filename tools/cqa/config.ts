// Stack adapter config. The ONLY stack-specific file. Add a sibling config
// for another stack (e.g. WordPress) and select it by detection; the rest of
// the pipeline is stack-agnostic.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface AdapterConfig {
  id: string;
  // Returns true if this adapter applies to the repo at repoRoot. Checked in
  // registry order (see `adapters` below) — first match wins.
  detect: (repoRoot: string) => boolean;
  srcDir: string;
  alias: Record<string, string>;
  extensions: string[];
  entryMatchers: RegExp[];
  skip: { pattern: RegExp; reason: string }[];
  charsPerToken: number;
  unitTokenBudget: number;
  notMeasured: string[];
  // Which deterministic collectors to run. Each is best-effort: if the tool
  // isn't available it's skipped and recorded in the manifest.
  collectors: {
    regex: boolean;
    eslint: boolean;
    npmAudit: boolean;
    orphans: boolean;
    testCoverage: boolean;
  };
  eslintCmd: string; // produces eslint JSON on stdout
  npmAuditCmd: string; // produces npm audit JSON on stdout
  // Runs the project's own test suite with coverage enabled. Adapter-specific
  // because the test runner (and its coverage flags) isn't necessarily Jest —
  // the collector never hardcodes `--coverage` itself, it just invokes this.
  testCoverageCmd: string;
  // Repo-relative path to the Istanbul/Jest-style json-summary coverage file
  // the command above produces (e.g. `coverage/coverage-summary.json`).
  coverageSummaryPath: string;
  // Line-coverage percentage below which a file is flagged as low-coverage.
  coverageThreshold: number;
  // Packages whose version-specific API surface actually matters to this
  // stack's discovery pass (framework/runtime packages with meaningful
  // breaking-change history), not every dependency in package.json — each
  // costs 2 Context7 calls (resolve-library-id + query-docs) in
  // VERSION_BRIEF.md, so this is deliberately narrow.
  versionRelevantPackages: string[];
}

// All dependencies (prod + dev) declared in repoRoot/package.json. Shared by
// detectVersions and every adapter's detect(). Throws if package.json is
// missing/malformed — callers that want a safe default catch it themselves.
function readAllDependencies(repoRoot: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
}

// Reports versions only for `packages` (an adapter's `versionRelevantPackages`)
// rather than every dependency in package.json — see that field's comment for
// why. A requested package absent from the repo is reported as 'unknown'
// rather than omitted, so VERSION_BRIEF.md's fallback has something to key on.
export function detectVersions(repoRoot: string, packages: string[]): Record<string, string> {
  try {
    const deps = readAllDependencies(repoRoot);
    const clean = (v?: string) => (v ? v.replace(/^[\^~]/, '') : 'unknown');
    const versions: Record<string, string> = {};
    for (const pkg of packages) {
      versions[pkg] = clean(deps[pkg]);
    }
    return versions;
  } catch {
    return {};
  }
}

// true if `name` appears in repoRoot/package.json's dependencies or devDependencies.
function hasDependency(repoRoot: string, name: string): boolean {
  try {
    return name in readAllDependencies(repoRoot);
  } catch {
    return false;
  }
}

// A CDK app's `cdk.json` lives at the CDK app root (e.g. `hotel-api/cdk/cdk.json`),
// but a Lambda handler package nested under it (e.g.
// `hotel-api/cdk/lambdas/getCurrency`) is its own npm workspace — it has its
// own package.json (which is how findWorkspaceRoots finds it) but often has
// none of its own aws-cdk-lib/aws-lambda markers. Verified against the real
// DotcomV2-AppSync monorepo: packages like `profile-api/cdk/lambdas/getAgentProfile`
// and `ssm-params/lambdas/appConfig` depend on nothing but `axios`. Walking a
// bounded number of ancestor directories looking for the CDK app's own
// cdk.json catches these without guessing from dependencies that aren't there.
function hasAncestorCdkJson(repoRoot: string, maxLevels = 3): boolean {
  let dir = repoRoot;
  for (let i = 0; i < maxLevels; i++) {
    const parent = dirname(dir);
    if (parent === dir) return false; // reached filesystem root
    dir = parent;
    if (existsSync(join(dir, 'cdk.json'))) return true;
  }
  return false;
}

export const nextContentful: AdapterConfig = {
  id: 'next-contentful',
  detect: (repoRoot) => hasDependency(repoRoot, 'next'),
  srcDir: 'src',
  alias: { '@/': 'src/' },
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],

  entryMatchers: [
    /\/app\/.*\/(page|layout|template|loading|error|not-found|default|global-error)\.(t|j)sx?$/,
    /\/app\/.*\/route\.(t|j)s$/,
    /\/middleware\.(t|j)s$/,
    /\/auth\.(t|j)s$/,
    /\/app\/.*\/(opengraph-image|sitemap|robots|manifest)\.(t|j)sx?$/
  ],

  skip: [
    { pattern: /node_modules\//, reason: 'dependency' },
    { pattern: /\.next\//, reason: 'build output' },
    { pattern: /\.swc\//, reason: 'build cache' },
    { pattern: /\/public\//, reason: 'static asset' },
    {
      pattern: /\.generated\.(t|j)sx?$/,
      reason: 'codegen output (never edited)'
    },
    { pattern: /\.stories\.(t|j)sx?$/, reason: 'storybook story' },
    { pattern: /\.(test|spec)\.(t|j)sx?$/, reason: 'test file' },
    { pattern: /\/__mocks__\//, reason: 'test mock' },
    { pattern: /\/mockApi\//, reason: 'mock api infra' },
    { pattern: /\.d\.ts$/, reason: 'type declaration' }
  ],

  charsPerToken: 4,
  unitTokenBudget: 12000,

  notMeasured: [
    'Test coverage % (requires running the suite)',
    'Exact duplication %',
    'Runtime performance'
  ],

  collectors: { regex: true, eslint: true, npmAudit: true, orphans: true, testCoverage: true },
  eslintCmd: 'npx eslint "src/**/*.{ts,tsx,js,jsx}" --format json',
  npmAuditCmd: 'npm audit --json',
  testCoverageCmd: 'npm test -- --coverage --coverageReporters=json-summary',
  coverageSummaryPath: 'coverage/coverage-summary.json',
  coverageThreshold: 80,
  versionRelevantPackages: ['next', 'react', 'typescript', 'next-auth']
};

// AWS Lambda/AppSync/CDK adapter, verified against the real DotcomV2-AppSync
// monorepo (~33 independently-deployable services, no root package.json).
// That repo is NOT uniform: a CDK app root (e.g. `hotel-api/cdk`) declares
// aws-cdk-lib and has its own `cdk.json`; a Lambda handler package nested
// under it (e.g. `hotel-api/cdk/lambdas/getCurrency`) is a separate npm
// workspace that may declare `aws-lambda`/`@types/aws-lambda` itself, or may
// declare nothing AWS-specific at all (just `axios`) and only be identifiable
// by its CDK-app ancestor's cdk.json (see hasAncestorCdkJson above). A plain
// Express service with no AWS deps anywhere in its tree (e.g.
// `contentful-search`) correctly matches neither condition and falls through
// to "no adapter matched" rather than being guessed into this stack.
export const awsLambdaCdk: AdapterConfig = {
  id: 'aws-lambda-cdk',
  detect: (repoRoot) =>
    existsSync(join(repoRoot, 'cdk.json')) ||
    hasDependency(repoRoot, 'aws-cdk-lib') ||
    hasDependency(repoRoot, 'aws-lambda') ||
    hasDependency(repoRoot, '@types/aws-lambda') ||
    hasAncestorCdkJson(repoRoot),
  srcDir: '.',
  alias: {},
  extensions: ['.ts', '.js', '.mjs'],

  // Grounded in the real repo's actual layout, not generic AWS convention —
  // it uses `lambdas/<name>/index.ts`, not `handler.ts`.
  entryMatchers: [
    /\/bin\/[^/]+\.(t|j)s$/, // CDK app entry point (e.g. bin/hotel-api.ts)
    /\/lib\/.*(stack|construct)\.(t|j)s$/, // CDK stack/construct definitions
    /\/lambdas\/[^/]+\/index\.(t|j)s$/, // Lambda handler, scanned from a CDK app root
    /^\/index\.(t|j)s$/ // Lambda handler, scanned as its own leaf workspace (e.g. getCurrency)
  ],

  skip: [
    { pattern: /node_modules\//, reason: 'dependency' },
    // No leading `\/` on these three: unlike nextContentful (srcDir 'src'),
    // this adapter's srcDir is the workspace root itself, so build output
    // dirs like `dist/` commonly appear as the FIRST path segment (no
    // preceding slash) — verified against the real repo, where
    // `hotel-api/cdk/dist/...` duplicates the whole compiled tree.
    { pattern: /dist\//, reason: 'build output' },
    { pattern: /cdk\.out\//, reason: 'cdk synth output' },
    { pattern: /coverage\//, reason: 'test coverage output' },
    { pattern: /\.d\.ts$/, reason: 'type declaration' },
    { pattern: /\.(test|spec)\.(t|j)s$/, reason: 'test file' },
    { pattern: /\/__mocks__\//, reason: 'test mock' }
  ],

  charsPerToken: 4,
  unitTokenBudget: 12000,

  notMeasured: [
    'Test coverage % (requires running the suite)',
    'Exact duplication %',
    'Runtime performance',
    'Deployed infra drift (reviewed CDK code, not live stack state)'
  ],

  // eslint/testCoverage are best-effort here more than for nextContentful:
  // many leaf Lambda packages in the real repo (e.g. getAgentProfile,
  // appConfig) have no eslint config or test script of their own — the
  // collector already degrades to "skipped" when the command fails, which is
  // the correct outcome for those packages rather than an error.
  collectors: { regex: true, eslint: true, npmAudit: true, orphans: true, testCoverage: false },
  eslintCmd: 'npx eslint "**/*.{ts,js,mjs}" --format json',
  npmAuditCmd: 'npm audit --json',
  testCoverageCmd: 'npm test -- --coverage --coverageReporters=json-summary',
  coverageSummaryPath: 'coverage/coverage-summary.json',
  coverageThreshold: 80,
  // aws-lambda/@types/aws-lambda and aws-cdk-lib/constructs are this stack's
  // equivalents of next/react above — the packages whose breaking-change
  // history actually affects what the discovery pass should flag. typescript
  // carries over since both stacks compile through it.
  versionRelevantPackages: ['aws-cdk-lib', 'constructs', 'aws-lambda', '@types/aws-lambda', 'typescript']
};

// Registry of all known stack adapters, checked in order — first match wins.
// Add a new adapter here (e.g. a WordPress config) to extend the pipeline to
// another stack; nothing else in the pipeline needs to change.
export const adapters: AdapterConfig[] = [nextContentful, awsLambdaCdk];

export function detectAdapter(repoRoot: string): AdapterConfig {
  const match = adapters.find((a) => a.detect(repoRoot));
  if (!match) {
    const ids = adapters.map((a) => a.id).join(', ');
    throw new Error(
      `[cqa] no stack adapter matched this repo (checked: ${ids}). Add a new AdapterConfig in tools/cqa/config.ts with a detect() for this stack.`
    );
  }
  return match;
}

// Directories that are never a package root worth descending for, nor worth
// descending *into* — build output, dependency trees, VCS metadata, and (seen
// in practice scanning a real monorepo) Claude Code's own git-worktree
// scratch copies, which duplicate real service folders wholesale.
const WORKSPACE_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'cdk.out',
  '.next',
  'coverage',
  '.claude',
]);

// A monorepo (e.g. a collection of independently-deployable Lambda/CDK
// services with no root package.json) doesn't have one single repoRoot to
// detect against — it has many. Walk the tree (bounded depth, skipping the
// usual noise) and return every directory that has its own package.json,
// i.e. every independently-installable package/service.
export function findWorkspaceRoots(repoRoot: string, maxDepth = 4): string[] {
  const roots: string[] = [];

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
      roots.push(dir);
    }
    for (const e of entries) {
      if (!e.isDirectory() || WORKSPACE_SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), depth + 1);
    }
  }

  walk(repoRoot, 0);
  return roots;
}

export interface WorkspaceTarget {
  root: string;
  adapter: AdapterConfig | null; // null if no adapter matched this package yet
  reason?: string; // set when adapter is null
}

// The entry point for driving the pipeline against something that might be a
// single package (repoRoot has its own package.json — existing single-repo
// behavior, unchanged) or a monorepo with no root manifest (repoRoot itself
// has none, but subdirectories do — e.g. a collection of Lambda services each
// with their own package.json at varying depth). Never guesses silently: a
// package with no matching adapter is still returned, with `adapter: null`
// and a `reason`, so the caller can report it rather than drop it.
export function detectWorkspaces(repoRoot: string): WorkspaceTarget[] {
  const tryDetect = (root: string): WorkspaceTarget => {
    try {
      return { root, adapter: detectAdapter(root) };
    } catch (e) {
      return { root, adapter: null, reason: (e as Error).message };
    }
  };

  if (existsSync(join(repoRoot, 'package.json'))) {
    return [tryDetect(repoRoot)];
  }

  const workspaceRoots = findWorkspaceRoots(repoRoot);
  return workspaceRoots.map(tryDetect);
}

export default nextContentful;
