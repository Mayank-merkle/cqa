import { parseCoverageSummary, mergeCandidates } from '../collectors';
import type { Candidate } from '../types';

function regexCandidate(ruleId: string, evidence: { file: string; line: number }[]): Candidate {
  return {
    id: `${ruleId}:x`,
    ruleId,
    category: ruleId,
    dimension: 'Maintainability',
    severity: 'Low',
    source: 'pattern',
    collector: 'regex',
    occurrences: evidence.length,
    evidence: evidence.map((e) => ({ ...e, snippet: 'x' })),
    description: 'd',
    suggestedFix: 'f',
  };
}

function eslintCandidate(ruleId: string, evidence: { file: string; line: number }[]): Candidate {
  return {
    id: `eslint:${ruleId}:x`,
    ruleId: `eslint:${ruleId}`,
    category: `eslint: ${ruleId}`,
    dimension: 'Maintainability',
    severity: 'Low',
    source: 'pattern',
    collector: 'eslint',
    occurrences: evidence.length,
    evidence: evidence.map((e) => ({ ...e, snippet: 'x' })),
    description: 'd',
    suggestedFix: 'f',
  };
}

describe('mergeCandidates', () => {
  it('drops a regex candidate entirely when every one of its locations is also flagged by the known-overlapping eslint rule', () => {
    const regex = regexCandidate('next.raw-img-tag', [{ file: 'a.tsx', line: 10 }]);
    const eslint = eslintCandidate('@next/next/no-img-element', [{ file: 'a.tsx', line: 10 }]);

    const merged = mergeCandidates([[regex], [eslint]]);

    expect(merged.map((c) => c.id)).toEqual([eslint.id]);
  });

  it('trims only the overlapping locations, keeping a regex candidate’s locations eslint did not also flag', () => {
    const regex = regexCandidate('general.any-type', [
      { file: 'a.ts', line: 1 },
      { file: 'b.ts', line: 5 },
    ]);
    const eslint = eslintCandidate('@typescript-eslint/no-explicit-any', [{ file: 'a.ts', line: 1 }]);

    const merged = mergeCandidates([[regex], [eslint]]);
    const survivingRegex = merged.find((c) => c.collector === 'regex')!;

    expect(survivingRegex.evidence).toEqual([{ file: 'b.ts', line: 5, snippet: 'x' }]);
    expect(survivingRegex.occurrences).toBe(1);
  });

  it('does not collapse two unrelated candidates that merely share a file:line with no declared overlap', () => {
    const regex = regexCandidate('general.stale-todo', [{ file: 'a.ts', line: 1 }]);
    const eslint = eslintCandidate('no-unused-vars', [{ file: 'a.ts', line: 1 }]);

    const merged = mergeCandidates([[regex], [eslint]]);

    expect(merged.map((c) => c.id).sort()).toEqual([eslint.id, regex.id].sort());
  });
});

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
