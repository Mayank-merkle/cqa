# CQA Refutation Pass — final gate before High/Critical findings ship (run inside Claude Code)

High and Critical findings carry the most weight in the report — they're what
gets acted on first. This pass's only job is to try to prove each one wrong,
one more time, with fresh eyes and the full cited context.

## Input
`.claude/cqa/refute-input.json` — an array of the High/Critical findings that
already survived judgment, each with `id`, `category`, `severity`,
`description`, `ref` (file:line), and `context` (cited code).

## Task
For EACH item, actively try to refute it: is there a reason, visible in
`context`, that this is NOT actually a problem? Default to REFUTED only when
you can point to the specific line that disproves it — uncertainty is not
grounds for refutation.

```json
{ "id": "<finding id>", "result": "STANDS" | "REFUTED",
  "rationale": "<one sentence — if REFUTED, cite the disproving line>" }
```

Constraints:
- You may only use what's in `context` — do not re-fetch or re-read the file.
  If the context is insufficient to judge either way, the finding STANDS
  (this pass downgrades on positive proof only, never on doubt).
- Output ONLY a JSON array to `.claude/cqa/refute-verdicts.json`. No prose.
