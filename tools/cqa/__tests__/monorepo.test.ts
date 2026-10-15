import { aggregateDependencyDrift, aggregateFleetPosture, excludeNestedWorkspaces } from '../monorepo';
import type { Candidate } from '../types';

describe('excludeNestedWorkspaces', () => {
  const cfg = { skip: [{ pattern: /node_modules\//, reason: 'dependency' }] };

  it('adds a skip pattern for a nested workspace root so its files are not double-scanned by the parent', () => {
    const scoped = excludeNestedWorkspaces(cfg, 'C:/repo/hotel-api/cdk', [
      'C:/repo/hotel-api/cdk',
      'C:/repo/hotel-api/cdk/lambdas/hotelProcessor',
      'C:/repo/reservation-api/cdk',
    ]);

    expect(scoped.skip).toHaveLength(2);
    const nested = scoped.skip[1];
    expect(nested.pattern.test('lambdas/hotelProcessor/services/HotelService.ts')).toBe(true);
    expect(nested.pattern.test('lambdas/hotelProcessor/')).toBe(true);
    // Unrelated sibling directories must not be caught by the same pattern.
    expect(nested.pattern.test('lambdas/hotelIndexer/services/TypeaheadIndexer.ts')).toBe(false);
  });

  it('does not add a skip pattern for a sibling or ancestor workspace', () => {
    const scoped = excludeNestedWorkspaces(cfg, 'C:/repo/hotel-api/cdk', ['C:/repo/hotel-api/cdk', 'C:/repo/reservation-api/cdk', 'C:/repo']);

    expect(scoped.skip).toHaveLength(1); // only the original node_modules pattern, nothing added
  });

  it('returns the same config unchanged when there are no nested workspaces', () => {
    const scoped = excludeNestedWorkspaces(cfg, 'C:/repo/ssm-params', ['C:/repo/ssm-params']);

    expect(scoped).toBe(cfg);
  });
});

describe('aggregateDependencyDrift', () => {
  it('reports a package at genuinely different versions across workspaces', () => {
    const drift = aggregateDependencyDrift([
      { workspace: 'hotel-api/cdk', versions: { 'aws-cdk-lib': '2.150.0' } },
      { workspace: 'reservation-api/cdk', versions: { 'aws-cdk-lib': '2.98.0' } },
    ]);

    expect(drift).toHaveLength(1);
    expect(drift[0].package).toBe('aws-cdk-lib');
    expect(drift[0].versions.map((v) => v.version).sort()).toEqual(['2.150.0', '2.98.0']);
  });

  it('does not report a package pinned to the same version everywhere', () => {
    const drift = aggregateDependencyDrift([
      { workspace: 'a', versions: { typescript: '5.8.2' } },
      { workspace: 'b', versions: { typescript: '5.8.2' } },
    ]);

    expect(drift).toEqual([]);
  });

  it('does not report a package only detected in one workspace', () => {
    const drift = aggregateDependencyDrift([
      { workspace: 'a', versions: { 'aws-lambda': '1.0.7' } },
      { workspace: 'b', versions: {} },
    ]);

    expect(drift).toEqual([]);
  });

  it('ignores "unknown" version entries', () => {
    const drift = aggregateDependencyDrift([
      { workspace: 'a', versions: { 'aws-cdk-lib': 'unknown' } },
      { workspace: 'b', versions: { 'aws-cdk-lib': 'unknown' } },
    ]);

    expect(drift).toEqual([]);
  });
});

describe('aggregateFleetPosture', () => {
  function candidate(dimension: Candidate['dimension']): Candidate {
    return {
      id: 'x',
      ruleId: 'x',
      category: 'x',
      dimension,
      severity: 'Medium',
      source: 'pattern',
      collector: 'regex',
      occurrences: 1,
      evidence: [],
      description: 'd',
      suggestedFix: 'f',
    };
  }

  it('counts candidates per dimension per workspace', () => {
    const posture = aggregateFleetPosture([
      { workspace: 'a', candidates: [candidate('Security'), candidate('Security'), candidate('Maintainability')] },
    ]);

    expect(posture[0].candidatesByDimension).toEqual({ Security: 2, Maintainability: 1 });
  });

  it('carries test-coverage data through unmodified when present', () => {
    const posture = aggregateFleetPosture([{ workspace: 'a', candidates: [], testCoverage: { ran: true, overallPct: 42.5 } }]);

    expect(posture[0].testCoverage).toEqual({ ran: true, overallPct: 42.5 });
  });

  it('leaves testCoverage undefined when the workspace never ran it', () => {
    const posture = aggregateFleetPosture([{ workspace: 'a', candidates: [] }]);

    expect(posture[0].testCoverage).toBeUndefined();
  });
});
