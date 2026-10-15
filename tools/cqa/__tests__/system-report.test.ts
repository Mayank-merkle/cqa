import { renderSystemReport } from '../system-report';
import type { MonorepoManifest } from '../monorepo';

function baseManifest(overrides: Partial<MonorepoManifest> = {}): MonorepoManifest {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    repoRoot: 'C:/lhw/DotcomV2-AppSync',
    workspaces: [
      { workspace: 'hotel-api/cdk', root: 'C:/repo/hotel-api/cdk', adapterId: 'aws-lambda-cdk', sourceFiles: 40, workUnits: 3, candidates: 5 },
      { workspace: 'sitecore-to-contentful', root: 'C:/repo/sitecore-to-contentful', adapterId: null, reason: 'no stack adapter matched', sourceFiles: 8 },
    ],
    duplication: [],
    crossService: [],
    dependencyDrift: [],
    fleetPosture: [],
    ...overrides,
  };
}

describe('renderSystemReport', () => {
  it('renders the workspace table with a report link for matched workspaces and a reason for unmatched ones', () => {
    const html = renderSystemReport(baseManifest());

    expect(html).toContain('<html');
    expect(html).toContain('hotel-api/cdk');
    expect(html).toContain('../../hotel-api/cdk/.claude/cqa/report.html');
    expect(html).toContain('sitecore-to-contentful');
    expect(html).toContain('no stack adapter matched');
    expect(html).toContain('mechanical scan only');
  });

  it('shows a fallback notice instead of a narrative when no system-holistic.json exists yet', () => {
    const html = renderSystemReport(baseManifest());

    expect(html).toContain('AI synthesis has not run yet');
  });

  it('renders the executive summary and findings when holistic data is supplied', () => {
    const html = renderSystemReport(baseManifest(), {
      overallNarrative: 'The fleet is mostly clean with one real duplication cluster.',
      duplicationFindings: [
        {
          title: 'Shared SSM-fetch logic',
          assessment: 'Both lambdas re-implement the same parameter decryption.',
          workspacesInvolved: ['hotel-api/cdk/lambdas/getCurrency', 'profile-api/cdk/lambdas/getAgentProfile'],
          recommendedAction: 'Extract to a shared internal package.',
        },
      ],
      communicationTopology: { narrative: 'Hotel-api is a hub with 4 outbound edges.', hubs: ['hotel-api/cdk'], risks: [] },
      dependencyDriftFindings: [{ package: 'aws-cdk-lib', assessment: 'Minor patch drift, low risk.' }],
      observations: [{ title: 'Consistent error handling', assessment: 'Every lambda wraps handlers in try/catch.', weight: 'Low' }],
    });

    expect(html).toContain('The fleet is mostly clean with one real duplication cluster.');
    expect(html).toContain('Shared SSM-fetch logic');
    expect(html).toContain('Extract to a shared internal package.');
    expect(html).toContain('Hotel-api is a hub with 4 outbound edges.');
    expect(html).toContain('Minor patch drift, low risk.');
    expect(html).toContain('Consistent error handling');
    expect(html).not.toContain('AI synthesis has not run yet');
  });

  it('renders duplication, cross-service, and dependency-drift tables from the deterministic manifest', () => {
    const html = renderSystemReport(
      baseManifest({
        duplication: [
          {
            lines: 12,
            locations: [
              { workspace: 'a', file: 'index.ts', startLine: 1, endLine: 12 },
              { workspace: 'b', file: 'index.ts', startLine: 5, endLine: 16 },
            ],
          },
        ],
        crossService: [
          { mechanism: 'cdk-cross-stack-reference', fromWorkspace: 'a', toWorkspace: 'b', detail: 'SharedExport', evidence: [] },
        ],
        dependencyDrift: [{ package: 'aws-cdk-lib', versions: [{ version: '2.150.0', workspaces: ['a'] }, { version: '2.98.0', workspaces: ['b'] }] }],
        fleetPosture: [{ workspace: 'a', candidatesByDimension: { Security: 2 }, testCoverage: { ran: true, overallPct: 55 } }],
      })
    );

    expect(html).toContain('cdk-cross-stack-reference');
    expect(html).toContain('SharedExport');
    expect(html).toContain('aws-cdk-lib');
    expect(html).toContain('2.150.0');
    expect(html).toContain('2.98.0');
    expect(html).toContain('55.0%');
  });

  it('shows an empty-state message rather than a blank table when there is nothing to report', () => {
    const html = renderSystemReport(baseManifest());

    expect(html).toContain('No duplicate blocks found across the fleet.');
    expect(html).toContain('No cross-service coupling candidates found.');
    expect(html).toContain('No dependency version drift detected');
  });
});
