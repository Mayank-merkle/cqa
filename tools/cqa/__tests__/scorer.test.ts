import { collectScorableFindings, countSourceLines } from '../scorer';
import type { JudgedFinding, Candidate } from '../types';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function judged(id: string, severity: JudgedFinding['severity']): JudgedFinding {
  return {
    id,
    ruleId: id,
    category: 'c',
    dimension: 'Reliability',
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

function candidate(id: string, severity: Candidate['severity']): Candidate {
  return {
    id,
    ruleId: id,
    category: 'c',
    dimension: 'Performance',
    severity,
    source: 'semantic',
    collector: 'reconciliation',
    occurrences: 1,
    evidence: [{ file: 'src/b.ts', line: 1, snippet: 'y' }],
    description: 'd',
    suggestedFix: 'f',
  };
}

describe('collectScorableFindings', () => {
  it('combines static-confirmed, discovery-confirmed, and reconciliation findings', () => {
    const result = collectScorableFindings({
      staticConfirmed: [judged('a', 'High')],
      discoveryConfirmed: [judged('b', 'Medium')],
      reconciliation: [candidate('c', 'Low')],
      refutedIds: new Set(),
    });

    expect(result.map((f) => f.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('excludes any finding whose id was refuted', () => {
    const result = collectScorableFindings({
      staticConfirmed: [judged('a', 'High'), judged('refuted-1', 'Critical')],
      discoveryConfirmed: [],
      reconciliation: [],
      refutedIds: new Set(['refuted-1']),
    });

    expect(result.map((f) => f.id)).toEqual(['a']);
  });
});

describe('countSourceLines', () => {
  it('sums line counts of every given file under the repo root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cqa-scorer-test-'));
    writeFileSync(join(dir, 'a.ts'), 'line1\nline2\nline3');
    writeFileSync(join(dir, 'b.ts'), 'line1\nline2');

    const total = countSourceLines(dir, ['a.ts', 'b.ts']);

    expect(total).toBe(5);
    rmSync(dir, { recursive: true, force: true });
  });
});
