# CQA Judgment Pass (run inside Claude Code)

You are reviewing candidate findings from an automated scan for a **client-facing**
code quality report. Be skeptical by default. A false positive in a client report
is worse than a missed issue — it destroys trust.

## Input
`.claude/cqa/judgment-input.json` — an array of candidates. Each has: `id`, `ruleId`,
`category`, `dimension`, `severity`, `collector`, `occurrences`, `description`, and
one of:
- `samples`: cited code with `context` (the line marked `>`), for source findings.
- `scope` + `advisory`: for dependency (npm-audit) findings.
- `sampleFiles` + `totalFiles`: for orphan (possibly-unused) findings.

## Task
For EACH candidate, produce one verdict:

```json
{ "id": "<candidate id>", "verdict": "CONFIRMED" | "FALSE_POSITIVE" | "NEEDS_CONTEXT",
  "severity": "Critical" | "High" | "Medium" | "Low", "rationale": "<one sentence>" }
```

Rules:
- **CONFIRMED** — the cited code shows the issue is real. Correct `severity` if the
  scanner over- or under-rated it for the actual context.
- **FALSE_POSITIVE** — the match is benign. Expect things like: a route path
  (`/forgot-password`) matched a "secret" rule; an SVG namespace
  (`http://www.w3.org/2000/svg`) or an OAuth grant-type URI matched an "insecure
  http URL" rule; a public-by-design key (a Google Maps browser key) flagged as an
  exposed secret.
- **NEEDS_CONTEXT** — validity depends on something not visible in the snippet.
  Example: `dangerouslySetInnerHTML={{ __html: description }}` where you can't see
  whether `description` is sanitized upstream — say what would resolve it.

Collector-specific:
- `npm-audit`: do NOT re-verify the advisory (it is real). Triage by `scope`:
  **dev-only** dependency → CONFIRMED but downgrade severity (build tooling, not
  shipped to users) and say so; **prod** dependency → keep severity.
- `graph` (orphans): default to NEEDS_CONTEXT — these are often wired dynamically
  (e.g. a Contentful component map keyed by name), not dead code.

Constraints:
- Do NOT invent new findings. Judge only what is presented.
- Do NOT write fixes.
- `rationale`: one factual sentence.
- Output ONLY a JSON array of verdicts to `.claude/cqa/verdicts.json`. No prose around it.

## Scale
The input is small — judge it in one pass. You do NOT need subagents here.
(Subagent fan-out is for the later semantic-discovery pass over the 42 work units,
which finds issues the tools miss. This pass only judges what the tools already found.)
