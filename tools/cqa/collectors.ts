import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterConfig } from './config';
import type { Candidate, Evidence, FileRecord, CollectorStatus, Severity } from './types';
import type { PatternRule } from './patterns';
import { mapEslintRule } from './eslintMap';

// Candidate collectors. Each is deterministic and best-effort: if a tool
// isn't available the collector returns nothing and records why. The pipeline
// is agnostic about which collector a candidate came from.

const MAX_EVIDENCE = 25;
const MAX_SNIPPET = 200;
const EXEC_TIMEOUT = 240_000;
const MAX_BUFFER = 256 * 1024 * 1024;

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function makeCandidate(
  ruleId: string,
  category: string,
  dimension: Candidate['dimension'],
  severity: Severity,
  collector: string,
  evidence: Evidence[],
  description: string,
  suggestedFix: string
): Candidate {
  const locations = evidence.map((e) => `${e.file}:${e.line}`).sort();
  return {
    id: `${ruleId}:${hash(locations.join('|'))}`,
    ruleId,
    category,
    dimension,
    severity,
    source: 'pattern',
    collector,
    occurrences: evidence.length,
    evidence: evidence.slice(0, MAX_EVIDENCE),
    description,
    suggestedFix,
  };
}

// Run a command, capturing stdout AND stderr. eslint and npm audit exit
// non-zero when they find issues, so a non-zero code with stdout is fine.
function runCapture(cmd: string, cwd: string): { ok: boolean; out: string; errOut: string; err?: string } {
  const r = spawnSync(cmd, {
    cwd,
    encoding: 'utf8',
    shell: true,
    timeout: EXEC_TIMEOUT,
    maxBuffer: MAX_BUFFER,
  });
  const out = r.stdout ?? '';
  const errOut = r.stderr ?? '';
  if (r.error) return { ok: false, out: '', errOut, err: r.error.message };
  if (out.trim()) return { ok: true, out, errOut };
  return { ok: false, out: '', errOut, err: errOut.trim().slice(0, 200) || `exit ${r.status}` };
}

// --- regex collector (wraps the first-party pattern scan) ---
export function collectRegex(
  repoRoot: string,
  files: FileRecord[],
  rules: PatternRule[],
  texts: Map<string, string>
): { candidates: Candidate[]; status: CollectorStatus } {
  const byRule = new Map<string, Evidence[]>();
  const isComment = (l: string) => {
    const t = l.trimStart();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
  };
  for (const f of files) {
    if (!f.scanned) continue;
    let text = texts.get(f.path);
    if (text === undefined) {
      try {
        text = readFileSync(join(repoRoot, f.path), 'utf8');
      } catch {
        continue;
      }
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const comment = isComment(line);
      for (const rule of rules) {
        if (comment && !rule.includeComments) continue;
        rule.regex.lastIndex = 0;
        if (rule.regex.test(line)) {
          const list = byRule.get(rule.id) ?? [];
          list.push({ file: f.path, line: i + 1, snippet: line.trim().slice(0, MAX_SNIPPET) });
          byRule.set(rule.id, list);
        }
      }
    }
  }
  const candidates: Candidate[] = [];
  for (const rule of rules) {
    const ev = byRule.get(rule.id);
    if (!ev || !ev.length) continue;
    candidates.push(
      makeCandidate(rule.id, rule.category, rule.dimension, rule.severity, 'regex', ev, rule.description, rule.suggestedFix)
    );
  }
  return { candidates, status: { id: 'regex', ran: true, candidates: candidates.length } };
}

// --- eslint collector ---
export function collectEslint(repoRoot: string, cfg: AdapterConfig): { candidates: Candidate[]; status: CollectorStatus } {
  const res = runCapture(cfg.eslintCmd, repoRoot);
  if (!res.ok) return { candidates: [], status: { id: 'eslint', ran: false, candidates: 0, note: `did not run: ${res.err}` } };
  let parsed: any[];
  try {
    parsed = JSON.parse(res.out);
  } catch {
    return { candidates: [], status: { id: 'eslint', ran: false, candidates: 0, note: `output was not JSON: ${res.out.slice(0, 120)}` } };
  }

  const filesLinted = Array.isArray(parsed) ? parsed.length : 0;
  let totalMessages = 0;
  const byRule = new Map<string, { ev: Evidence[]; sample: string }>();
  for (const file of parsed) {
    const rel = String(file.filePath ?? '').replace(repoRoot, '').replace(/^[/\\]+/, '').split('\\').join('/');
    for (const m of file.messages ?? []) {
      totalMessages++;
      if (!m.ruleId) continue; // skip parse errors / inline-disable noise
      const key = m.ruleId as string;
      const entry = byRule.get(key) ?? { ev: [], sample: m.message ?? key };
      entry.ev.push({ file: rel, line: m.line ?? 1, snippet: String(m.message ?? '').slice(0, MAX_SNIPPET) });
      byRule.set(key, entry);
    }
  }

  const candidates: Candidate[] = [];
  for (const [ruleId, { ev, sample }] of byRule) {
    const { dimension, severity } = mapEslintRule(ruleId, 2);
    candidates.push(
      makeCandidate(
        `eslint:${ruleId}`,
        `eslint: ${ruleId}`,
        dimension,
        severity,
        'eslint',
        ev,
        sample,
        'Resolve per the eslint rule; confirm relevance in the judgment pass.'
      )
    );
  }

  // Diagnostics: distinguish "ran clean" from "linted nothing" (a command/glob problem).
  let note: string;
  if (filesLinted === 0) {
    note = `linted 0 files — likely a command/glob issue. ${res.errOut.trim().slice(0, 160)}`.trim();
  } else {
    note = `linted ${filesLinted} files, ${totalMessages} messages`;
  }
  return { candidates, status: { id: 'eslint', ran: true, candidates: candidates.length, note } };
}

// --- npm audit collector (dependency vulnerabilities) ---
export function collectNpmAudit(repoRoot: string, cfg: AdapterConfig): { candidates: Candidate[]; status: CollectorStatus } {
  const res = runCapture(cfg.npmAuditCmd, repoRoot);
  if (!res.ok) return { candidates: [], status: { id: 'npm-audit', ran: false, candidates: 0, note: `did not run: ${res.err}` } };
  let parsed: any;
  try {
    parsed = JSON.parse(res.out);
  } catch {
    return { candidates: [], status: { id: 'npm-audit', ran: false, candidates: 0, note: 'output was not JSON' } };
  }

  const sevMap: Record<string, Severity> = { critical: 'Critical', high: 'High', moderate: 'Medium', low: 'Low', info: 'Low' };
  const candidates: Candidate[] = [];
  const vulns = parsed?.vulnerabilities ?? {};
  for (const name of Object.keys(vulns)) {
    const v = vulns[name];
    const severity = sevMap[String(v?.severity ?? 'low')] ?? 'Low';
    let title = '';
    for (const via of v?.via ?? []) {
      if (via && typeof via === 'object' && via.title) {
        title = via.title;
        break;
      }
    }
    const ev: Evidence[] = [
      { file: 'package.json', line: 1, snippet: `${name}@${v?.range ?? ''} — ${title || 'known advisory'}`.slice(0, MAX_SNIPPET) },
    ];
    candidates.push(
      makeCandidate(
        `npm-audit:${name}`,
        `Vulnerable dependency: ${name}`,
        'Security',
        severity,
        'npm-audit',
        ev,
        title || `${name} has a known advisory at ${severity} severity.`,
        v?.fixAvailable ? 'A fix is available; update the dependency.' : 'No automatic fix; assess upgrade or mitigation.'
      )
    );
  }
  return { candidates, status: { id: 'npm-audit', ran: true, candidates: candidates.length } };
}

// --- orphan collector (possible dead code from the import graph) ---
export function collectOrphans(orphans: string[]): { candidates: Candidate[]; status: CollectorStatus } {
  if (!orphans.length) return { candidates: [], status: { id: 'graph', ran: true, candidates: 0 } };
  const ev: Evidence[] = orphans.map((p) => ({ file: p, line: 1, snippet: 'not import-reachable from any entry point' }));
  const c = makeCandidate(
    'graph.orphan-module',
    'Possibly unused module',
    'Maintainability',
    'Low',
    'graph',
    ev,
    'Source file not reachable by following imports from any framework entry point — may be dead code, or wired dynamically (e.g. a CMS component map).',
    'Confirm whether it is referenced dynamically; remove if truly unused.'
  );
  return { candidates: [c], status: { id: 'graph', ran: true, candidates: 1 } };
}

// Merge candidate lists. Light dedupe: collapse the known regex/eslint overlap
// (raw <img>) by dropping the first-party regex finding where eslint already
// covers the same location. Deeper semantic dedupe is the judgment pass's job.
export function mergeCandidates(lists: Candidate[][]): Candidate[] {
  const all = lists.flat();
  const eslintImgLocs = new Set<string>();
  for (const c of all) {
    if (c.collector === 'eslint' && c.ruleId.includes('no-img-element')) {
      for (const e of c.evidence) eslintImgLocs.add(`${e.file}:${e.line}`);
    }
  }
  const kept = all.filter((c) => {
    if (c.collector === 'regex' && c.ruleId === 'next.raw-img-tag') {
      return !c.evidence.every((e) => eslintImgLocs.has(`${e.file}:${e.line}`));
    }
    return true;
  });
  const sevRank: Record<Severity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  kept.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.occurrences - a.occurrences);
  return kept;
}
