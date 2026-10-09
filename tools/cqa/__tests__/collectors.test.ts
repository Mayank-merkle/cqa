import { parseCoverageSummary } from '../collectors';

describe('parseCoverageSummary', () => {
  const repoRoot = '/repo';

  it('reports the overall line-coverage percentage from the "total" entry', () => {
    const summary = {
      total: { lines: { pct: 87.5 } },
      '/repo/src/a.ts': { lines: { pct: 100 } },
    };

    const { overallPct } = parseCoverageSummary(summary, repoRoot, 80);

    expect(overallPct).toBe(87.5);
  });

  it('flags files below the threshold and converts absolute paths to repo-relative, forward-slashed paths', () => {
    const summary = {
      total: { lines: { pct: 70 } },
      '/repo/src/a.ts': { lines: { pct: 40 } },
      '/repo/src/b.ts': { lines: { pct: 95 } },
    };

    const { lowCoverageFiles } = parseCoverageSummary(summary, repoRoot, 80);

    expect(lowCoverageFiles).toEqual([{ file: 'src/a.ts', pct: 40 }]);
  });

  it('sorts low-coverage files from worst to least-bad', () => {
    const summary = {
      total: { lines: { pct: 50 } },
      '/repo/src/a.ts': { lines: { pct: 60 } },
      '/repo/src/b.ts': { lines: { pct: 10 } },
      '/repo/src/c.ts': { lines: { pct: 40 } },
    };

    const { lowCoverageFiles } = parseCoverageSummary(summary, repoRoot, 80);

    expect(lowCoverageFiles.map((f) => f.file)).toEqual(['src/b.ts', 'src/c.ts', 'src/a.ts']);
  });

  it('skips entries with no numeric line-coverage percentage', () => {
    const summary = {
      total: { lines: { pct: 50 } },
      '/repo/src/a.ts': {},
      '/repo/src/b.ts': { lines: { pct: 'not-a-number' } },
    };

    const { lowCoverageFiles } = parseCoverageSummary(summary, repoRoot, 80);

    expect(lowCoverageFiles).toEqual([]);
  });

  it('treats a missing or malformed summary as zero coverage with no flagged files', () => {
    expect(parseCoverageSummary(undefined, repoRoot, 80)).toEqual({ overallPct: 0, lowCoverageFiles: [] });
    expect(parseCoverageSummary({}, repoRoot, 80)).toEqual({ overallPct: 0, lowCoverageFiles: [] });
  });
});
