import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MonorepoManifest, WorkspaceSummary, DependencyDriftEntry, FleetPostureEntry } from './monorepo';
import type { DuplicateBlock } from './duplication';
import type { CrossServiceEdge } from './cross-service';

// The fleet-level counterpart to report.ts: renders system-manifest.json
// (always present once monorepo.ts has run) plus system-holistic.json
// (optional — present only once SYSTEM_HOLISTIC.md's AI pass has run) into
// one self-contained report.html at the monorepo root. Deliberately a
// separate, simpler stylesheet rather than importing report.ts's — report.ts
// is already shipped and tested against its own fixtures; this keeps that
// surface untouched rather than risking it for a shared-CSS refactor.

interface SystemHolisticFinding {
  title?: string;
  assessment: string;
  workspacesInvolved?: string[];
  recommendedAction?: string;
  package?: string;
  supporting?: string[];
  weight?: string;
}

interface SystemHolistic {
  duplicationFindings?: SystemHolisticFinding[];
  communicationTopology?: { narrative: string; hubs?: string[]; risks?: string[] };
  dependencyDriftFindings?: SystemHolisticFinding[];
  observations?: SystemHolisticFinding[];
  overallNarrative?: string;
}

const readJSON = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const tryJSON = (p: string, fallback: any): any => (existsSync(p) ? readJSON(p) : fallback);

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function workspaceTableHtml(workspaces: WorkspaceSummary[]): string {
  const rows = workspaces
    .map((w) => {
      const reportHref = w.adapterId ? `../../${w.workspace}/.claude/cqa/report.html` : null;
      const status = w.adapterId
        ? `<a href="${esc(reportHref!)}">open report</a>`
        : `<span class="unmatched">mechanical scan only${w.reason ? ` — ${esc(w.reason)}` : ''}</span>`;
      return `<tr>
        <td class="mono">${esc(w.workspace)}</td>
        <td>${w.adapterId ? esc(w.adapterId) : '<span class="unmatched">none</span>'}</td>
        <td>${w.sourceFiles}</td>
        <td>${w.workUnits ?? '—'}</td>
        <td>${w.candidates ?? '—'}</td>
        <td>${status}</td>
      </tr>`;
    })
    .join('\n');
  return `<table class="fleet-table">
    <thead><tr><th>Workspace</th><th>Adapter</th><th>Source files</th><th>Work units</th><th>Candidates</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function duplicationHtml(blocks: DuplicateBlock[]): string {
  if (!blocks.length) return '<p class="empty">No duplicate blocks found across the fleet.</p>';
  const rows = blocks
    .slice(0, 50)
    .map((b) => {
      const [a, c] = b.locations;
      const loc = (l: (typeof b.locations)[number]) => `${l.workspace ? esc(l.workspace) + '/' : ''}${esc(l.file)}:${l.startLine}-${l.endLine}`;
      return `<tr><td>${b.lines}</td><td class="mono">${loc(a)}</td><td class="mono">${loc(c)}</td></tr>`;
    })
    .join('\n');
  const more = blocks.length > 50 ? `<p class="empty">...and ${blocks.length - 50} more.</p>` : '';
  return `<table class="fleet-table">
    <thead><tr><th>Lines</th><th>Location A</th><th>Location B</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${more}`;
}

function crossServiceHtml(edges: CrossServiceEdge[]): string {
  if (!edges.length) return '<p class="empty">No cross-service coupling candidates found.</p>';
  const rows = edges
    .slice(0, 80)
    .map(
      (e) =>
        `<tr><td>${esc(e.mechanism)}</td><td class="mono">${esc(e.fromWorkspace)}</td><td class="mono">${esc(e.toWorkspace)}</td><td class="mono">${esc(e.detail)}</td></tr>`
    )
    .join('\n');
  const more = edges.length > 80 ? `<p class="empty">...and ${edges.length - 80} more.</p>` : '';
  return `<table class="fleet-table">
    <thead><tr><th>Mechanism</th><th>From</th><th>To</th><th>Detail</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${more}`;
}

function dependencyDriftHtml(drift: DependencyDriftEntry[]): string {
  if (!drift.length) return '<p class="empty">No dependency version drift detected across adapter-matched workspaces.</p>';
  const rows = drift
    .map((d) => `<tr><td class="mono">${esc(d.package)}</td><td>${d.versions.map((v) => `${esc(v.version)} (${v.workspaces.length})`).join(', ')}</td></tr>`)
    .join('\n');
  return `<table class="fleet-table"><thead><tr><th>Package</th><th>Versions in use</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function fleetPostureHtml(posture: FleetPostureEntry[]): string {
  const rows = posture
    .map((p) => {
      const dims = Object.entries(p.candidatesByDimension)
        .map(([d, n]) => `${esc(d)}: ${n}`)
        .join(', ');
      const coverage = p.testCoverage?.ran ? `${(p.testCoverage.overallPct ?? 0).toFixed(1)}%` : 'not measured';
      return `<tr><td class="mono">${esc(p.workspace)}</td><td>${dims || '—'}</td><td>${coverage}</td></tr>`;
    })
    .join('\n');
  return `<table class="fleet-table"><thead><tr><th>Workspace</th><th>Candidates by dimension</th><th>Test coverage</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function findingsListHtml(items: SystemHolisticFinding[] | undefined): string {
  if (!items || !items.length) return '<p class="empty">None reported.</p>';
  return `<ul class="finding-list">${items
    .map(
      (i) => `<li>
        ${i.title ? `<strong>${esc(i.title)}</strong>${i.weight ? ` <span class="weight">${esc(i.weight)}</span>` : ''}<br/>` : ''}
        ${i.package ? `<strong>${esc(i.package)}</strong><br/>` : ''}
        ${esc(i.assessment)}
        ${i.workspacesInvolved?.length ? `<div class="meta">Involves: ${i.workspacesInvolved.map(esc).join(', ')}</div>` : ''}
        ${i.recommendedAction ? `<div class="meta">Recommendation: ${esc(i.recommendedAction)}</div>` : ''}
        ${i.supporting?.length ? `<div class="meta">Supporting: ${i.supporting.map(esc).join(', ')}</div>` : ''}
      </li>`
    )
    .join('\n')}</ul>`;
}

export function renderSystemReport(manifest: MonorepoManifest, holistic?: SystemHolistic): string {
  const matched = manifest.workspaces.filter((w) => w.adapterId);
  const unmatched = manifest.workspaces.filter((w) => !w.adapterId);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Code Quality Report — Fleet Overview</title>
<style>
  :root { --bg: #f8fafc; --surface: #fff; --border: #e2e8f0; --text: #0f172a; --text-muted: #64748b; --accent: #2563eb; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 0 0 4rem; line-height: 1.55; }
  .page { max-width: 1100px; margin: 0 auto; padding: 0 1.5rem; }
  header.hero { background: var(--surface); border-bottom: 1px solid var(--border); padding: 2.5rem 0 2rem; margin-bottom: 2rem; }
  header.hero h1 { margin: 0 0 0.25rem; font-size: 1.6rem; }
  header.hero .timestamp { color: var(--text-muted); font-size: 0.875rem; }
  section { margin-bottom: 2.5rem; }
  section > h2 { font-size: 1.05rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; margin-bottom: 1.25rem; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1.5rem; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1rem; }
  .stat .n { font-size: 1.6rem; font-weight: 700; }
  .stat .l { color: var(--text-muted); font-size: 0.8rem; text-transform: uppercase; }
  table.fleet-table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  table.fleet-table th, table.fleet-table td { border-bottom: 1px solid var(--border); padding: 0.5rem 0.75rem; text-align: left; vertical-align: top; }
  table.fleet-table th { color: var(--text-muted); font-weight: 600; font-size: 0.78rem; text-transform: uppercase; }
  .mono { font-family: ui-monospace, 'SF Mono', Consolas, monospace; font-size: 0.85rem; overflow-wrap: anywhere; }
  .empty { color: var(--text-muted); font-style: italic; }
  .unmatched { color: var(--text-muted); font-style: italic; }
  a { color: var(--accent); }
  .finding-list { list-style: none; margin: 0; padding: 0; }
  .finding-list li { padding: 0.9rem 0; border-top: 1px solid var(--border); }
  .finding-list li:first-child { border-top: none; }
  .finding-list .meta { color: var(--text-muted); font-size: 0.85rem; margin-top: 0.3rem; }
  .finding-list .weight { font-size: 0.7rem; text-transform: uppercase; color: var(--accent); }
  details.collapsible { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 0.5rem 1.25rem; }
  details.collapsible summary { cursor: pointer; font-weight: 600; padding: 0.75rem 0; }
  .narrative { font-size: 1.02rem; }
</style>
</head>
<body>
<header class="hero"><div class="page">
  <h1>Code Quality Report — Fleet Overview</h1>
  <div class="timestamp">Generated ${esc(manifest.generatedAt)} &middot; ${esc(manifest.repoRoot)}</div>
</div></header>

<div class="page">

  ${
    holistic?.overallNarrative
      ? `<section><h2>Executive summary</h2><div class="card narrative">${esc(holistic.overallNarrative)}</div></section>`
      : `<section><div class="card narrative">AI synthesis has not run yet for this fleet (no <code>system-holistic.json</code> found) — this report currently shows the deterministic scan only: workspace inventory, duplication, cross-service coupling, and dependency drift.</div></section>`
  }

  <section>
    <h2>Fleet overview</h2>
    <div class="stat-grid">
      <div class="stat"><div class="n">${manifest.workspaces.length}</div><div class="l">Workspaces found</div></div>
      <div class="stat"><div class="n">${matched.length}</div><div class="l">Fully reviewed</div></div>
      <div class="stat"><div class="n">${unmatched.length}</div><div class="l">Mechanical scan only</div></div>
      <div class="stat"><div class="n">${manifest.duplication.length}</div><div class="l">Duplicate blocks</div></div>
      <div class="stat"><div class="n">${manifest.crossService.length}</div><div class="l">Cross-service edges</div></div>
      <div class="stat"><div class="n">${manifest.dependencyDrift.length}</div><div class="l">Packages drifted</div></div>
    </div>
  </section>

  <section>
    <h2>Workspaces</h2>
    <div class="card">${workspaceTableHtml(manifest.workspaces)}</div>
  </section>

  <section>
    <h2>Duplication across the fleet</h2>
    <div class="card">
      ${duplicationHtml(manifest.duplication)}
      ${holistic?.duplicationFindings ? `<h3>Assessment</h3>${findingsListHtml(holistic.duplicationFindings)}` : ''}
    </div>
  </section>

  <section>
    <h2>Cross-service communication</h2>
    <div class="card">
      ${holistic?.communicationTopology ? `<p class="narrative">${esc(holistic.communicationTopology.narrative)}</p>` : ''}
      ${holistic?.communicationTopology?.hubs?.length ? `<p><strong>Hubs:</strong> ${holistic.communicationTopology.hubs.map(esc).join(', ')}</p>` : ''}
      ${holistic?.communicationTopology?.risks?.length ? `<p><strong>Risks:</strong></p>${findingsListHtml(holistic.communicationTopology.risks.map((r) => ({ assessment: r })))}` : ''}
      <details class="collapsible"><summary>All coupling edges (${manifest.crossService.length})</summary>${crossServiceHtml(manifest.crossService)}</details>
    </div>
  </section>

  <section>
    <h2>Dependency drift</h2>
    <div class="card">
      ${dependencyDriftHtml(manifest.dependencyDrift)}
      ${holistic?.dependencyDriftFindings ? `<h3>Assessment</h3>${findingsListHtml(holistic.dependencyDriftFindings)}` : ''}
    </div>
  </section>

  <section>
    <h2>Fleet posture</h2>
    <div class="card">${fleetPostureHtml(manifest.fleetPosture)}</div>
  </section>

  ${
    holistic?.observations
      ? `<section><h2>Architecture observations</h2><div class="card">${findingsListHtml(holistic.observations)}</div></section>`
      : ''
  }

</div>
</body>
</html>`;
}

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const dir = join(repoRoot, '.claude', 'cqa');

  const manifest: MonorepoManifest = readJSON(join(dir, 'system-manifest.json'));
  const holistic: SystemHolistic | undefined = tryJSON(join(dir, 'system-holistic.json'), undefined);

  const html = renderSystemReport(manifest, holistic);
  writeFileSync(join(dir, 'report.html'), html);
  console.log(`[cqa] ${join(dir, 'report.html')} written (${manifest.workspaces.length} workspaces, ${manifest.duplication.length} duplicate blocks, ${manifest.crossService.length} cross-service edges)`);
}

if (require.main === module) {
  main();
}
