import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectVersions, detectAdapter, detectWorkspaces, findWorkspaceRoots, nextContentful, awsLambdaCdk } from '../config';

describe('detectVersions', () => {
  it('strips ^ and ~ range prefixes and reports unknown for a missing package', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cqa-config-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { next: '15.5.18', react: '^19.2.0' },
        devDependencies: { typescript: '~5.8.2' }
      })
    );

    const versions = detectVersions(dir, ['next', 'react', 'typescript', 'next-auth']);

    expect(versions).toEqual({
      next: '15.5.18',
      react: '19.2.0',
      typescript: '5.8.2',
      'next-auth': 'unknown'
    });
  });

  it('only reports the requested packages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cqa-config-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { 'aws-cdk-lib': '2.150.0', next: '15.5.18' } })
    );

    const versions = detectVersions(dir, ['aws-cdk-lib', 'constructs']);

    expect(versions).toEqual({ 'aws-cdk-lib': '2.150.0', constructs: 'unknown' });
  });

  it('returns an empty object when package.json is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cqa-config-'));

    const versions = detectVersions(dir, ['next']);

    expect(versions).toEqual({});
  });

  it('returns an empty object when package.json is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cqa-config-'));
    writeFileSync(join(dir, 'package.json'), '{ not valid json');

    const versions = detectVersions(dir, ['next']);

    expect(versions).toEqual({});
  });
});

describe('detectAdapter', () => {
  it('selects the Next.js adapter when "next" is a dependency', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cqa-config-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '15.5.18' } }));

    expect(detectAdapter(dir)).toBe(nextContentful);
  });

  it('also matches when "next" is only a devDependency', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cqa-config-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { next: '15.5.18' } }));

    expect(detectAdapter(dir)).toBe(nextContentful);
  });

  it('throws a clear error when no adapter matches the repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cqa-config-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '4.0.0' } }));

    expect(() => detectAdapter(dir)).toThrow(/no stack adapter matched/);
  });

  it('throws when package.json is missing entirely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cqa-config-'));

    expect(() => detectAdapter(dir)).toThrow(/no stack adapter matched/);
  });
});

describe('awsLambdaCdk.detect', () => {
  it('matches a CDK app root via its own cdk.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cqa-cdk-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(dir, 'cdk.json'), '{}');

    expect(awsLambdaCdk.detect(dir)).toBe(true);
  });

  it('matches via an aws-cdk-lib dependency even without a local cdk.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cqa-cdk-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'aws-cdk-lib': '2.260.0' } }));

    expect(awsLambdaCdk.detect(dir)).toBe(true);
  });

  it('matches a Lambda handler package via an aws-lambda devDependency (e.g. getCurrency in the real repo)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cqa-cdk-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { '@types/aws-lambda': '^8.10.162' } }));

    expect(awsLambdaCdk.detect(dir)).toBe(true);
  });

  it('matches a Lambda handler package with no AWS-specific dependency at all, via its CDK-app ancestor cdk.json (e.g. getAgentProfile in the real repo)', () => {
    const cdkRoot = mkdtempSync(join(tmpdir(), 'cqa-cdk-'));
    writeFileSync(join(cdkRoot, 'package.json'), JSON.stringify({ dependencies: { 'aws-cdk-lib': '2.260.0' } }));
    writeFileSync(join(cdkRoot, 'cdk.json'), '{}');
    const leaf = join(cdkRoot, 'lambdas', 'getAgentProfile');
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(leaf, 'package.json'), JSON.stringify({ dependencies: { axios: '1.18.0' } }));

    expect(awsLambdaCdk.detect(leaf)).toBe(true);
  });

  it('does not match a plain Express service with no AWS markers anywhere in its ancestry (e.g. contentful-search in the real repo)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cqa-express-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '^5.2.1' } }));

    expect(awsLambdaCdk.detect(dir)).toBe(false);
  });
});

describe('findWorkspaceRoots', () => {
  it('finds every nested package.json, at varying depth, skipping node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'cqa-monorepo-'));
    mkdirSync(join(root, 'service-a'), { recursive: true });
    writeFileSync(join(root, 'service-a', 'package.json'), '{}');
    mkdirSync(join(root, 'service-b', 'cdk'), { recursive: true });
    writeFileSync(join(root, 'service-b', 'cdk', 'package.json'), '{}');
    mkdirSync(join(root, 'service-a', 'node_modules', 'some-dep'), { recursive: true });
    writeFileSync(join(root, 'service-a', 'node_modules', 'some-dep', 'package.json'), '{}');

    const roots = findWorkspaceRoots(root);

    expect(roots.sort()).toEqual([join(root, 'service-a'), join(root, 'service-b', 'cdk')].sort());
  });

  it('returns an empty array when nothing has a package.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'cqa-monorepo-'));
    mkdirSync(join(root, 'docs'), { recursive: true });

    expect(findWorkspaceRoots(root)).toEqual([]);
  });
});

describe('detectWorkspaces', () => {
  it('treats a repo with its own package.json as a single workspace (unchanged single-repo behavior)', () => {
    const root = mkdtempSync(join(tmpdir(), 'cqa-config-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '15.5.18' } }));

    const targets = detectWorkspaces(root);

    expect(targets).toEqual([{ root, adapter: nextContentful }]);
  });

  it('discovers each service in a monorepo with no root package.json, matching and non-matching alike', () => {
    const root = mkdtempSync(join(tmpdir(), 'cqa-monorepo-'));
    mkdirSync(join(root, 'web-app'), { recursive: true });
    writeFileSync(join(root, 'web-app', 'package.json'), JSON.stringify({ dependencies: { next: '15.5.18' } }));
    mkdirSync(join(root, 'lambda-service'), { recursive: true });
    writeFileSync(join(root, 'lambda-service', 'package.json'), JSON.stringify({ dependencies: { express: '4.0.0' } }));

    const targets = detectWorkspaces(root).sort((a, b) => a.root.localeCompare(b.root));

    expect(targets).toHaveLength(2);
    const lambda = targets.find((t) => t.root.includes('lambda-service'))!;
    const web = targets.find((t) => t.root.includes('web-app'))!;
    expect(web.adapter).toBe(nextContentful);
    expect(lambda.adapter).toBeNull();
    expect(lambda.reason).toMatch(/no stack adapter matched/);
  });

  it('returns an empty array for a directory with no package.json anywhere', () => {
    const root = mkdtempSync(join(tmpdir(), 'cqa-monorepo-'));
    mkdirSync(join(root, 'docs'), { recursive: true });

    expect(detectWorkspaces(root)).toEqual([]);
  });

  it('matches the CDK app, its marker-less nested Lambda, and leaves a plain Express service unmatched (real repo shape)', () => {
    const root = mkdtempSync(join(tmpdir(), 'cqa-monorepo-'));
    const cdkRoot = join(root, 'hotel-api', 'cdk');
    mkdirSync(cdkRoot, { recursive: true });
    writeFileSync(join(cdkRoot, 'package.json'), JSON.stringify({ dependencies: { 'aws-cdk-lib': '2.260.0' } }));
    writeFileSync(join(cdkRoot, 'cdk.json'), '{}');
    const leaf = join(cdkRoot, 'lambdas', 'getCurrency');
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(leaf, 'package.json'), JSON.stringify({ dependencies: { axios: '1.18.0' } }));
    const expressRoot = join(root, 'contentful-search');
    mkdirSync(expressRoot, { recursive: true });
    writeFileSync(join(expressRoot, 'package.json'), JSON.stringify({ dependencies: { express: '^5.2.1' } }));

    const targets = detectWorkspaces(root);

    const cdk = targets.find((t) => t.root === cdkRoot)!;
    const lambda = targets.find((t) => t.root === leaf)!;
    const express = targets.find((t) => t.root === expressRoot)!;
    expect(cdk.adapter).toBe(awsLambdaCdk);
    expect(lambda.adapter).toBe(awsLambdaCdk);
    expect(express.adapter).toBeNull();
    expect(express.reason).toMatch(/no stack adapter matched/);
  });
});
