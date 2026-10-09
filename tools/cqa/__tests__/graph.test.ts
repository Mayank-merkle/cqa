import { join } from 'node:path';
import { buildUnits } from '../graph';
import type { AdapterConfig } from '../config';
import type { FileRecord } from '../types';

const FIXTURE_ROOT = join(__dirname, 'fixtures', 'graph-basic');

const cfg: AdapterConfig = {
  id: 'test',
  detect: () => true,
  srcDir: 'src',
  alias: { '@/': 'src/' },
  extensions: ['.ts', '.tsx'],
  entryMatchers: [/entry\.ts$/],
  skip: [],
  charsPerToken: 4,
  unitTokenBudget: 12000,
  notMeasured: [],
  collectors: { regex: false, eslint: false, npmAudit: false, orphans: false },
  eslintCmd: '',
  npmAuditCmd: '',
};

function fileRecord(path: string, role: FileRecord['role']): FileRecord {
  return { path, role, bytes: 100, scanned: true };
}

describe('buildUnits (compiler-based resolution)', () => {
  it('resolves alias imports and does not mistake a string literal for a real import', () => {
    const files: FileRecord[] = [
      fileRecord('src/entry.ts', 'entry'),
      fileRecord('src/lib/util.ts', 'source'),
      fileRecord('src/lib/shouldNotCount.ts', 'source'),
    ];

    const { units, orphans } = buildUnits(FIXTURE_ROOT, cfg, files);
    const allFiles = units.flatMap((u) => u.files);

    expect(allFiles).toContain('src/entry.ts');
    expect(allFiles).toContain('src/lib/util.ts');
    // Real edge (alias import) is followed; the decoy string is not.
    expect(orphans).toEqual(['src/lib/shouldNotCount.ts']);
  });
});
