import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileRecord, Candidate, Evidence } from './types';
import type { PatternRule } from './patterns';

// Apply pattern rules line-by-line to scannable files and group hits into
// candidates. Every candidate is anchored to verbatim lines — no citation,
// no candidate. The AI judgment pass confirms or rejects each one.

const MAX_EVIDENCE = 25;
const MAX_SNIPPET = 200;

function isComment(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function scan(
  repoRoot: string,
  files: FileRecord[],
  rules: PatternRule[],
  texts: Map<string, string>
): Candidate[] {
  const byRule = new Map<string, Evidence[]>();

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
    if (!ev || ev.length === 0) continue;
    const locations = ev.map((e) => `${e.file}:${e.line}`).sort();
    candidates.push({
      id: `${rule.id}:${hash(locations.join('|'))}`,
      ruleId: rule.id,
      category: rule.category,
      dimension: rule.dimension,
      severity: rule.severity,
      source: rule.source,
      occurrences: ev.length,
      evidence: ev.slice(0, MAX_EVIDENCE),
      description: rule.description,
      suggestedFix: rule.suggestedFix,
    });
  }

  // Sort: severity then occurrence count.
  const sevRank = { Critical: 0, High: 1, Medium: 2, Low: 3 } as const;
  candidates.sort(
    (a, b) => sevRank[a.severity] - sevRank[b.severity] || b.occurrences - a.occurrences
  );
  return candidates;
}
