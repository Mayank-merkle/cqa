import { detectIssues } from '../diagnose';

const ALL_FILES = [
  'manifest.json',
  'candidates.json',
  'version-brief.json',
  'project-docs-brief.json',
  'discovery-findings.json',
  'unit-summaries.json',
  'findings.json',
  'discovery-findings.judged.json',
  'reconciliation-findings.json',
  'storybook-coverage-findings.json',
  'holistic.json',
  'refute-result.json',
  'score.json',
  'cost.json',
  'report.html',
];

describe('detectIssues', () => {
  it('reports no issues for a clean, complete run', () => {
    const issues = detectIssues({
      dir: '/repo/.claude/cqa',
      existingFiles: new Set(ALL_FILES),
      manifest: {
        collectors: [{ id: 'eslint', ran: true, candidates: 2 }],
        coverage: { reviewedPct: 54 },
        workUnits: [{ crossClusterEdges: [{ from: 'a', to: 'b' }] }],
      },
      cost: { budget: { exceeded: false, capUsd: 100 } },
    });
    expect(issues).toEqual([]);
  });

  it('flags a missing expected output file as an error', () => {
    const issues = detectIssues({
      dir: '/repo/.claude/cqa',
      existingFiles: new Set(ALL_FILES.filter((f) => f !== 'score.json')),
      manifest: undefined,
      cost: undefined,
    });
    expect(issues).toContainEqual(expect.objectContaining({ severity: 'error', message: expect.stringContaining('score.json') }));
  });

  it('flags a collector that did not run', () => {
    const issues = detectIssues({
      dir: '/repo/.claude/cqa',
      existingFiles: new Set(ALL_FILES),
      manifest: {
        collectors: [{ id: 'npm-audit', ran: false, candidates: 0, note: 'did not run: spawnSync ETIMEDOUT' }],
        coverage: { reviewedPct: 54 },
        workUnits: [{ crossClusterEdges: [{ from: 'a', to: 'b' }] }],
      },
      cost: undefined,
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: 'error', message: expect.stringContaining('npm-audit') })
    );
  });

  it('flags every work unit lacking crossClusterEdges as a likely broken graph step', () => {
    const issues = detectIssues({
      dir: '/repo/.claude/cqa',
      existingFiles: new Set(ALL_FILES),
      manifest: {
        collectors: [],
        coverage: { reviewedPct: 54 },
        workUnits: [{ crossClusterEdges: [] }, {}],
      },
      cost: undefined,
    });
    expect(issues).toContainEqual(expect.objectContaining({ severity: 'error', message: expect.stringContaining('crossClusterEdges') }));
  });

  it('does not flag crossClusterEdges when at least one unit has edges', () => {
    const issues = detectIssues({
      dir: '/repo/.claude/cqa',
      existingFiles: new Set(ALL_FILES),
      manifest: {
        collectors: [],
        coverage: { reviewedPct: 54 },
        workUnits: [{ crossClusterEdges: [] }, { crossClusterEdges: [{ from: 'a', to: 'b' }] }],
      },
      cost: undefined,
    });
    expect(issues.some((i) => i.message.includes('crossClusterEdges'))).toBe(false);
  });

  it('warns on suspiciously low reviewed-file coverage', () => {
    const issues = detectIssues({
      dir: '/repo/.claude/cqa',
      existingFiles: new Set(ALL_FILES),
      manifest: { collectors: [], coverage: { reviewedPct: 1 }, workUnits: [] },
      cost: undefined,
    });
    expect(issues).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('adapter misdetected') }));
  });

  it('warns when the budget cap was reached', () => {
    const issues = detectIssues({
      dir: '/repo/.claude/cqa',
      existingFiles: new Set(ALL_FILES),
      manifest: { collectors: [], coverage: { reviewedPct: 54 }, workUnits: [] },
      cost: { budget: { exceeded: true, capUsd: 100, stoppedAtStage: 'Reconciliation (batch 12 of 31)', skipped: 'Batches 13-31 skipped.' } },
    });
    expect(issues).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('Reconciliation (batch 12 of 31)') }));
  });
});
