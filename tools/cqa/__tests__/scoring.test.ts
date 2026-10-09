import { weightOf, weightedPoints, densityPerKloc, gradeFor, scoreFindings } from '../scoring';
import type { JudgedFinding } from '../types';

function finding(id: string, dimension: JudgedFinding['dimension'], severity: JudgedFinding['severity']): JudgedFinding {
  return {
    id,
    ruleId: id,
    category: 'test category',
    dimension,
    severity,
    source: 'pattern',
    collector: 'regex',
    occurrences: 1,
    evidence: [{ file: 'src/a.ts', line: 1, snippet: 'x' }],
    description: 'd',
    suggestedFix: 'f',
    verdict: 'CONFIRMED',
    rationale: 'r',
  };
}

describe('weightOf', () => {
  it('maps each severity to its fixed point weight', () => {
    expect(weightOf('Critical')).toBe(10);
    expect(weightOf('High')).toBe(5);
    expect(weightOf('Medium')).toBe(2);
    expect(weightOf('Low')).toBe(1);
  });
});

describe('weightedPoints', () => {
  it('sums severity weights across a list of findings', () => {
    const findings = [finding('a', 'Security', 'Critical'), finding('b', 'Security', 'Low')];
    expect(weightedPoints(findings)).toBe(11);
  });

  it('returns 0 for an empty list', () => {
    expect(weightedPoints([])).toBe(0);
  });
});

describe('densityPerKloc', () => {
  it('divides weighted points by thousands of lines', () => {
    expect(densityPerKloc(20, 10000)).toBe(2);
  });

  it('returns 0 when there are no lines (avoids divide-by-zero)', () => {
    expect(densityPerKloc(20, 0)).toBe(0);
  });
});

describe('gradeFor', () => {
  it('grades A at or below 0.5 points per KLOC', () => {
    expect(gradeFor(0)).toBe('A');
    expect(gradeFor(0.5)).toBe('A');
  });

  it('grades B above 0.5 and at or below 2', () => {
    expect(gradeFor(0.51)).toBe('B');
    expect(gradeFor(2)).toBe('B');
  });

  it('grades C above 2 and at or below 5', () => {
    expect(gradeFor(2.01)).toBe('C');
    expect(gradeFor(5)).toBe('C');
  });

  it('grades D above 5 and at or below 10', () => {
    expect(gradeFor(5.01)).toBe('D');
    expect(gradeFor(10)).toBe('D');
  });

  it('grades E above 10', () => {
    expect(gradeFor(10.01)).toBe('E');
  });
});

describe('scoreFindings', () => {
  it('produces a per-category and overall grade from weighted density', () => {
    const findings = [
      finding('a', 'Security', 'Critical'),
      finding('b', 'Reliability', 'Low'),
    ];
    const result = scoreFindings(findings, 1000); // 1 KLOC

    expect(result.byCategory.Security!.pointsPerKloc).toBe(10);
    expect(result.byCategory.Security!.grade).toBe('D');
    expect(result.byCategory.Reliability!.pointsPerKloc).toBe(1);
    expect(result.byCategory.Reliability!.grade).toBe('B');
    expect(result.overall.totalWeightedPoints).toBe(11);
    expect(result.overall.pointsPerKloc).toBe(11);
    expect(result.overall.grade).toBe('E');
  });

  it('only includes categories that have at least one finding', () => {
    const findings = [finding('a', 'Security', 'Low')];
    const result = scoreFindings(findings, 1000);

    expect(Object.keys(result.byCategory)).toEqual(['Security']);
  });

  it('grades an empty finding set as A with zero points', () => {
    const result = scoreFindings([], 1000);

    expect(result.overall.grade).toBe('A');
    expect(result.overall.totalWeightedPoints).toBe(0);
    expect(result.byCategory).toEqual({});
  });
});
