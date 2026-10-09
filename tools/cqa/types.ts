// Common types shared across the Code Quality Analyzer (CQA) pipeline.
// The deterministic driver produces these; the AI passes consume them.

export type Dimension =
  | 'Security'
  | 'Reliability'
  | 'Correctness'
  | 'Maintainability'
  | 'Performance'
  | 'TestCoverage'
  | 'Accessibility';

const VALID_DIMENSIONS = new Set<Dimension>([
  'Security',
  'Reliability',
  'Correctness',
  'Maintainability',
  'Performance',
  'TestCoverage',
  'Accessibility',
]);

// AI passes emit `dimension` as free text — nothing stops them from inventing
// a category outside this enum (seen in practice: "Business logic", "Race
// condition", "Memory", ...). Letting those through fragments the scorer's
// fixed category set into one-off buckets. Callers that merge AI output
// (merge-discovery.ts, merge-reconciliation.ts) should coerce through this
// rather than casting the raw string straight to Dimension.
export function coerceDimension(raw: unknown, fallback: Dimension): Dimension {
  if (typeof raw === 'string' && (VALID_DIMENSIONS as Set<string>).has(raw)) return raw as Dimension;
  if (raw !== undefined) console.warn(`[cqa] AI pass used an unrecognized dimension "${raw}" — falling back to ${fallback}`);
  return fallback;
}

export type Severity = 'Critical' | 'High' | 'Medium' | 'Low';

// 'pattern'  = deterministic hit from a tool or regex (high trust, reproducible)
// 'semantic' = added later by the AI judgment pass (hedged)
export type FindingSource = 'pattern' | 'semantic';

export interface Evidence {
  file: string; // repo-relative path
  line: number; // 1-indexed
  snippet: string; // verbatim line / short description
}

export interface Candidate {
  id: string; // stable: ruleId + sorted evidence locations
  ruleId: string;
  category: string;
  dimension: Dimension;
  severity: Severity;
  source: FindingSource;
  collector: string; // provenance: 'regex' | 'eslint' | 'npm-audit' | 'graph'
  occurrences: number;
  evidence: Evidence[];
  description: string;
  suggestedFix: string;
}

export type FileRole =
  | 'entry'
  | 'source'
  | 'test'
  | 'story'
  | 'generated'
  | 'mock'
  | 'config';

export interface FileRecord {
  path: string;
  role: FileRole;
  bytes: number;
  scanned: boolean;
  skipReason?: string;
}

export interface CrossClusterEdge {
  from: string; // file
  to: string; // file
  fromUnit: string;
  toUnit: string;
}

// Contract for version-brief.json: an AI-orchestration output (VERSION_BRIEF.md),
// not something the deterministic driver produces or consumes directly.
export interface VersionBriefEntry {
  package: string;
  version: string;
  currentApiNotes: string;
  deprecations: string[];
  upcomingBreakingChanges: string[];
}

export interface VersionBrief {
  generatedAt: string;
  entries: VersionBriefEntry[];
}

export interface WorkUnit {
  id: string;
  files: string[];
  approxTokens: number;
  oversizedFile?: string;
  crossClusterEdges?: CrossClusterEdge[]; // edges touching this unit's boundary
}

// Honest coverage: how much of the repo is application source we review,
// and what was deliberately excluded (with counts by reason).
export interface Coverage {
  totalFiles: number;
  sourceFiles: number; // role === 'source' | 'entry' — the files we review
  excludedFiles: number;
  excludedByReason: Record<string, number>;
  reviewedPct: number; // sourceFiles / totalFiles * 100
  notMeasured: string[]; // dimensions no collector covered this run
}

export interface CollectorStatus {
  id: string;
  ran: boolean;
  candidates: number;
  note?: string; // why it didn't run, or what it found
}

export interface Manifest {
  stack: string;
  detectedVersions: Record<string, string>;
  generatedAt: string;
  rulesVersion: string; // bump to invalidate the .claude cache
  coverage: Coverage;
  collectors: CollectorStatus[];
  workUnits: WorkUnit[];
}

export type VerdictKind = 'CONFIRMED' | 'FALSE_POSITIVE' | 'NEEDS_CONTEXT';

export interface Verdict {
  id: string;
  verdict: VerdictKind;
  severity?: Severity; // corrected severity, if the scanner mis-rated it
  rationale: string; // one sentence
}

export interface JudgedFinding extends Candidate {
  verdict: VerdictKind;
  rationale: string;
}
