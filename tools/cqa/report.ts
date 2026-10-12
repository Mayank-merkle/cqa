import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Coverage, Dimension, JudgedFinding, Severity } from './types';
import type { Grade } from './scoring';

const readJSON = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const tryJSON = (p: string, fallback: any): any => (existsSync(p) ? readJSON(p) : fallback);

interface ScoreData {
  generatedAt: string;
  overall: { grade: Grade; pointsPerKloc: number; totalWeightedPoints: number; kloc: number };
  byCategory: Partial<Record<Dimension, { grade: Grade; pointsPerKloc: number; findingCount: number }>>;
  excludedFromScore: { refuted: number; needsContext: number };
}

interface DismissedItem {
  id: string;
  category: string;
  severity: Severity;
  rationale: string;
}

interface CostBreakdownRow {
  stage: string;
  count: string;
  estimatedTokens: number;
}

interface BudgetData {
  capUsd: number;
  exceeded: boolean;
  stoppedAtStage?: string; // which stage dispatch stopped at, if exceeded
  skipped?: string; // human-readable description of what was skipped as a result
}

interface CostData {
  generatedAt: string;
  model: string;
  pricing: { inputPerMTok: number; outputPerMTok: number; assumedBlendedPerMTok: number; assumptionNote: string };
  measured: { tokens: number; description: string };
  estimatedNested: { tokens: number; description: string; breakdown: CostBreakdownRow[] };
  totalEstimateTokens: number;
  costEstimateUsd: { low: number; central: number; high: number };
  caveat: string;
  budget?: BudgetData;
}

interface TestCoverageData {
  ran: boolean;
  note?: string;
  overallPct?: number;
  threshold: number;
  lowCoverageFiles: { file: string; pct: number }[];
}

interface StorybookGap {
  component: string;
  prop: string;
  description: string;
}

interface ReportInput {
  score: ScoreData;
  findings: JudgedFinding[];
  dismissed: { refuted: DismissedItem[]; needsContext: DismissedItem[] };
  executiveSummary: string;
  coverage: Coverage;
  cost?: CostData;
  testCoverage?: TestCoverageData;
  storybookGaps?: StorybookGap[];
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const GRADE_CLASS: Record<Grade, string> = { A: 'grade-a', B: 'grade-b', C: 'grade-c', D: 'grade-d', E: 'grade-e' };
const SEVERITY_CLASS: Record<Severity, string> = {
  Critical: 'sev-critical',
  High: 'sev-high',
  Medium: 'sev-medium',
  Low: 'sev-low',
};

function findingsByCategoryThenSeverity(findings: JudgedFinding[]): Map<Dimension, JudgedFinding[]> {
  const sevRank: Record<Severity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const grouped = new Map<Dimension, JudgedFinding[]>();
  for (const f of findings) {
    const list = grouped.get(f.dimension) ?? [];
    list.push(f);
    grouped.set(f.dimension, list);
  }
  for (const list of grouped.values()) list.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
  return grouped;
}

// Dependency-advisory findings (one per package, from the npm-audit collector) are
// structurally identical and numerous — rendering each as a full prose block buries
// the handful of genuine code-level findings in a wall of repetition. They get a
// compact table instead; everything else keeps the detailed list.
function isDependencyFinding(f: JudgedFinding): boolean {
  return f.collector === 'npm-audit';
}

function packageName(f: JudgedFinding): string {
  return f.ruleId.replace(/^npm-audit:/, '');
}

function severityBadge(severity: Severity): string {
  return `<span class="badge ${SEVERITY_CLASS[severity]}">${esc(severity)}</span>`;
}

// 'discovery' = per-unit AI semantic read; 'reconciliation' = AI cross-unit review.
// Everything else (regex/eslint/npm-audit/graph) is deterministic tooling.
function isAiFound(f: JudgedFinding): boolean {
  return f.collector === 'discovery' || f.collector === 'reconciliation';
}

function sourceBadge(f: JudgedFinding): string {
  return isAiFound(f) ? '<span class="badge src-ai">AI</span>' : '<span class="badge src-tool">Tool</span>';
}

// npm-audit findings are low-signal in volume (one row per advisory, mostly
// transitive/dev tooling) — a client report shouldn't spend a page enumerating
// them. One summary paragraph plus the package list is enough; the full
// detail (description, triage rationale) stays in .claude/cqa/findings.json.
function dependencySummary(findings: JudgedFinding[]): string {
  const sevRank: Record<Severity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const bySeverity: Record<Severity, number> = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const f of findings) bySeverity[f.severity]++;
  const sevParts = (['Critical', 'High', 'Medium', 'Low'] as Severity[])
    .filter((s) => bySeverity[s] > 0)
    .map((s) => `${bySeverity[s]} ${s}`)
    .join(', ');

  const SAMPLE_SIZE = 6;
  const sortedNames = [...findings]
    .sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || packageName(a).localeCompare(packageName(b)))
    .map(packageName);
  const sample = sortedNames.slice(0, SAMPLE_SIZE).join(', ');
  const remaining = sortedNames.length - SAMPLE_SIZE;
  const sampleLabel = remaining > 0 ? `${sample}, and ${remaining} more` : sample;

  return `<p class="dep-summary">${findings.length} dependency advisories from <code>npm audit</code> (${esc(
    sevParts
  )}) — low-signal in volume, mostly transitive or dev/build-only packages; full detail in <code>.claude/cqa/findings.json</code>. Highest-severity examples: <span class="mono">${esc(
    sampleLabel
  )}</span>.</p>`;
}

function codeFindingList(findings: JudgedFinding[]): string {
  const rows = findings
    .map(
      (f) => `<li class="finding">
        <div class="finding-head">${severityBadge(f.severity)} ${sourceBadge(f)} <span class="finding-category">${esc(f.category)}</span></div>
        <div class="finding-loc mono">${esc(f.evidence[0]?.file ?? '')}:${f.evidence[0]?.line ?? 0}</div>
        <p class="finding-desc">${esc(f.description)}</p>
        <p class="finding-fix"><strong>Fix:</strong> ${esc(f.suggestedFix)}</p>
      </li>`
    )
    .join('\n');
  return `<ul class="finding-list">${rows}</ul>`;
}

function findingSectionsHtml(grouped: Map<Dimension, JudgedFinding[]>): string {
  return [...grouped.entries()]
    .map(([dim, list]) => {
      const deps = list.filter(isDependencyFinding);
      const code = list.filter((f) => !isDependencyFinding(f));
      const parts: string[] = [];
      if (deps.length) parts.push(`<h4>Vulnerable dependencies (${deps.length})</h4>${dependencySummary(deps)}`);
      if (code.length) {
        const label = deps.length ? `Code findings (${code.length})` : '';
        parts.push((label ? `<h4>${label}</h4>` : '') + codeFindingList(code));
      }
      return `<details class="category-block">
        <summary>${esc(dim)} <span class="count-chip">${list.length}</span></summary>
        ${parts.join('\n')}
      </details>`;
    })
    .join('\n');
}

function dismissedListHtml(items: DismissedItem[]): string {
  if (!items.length) return '<p class="empty">None.</p>';
  return `<ul class="dismissed-list">${items
    .map((d) => `<li>${severityBadge(d.severity)} <strong>${esc(d.category)}</strong> — ${esc(d.rationale)}</li>`)
    .join('\n')}</ul>`;
}

function fmtTokens(n: number): string {
  return n.toLocaleString('en-US');
}

// Token/cost accounting is not an automated byproduct of the pipeline — nested
// subagents don't report usage back to the orchestrating session, so this
// section renders a hand-recorded estimate (.claude/cqa/cost.json) when present,
// and is omitted entirely otherwise rather than showing a fabricated number.
function budgetBannerHtml(budget: BudgetData): string {
  if (!budget.exceeded) {
    return `<p class="dep-summary">Budget cap: $${budget.capUsd} for this run. Not reached — this report covers the full scope.</p>`;
  }
  return `
  <div class="card budget-exceeded">
    <p><strong>&#9888; Budget cap of $${budget.capUsd} was reached${budget.stoppedAtStage ? ` during ${esc(budget.stoppedAtStage)}` : ''}.</strong>
    The pipeline did not re-scope or fail — it stopped dispatching further review work once the cap was hit and completed
    scoring/reporting on everything already collected, so this report is based on a <strong>partial</strong> scan, not the full one.</p>
    ${budget.skipped ? `<p>${esc(budget.skipped)}</p>` : ''}
  </div>`;
}

function costSectionHtml(cost: CostData): string {
  const breakdownRows = cost.estimatedNested.breakdown
    .map((r) => `<tr><td>${esc(r.stage)}</td><td>${esc(r.count)}</td><td>${fmtTokens(r.estimatedTokens)}</td></tr>`)
    .join('\n');

  return `
  <section>
    <h2>Appendix: pipeline cost</h2>
    <div class="card methodology">
      ${cost.budget ? budgetBannerHtml(cost.budget) : ''}
      <p>This baseline run used model <code>${esc(cost.model)}</code> ($${cost.pricing.inputPerMTok}/$${cost.pricing.outputPerMTok} per MTok input/output).</p>

      <h4>Measured</h4>
      <p><strong>${fmtTokens(cost.measured.tokens)} tokens</strong> — ${esc(cost.measured.description)}</p>

      <h4>Estimated (nested subagents, not directly observable)</h4>
      <p>${esc(cost.estimatedNested.description)}</p>
      <table class="method-table">
        <thead><tr><th>Stage</th><th>Count</th><th>Est. tokens</th></tr></thead>
        <tbody>${breakdownRows}</tbody>
      </table>

      <h4>Total</h4>
      <p><strong>${fmtTokens(cost.totalEstimateTokens)} tokens</strong> (measured + estimated), blended at ~$${cost.pricing.assumedBlendedPerMTok}/MTok (${esc(
        cost.pricing.assumptionNote
      )}) &rarr; roughly <strong>$${cost.costEstimateUsd.low}&ndash;$${cost.costEstimateUsd.high}</strong> (central estimate ~$${cost.costEstimateUsd.central}).</p>

      <p class="dep-summary">${esc(cost.caveat)}</p>
    </div>
  </section>`;
}

// Real Jest/Istanbul line coverage — reported here, never severity-weighted
// (a continuous % isn't a discrete defect; see collectors.ts's TestCoverageResult).
function testCoverageHtml(tc: TestCoverageData): string {
  if (!tc.ran) {
    return `<h4>Test coverage</h4><p class="empty">Not measured this run${tc.note ? ` — ${esc(tc.note)}` : ''}.</p>`;
  }
  const rows = tc.lowCoverageFiles
    .slice(0, 20)
    .map((f) => `<tr><td class="mono">${esc(f.file)}</td><td>${f.pct.toFixed(1)}%</td></tr>`)
    .join('\n');
  const more = tc.lowCoverageFiles.length > 20 ? `<p class="empty">...and ${tc.lowCoverageFiles.length - 20} more below ${tc.threshold}%.</p>` : '';
  return `
  <h4>Test coverage</h4>
  <p>${(tc.overallPct ?? 0).toFixed(1)}% overall line coverage. ${tc.lowCoverageFiles.length} file(s) below the ${tc.threshold}% threshold:</p>
  <table class="exclusion-table"><thead><tr><th>File</th><th>Line coverage</th></tr></thead><tbody>${rows}</tbody></table>
  ${more}`;
}

// Storybook prop/variant coverage gaps — a coverage-gap check, not a
// story-quality opinion; also reported rather than scored, same reasoning as
// Jest coverage above. Note this is a DIFFERENT signal than the "storybook
// story" row in the exclusion table above: that row says story files
// themselves are excluded from the code-quality *source* review (they aren't
// application logic); this section separately checks, for a component that
// HAS a colocated story, whether that story exercises every prop/variant the
// component accepts. The two aren't in tension — exclude-from-review and
// check-story-completeness are orthogonal questions — but said back to back
// without a connector they read as contradictory, hence the explicit note.
const STORYBOOK_INTRO =
  '<p class="coverage-note">Story files are excluded from the code-quality review above (they aren’t application logic) — but when a component has a colocated <code>.stories.tsx</code>, its prop/variant surface is checked separately here: does the story actually demonstrate every prop the component accepts.</p>';

function storybookGapsHtml(gaps: StorybookGap[]): string {
  if (!gaps.length) {
    return `<details class="category-block">
      <summary>Storybook prop coverage <span class="count-chip">0</span></summary>
      ${STORYBOOK_INTRO}
      <p class="empty">No gaps found (or this run had no colocated component/story pairs).</p>
    </details>`;
  }
  const rows = gaps
    .slice(0, 30)
    .map((g) => `<tr><td class="mono">${esc(g.component)}</td><td class="mono">${esc(g.prop)}</td><td>${esc(g.description)}</td></tr>`)
    .join('\n');
  const more = gaps.length > 30 ? `<p class="empty">...and ${gaps.length - 30} more.</p>` : '';
  return `
  <details class="category-block">
    <summary>Storybook prop coverage <span class="count-chip">${gaps.length}</span></summary>
    ${STORYBOOK_INTRO}
    <p>${gaps.length} prop(s)/variant(s) not exercised by any <code>.stories.tsx</code> for their component:</p>
    <table class="gap-table"><thead><tr><th>Component</th><th>Prop</th><th>Gap</th></tr></thead><tbody>${rows}</tbody></table>
    ${more}
  </details>`;
}

export function renderReport(input: ReportInput): string {
  const { score, findings, dismissed, executiveSummary, coverage, cost } = input;
  const grouped = findingsByCategoryThenSeverity(findings);

  const categoryCards = Object.entries(score.byCategory)
    .map(
      ([dim, c]) => `<div class="cat-card">
        <div class="cat-grade ${GRADE_CLASS[c!.grade]}">${c!.grade}</div>
        <div class="cat-meta">
          <div class="cat-name">${esc(dim)}</div>
          <div class="cat-stats">${c!.pointsPerKloc.toFixed(2)} pts/KLOC &middot; ${c!.findingCount} finding${c!.findingCount === 1 ? '' : 's'}</div>
        </div>
      </div>`
    )
    .join('\n');

  const findingSections = findingSectionsHtml(grouped);
  const aiFoundCount = findings.filter(isAiFound).length;
  const toolFoundCount = findings.length - aiFoundCount;
  const notMeasuredRows = coverage.notMeasured.map((m) => `<li>${esc(m)}</li>`).join('\n');
  const exclusionRows = Object.entries(coverage.excludedByReason)
    .sort(([, a], [, b]) => b - a)
    .map(([reason, count]) => `<tr><td>${esc(reason)}</td><td>${count}</td></tr>`)
    .join('\n');

  const categoryDensitySum = Object.values(score.byCategory).reduce((sum, c) => sum + (c?.pointsPerKloc ?? 0), 0);
  const sumWorkedExample = Object.entries(score.byCategory)
    .map(([, c]) => c!.pointsPerKloc.toFixed(2))
    .join(' + ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Code Quality Report</title>
<style>
  :root {
    --bg: #f8fafc;
    --surface: #ffffff;
    --border: #e2e8f0;
    --text: #0f172a;
    --text-muted: #64748b;
    --accent: #2563eb;
    --grade-a: #16a34a;
    --grade-b: #65a30d;
    --grade-c: #d97706;
    --grade-d: #ea580c;
    --grade-e: #dc2626;
    --sev-critical: #7f1d1d;
    --sev-high: #dc2626;
    --sev-medium: #d97706;
    --sev-low: #64748b;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    margin: 0;
    padding: 0 0 4rem;
    line-height: 1.55;
    overflow-wrap: break-word;
    word-break: break-word;
  }
  .page { max-width: 980px; margin: 0 auto; padding: 0 1.5rem; }
  header.hero {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 2.5rem 0 2rem;
    margin-bottom: 2rem;
  }
  header.hero h1 { margin: 0 0 0.25rem; font-size: 1.75rem; }
  header.hero .timestamp { color: var(--text-muted); font-size: 0.875rem; }
  section { margin-bottom: 2.5rem; }
  section > h2 {
    font-size: 1.1rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
    margin-bottom: 1.25rem;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.5rem;
  }
  .exec-summary { font-size: 1.05rem; }

  .overall-grid { display: flex; align-items: center; gap: 2rem; flex-wrap: wrap; }
  .grade-badge {
    width: 110px; height: 110px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 3rem; font-weight: 700; color: #fff; flex-shrink: 0;
  }
  .grade-a { background: var(--grade-a); }
  .grade-b { background: var(--grade-b); }
  .grade-c { background: var(--grade-c); }
  .grade-d { background: var(--grade-d); }
  .grade-e { background: var(--grade-e); }
  .overall-stats { color: var(--text-muted); }
  .overall-stats strong { color: var(--text); font-size: 1.1rem; }

  .cat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
  .cat-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: 1rem; display: flex; align-items: center; gap: 1rem;
  }
  .cat-grade {
    width: 48px; height: 48px; border-radius: 8px; color: #fff; font-weight: 700;
    font-size: 1.4rem; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .cat-name { font-weight: 600; }
  .cat-stats { color: var(--text-muted); font-size: 0.8rem; }

  details.category-block {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: 0.5rem 1.25rem; margin-bottom: 0.75rem;
  }
  details.category-block summary {
    cursor: pointer; font-weight: 600; padding: 0.75rem 0; display: flex; align-items: center; gap: 0.5rem;
    list-style: none;
  }
  details.category-block summary::-webkit-details-marker { display: none; }
  details.category-block summary::before { content: '▸'; color: var(--text-muted); }
  details.category-block[open] summary::before { content: '▾'; }
  .count-chip {
    background: var(--bg); border: 1px solid var(--border); border-radius: 999px;
    padding: 0.1rem 0.6rem; font-size: 0.75rem; color: var(--text-muted); font-weight: 500;
  }
  details.category-block h4 { font-size: 0.8rem; text-transform: uppercase; color: var(--text-muted); margin: 1rem 0 0.5rem; }

  .badge {
    display: inline-block; padding: 0.15rem 0.55rem; border-radius: 999px;
    font-size: 0.7rem; font-weight: 700; text-transform: uppercase; color: #fff; letter-spacing: 0.02em;
  }
  .sev-critical { background: var(--sev-critical); }
  .sev-high { background: var(--sev-high); }
  .sev-medium { background: var(--sev-medium); }
  .sev-low { background: var(--sev-low); }
  .src-ai { background: var(--accent); }
  .src-tool { background: var(--text-muted); }

  .source-summary { color: var(--text-muted); font-size: 0.9rem; margin: -0.5rem 0 1.25rem; }
  .source-summary .badge { vertical-align: middle; }

  .mono { font-family: ui-monospace, 'SF Mono', Consolas, monospace; font-size: 0.85rem; overflow-wrap: anywhere; }

  .dep-summary {
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    padding: 0.85rem 1rem; color: var(--text-muted); font-size: 0.9rem;
  }
  .dep-summary code { background: var(--border); border-radius: 4px; padding: 0.05rem 0.3rem; font-size: 0.85em; }
  .dep-summary .mono { color: var(--text); }

  .budget-exceeded {
    background: #fffbeb; border: 1px solid var(--grade-c); color: var(--text);
  }
  .budget-exceeded p { margin: 0 0 0.5rem; }
  .budget-exceeded p:last-child { margin-bottom: 0; }

  .finding-list { list-style: none; margin: 0; padding: 0; }
  .finding { border-top: 1px solid var(--border); padding: 0.85rem 0; }
  .finding:first-child { border-top: none; }
  .finding-head { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; }
  .finding-category { font-weight: 600; }
  .finding-loc { color: var(--text-muted); margin-bottom: 0.35rem; }
  .finding-desc { margin: 0.25rem 0; }
  .finding-fix { margin: 0.25rem 0; color: var(--text-muted); }

  .dismissed-list { list-style: none; margin: 0; padding: 0; }
  .dismissed-list li { padding: 0.6rem 0; border-top: 1px solid var(--border); }
  .dismissed-list li:first-child { border-top: none; }
  .empty { color: var(--text-muted); font-style: italic; }

  .coverage-bar-track { background: var(--border); border-radius: 999px; height: 10px; overflow: hidden; margin: 0.75rem 0; }
  .coverage-bar-fill { background: var(--accent); height: 100%; }
  .coverage-note { font-size: 0.9rem; }
  .coverage-note code { background: var(--bg); border-radius: 4px; padding: 0.05rem 0.3rem; font-size: 0.85em; }

  table.exclusion-table { border-collapse: collapse; width: 100%; margin: 0.75rem 0 1.25rem; font-size: 0.9rem; }
  table.exclusion-table th, table.exclusion-table td {
    border-bottom: 1px solid var(--border); padding: 0.45rem 0.6rem; text-align: left;
  }
  table.exclusion-table th { color: var(--text-muted); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }
  table.exclusion-table td:last-child, table.exclusion-table th:last-child { text-align: right; width: 5rem; }

  /* Separate from .exclusion-table: that table's last column is always a
     short count, so it's pinned to a narrow right-aligned width. This
     table's last column (a free-text gap description) needs the opposite —
     room to wrap normally — so it gets its own rule set rather than
     inheriting the narrow-last-column behavior. */
  table.gap-table { border-collapse: collapse; width: 100%; margin: 0.75rem 0 1.25rem; font-size: 0.9rem; table-layout: fixed; }
  table.gap-table th, table.gap-table td {
    border-bottom: 1px solid var(--border); padding: 0.5rem 0.75rem 0.5rem 0; text-align: left; vertical-align: top;
    overflow-wrap: break-word;
  }
  table.gap-table th { color: var(--text-muted); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }
  table.gap-table th:nth-child(1), table.gap-table td:nth-child(1) { width: 32%; }
  table.gap-table th:nth-child(2), table.gap-table td:nth-child(2) { width: 18%; }

  .methodology h4 { font-size: 0.95rem; margin: 1.5rem 0 0.5rem; }
  .methodology h4:first-child { margin-top: 0; }
  table.method-table { border-collapse: collapse; margin: 0.5rem 0 1rem; font-size: 0.9rem; width: auto; min-width: 260px; }
  table.method-table th, table.method-table td { border-bottom: 1px solid var(--border); padding: 0.4rem 1.5rem 0.4rem 0; text-align: left; }
  table.method-table th { color: var(--text-muted); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }
  .cat-grade-inline {
    display: inline-flex; align-items: center; justify-content: center;
    width: 1.8rem; height: 1.8rem; border-radius: 6px; color: #fff; font-weight: 700;
  }
  .formula {
    font-family: ui-monospace, 'SF Mono', Consolas, monospace; background: var(--bg);
    border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem;
    overflow-wrap: anywhere; font-size: 0.9rem;
  }
</style>
</head>
<body>
<header class="hero"><div class="page">
  <h1>Code Quality Report</h1>
  <div class="timestamp">Generated ${esc(score.generatedAt)}</div>
</div></header>

<div class="page">

  ${cost?.budget?.exceeded ? `<section>${budgetBannerHtml(cost.budget)}</section>` : ''}

  <section>
    <h2>Executive summary</h2>
    <div class="card exec-summary">${esc(executiveSummary)}</div>
  </section>

  <section>
    <h2>Overall grade</h2>
    <div class="card overall-grid">
      <div class="grade-badge ${GRADE_CLASS[score.overall.grade]}">${score.overall.grade}</div>
      <div class="overall-stats">
        <div><strong>${score.overall.pointsPerKloc.toFixed(2)}</strong> weighted points / KLOC</div>
        <div>${score.overall.totalWeightedPoints} total points across ${score.overall.kloc.toFixed(1)} KLOC</div>
      </div>
    </div>
  </section>

  <section>
    <h2>Grades by category</h2>
    <div class="cat-grid">${categoryCards}</div>
  </section>

  <section>
    <h2>Findings</h2>
    <p class="source-summary">${findings.length} findings in scope: <span class="badge src-ai">AI</span> ${aiFoundCount} found by the AI discovery/reconciliation passes (semantic code review) &middot; <span class="badge src-tool">Tool</span> ${toolFoundCount} found by deterministic tooling (regex rules, eslint, npm audit). Each finding below is tagged with its source.</p>
    ${findingSections}
  </section>

  <section>
    <h2>Reviewed and dismissed</h2>
    <details class="category-block">
      <summary>Refuted and needs-context items <span class="count-chip">${dismissed.refuted.length + dismissed.needsContext.length}</span></summary>
      <h4>Refuted (${dismissed.refuted.length})</h4>
      ${dismissedListHtml(dismissed.refuted)}
      <h4>Needs further context (${dismissed.needsContext.length})</h4>
      ${dismissedListHtml(dismissed.needsContext)}
    </details>
  </section>

  <section>
    <h2>Coverage</h2>
    <div class="card">
      <p>${coverage.sourceFiles} of ${coverage.totalFiles} files reviewed (${coverage.reviewedPct}%).</p>
      <div class="coverage-bar-track"><div class="coverage-bar-fill" style="width:${coverage.reviewedPct}%"></div></div>
      <p class="coverage-note">${coverage.reviewedPct}% isn't "the rest went unchecked" — it's "${coverage.reviewedPct}% of everything under <code>src/</code> is actual application source code, and that's the part we reviewed." The remaining ${coverage.excludedFiles} files are structurally excluded because they can't have the kind of quality issues this pipeline looks for (stories, tests, generated code, type declarations, etc.):</p>
      <table class="exclusion-table">
        <thead><tr><th>Excluded reason</th><th>Files</th></tr></thead>
        <tbody>${exclusionRows}</tbody>
      </table>
      <h4>Not measured this run</h4>
      <ul>${notMeasuredRows}</ul>
      ${input.testCoverage ? testCoverageHtml(input.testCoverage) : ''}
      ${input.storybookGaps ? storybookGapsHtml(input.storybookGaps) : ''}
    </div>
  </section>

  <section>
    <h2>Appendix: grading methodology</h2>
    <div class="card methodology">
      <h4>Severity weights</h4>
      <p>Each confirmed finding contributes a fixed number of points by severity. <code>Info</code>-level findings aren't scored (informational only).</p>
      <table class="method-table">
        <thead><tr><th>Severity</th><th>Weight</th></tr></thead>
        <tbody>
          <tr><td>${severityBadge('Critical')}</td><td>10</td></tr>
          <tr><td>${severityBadge('High')}</td><td>5</td></tr>
          <tr><td>${severityBadge('Medium')}</td><td>2</td></tr>
          <tr><td>${severityBadge('Low')}</td><td>1</td></tr>
        </tbody>
      </table>

      <h4>Normalization</h4>
      <p>Points are summed per category and divided by thousands of lines of reviewed source (KLOC), so a larger codebase isn't penalized just for having more files:</p>
      <p class="formula">points per KLOC&nbsp;=&nbsp;(sum of severity weights)&nbsp;&divide;&nbsp;(lines of source&nbsp;&divide;&nbsp;1000)</p>

      <h4>Grade bands</h4>
      <table class="method-table">
        <thead><tr><th>Grade</th><th>Points / KLOC</th></tr></thead>
        <tbody>
          <tr><td><span class="cat-grade-inline ${GRADE_CLASS.A}">A</span></td><td>&le; 0.5</td></tr>
          <tr><td><span class="cat-grade-inline ${GRADE_CLASS.B}">B</span></td><td>&le; 2</td></tr>
          <tr><td><span class="cat-grade-inline ${GRADE_CLASS.C}">C</span></td><td>&le; 5</td></tr>
          <tr><td><span class="cat-grade-inline ${GRADE_CLASS.D}">D</span></td><td>&le; 10</td></tr>
          <tr><td><span class="cat-grade-inline ${GRADE_CLASS.E}">E</span></td><td>&gt; 10</td></tr>
        </tbody>
      </table>

      <h4>Why the overall grade can be worse than every category</h4>
      <p>The overall grade is <strong>not</strong> an average of the category grades, and it is not computed against a different, larger budget. It's the same formula applied once across every category's findings together, against the same total KLOC each category is already measured against. Because the categories partition all scored findings, overall points-per-KLOC is mathematically the <strong>sum</strong> of the per-category densities:</p>
      <p class="formula">${esc(sumWorkedExample)} = ${categoryDensitySum.toFixed(2)} &asymp; ${score.overall.pointsPerKloc.toFixed(2)} pts/KLOC &rarr; grade ${score.overall.grade}</p>
      <p>So a codebase with no single alarming category can still land on a worse overall grade than any of its parts — the per-category densities are each "the burden this category alone adds to the shared codebase," and the overall grade is the total burden across all of them combined, not the worst (or average) one.</p>

      <h4>What's excluded from scoring</h4>
      <p>Findings the refutation pass disproved (<strong>${score.excludedFromScore.refuted}</strong> this run) and findings still awaiting more context (<strong>${score.excludedFromScore.needsContext}</strong>) are shown in the report for transparency but do not count toward any grade — only findings the pipeline actually stands behind are scored.</p>
    </div>
  </section>
${input.cost ? costSectionHtml(input.cost) : ''}
</div>
</body>
</html>`;
}

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');

  const score: ScoreData = readJSON(join(dir, 'score.json'));
  const staticFindings = tryJSON(join(dir, 'findings.json'), { confirmed: [], needsContext: [] });
  const discoveryFindings = tryJSON(join(dir, 'discovery-findings.judged.json'), { confirmed: [], needsContext: [] });
  const reconciliation = tryJSON(join(dir, 'reconciliation-findings.json'), []);
  const refuteResult = tryJSON(join(dir, 'refute-result.json'), { stands: [], refuted: [] });
  const manifest = readJSON(join(dir, 'manifest.json'));
  const holistic = tryJSON(join(dir, 'holistic.json'), { observations: [] });
  const cost: CostData | undefined = tryJSON(join(dir, 'cost.json'), undefined);
  const testCoverage: TestCoverageData | undefined = tryJSON(join(dir, 'coverage-summary.json'), undefined);
  const storybookGaps: StorybookGap[] | undefined = tryJSON(join(dir, 'storybook-coverage-findings.json'), undefined);

  const refutedIds = new Set<string>(refuteResult.refuted.map((r: { id: string }) => r.id));
  const findings: JudgedFinding[] = [...staticFindings.confirmed, ...discoveryFindings.confirmed, ...reconciliation].filter(
    (f) => !refutedIds.has(f.id)
  );

  const findById = (id: string, pool: { category?: string; severity?: Severity }[]) => pool.find((f: any) => f.id === id);
  const allJudged = [...staticFindings.confirmed, ...discoveryFindings.confirmed, ...staticFindings.needsContext, ...discoveryFindings.needsContext];

  const dismissed = {
    refuted: refuteResult.refuted.map((r: { id: string; rationale: string }) => {
      const match = findById(r.id, allJudged) as JudgedFinding | undefined;
      return { id: r.id, category: match?.category ?? r.id, severity: match?.severity ?? 'Medium', rationale: r.rationale };
    }),
    needsContext: [...staticFindings.needsContext, ...discoveryFindings.needsContext].map((f: JudgedFinding) => ({
      id: f.id,
      category: f.category,
      severity: f.severity,
      rationale: f.rationale,
    })),
  };

  const executiveSummary = holistic.observations?.[0]?.assessment ?? 'No holistic synthesis available for this run.';

  const html = renderReport({ score, findings, dismissed, executiveSummary, coverage: manifest.coverage, cost, testCoverage, storybookGaps });
  writeFileSync(join(dir, 'report.html'), html);
  console.log(`[cqa] report.html written (${findings.length} scored findings, grade ${score.overall.grade})`);
}

if (require.main === module) {
  main();
}
