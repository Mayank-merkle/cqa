import { renderReport } from '../report';
import type { JudgedFinding } from '../types';

function finding(id: string, severity: JudgedFinding['severity']): JudgedFinding {
  return {
    id,
    ruleId: id,
    category: 'Direct innerHTML assignment',
    dimension: 'Security',
    severity,
    source: 'pattern',
    collector: 'regex',
    occurrences: 1,
    evidence: [{ file: 'src/components/googleMap/googleMap.tsx', line: 105, snippet: 'el.innerHTML = `' }],
    description: 'Direct innerHTML assignment can introduce XSS.',
    suggestedFix: 'Use textContent, or sanitize with DOMPurify.',
    verdict: 'CONFIRMED',
    rationale: 'Confirmed by regex collector.',
  };
}

function aiFinding(id: string, severity: JudgedFinding['severity']): JudgedFinding {
  return {
    id,
    ruleId: id,
    category: 'Stale-response race condition',
    dimension: 'Security',
    severity,
    source: 'semantic',
    collector: 'discovery',
    occurrences: 1,
    evidence: [{ file: 'src/components/search/searchForm.tsx', line: 42, snippet: 'const results = await fetchResults(query);' }],
    description: 'No request-ordering guard; a slow earlier response can overwrite a newer one.',
    suggestedFix: 'Add an AbortController or request-id check.',
    verdict: 'CONFIRMED',
    rationale: 'Confirmed by the AI discovery pass reading the full component.',
  };
}

describe('renderReport', () => {
  it('includes the headline grade, every section header, and at least one finding file:line', () => {
    const html = renderReport({
      score: {
        generatedAt: '2026-01-01T00:00:00.000Z',
        overall: { grade: 'B', pointsPerKloc: 1.8, totalWeightedPoints: 90, kloc: 50 },
        byCategory: { Security: { grade: 'C', pointsPerKloc: 3, findingCount: 1 } },
        excludedFromScore: { refuted: 1, needsContext: 2 },
      },
      findings: [finding('a', 'Critical'), aiFinding('b', 'High')],
      dismissed: {
        refuted: [{ id: 'r1', category: 'Some category', severity: 'High', rationale: 'Context disproved it.' }],
        needsContext: [{ id: 'n1', category: 'Other category', severity: 'Medium', rationale: 'Origin of the value is unclear.' }],
      },
      executiveSummary: 'This is a well-structured codebase.',
      coverage: {
        totalFiles: 1579,
        sourceFiles: 878,
        excludedFiles: 701,
        excludedByReason: { 'storybook story': 246, 'test file': 79 },
        reviewedPct: 56,
        notMeasured: ['Test coverage %'],
      },
    });

    expect(html).toContain('<html');
    expect(html).toContain('>B<'); // headline grade
    expect(html).toContain('Executive summary');
    expect(html).toContain('This is a well-structured codebase.');
    expect(html).toContain('Reviewed and dismissed');
    expect(html).toContain('src/components/googleMap/googleMap.tsx:105');
    expect(html).toContain('Coverage');

    // AI vs tool detection source: both badges present, with the right counts
    expect(html).toContain('2 findings in scope');
    expect(html).toContain('found by the AI discovery/reconciliation passes');
    expect(html).toContain('found by deterministic tooling');

    // Coverage: the plain-English clarification plus the exclusion-reason breakdown
    expect(html).toContain(`isn't "the rest went unchecked"`);
    expect(html).toContain('storybook story');
    expect(html).toContain('246');
    expect(html).toContain('test file');
    expect(html).toContain('79');
  });

  it('renders npm-audit findings as a one-paragraph summary, separate from code findings', () => {
    const dependencyFinding: JudgedFinding = {
      id: 'npm-audit:lodash:abc123',
      ruleId: 'npm-audit:lodash',
      category: 'Vulnerable dependency: lodash',
      dimension: 'Security',
      severity: 'High',
      source: 'pattern',
      collector: 'npm-audit',
      occurrences: 1,
      evidence: [{ file: 'package.json', line: 1, snippet: 'lodash@<=4.17.20 — known advisory' }],
      description: 'lodash has a known advisory at High severity.',
      suggestedFix: 'A fix is available; update the dependency.',
      verdict: 'CONFIRMED',
      rationale: 'Production runtime dependency; severity kept as reported.',
    };
    const codeFinding = finding('b', 'Medium');

    const html = renderReport({
      score: {
        generatedAt: '2026-01-01T00:00:00.000Z',
        overall: { grade: 'C', pointsPerKloc: 3, totalWeightedPoints: 30, kloc: 10 },
        byCategory: { Security: { grade: 'C', pointsPerKloc: 3, findingCount: 2 } },
        excludedFromScore: { refuted: 0, needsContext: 0 },
      },
      findings: [dependencyFinding, codeFinding],
      dismissed: { refuted: [], needsContext: [] },
      executiveSummary: 'Summary.',
      coverage: {
        totalFiles: 10,
        sourceFiles: 8,
        excludedFiles: 2,
        excludedByReason: {},
        reviewedPct: 80,
        notMeasured: [],
      },
    });

    expect(html).toContain('Vulnerable dependencies (1)');
    expect(html).toContain('lodash');
    expect(html).not.toContain('class="dep-table"');
    expect(html).toContain('dep-summary');
    expect(html).toContain('Code findings (1)');
    expect(html).toContain('Direct innerHTML assignment');
  });

  it('truncates the dependency package list to a handful of examples, not every package', () => {
    function depFinding(pkg: string): JudgedFinding {
      return {
        id: `npm-audit:${pkg}:x`,
        ruleId: `npm-audit:${pkg}`,
        category: `Vulnerable dependency: ${pkg}`,
        dimension: 'Security',
        severity: 'Medium',
        source: 'pattern',
        collector: 'npm-audit',
        occurrences: 1,
        evidence: [{ file: 'package.json', line: 1, snippet: `${pkg} advisory` }],
        description: `${pkg} has a known advisory.`,
        suggestedFix: 'Update the dependency.',
        verdict: 'CONFIRMED',
        rationale: 'Confirmed.',
      };
    }
    const packages = Array.from({ length: 20 }, (_, i) => `pkg-${i}`);
    const html = renderReport({
      score: {
        generatedAt: '2026-01-01T00:00:00.000Z',
        overall: { grade: 'C', pointsPerKloc: 3, totalWeightedPoints: 30, kloc: 10 },
        byCategory: { Security: { grade: 'C', pointsPerKloc: 3, findingCount: 20 } },
        excludedFromScore: { refuted: 0, needsContext: 0 },
      },
      findings: packages.map(depFinding),
      dismissed: { refuted: [], needsContext: [] },
      executiveSummary: 'Summary.',
      coverage: { totalFiles: 10, sourceFiles: 8, excludedFiles: 2, excludedByReason: {}, reviewedPct: 80, notMeasured: [] },
    });

    expect(html).toContain('20 dependency advisories');
    expect(html).toContain('and 14 more');
    expect(html).toContain('pkg-0');
    expect(html).not.toContain('pkg-19');
  });

  it('includes a grading-methodology appendix whose worked example sums the category densities', () => {
    const html = renderReport({
      score: {
        generatedAt: '2026-01-01T00:00:00.000Z',
        overall: { grade: 'D', pointsPerKloc: 8.56, totalWeightedPoints: 688, kloc: 80.3 },
        byCategory: {
          Security: { grade: 'C', pointsPerKloc: 4.33, findingCount: 154 },
          Reliability: { grade: 'C', pointsPerKloc: 2.95, findingCount: 87 },
          Maintainability: { grade: 'B', pointsPerKloc: 0.83, findingCount: 38 },
          Performance: { grade: 'A', pointsPerKloc: 0.42, findingCount: 18 },
          Correctness: { grade: 'A', pointsPerKloc: 0.02, findingCount: 1 },
        },
        excludedFromScore: { refuted: 1, needsContext: 10 },
      },
      findings: [finding('a', 'Critical')],
      dismissed: { refuted: [], needsContext: [] },
      executiveSummary: 'Summary.',
      coverage: { totalFiles: 10, sourceFiles: 8, excludedFiles: 2, excludedByReason: {}, reviewedPct: 80, notMeasured: [] },
    });

    expect(html).toContain('Appendix: grading methodology');
    expect(html).toContain('Severity weights');
    expect(html).toContain('Grade bands');
    expect(html).toContain('Why the overall grade can be worse than every category');
    // the worked example should sum to the same figure as the overall density
    expect(html).toContain('4.33 + 2.95 + 0.83 + 0.42 + 0.02 = 8.55');
    expect(html).toContain('grade D');
    expect(html).toContain('<strong>1</strong> this run'); // refuted-exclusion count rendered
  });

  const baseReport = {
    score: {
      generatedAt: '2026-01-01T00:00:00.000Z',
      overall: { grade: 'D' as const, pointsPerKloc: 8.56, totalWeightedPoints: 688, kloc: 80.3 },
      byCategory: { Security: { grade: 'C' as const, pointsPerKloc: 4.33, findingCount: 154 } },
      excludedFromScore: { refuted: 1, needsContext: 10 },
    },
    findings: [finding('a', 'Critical')],
    dismissed: { refuted: [], needsContext: [] },
    executiveSummary: 'Summary.',
    coverage: { totalFiles: 10, sourceFiles: 8, excludedFiles: 2, excludedByReason: {}, reviewedPct: 80, notMeasured: [] },
  };

  it('omits the pipeline-cost appendix entirely when no cost data is supplied', () => {
    const html = renderReport(baseReport);

    expect(html).not.toContain('Appendix: pipeline cost');
  });

  it('renders the pipeline-cost appendix when cost data is supplied', () => {
    const html = renderReport({
      ...baseReport,
      cost: {
        generatedAt: '2026-10-08T09:00:00.000Z',
        model: 'claude-sonnet-5-5',
        pricing: { inputPerMTok: 2, outputPerMTok: 10, assumedBlendedPerMTok: 3.6, assumptionNote: 'read-heavy assumption' },
        measured: { tokens: 825277, description: 'Directly observed via task notifications.' },
        estimatedNested: {
          tokens: 1790000,
          description: 'Extrapolated from measured per-item density.',
          breakdown: [{ stage: 'Discovery', count: '58 units', estimatedTokens: 700000 }],
        },
        totalEstimateTokens: 2615277,
        costEstimateUsd: { low: 6, central: 9.5, high: 15 },
        caveat: 'Not an authoritative billing figure.',
      },
    });

    expect(html).toContain('Appendix: pipeline cost');
    expect(html).toContain('claude-sonnet-5-5');
    expect(html).toContain('825,277 tokens');
    expect(html).toContain('2,615,277 tokens');
    expect(html).toContain('$6');
    expect(html).toContain('$15');
    expect(html).toContain('Not an authoritative billing figure.');
  });

  it('renders a quiet confirmation when the budget cap was not reached', () => {
    const html = renderReport({
      ...baseReport,
      cost: {
        generatedAt: '2026-10-08T09:00:00.000Z',
        model: 'claude-sonnet-5-5',
        pricing: { inputPerMTok: 2, outputPerMTok: 10, assumedBlendedPerMTok: 3.6, assumptionNote: 'read-heavy assumption' },
        measured: { tokens: 100000, description: 'Directly observed.' },
        estimatedNested: { tokens: 0, description: 'None.', breakdown: [] },
        totalEstimateTokens: 100000,
        costEstimateUsd: { low: 0.2, central: 0.36, high: 1 },
        caveat: 'Not an authoritative billing figure.',
        budget: { capUsd: 100, exceeded: false },
      },
    });

    expect(html).toContain('Budget cap: $100 for this run. Not reached');
    expect(html).not.toContain('Budget cap of $100 was reached');
  });

  it('surfaces a prominent, non-buried warning when the budget cap was reached, and still renders the full report', () => {
    const html = renderReport({
      ...baseReport,
      cost: {
        generatedAt: '2026-10-08T09:00:00.000Z',
        model: 'claude-sonnet-5-5',
        pricing: { inputPerMTok: 2, outputPerMTok: 10, assumedBlendedPerMTok: 3.6, assumptionNote: 'read-heavy assumption' },
        measured: { tokens: 28000000, description: 'Directly observed.' },
        estimatedNested: { tokens: 0, description: 'None.', breakdown: [] },
        totalEstimateTokens: 28000000,
        costEstimateUsd: { low: 56, central: 100.8, high: 280 },
        caveat: 'Not an authoritative billing figure.',
        budget: {
          capUsd: 100,
          exceeded: true,
          stoppedAtStage: 'Reconciliation (batch 12 of 31)',
          skipped: 'Reconciliation batches 13-31 and Refutation were not run; scoring/report cover only what was collected through batch 12.',
        },
      },
    });

    // Still a complete report — scoring/report generation isn't skipped just because the cap was hit.
    expect(html).toContain('<html');
    expect(html).toContain('Appendix: pipeline cost');
    expect(html).toContain('Overall grade');

    // The warning appears near the top of the document (before the executive summary),
    // not only buried in the cost appendix.
    const topBannerIndex = html.indexOf('Budget cap of $100 was reached');
    const execSummaryIndex = html.indexOf('Executive summary');
    expect(topBannerIndex).toBeGreaterThan(-1);
    expect(topBannerIndex).toBeLessThan(execSummaryIndex);

    expect(html).toContain('Reconciliation (batch 12 of 31)');
    expect(html).toContain('Reconciliation batches 13-31 and Refutation were not run');
  });
});
