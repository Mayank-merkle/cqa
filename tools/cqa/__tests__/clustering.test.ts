import { clusterFiles, annotateCrossClusterEdges, packClusters } from '../graph';

describe('clusterFiles', () => {
  it('groups a hook with all of its consumers into one cluster, separate from an unrelated file', () => {
    const adj = new Map<string, string[]>([
      ['src/components/A.tsx', ['src/hooks/useAuth.ts']],
      ['src/components/B.tsx', ['src/hooks/useAuth.ts']],
      ['src/hooks/useAuth.ts', []],
      ['src/lib/unrelated.ts', []],
    ]);
    const all = [...adj.keys()];

    const clusters = clusterFiles(adj, all);
    const clusterOf = (f: string) => clusters.find((c) => c.includes(f));

    expect(clusterOf('src/components/A.tsx')).toEqual(clusterOf('src/hooks/useAuth.ts'));
    expect(clusterOf('src/components/B.tsx')).toEqual(clusterOf('src/hooks/useAuth.ts'));
    expect(clusterOf('src/lib/unrelated.ts')).not.toEqual(clusterOf('src/hooks/useAuth.ts'));
  });

  it('excludes a high-fan-in hub file from merging its unrelated importers, but still merges a low-fan-in shared dependency', () => {
    // shared.ts: imported by 4 otherwise-unrelated components (fan-in 4).
    // useAuth.ts: imported by 2 of those same components (fan-in 2).
    const adj = new Map<string, string[]>([
      ['src/components/A.tsx', ['src/lib/shared.ts', 'src/hooks/useAuth.ts']],
      ['src/components/B.tsx', ['src/lib/shared.ts', 'src/hooks/useAuth.ts']],
      ['src/components/C.tsx', ['src/lib/shared.ts']],
      ['src/components/D.tsx', ['src/lib/shared.ts']],
      ['src/lib/shared.ts', []],
      ['src/hooks/useAuth.ts', []],
    ]);
    const all = [...adj.keys()];

    // Threshold 3: shared.ts (fan-in 4) is a hub and is excluded as a merge
    // bridge; useAuth.ts (fan-in 2) is below threshold and still merges.
    const clusters = clusterFiles(adj, all, 3);
    const clusterOf = (f: string) => clusters.find((c) => c.includes(f));

    // A and B still cluster together through the low-fan-in hook.
    expect(clusterOf('src/components/A.tsx')).toEqual(clusterOf('src/hooks/useAuth.ts'));
    expect(clusterOf('src/components/B.tsx')).toEqual(clusterOf('src/hooks/useAuth.ts'));

    // But shared.ts does not fuse C and D (or A/B) together via itself.
    expect(clusterOf('src/components/C.tsx')).not.toEqual(clusterOf('src/components/D.tsx'));
    expect(clusterOf('src/components/C.tsx')).not.toEqual(clusterOf('src/components/A.tsx'));
    expect(clusterOf('src/lib/shared.ts')).toEqual(['src/lib/shared.ts']);
  });
});

describe('annotateCrossClusterEdges', () => {
  it('records an edge that crosses a unit boundary on both sides', () => {
    const units = [
      { id: 'unit-001', files: ['a.ts'], approxTokens: 10 },
      { id: 'unit-002', files: ['b.ts'], approxTokens: 10 },
    ];
    const adj = new Map<string, string[]>([
      ['a.ts', ['b.ts']],
      ['b.ts', []],
    ]);

    const annotated = annotateCrossClusterEdges(units, adj);

    expect(annotated[0].crossClusterEdges).toEqual([{ from: 'a.ts', to: 'b.ts', fromUnit: 'unit-001', toUnit: 'unit-002' }]);
    expect(annotated[1].crossClusterEdges).toEqual([{ from: 'a.ts', to: 'b.ts', fromUnit: 'unit-001', toUnit: 'unit-002' }]);
  });
});

describe('packClusters', () => {
  it('gives a single file bigger than the token budget its own unit with oversizedFile set', () => {
    const clusters = [['big.ts']];
    const tokensOf = (f: string) => (f === 'big.ts' ? 100 : 1);

    const units = packClusters(clusters, [], tokensOf, 50);

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ files: ['big.ts'], approxTokens: 100, oversizedFile: 'big.ts' });
  });

  it('splits a cluster larger than the token budget into multiple units', () => {
    const clusters = [['a.ts', 'b.ts', 'c.ts', 'd.ts']];
    const tokensOf = () => 30; // cluster total 120 tokens, well over budget

    const units = packClusters(clusters, [], tokensOf, 50);

    expect(units.length).toBeGreaterThan(1);
    expect(units.flatMap((u) => u.files).sort()).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    for (const u of units) expect(u.approxTokens).toBeLessThanOrEqual(50);
  });

  it('orders a cluster containing an entry point before a cluster with no entry point', () => {
    const clusters = [
      ['z.ts'],
      ['entry.ts', 'dep.ts'],
    ];
    const tokensOf = () => 10;

    // Budget fits either cluster alone but not both together, so ordering
    // is observable as separate units rather than merged into one.
    const units = packClusters(clusters, ['entry.ts'], tokensOf, 25);

    expect(units[0].files).toEqual(['entry.ts', 'dep.ts']);
    expect(units[1].files).toEqual(['z.ts']);
  });
});
