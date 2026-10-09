import { buildReconciliationInput } from '../prepare-reconciliation';
import { normalizeReconciliationFindings } from '../merge-reconciliation';
import type { Manifest } from '../types';

function manifest(workUnits: Manifest['workUnits']): Manifest {
  return {
    stack: 'test',
    detectedVersions: {},
    generatedAt: '2026-01-01',
    rulesVersion: '1',
    coverage: { totalFiles: 0, sourceFiles: 0, excludedFiles: 0, excludedByReason: {}, reviewedPct: 0, notMeasured: [] },
    collectors: [],
    workUnits,
  };
}

describe('buildReconciliationInput', () => {
  it('dedupes edges that appear on both sides and flags files with high fan-in', () => {
    const shared = { from: 'a.ts', to: 'shared.ts', fromUnit: 'unit-001', toUnit: 'unit-002' };
    const m = manifest([
      { id: 'unit-001', files: ['a.ts'], approxTokens: 10, crossClusterEdges: [shared] },
      {
        id: 'unit-002',
        files: ['shared.ts'],
        approxTokens: 10,
        crossClusterEdges: [
          shared,
          { from: 'b.ts', to: 'shared.ts', fromUnit: 'unit-003', toUnit: 'unit-002' },
          { from: 'c.ts', to: 'shared.ts', fromUnit: 'unit-004', toUnit: 'unit-002' },
          { from: 'd.ts', to: 'shared.ts', fromUnit: 'unit-005', toUnit: 'unit-002' },
        ],
      },
    ]);

    const input = buildReconciliationInput(m, {});

    expect(input.crossClusterEdges).toHaveLength(4);
    expect(input.highFanInFiles).toEqual([{ file: 'shared.ts', importedByCount: 4 }]);
  });

  it('groups edges by target file so a shared file is reviewed once, not once per edge', () => {
    const m = manifest([
      {
        id: 'unit-001',
        files: ['a.ts', 'b.ts'],
        approxTokens: 10,
        crossClusterEdges: [
          { from: 'a.ts', to: 'shared.ts', fromUnit: 'unit-001', toUnit: 'unit-002' },
          { from: 'b.ts', to: 'shared.ts', fromUnit: 'unit-001', toUnit: 'unit-002' },
          { from: 'a.ts', to: 'rare.ts', fromUnit: 'unit-001', toUnit: 'unit-003' },
        ],
      },
    ]);

    const input = buildReconciliationInput(m, {});

    // Exhaustive and unfiltered: every unique target becomes its own group, no
    // thresholding — a single-incoming-edge target still gets a group.
    expect(input.targetGroups).toHaveLength(2);
    // Sorted with the highest fan-in group first.
    expect(input.targetGroups[0]).toEqual({
      file: 'shared.ts',
      importedByCount: 2,
      incomingEdges: [
        { from: 'a.ts', fromUnit: 'unit-001' },
        { from: 'b.ts', fromUnit: 'unit-001' },
      ],
    });
    expect(input.targetGroups[1]).toEqual({
      file: 'rare.ts',
      importedByCount: 1,
      incomingEdges: [{ from: 'a.ts', fromUnit: 'unit-001' }],
    });
  });
});

describe('normalizeReconciliationFindings', () => {
  it('drops findings with no file:line anchor and normalizes the rest', () => {
    const result = normalizeReconciliationFindings([
      { category: 'Re-render', dimension: 'Performance', severity: 'Medium', file: 'a.ts', line: 5, snippet: 'x', description: 'd', suggestedFix: 'f' },
      { category: 'No anchor', description: 'missing file/line' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].collector).toBe('reconciliation');
    expect(result[0].evidence).toEqual([{ file: 'a.ts', line: 5, snippet: 'x' }]);
  });
});
