# CQA Holistic Pass — Pass 2 of the AI scan (run inside Claude Code)

This pass steps back and reasons across the whole codebase. It runs ONCE, over
a compressed view — never the raw source — so it fits in one context.

## Input
`.claude/cqa/holistic-input.json`:
- `moduleMap` — a one-line summary per work unit (what each part of the app does)
- `semanticFindings` — digest of pass-1 findings (category, dimension, severity, where)
- `confirmedFindings` — digest of the confirmed deterministic findings
- `needsContext` — items awaiting team input

## Task
Identify **cross-cutting and architectural observations** — patterns that no
single unit reveals. For example:
- the same weakness recurring across many units (systemic, not local)
- an architectural choice that's fighting the framework
- a data-flow or boundary pattern that's risky at scale
- a consistent strength worth stating (a clean, disciplined codebase is a
  legitimate finding for a client report)

Rules:
- Ground every observation in the input. Reference the supporting findings or
  modules. Do NOT invent specifics you can't point to.
- This is **judgment**, not a defect list. Each observation is a paragraph of
  assessment, not a counted issue.
- Be honest about a clean codebase. If the data shows discipline, say so —
  don't manufacture concerns.
- 3-8 observations maximum. Quality over volume.

## Output (write to `.claude/cqa/holistic.json`)
```json
{
  "observations": [
    {
      "title": "Short headline",
      "assessment": "2-4 sentences of reasoning, grounded in the input.",
      "supporting": ["module ids or finding categories this rests on"],
      "weight": "High | Medium | Low"
    }
  ],
  "overallNarrative": "3-5 sentences: the honest one-paragraph story of this codebase's quality."
}
```
