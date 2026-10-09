import { normalizeStorybookFindings } from '../merge-storybook-coverage';

describe('normalizeStorybookFindings', () => {
  it('keeps well-formed findings and carries the optional suggestedFix through', () => {
    const result = normalizeStorybookFindings([
      { component: 'src/Button/Button.tsx', prop: 'size', description: 'never exercised', suggestedFix: 'add a story' },
    ]);

    expect(result).toEqual([
      { component: 'src/Button/Button.tsx', prop: 'size', description: 'never exercised', suggestedFix: 'add a story' },
    ]);
  });

  it('drops findings with no component or no prop anchor', () => {
    const result = normalizeStorybookFindings([
      { prop: 'size', description: 'missing component' },
      { component: 'src/Button/Button.tsx', description: 'missing prop' },
      {},
    ]);

    expect(result).toEqual([]);
  });

  it('defaults a missing description to an empty string and omits suggestedFix when absent', () => {
    const result = normalizeStorybookFindings([{ component: 'src/a.tsx', prop: 'x' }]);

    expect(result).toEqual([{ component: 'src/a.tsx', prop: 'x', description: '', suggestedFix: undefined }]);
  });

  it('handles an empty or undefined input array', () => {
    expect(normalizeStorybookFindings([])).toEqual([]);
    expect(normalizeStorybookFindings(undefined as any)).toEqual([]);
  });
});
