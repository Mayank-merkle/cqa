import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Deterministic discovery of project-authored markdown docs (code, no AI).
// These are a much higher-fidelity source of domain context than a human
// guessing at framework/CMS foot-guns in a regex rule — a doc like
// "page-querying-and-restitching.md" explains *why* a multi-query fan-out
// pattern exists, which a static rule can only ever misread as an N+1 bug.
// This step only finds candidate docs; PROJECT_DOCS_BRIEF.md (an AI pass)
// decides which are worth summarizing and how.

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.next', '.swc', 'dist', 'build', 'coverage', 'cdk.out', '.claude']);

// The CQA engine's own bundled docs (README/PLAN/DISCOVERY.md/...) describe
// the pipeline itself, not the project being scanned — never relevant here.
// Matched by relative path, not by directory name, so a project's own
// unrelated top-level `tools/` directory isn't skipped wholesale.
const SKIP_RELATIVE_PATHS = new Set(['tools/cqa']);

export interface DocCandidate {
  path: string; // repo-relative, forward slashes
  bytes: number;
  firstHeading: string | null;
}

export function findProjectDocs(repoRoot: string, maxDepth = 4): DocCandidate[] {
  const docs: DocCandidate[] = [];

  function firstHeading(absPath: string): string | null {
    try {
      const text = readFileSync(absPath, 'utf8');
      const match = text.split(/\r?\n/).find((l) => l.trimStart().startsWith('#'));
      return match ? match.replace(/^#+\s*/, '').trim() : null;
    } catch {
      return null;
    }
  }

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        const rel = relative(repoRoot, abs).split(sep).join('/');
        if (SKIP_DIR_NAMES.has(e.name) || SKIP_RELATIVE_PATHS.has(rel)) continue;
        walk(abs, depth + 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        let bytes = 0;
        try {
          bytes = readFileSync(abs).length;
        } catch {
          continue;
        }
        docs.push({
          path: relative(repoRoot, abs).split(sep).join('/'),
          bytes,
          firstHeading: firstHeading(abs),
        });
      }
    }
  }

  walk(repoRoot, 0);
  return docs.sort((a, b) => a.path.localeCompare(b.path));
}

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');
  const docs = findProjectDocs(repoRoot);

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project-docs-input.json'), JSON.stringify(docs, null, 2));
  console.log(`[cqa] project-docs-input.json: ${docs.length} markdown file(s) found`);
}

if (require.main === module) {
  main();
}
