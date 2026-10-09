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

// Fixed density->grade bands. See docs/superpowers/specs/2026-10-08-cqa-scorer-report-design.md
// section 3 for why these specific thresholds.
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
