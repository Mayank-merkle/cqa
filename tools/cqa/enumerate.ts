import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { FileRecord, FileRole, Coverage } from './types';

// Walk srcDir recursively and classify every file. Deterministic — this is
// where "scanning the whole codebase" actually happens (by the filesystem,
// which has no context limit).

// Only the fields this module actually reads — narrower than the full
// AdapterConfig (which satisfies this structurally, so every existing caller
// is unaffected) so monorepo.ts can enumerate a workspace that matched no
// adapter at all using a minimal generic config, without needing to fabricate
// an eslintCmd/npmAuditCmd/etc. it has no use for.
export interface EnumerateConfig {
  srcDir: string;
  skip: { pattern: RegExp; reason: string }[];
  entryMatchers: RegExp[];
  notMeasured: string[];
}

function toRel(repoRoot: string, abs: string): string {
  return relative(repoRoot, abs).split(sep).join('/');
}

function classify(rel: string, cfg: EnumerateConfig): { role: FileRole; skipReason?: string } {
  for (const s of cfg.skip) {
    if (s.pattern.test(rel)) {
      if (/\.(test|spec)\./.test(rel)) return { role: 'test', skipReason: s.reason };
      if (/\.stories\./.test(rel)) return { role: 'story', skipReason: s.reason };
      if (/\.generated\./.test(rel)) return { role: 'generated', skipReason: s.reason };
      if (/__mocks__|mockApi/.test(rel)) return { role: 'mock', skipReason: s.reason };
      return { role: 'config', skipReason: s.reason };
    }
  }
  if (cfg.entryMatchers.some((m) => m.test('/' + rel))) return { role: 'entry' };
  if (/\.(t|j)sx?$/.test(rel) || /\.mjs$/.test(rel)) return { role: 'source' };
  return { role: 'config', skipReason: 'non-source file' };
}

export function enumerate(repoRoot: string, cfg: EnumerateConfig): {
  files: FileRecord[];
  coverage: Coverage;
} {
  const root = join(repoRoot, cfg.srcDir);
  const files: FileRecord[] = [];

  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const rel = toRel(repoRoot, abs);
      if (st.isDirectory()) {
        if (cfg.skip.some((s) => s.pattern.test(rel + '/'))) continue;
        walk(abs);
      } else {
        const { role, skipReason } = classify(rel, cfg);
        const scanned = role === 'source' || role === 'entry';
        files.push({ path: rel, role, bytes: st.size, scanned, skipReason });
      }
    }
  };
  walk(root);

  const sourceFiles = files.filter((f) => f.scanned).length;
  const excluded = files.filter((f) => !f.scanned);
  const excludedByReason: Record<string, number> = {};
  for (const f of excluded) {
    const r = f.skipReason ?? 'other';
    excludedByReason[r] = (excludedByReason[r] ?? 0) + 1;
  }

  const coverage: Coverage = {
    totalFiles: files.length,
    sourceFiles,
    excludedFiles: excluded.length,
    excludedByReason,
    reviewedPct: files.length ? Math.round((sourceFiles / files.length) * 100) : 0,
    notMeasured: [...cfg.notMeasured],
  };

  return { files, coverage };
}
