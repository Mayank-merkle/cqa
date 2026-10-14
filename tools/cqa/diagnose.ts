import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Where a user who hit a problem run should send the diagnostic report. Deliberately
// a single hardcoded address rather than a config option — this is a debugging
// contact point for the plugin's maintainer during early use, not a product feature.
const MAINTAINER_EMAIL = 'mayank.jhunjhunwala@merkle.com';

// Every output file a complete run is expected to produce (mirrors the Step 12
// checklist in commands/run-cqa.md). coverage-summary.json is deliberately excluded —
// it only exists when the adapter's testCoverage collector is enabled.
const EXPECTED_FILES = [
  'manifest.json',
  'candidates.json',
  'version-brief.json',
  'project-docs-brief.json',
  'discovery-findings.json',
  'unit-summaries.json',
  'findings.json',
  'discovery-findings.judged.json',
  'reconciliation-findings.json',
  'storybook-coverage-findings.json',
  'holistic.json',
  'refute-result.json',
  'score.json',
  'cost.json',
  'report.html',
];

export interface Issue {
  severity: 'error' | 'warning';
  message: string;
}

interface CollectorStatus {
  id: string;
  ran: boolean;
  candidates: number;
  note?: string;
}

interface DiagnoseContext {
  dir: string;
  existingFiles: Set<string>;
  manifest?: {
    stack?: string;
    detectedVersions?: Record<string, string>;
    collectors?: CollectorStatus[];
    coverage?: { reviewedPct?: number };
    workUnits?: { crossClusterEdges?: unknown[] }[];
  };
  cost?: { budget?: { exceeded?: boolean; capUsd?: number; stoppedAtStage?: string; skipped?: string } };
}

// Pure so it's testable without touching the filesystem — main() does the reading,
// this just turns already-parsed JSON into a flat issue list.
export function detectIssues(ctx: DiagnoseContext): Issue[] {
  const issues: Issue[] = [];

  for (const file of EXPECTED_FILES) {
    if (!ctx.existingFiles.has(file)) {
      issues.push({ severity: 'error', message: `Expected output file is missing: ${file} — the run likely stopped partway through the pipeline.` });
    }
  }

  const collectors = ctx.manifest?.collectors ?? [];
  for (const c of collectors) {
    if (!c.ran) {
      issues.push({
        severity: 'error',
        message: `Collector "${c.id}" did not run — ${c.note ?? 'no reason recorded'}. Findings/coverage from this collector are missing from the report, not just empty.`,
      });
    }
  }

  const workUnits = ctx.manifest?.workUnits ?? [];
  if (workUnits.length > 0 && workUnits.every((u) => !u.crossClusterEdges || u.crossClusterEdges.length === 0)) {
    issues.push({
      severity: 'error',
      message: 'crossClusterEdges is empty on every work unit — the deterministic graph step may be broken for this project (see Step 2 sanity check in run-cqa.md).',
    });
  }

  const reviewedPct = ctx.manifest?.coverage?.reviewedPct;
  if (reviewedPct !== undefined && reviewedPct < 5) {
    issues.push({
      severity: 'warning',
      message: `Only ${reviewedPct}% of files were classified as reviewable source — this usually means the stack adapter misdetected the project layout.`,
    });
  }

  if (ctx.cost?.budget?.exceeded) {
    issues.push({
      severity: 'warning',
      message: `Budget cap of $${ctx.cost.budget.capUsd} was reached during ${ctx.cost.budget.stoppedAtStage ?? 'an unrecorded stage'} — this is a partial-scope run, not a failure, but worth knowing about. ${ctx.cost.budget.skipped ?? ''}`.trim(),
    });
  }

  return issues;
}

function formatReport(repoRoot: string, issues: Issue[], manifest?: DiagnoseContext['manifest']): string {
  const lines: string[] = [];
  lines.push('CQA pipeline diagnostic report');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Project: ${repoRoot}`);
  if (manifest?.stack) lines.push(`Stack: ${manifest.stack}`);
  if (manifest?.detectedVersions) lines.push(`Detected versions: ${JSON.stringify(manifest.detectedVersions)}`);
  lines.push('');
  lines.push(`${issues.length} issue(s) found:`);
  for (const issue of issues) {
    lines.push(`  [${issue.severity.toUpperCase()}] ${issue.message}`);
  }
  lines.push('');
  lines.push('This file contains no source code or finding content — only pipeline metadata (collector status, file presence, coverage percentages, budget state) — safe to share as-is.');
  return lines.join('\n');
}

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');

  const existingFiles = new Set(EXPECTED_FILES.filter((f) => existsSync(join(dir, f))));
  const manifest = existsSync(join(dir, 'manifest.json')) ? JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) : undefined;
  const cost = existsSync(join(dir, 'cost.json')) ? JSON.parse(readFileSync(join(dir, 'cost.json'), 'utf8')) : undefined;

  const issues = detectIssues({ dir, existingFiles, manifest, cost });

  if (issues.length === 0) {
    console.log('[cqa] diagnose: no issues found.');
    return;
  }

  const report = formatReport(repoRoot, issues, manifest);
  const reportPath = join(dir, 'diagnostic-report.txt');
  writeFileSync(reportPath, report);

  console.log(report);
  console.log('');
  console.log(`[cqa] ${issues.length} issue(s) found this run. A metadata-only diagnostic report was written to:`);
  console.log(`  ${reportPath}`);
  console.log(`Please consider emailing that file to ${MAINTAINER_EMAIL} so this can get fixed.`);
}

if (require.main === module) {
  main();
}
