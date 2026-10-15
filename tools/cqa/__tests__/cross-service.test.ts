import { findCrossServiceEdges } from '../cross-service';
import type { WorkspaceFileInput } from '../cross-service';

function ws(workspace: string, file: string, text: string): WorkspaceFileInput {
  return { workspace, workspaceRoot: `C:/repo/${workspace}`, file, text };
}

describe('findCrossServiceEdges', () => {
  it('detects a CDK cross-stack reference between an exporting and importing workspace', () => {
    const files = [
      ws('hotel-api/cdk', 'lib/hotel-stack.ts', "new CfnOutput(this, 'ApiUrl', { value: api.url, exportName: 'HotelApiUrl' });"),
      ws('reservation-api/cdk', 'lib/reservation-stack.ts', "const url = Fn.importValue('HotelApiUrl');"),
    ];

    const edges = findCrossServiceEdges(files);
    const edge = edges.find((e) => e.mechanism === 'cdk-cross-stack-reference');

    expect(edge).toBeDefined();
    expect(edge!.fromWorkspace).toBe('hotel-api/cdk');
    expect(edge!.toWorkspace).toBe('reservation-api/cdk');
    expect(edge!.detail).toBe('HotelApiUrl');
    expect(edge!.evidence).toHaveLength(2);
  });

  it('detects two workspaces sharing a literal DynamoDB table name', () => {
    const files = [
      ws('profile-api/cdk', 'lib/table.ts', "new dynamodb.Table(this, 'T', { tableName: 'shared-profiles' });"),
      ws('reservation-api/cdk', 'lib/reader.ts', "const table = dynamodb.Table.fromTableName(this, 'T', 'shared-profiles');"),
    ];

    const edges = findCrossServiceEdges(files);
    const edge = edges.find((e) => e.mechanism === 'shared-resource-name' && e.detail === 'tableName:shared-profiles');

    expect(edge).toBeDefined();
    expect([edge!.fromWorkspace, edge!.toWorkspace].sort()).toEqual(['profile-api/cdk', 'reservation-api/cdk']);
  });

  it('detects two workspaces sharing an SSM parameter path literal', () => {
    const files = [
      ws('ssm-params', 'lib/params.ts', "new ssm.StringParameter(this, 'P', { parameterName: '/hotel-api/config/apiKey' });"),
      ws('hotel-api/cdk/lambdas/getCurrency', 'index.ts', "const key = '/hotel-api/config/apiKey';"),
    ];

    const edges = findCrossServiceEdges(files);
    const edge = edges.find((e) => e.mechanism === 'shared-resource-name' && e.detail.includes('/hotel-api/config/apiKey'));

    expect(edge).toBeDefined();
  });

  it('does not report a resource name used in only one workspace', () => {
    const files = [
      ws('profile-api/cdk', 'lib/table.ts', "new dynamodb.Table(this, 'T', { tableName: 'profile-only-table' });"),
      ws('profile-api/cdk', 'lib/reader.ts', "const table = dynamodb.Table.fromTableName(this, 'T', 'profile-only-table');"),
    ];

    const edges = findCrossServiceEdges(files);

    expect(edges.some((e) => e.detail.includes('profile-only-table'))).toBe(false);
  });

  it('links a CDK stack to the lambda workspace its NodejsFunction entry points at', () => {
    const files = [
      ws('hotel-api/cdk', 'lib/hotel-stack.ts', "new NodejsFunction(this, 'Fn', { entry: '../lambdas/getCurrency/index.ts' });"),
      ws('hotel-api/cdk/lambdas/getCurrency', 'index.ts', 'export const handler = async () => {};'),
    ];

    const edges = findCrossServiceEdges(files);
    const edge = edges.find((e) => e.mechanism === 'cdk-lambda-entry-reference');

    expect(edge).toBeDefined();
    expect(edge!.fromWorkspace).toBe('hotel-api/cdk');
    expect(edge!.toWorkspace).toBe('hotel-api/cdk/lambdas/getCurrency');
  });

  it('includes evidence with file and line for every edge', () => {
    const files = [
      ws('a', 'x.ts', "new CfnOutput(this, 'O', { exportName: 'Shared' });"),
      ws('b', 'y.ts', "Fn.importValue('Shared');"),
    ];

    const edges = findCrossServiceEdges(files);

    expect(edges[0].evidence[0]).toMatchObject({ file: 'x.ts', line: 1 });
    expect(edges[0].evidence[1]).toMatchObject({ file: 'y.ts', line: 1 });
  });
});
