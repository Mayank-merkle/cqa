import { isNewer, parseVersion, rawPluginJsonUrl } from '../check-version';

describe('parseVersion', () => {
  it('parses a plain x.y.z string', () => {
    expect(parseVersion('1.1.2')).toEqual([1, 1, 2]);
  });

  it('rejects anything that is not exactly three integer components', () => {
    expect(parseVersion('1.1')).toBeUndefined();
    expect(parseVersion('1.1.2-beta')).toBeUndefined();
    expect(parseVersion('not-a-version')).toBeUndefined();
  });
});

describe('isNewer', () => {
  it('detects a newer patch, minor, and major version', () => {
    expect(isNewer('1.1.1', '1.1.2')).toBe(true);
    expect(isNewer('1.1.9', '1.2.0')).toBe(true);
    expect(isNewer('1.9.9', '2.0.0')).toBe(true);
  });

  it('is false when versions are equal or local is ahead', () => {
    expect(isNewer('1.1.2', '1.1.2')).toBe(false);
    expect(isNewer('1.1.2', '1.1.1')).toBe(false);
    expect(isNewer('2.0.0', '1.9.9')).toBe(false);
  });

  it('returns undefined (no opinion) when either string is not comparable', () => {
    expect(isNewer('1.1', '1.1.2')).toBeUndefined();
    expect(isNewer('1.1.2', 'garbage')).toBeUndefined();
  });
});

describe('rawPluginJsonUrl', () => {
  it('builds a raw.githubusercontent.com HEAD url from a github.com repository url', () => {
    expect(rawPluginJsonUrl('https://github.com/Mayank-merkle/cqa')).toBe(
      'https://raw.githubusercontent.com/Mayank-merkle/cqa/HEAD/.claude-plugin/plugin.json'
    );
  });

  it('handles a trailing .git and trailing slash', () => {
    expect(rawPluginJsonUrl('https://github.com/Mayank-merkle/cqa.git')).toBe(
      'https://raw.githubusercontent.com/Mayank-merkle/cqa/HEAD/.claude-plugin/plugin.json'
    );
    expect(rawPluginJsonUrl('https://github.com/Mayank-merkle/cqa/')).toBe(
      'https://raw.githubusercontent.com/Mayank-merkle/cqa/HEAD/.claude-plugin/plugin.json'
    );
  });

  it('returns undefined for a non-github repository url', () => {
    expect(rawPluginJsonUrl('https://gitlab.com/Mayank-merkle/cqa')).toBeUndefined();
    expect(rawPluginJsonUrl('git@github.com:Mayank-merkle/cqa.git')).toBeUndefined();
  });
});
