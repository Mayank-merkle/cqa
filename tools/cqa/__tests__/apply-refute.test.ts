import { partitionByRefutation } from '../apply-refute';

describe('partitionByRefutation', () => {
  it('drops a finding only when explicitly REFUTED, keeping it on doubt or STANDS', () => {
    const { stands, refuted } = partitionByRefutation(
      ['a', 'b', 'c'],
      [
        { id: 'a', result: 'STANDS', rationale: 'context confirms it' },
        { id: 'b', result: 'REFUTED', rationale: 'line 12 shows cleanup already happens' },
      ]
    );

    expect(stands).toEqual(['a', 'c']); // 'c' has no verdict — doubt keeps it
    expect(refuted).toEqual([{ id: 'b', rationale: 'line 12 shows cleanup already happens' }]);
  });
});
