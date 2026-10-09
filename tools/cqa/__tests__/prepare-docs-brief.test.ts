import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProjectDocs } from '../prepare-docs-brief';

describe('findProjectDocs', () => {
  it('finds markdown docs, with their first heading and byte size', () => {
    const root = mkdtempSync(join(tmpdir(), 'cqa-docs-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'guide.md'), '# My Guide\n\nSome content here.');
    writeFileSync(join(root, 'README.md'), 'No heading, just text.');

    const docs = findProjectDocs(root);

    expect(docs).toEqual([
      { path: 'docs/guide.md', bytes: 30, firstHeading: 'My Guide' },
      { path: 'README.md', bytes: 22, firstHeading: null },
    ]);
  });

  it('excludes the CQA engine\'s own bundled docs under tools/cqa', () => {
    const root = mkdtempSync(join(tmpdir(), 'cqa-docs-'));
    mkdirSync(join(root, 'tools', 'cqa'), { recursive: true });
    writeFileSync(join(root, 'tools', 'cqa', 'README.md'), '# CQA engine docs');
    mkdirSync(join(root, 'tools', 'other-tool'), { recursive: true });
    writeFileSync(join(root, 'tools', 'other-tool', 'README.md'), '# Unrelated project tool');

    const docs = findProjectDocs(root);

    // tools/cqa is excluded, but an unrelated tools/ subdirectory is not.
    expect(docs.map((d) => d.path)).toEqual(['tools/other-tool/README.md']);
  });

  it('skips node_modules, .git, build output, and .claude', () => {
    const root = mkdtempSync(join(tmpdir(), 'cqa-docs-'));
    for (const dir of ['node_modules/some-pkg', '.git', 'dist', '.next', '.claude/cqa']) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'README.md'), '# noise');
    }

    expect(findProjectDocs(root)).toEqual([]);
  });

  it('returns an empty array when there are no markdown files at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'cqa-docs-'));
    writeFileSync(join(root, 'index.ts'), 'export {};');

    expect(findProjectDocs(root)).toEqual([]);
  });
});
