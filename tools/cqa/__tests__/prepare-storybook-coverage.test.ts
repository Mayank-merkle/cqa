import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterConfig } from '../config';
import {
  extractPropsFromComponent,
  extractExercisedPropsFromStory,
  findStorybookPairs,
  buildStorybookCoverageInput,
} from '../prepare-storybook-coverage';

const cfg: AdapterConfig = {
  id: 'test',
  detect: () => true,
  srcDir: 'src',
  alias: {},
  extensions: ['.ts', '.tsx'],
  entryMatchers: [],
  skip: [{ pattern: /\.stories\.(t|j)sx?$/, reason: 'storybook story' }],
  charsPerToken: 4,
  unitTokenBudget: 12000,
  notMeasured: [],
  collectors: { regex: false, eslint: false, npmAudit: false, orphans: false, testCoverage: false },
  eslintCmd: '',
  npmAuditCmd: '',
  testCoverageCmd: '',
  coverageSummaryPath: 'coverage/coverage-summary.json',
  coverageThreshold: 80,
  versionRelevantPackages: [],
};

describe('extractPropsFromComponent', () => {
  it('extracts member names from an interface Props block', () => {
    const text = `
      export interface ButtonProps {
        variant: 'primary' | 'secondary';
        size?: 'sm' | 'md';
        onClick: () => void;
      }
      export function Button(props: ButtonProps) { return null; }
    `;
    expect(extractPropsFromComponent(text)).toEqual(['variant', 'size', 'onClick']);
  });

  it('extracts member names from a type Props alias', () => {
    const text = `
      type CardProps = {
        title: string;
        footer?: React.ReactNode;
      };
    `;
    expect(extractPropsFromComponent(text)).toEqual(['title', 'footer']);
  });

  it('returns an empty array when there is no Props type', () => {
    expect(extractPropsFromComponent('export function Foo() { return null; }')).toEqual([]);
  });
});

describe('extractExercisedPropsFromStory', () => {
  it('collects the union of keys set across every story args block', () => {
    const text = `
      export const Primary = { args: { variant: 'primary', onClick: fn() } };
      export const Small = { args: { size: 'sm' } };
    `;
    const { exercisedProps, variantCount } = extractExercisedPropsFromStory(text);
    expect(new Set(exercisedProps)).toEqual(new Set(['variant', 'onClick', 'size']));
    expect(variantCount).toBe(2);
  });

  it('returns no exercised props and zero variants for a story file with no args', () => {
    expect(extractExercisedPropsFromStory('export default { title: "Button" };')).toEqual({
      exercisedProps: [],
      variantCount: 0,
    });
  });
});

describe('findStorybookPairs', () => {
  it('pairs a story with its colocated component of the same base name', () => {
    const root = mkdtempSync(join(tmpdir(), 'cqa-storybook-'));
    mkdirSync(join(root, 'src', 'Button'), { recursive: true });
    writeFileSync(join(root, 'src', 'Button', 'Button.tsx'), 'export function Button() { return null; }');
    writeFileSync(join(root, 'src', 'Button', 'Button.stories.tsx'), 'export default {};');

    const pairs = findStorybookPairs(root, cfg);

    expect(pairs).toEqual([{ pairId: 'pair-0', component: 'src/Button/Button.tsx', story: 'src/Button/Button.stories.tsx' }]);
  });

  it('does not pair a story with no colocated component file', () => {
    const root = mkdtempSync(join(tmpdir(), 'cqa-storybook-'));
    mkdirSync(join(root, 'src', 'Orphan'), { recursive: true });
    writeFileSync(join(root, 'src', 'Orphan', 'Orphan.stories.tsx'), 'export default {};');

    expect(findStorybookPairs(root, cfg)).toEqual([]);
  });
});

describe('buildStorybookCoverageInput', () => {
  it('keeps only pairs with a genuine uncovered prop, batching them', () => {
    const root = mkdtempSync(join(tmpdir(), 'cqa-storybook-'));
    mkdirSync(join(root, 'src', 'Button'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'Button', 'Button.tsx'),
      `export interface ButtonProps { variant: string; size?: string; className?: string; }`
    );
    writeFileSync(join(root, 'src', 'Button', 'Button.stories.tsx'), `export const Primary = { args: { variant: 'primary' } };`);

    mkdirSync(join(root, 'src', 'FullyCovered'), { recursive: true });
    writeFileSync(join(root, 'src', 'FullyCovered', 'FullyCovered.tsx'), `export interface FullyCoveredProps { label: string; }`);
    writeFileSync(
      join(root, 'src', 'FullyCovered', 'FullyCovered.stories.tsx'),
      `export const Only = { args: { label: 'hi' } };`
    );

    const input = buildStorybookCoverageInput(root, cfg);

    expect(input.pairsScanned).toBe(2);
    expect(input.pairsWithGaps).toHaveLength(1);
    expect(input.pairsWithGaps[0]).toMatchObject({
      component: 'src/Button/Button.tsx',
      declaredProps: ['variant', 'size'], // className is a standard ignored passthrough prop
      exercisedProps: ['variant'],
      uncoveredProps: ['size'],
    });
    expect(input.batches).toEqual([{ batchId: 'storybook-batch-0', pairIds: ['pair-0'] }]);
  });

  it('returns no candidates and no batches when there are no storybook pairs', () => {
    const root = mkdtempSync(join(tmpdir(), 'cqa-storybook-'));
    mkdirSync(join(root, 'src'), { recursive: true });

    const input = buildStorybookCoverageInput(root, cfg);

    expect(input).toEqual({ pairsWithGaps: [], batches: [], pairsScanned: 0 });
  });
});
