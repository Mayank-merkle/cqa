import type { Dimension, JudgedFinding, Severity } from './types';

// Severity -> point weight. Info is excluded entirely (not scored), matching
// how Info-priority rules are informational-only, never gate-blocking.
const SEVERITY_WEIGHT: Record<Severity, number> = {
  Critical: 10,
  High: 5,
  Medium: 2,
  Low: 1,
};

export function weightOf(severity: Severity): number {
  return SEVERITY_WEIGHT[severity];
}

export function weightedPoints(findings: JudgedFinding[]): number {
  return findings.reduce((sum, f) => sum + weightOf(f.severity), 0);
}

export function densityPerKloc(points: number, lines: number): number {
  if (lines <= 0) return 0;
  return points / (lines / 1000);
}

export type Grade = 'A' | 'B' | 'C' | 'D' | 'E';

// Fixed density -> grade bands, calibrated against SEVERITY_WEIGHT above
// rather than an arbitrary 0-100 scale:
//   A <= 0.5   effectively clean — at most one Low-severity finding per
//              ~2,000 lines of source (1 point / 0.5 per KLOC), or the
//              rounding-down tail of a near-miss on B.
//   B <= 2     a small number of Low/Medium findings per KLOC, or roughly
//              one High-severity finding (5 points) per ~2,500 lines — the
//              normal state of most actively-developed code, not a red flag.
//   C <= 5     density of one High-severity finding roughly every 1,000
//              lines, or an equivalent mix of Medium/Low — worth a focused
//              cleanup pass, not an emergency.
//   D <= 10    density of one Critical (10 points) per KLOC, or multiple
//              Highs per KLOC — concentrated enough that a reviewer would
//              expect to see a pattern repeating, not isolated incidents.
//   E > 10     denser than one Critical-equivalent finding per KLOC —
//              findings are not isolated, they're systemic for that category.
// These bands are intentionally coarse (5 grades, not a continuous score) so
// a 1-point swing in a large codebase can't flip the letter grade — the
// severity weights already do the fine-grained differentiation; the bands
// exist to give a client a single stable letter, not a volatile number.
export function gradeFor(pointsPerKloc: number): Grade {
  if (pointsPerKloc <= 0.5) return 'A';
  if (pointsPerKloc <= 2) return 'B';
  if (pointsPerKloc <= 5) return 'C';
  if (pointsPerKloc <= 10) return 'D';
  return 'E';
}

export interface CategoryScore {
  grade: Grade;
  pointsPerKloc: number;
  findingCount: number;
}

export interface ScoreResult {
  overall: { grade: Grade; pointsPerKloc: number; totalWeightedPoints: number; kloc: number };
  byCategory: Partial<Record<Dimension, CategoryScore>>;
}

export function scoreFindings(findings: JudgedFinding[], totalLines: number): ScoreResult {
  const kloc = totalLines / 1000;
  const byDimension = new Map<Dimension, JudgedFinding[]>();
  for (const f of findings) {
    const list = byDimension.get(f.dimension) ?? [];
    list.push(f);
    byDimension.set(f.dimension, list);
  }

  const byCategory: Partial<Record<Dimension, CategoryScore>> = {};
  for (const [dimension, list] of byDimension) {
    const points = weightedPoints(list);
    const density = densityPerKloc(points, totalLines);
    byCategory[dimension] = { grade: gradeFor(density), pointsPerKloc: density, findingCount: list.length };
  }

  const totalWeightedPoints = weightedPoints(findings);
  const overallDensity = densityPerKloc(totalWeightedPoints, totalLines);

  return {
    overall: { grade: gradeFor(overallDensity), pointsPerKloc: overallDensity, totalWeightedPoints, kloc },
    byCategory,
  };
}
