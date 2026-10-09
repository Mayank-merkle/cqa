import { collectHighSeverityFindings, dedupeByLocation } from '../prepare-refute';
import type { Candidate } from '../types';

function finding(id: string, severity: Candidate['severity'], location = { file: 'a.ts', line: 1 }): Candidate {
  return {
    id,
    ruleId: id,
    category: 'c',
    dimension: 'Security',
    severity,
    source: 'pattern',
    collector: 'test',
    occurrences: 1,
    evidence: [{ file: location.file, line: location.line, snippet: 'x' }],
    description: 'd',
    suggestedFix: 'f',
  };
}

describe('collectHighSeverityFindings', () => {
  it('keeps only High and Critical findings across multiple sources', () => {
    const result = collectHighSeverityFindings([
      [finding('a', 'High'), finding('b', 'Medium')],
      [finding('c', 'Critical'), finding('d', 'Low')],
    ]);
    expect(result.map((f) => f.id)).toEqual(['a', 'c']);
  });
});

describe('dedupeByLocation', () => {
  it('keeps only the first finding when two sources flag the same file:line', () => {
    const fromStatic = finding('rule:abc', 'High', { file: 'src/a.ts', line: 42 });
    const fromReconciliation = finding('reconciliation:xyz', 'High', { file: 'src/a.ts', line: 42 });
    const distinct = finding('rule:def', 'Critical', { file: 'src/b.ts', line: 7 });

    const result = dedupeByLocation([fromStatic, fromReconciliation, distinct]);

    expect(result.map((f) => f.id)).toEqual(['rule:abc', 'rule:def']);
  });
});
