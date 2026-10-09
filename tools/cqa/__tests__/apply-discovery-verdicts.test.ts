import { applyDiscoveryVerdicts } from '../apply-discovery-verdicts';
import type { Candidate, Verdict } from '../types';

function candidate(id: string, severity: Candidate['severity']): Candidate {
  return {
    id,
    ruleId: id,
    category: 'test',
    dimension: 'Reliability',
    severity,
    source: 'semantic',
    collector: 'discovery',
    occurrences: 1,
    evidence: [{ file: 'src/a.ts', line: 1, snippet: 'x' }],
    description: 'desc',
    suggestedFix: 'fix',
  };
}

describe('applyDiscoveryVerdicts', () => {
  it('splits candidates into confirmed, needs-context, and dropped by verdict', () => {
    const candidates = [candidate('a', 'High'), candidate('b', 'Medium'), candidate('c', 'Low')];
    const verdicts: Verdict[] = [
      { id: 'a', verdict: 'CONFIRMED', rationale: 'real' },
      { id: 'b', verdict: 'NEEDS_CONTEXT', rationale: 'unclear' },
      { id: 'c', verdict: 'FALSE_POSITIVE', rationale: 'benign' },
    ];

    const { confirmed, needsContext, dropped } = applyDiscoveryVerdicts(candidates, verdicts);

    expect(confirmed.map((f) => f.id)).toEqual(['a']);
    expect(needsContext.map((f) => f.id)).toEqual(['b']);
    expect(dropped).toBe(1);
  });

  it('treats a missing verdict as needs-context rather than silently dropping it', () => {
    const candidates = [candidate('a', 'High')];
    const { confirmed, needsContext } = applyDiscoveryVerdicts(candidates, []);

    expect(confirmed).toHaveLength(0);
    expect(needsContext.map((f) => f.id)).toEqual(['a']);
  });
});
