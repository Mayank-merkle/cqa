import { normalizeReconciliationFindings } from '../merge-reconciliation';

describe('normalizeReconciliationFindings', () => {
  it('coerces an unrecognized dimension instead of trusting the AI label verbatim', () => {
    const [candidate] = normalizeReconciliationFindings([
      {
        category: 'Unmemoized context causing cross-module re-renders',
        dimension: 'Memory', // not a real Dimension value
        severity: 'Medium',
        file: 'src/context/SearchContext.tsx',
        line: 18,
        snippet: 'const value = { results, setResults };',
        description: 'New object identity every render.',
        suggestedFix: 'Wrap in useMemo.',
      },
    ]);

    expect(candidate.dimension).toBe('Reliability'); // the fallback for this merger
  });

  it('keeps a valid dimension as given', () => {
    const [candidate] = normalizeReconciliationFindings([
      {
        category: 'Contract mismatch',
        dimension: 'Performance',
        severity: 'Low',
        file: 'src/a.ts',
        line: 1,
      },
    ]);

    expect(candidate.dimension).toBe('Performance');
  });

  it('skips findings with no file:line anchor', () => {
    const candidates = normalizeReconciliationFindings([{ category: 'x', dimension: 'Reliability' }]);

    expect(candidates).toHaveLength(0);
  });
});
