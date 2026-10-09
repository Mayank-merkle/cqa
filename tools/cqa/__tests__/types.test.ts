import { coerceDimension } from '../types';

describe('coerceDimension', () => {
  it('passes through a value that is already a valid Dimension', () => {
    expect(coerceDimension('Security', 'Maintainability')).toBe('Security');
  });

  it('falls back when the AI invents a category outside the enum', () => {
    expect(coerceDimension('Business logic', 'Maintainability')).toBe('Maintainability');
    expect(coerceDimension('Race condition', 'Reliability')).toBe('Reliability');
  });

  it('falls back when dimension is missing entirely', () => {
    expect(coerceDimension(undefined, 'Maintainability')).toBe('Maintainability');
  });

  it('falls back when dimension is not even a string', () => {
    expect(coerceDimension(42, 'Reliability')).toBe('Reliability');
  });
});
