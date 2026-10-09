// Stack adapter config. The ONLY stack-specific file. Add a sibling config
// for another stack (e.g. WordPress) and select it by detection; the rest of
// the pipeline is stack-agnostic.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
  };
  eslintCmd: string; // produces eslint JSON on stdout
  npmAuditCmd: string; // produces npm audit JSON on stdout
}

// All dependencies (prod + dev) declared in repoRoot/package.json. Shared by
// detectVersions and every adapter's detect(). Throws if package.json is
// missing/malformed — callers that want a safe default catch it themselves.
function readAllDependencies(repoRoot: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
}

export function detectVersions(repoRoot: string): Record<string, string> {
  try {
    const deps = readAllDependencies(repoRoot);
    const clean = (v?: string) => (v ? v.replace(/^[\^~]/, '') : 'unknown');
    return {
      next: clean(deps.next),
      react: clean(deps.react),
      typescript: clean(deps.typescript),
      'next-auth': clean(deps['next-auth'])
    };
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

  collectors: { regex: true, eslint: true, npmAudit: true, orphans: true },
  eslintCmd: 'npx eslint "src/**/*.{ts,tsx,js,jsx}" --format json',
  npmAuditCmd: 'npm audit --json'
};

// Registry of all known stack adapters, checked in order — first match wins.
// Add a new adapter here (e.g. an AWS Lambda/AppSync config) to extend the
// pipeline to another stack; nothing else in the pipeline needs to change.
export const adapters: AdapterConfig[] = [nextContentful];

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
