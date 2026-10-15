import rules, { rulesForStack } from '../patterns';

describe('rulesForStack', () => {
  it('includes every stack-agnostic rule (no `stacks` field) for any stack id', () => {
    const genericIds = rules.filter((r) => !r.stacks).map((r) => r.id);
    expect(genericIds.length).toBeGreaterThan(0);

    const forNext = rulesForStack(rules, 'next-contentful').map((r) => r.id);
    const forAws = rulesForStack(rules, 'aws-lambda-cdk').map((r) => r.id);
    for (const id of genericIds) {
      expect(forNext).toContain(id);
      expect(forAws).toContain(id);
    }
  });

  it('excludes next-contentful-only rules when scanning the aws-lambda-cdk stack', () => {
    const forAws = rulesForStack(rules, 'aws-lambda-cdk').map((r) => r.id);
    expect(forAws).not.toContain('next.raw-img-tag');
    expect(forAws).not.toContain('next.legacy-data-fetching');
    expect(forAws).not.toContain('contentful.public-token');
  });

  it('excludes aws-lambda-cdk-only rules when scanning the next-contentful stack', () => {
    const forNext = rulesForStack(rules, 'next-contentful').map((r) => r.id);
    expect(forNext).not.toContain('aws.wildcard-iam');
    expect(forNext).not.toContain('aws.hardcoded-account-arn');
  });

  it('includes stack-specific rules only for their matching stack', () => {
    const forAws = rulesForStack(rules, 'aws-lambda-cdk').map((r) => r.id);
    expect(forAws).toContain('aws.wildcard-iam');
    expect(forAws).toContain('aws.hardcoded-account-arn');
  });
});

describe('new pattern rules', () => {
  const byId = new Map(rules.map((r) => [r.id, r]));

  it('flags SQL built by string concatenation/interpolation', () => {
    const rule = byId.get('general.sql-string-concat')!;
    expect(rule.regex.test('db.query(`SELECT * FROM users WHERE id = ${id}`)')).toBe(true);
    expect(rule.regex.test('db.query("SELECT * FROM users WHERE id = ?", [id])')).toBe(false);
  });

  it('flags execSync with interpolated input', () => {
    const rule = byId.get('general.command-injection')!;
    expect(rule.regex.test('execSync(`rm -rf ${target}`)')).toBe(true);
    expect(rule.regex.test("execSync('ls -la')")).toBe(false);
  });

  it('flags a wildcard IAM action or resource', () => {
    const rule = byId.get('aws.wildcard-iam')!;
    expect(rule.regex.test("actions: ['*']")).toBe(true);
    expect(rule.regex.test("resources: ['*']")).toBe(true);
    expect(rule.regex.test("actions: ['s3:GetObject']")).toBe(false);
  });

  it('flags await inside a single-line for-loop body', () => {
    const rule = byId.get('general.await-in-loop')!;
    expect(rule.regex.test('for (const id of ids) { results.push(await fetchReviews(id)); }')).toBe(true);
    expect(rule.regex.test('const results = await Promise.all(ids.map(fetchReviews));')).toBe(false);
  });

  it('flags a stateful CDK construct declaration for removal-policy/PITR review', () => {
    const rule = byId.get('aws.stateful-resource-config-check')!;
    expect(rule.regex.test("new dynamodb.Table(this, 'T', {")).toBe(true);
    expect(rule.regex.test("new s3.Bucket(this, 'B', {")).toBe(true);
    expect(rule.regex.test("new sqs.Queue(this, 'Q', {")).toBe(false);
  });

  it('flags a legacy aws-sdk v2 import but not a modular v3 client', () => {
    const rule = byId.get('aws.legacy-aws-sdk-v2')!;
    expect(rule.regex.test("import AWS from 'aws-sdk';")).toBe(true);
    expect(rule.regex.test("const AWS = require('aws-sdk');")).toBe(true);
    expect(rule.regex.test("import { DynamoDBClient } from '@aws-sdk/client-dynamodb';")).toBe(false);
  });
});
