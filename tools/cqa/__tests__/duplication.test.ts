import { findDuplicateBlocks } from '../duplication';

const SHARED_BLOCK = [
  'function fetchWithRetry(url, attempts) {',
  '  for (let i = 0; i < attempts; i++) {',
  '    const res = await fetch(url);',
  '    if (res.ok) return res;',
  '    await sleep(100 * i);',
  '  }',
  '  throw new Error("failed");',
].join('\n');

describe('findDuplicateBlocks', () => {
  it('detects a duplicated block copy-pasted across two different files', () => {
    const files = [
      { file: 'a.ts', text: `// file a\n${SHARED_BLOCK}\nconsole.log("a-specific");` },
      { file: 'b.ts', text: `// file b\n${SHARED_BLOCK}\nconsole.log("b-specific");` },
    ];

    const blocks = findDuplicateBlocks(files, 4);

    expect(blocks.length).toBeGreaterThan(0);
    const files_ = blocks[0].locations.map((l) => l.file).sort();
    expect(files_).toEqual(['a.ts', 'b.ts']);
    expect(blocks[0].lines).toBeGreaterThanOrEqual(4);
  });

  it('tags cross-workspace duplicates with their workspace name', () => {
    const files = [
      { workspace: 'serviceA', file: 'index.ts', text: SHARED_BLOCK },
      { workspace: 'serviceB', file: 'index.ts', text: SHARED_BLOCK },
    ];

    const blocks = findDuplicateBlocks(files, 4);

    expect(blocks.length).toBeGreaterThan(0);
    const workspaces = blocks[0].locations.map((l) => l.workspace).sort();
    expect(workspaces).toEqual(['serviceA', 'serviceB']);
  });

  it('does not flag unrelated files with no shared content', () => {
    const files = [
      { file: 'a.ts', text: 'export function add(a, b) { return a + b; }' },
      { file: 'b.ts', text: 'export function multiply(a, b) { return a * b; }' },
    ];

    expect(findDuplicateBlocks(files, 4)).toEqual([]);
  });

  it('ignores import-only and boilerplate-only overlap between files', () => {
    const files = [
      {
        file: 'a.ts',
        text: [
          "import { readFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "import type { Foo } from './types';",
          "'use strict';",
          '{',
          '}',
          'export function uniqueLogicA() { return 1; }',
        ].join('\n'),
      },
      {
        file: 'b.ts',
        text: [
          "import { readFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "import type { Foo } from './types';",
          "'use strict';",
          '{',
          '}',
          'export function uniqueLogicB() { return 2; }',
        ].join('\n'),
      },
    ];

    expect(findDuplicateBlocks(files, 4)).toEqual([]);
  });

  it('merges consecutive matching windows into one span instead of many overlapping ones', () => {
    const files = [
      { file: 'a.ts', text: SHARED_BLOCK },
      { file: 'b.ts', text: SHARED_BLOCK },
    ];

    const blocks = findDuplicateBlocks(files, 4);

    // The whole 7-line shared block should collapse into a single reported
    // span per pair, not one block per overlapping 4-line window.
    const pairCount = blocks.filter((b) => b.locations[0].file === 'a.ts' && b.locations[1].file === 'b.ts').length;
    expect(pairCount).toBe(1);
    expect(blocks[0].lines).toBe(7);
  });

  it('sorts the biggest duplicated span first', () => {
    const bigBlock = Array.from({ length: 12 }, (_, i) => `const step${i} = compute(${i});`).join('\n');
    const smallBlock = ['const x = 1;', 'const y = 2;', 'const z = 3;', 'const w = 4;'].join('\n');
    const files = [
      { file: 'a.ts', text: `${bigBlock}\nconsole.log("a-divider-unmatched");\n${smallBlock}` },
      { file: 'b.ts', text: `${bigBlock}\nconsole.log("b-divider-unmatched");\n${smallBlock}` },
      { file: 'c.ts', text: smallBlock },
    ];

    const blocks = findDuplicateBlocks(files, 4);

    expect(blocks[0].lines).toBeGreaterThanOrEqual(blocks[blocks.length - 1].lines);
    expect(blocks[0].lines).toBe(12);
  });
});
