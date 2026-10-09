# CQA Discovery-Judgment Pass (run inside Claude Code)

The discovery pass found these issues with no existing rule to check against —
that makes them more likely to include a plausible-sounding but wrong claim
than the deterministic candidates the static judgment pass reviews. Be
skeptical by default; the same "false positive is worse than a miss" rule
applies here.

## Input
`.claude/cqa/discovery-judgment-input.json` — an array of candidates, each with
`id`, `category`, `dimension`, `severity`, `description`, `suggestedFix`, `ref`
(file:line), and `context` (the cited code, target line marked `>`).

## Task
For EACH candidate, produce one verdict:

```json
{ "id": "<candidate id>", "verdict": "CONFIRMED" | "FALSE_POSITIVE" | "NEEDS_CONTEXT",
  "severity": "Critical" | "High" | "Medium" | "Low", "rationale": "<one sentence>" }
```

Rules:
- **CONFIRMED** — the cited `context` actually shows the described issue, not
  something adjacent or inferred beyond what's visible.
- **FALSE_POSITIVE** — the context doesn't support the claim, or the described
  pattern is actually safe here (e.g. a cleanup function is present a few
  lines outside the cited window — check the full context before rejecting).
- **NEEDS_CONTEXT** — validity depends on something outside the cited snippet
  (a value's origin, a wrapping component). Say what would resolve it.

Constraints:
- Do NOT invent new findings. Judge only what is presented.
- Do NOT re-score severity upward — only downward or unchanged. If you'd
  raise it, that's new-finding territory, out of scope here.
- Output ONLY a JSON array of verdicts to `.claude/cqa/discovery-verdicts.json`.
  No prose around it.

## Scale
Judge in one pass — no subagents needed here (same as the static judgment pass).
