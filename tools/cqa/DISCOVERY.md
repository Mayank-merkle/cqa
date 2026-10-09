# CQA Discovery Pass — Pass 1 of the AI scan (run inside Claude Code)

This is where the AI *finds* things the tools can't express. It runs over the
bounded work units the driver already produced, one unit per subagent.

## Orchestration (for the main Claude Code agent)
1. Ensure `.claude/cqa/version-brief.json` exists — if not, run `VERSION_BRIEF.md`
   first. Ensure `.claude/cqa/project-docs-brief.json` exists — if not, run
   `prepare-docs-brief.ts` then `PROJECT_DOCS_BRIEF.md` first. Read
   `.claude/cqa/manifest.json`. It contains `workUnits` — a FIXED list, each
   with an `id` and a `files` array.
2. For EACH work unit, extract (a) the relevant entries from
   `.claude/cqa/version-brief.json` (matching the unit's stack/framework —
   e.g. the `next`, `react`, `typescript` entries for this codebase) and (b)
   any `project-docs-brief.json` entries whose `relevantTo` patterns match
   the unit's files, then launch ONE subagent with the "Per-unit task" below,
   giving it that unit's `files` list AND both extracted briefs. Process
   sequentially, or in small parallel batches.
3. Each subagent writes `.claude/cqa/units/<unitId>.findings.json`.
4. Hard rule: do NOT exceed the work-unit list, and subagents do NOT spawn
   further subagents. The fixed list is your budget — this prevents runaway
   token use.
5. When all units are done, stop. Aggregation happens in code (next step).

## Per-unit task (for each subagent)
You are reviewing ONE bounded unit of this codebase. Read the unit's files
and find **semantic** code-quality issues that a linter cannot express.
You are also given the relevant excerpt of `.claude/cqa/version-brief.json`
for this stack — use it, not training priors, when a finding depends on
current framework behavior (is this deprecated, will this break in the next
major version) — and any matching excerpt of `.claude/cqa/project-docs-brief.json`,
the project's own documented architecture decisions. **The project-docs
brief takes precedence over generic pattern-matching**: if a doc explains
*why* a pattern exists (e.g. multiple requests per page render is a
documented workaround for a response-size limit, not an accidental N+1),
do not flag the documented pattern as a bug — a project's own stated
rationale beats a surface-level resemblance to a known anti-pattern every
time. Look for:
- N+1 / sequential data fetching that should be parallel or batched —
  *unless* a project doc already explains why it's structured that way
- Missing cleanup → leaks (effects, subscriptions, listeners, timers)
- Unsafe handling of CMS/externally-sourced rich content before render
- Server/client boundary problems (secrets or server-only code reaching a
  `'use client'` component; needless `'use client'`)
- Deprecated-by-version API usage for this stack
- Race conditions, unhandled rejections, swallowed errors
- Business-logic smells visible in the code (not business-rule correctness —
  that's a later v2 pass)

Rules:
- Anchor EVERY finding to a real `file` + `line` with the verbatim line as
  `snippet`. No anchor → don't report it.
- Do NOT re-report mechanical issues (raw `<img>`, `var`, `console.log`,
  dependency vulns) — those are already collected deterministically.
- Cap severity at `High`. Use `High` only when the code unambiguously shows it.
  If you're inferring or unsure, mark it `NEEDS_CONTEXT` in `confidence`.
- Do NOT invent issues to look thorough. A clean unit returns `findings: []`.

## Output (write to `.claude/cqa/units/<unitId>.findings.json`)
A single JSON object, no prose around it:
```json
{
  "unitId": "unit-007",
  "summary": "1-2 sentences: what this unit does (used by the holistic pass).",
  "findings": [
    {
      "category": "Unbounded sequential fetch loop",
      "dimension": "Performance",
      "severity": "Medium",
      "confidence": "CONFIRMED",
      "file": "src/lib/reviews/getReviewsForHotels.ts",
      "line": 18,
      "snippet": "for (const id of hotelIds) { results.push(await fetchReviews(id)); }",
      "description": "Sequential await inside a loop with no documented reason for ordering; should be Promise.all.",
      "suggestedFix": "Fetch all in parallel with Promise.all, or batch via an `in` filter if the API supports it."
    }
  ]
}
```
Always emit `summary` even if `findings` is empty.
