# CQA Storybook Coverage Pass (run inside Claude Code)

This is a **coverage-gap check**, not a story-quality review: it does not
judge whether a story is well-written, uses good naming, or follows best
practices. It only asks one question per flagged prop — *does any story for
this component actually exercise this prop?* — and reports the gaps. Do not
add findings about story structure, naming, or style; that's out of scope.

## Why this exists
`prepare-storybook-coverage.ts` already did the mechanical work: it paired
every component with its colocated `.stories.tsx`, extracted the component's
declared `Props` members with a regex (no type-checker, no JSX runtime — it
can't know about spreads, computed prop names, or props set via a custom
`render:` function), diffed them against the prop keys actually set in each
story's `args`, and kept only the pairs with a non-empty `uncoveredProps`
list. Because the extraction is regex-based, some of those "gaps" are false
positives — this pass's job is to read the real source and separate genuine
coverage gaps from extraction noise before anything reaches the report.

## Orchestration (for the main Claude Code agent)
1. Ensure `.claude/cqa/storybook-coverage-input.json` exists — if not, run
   `npx tsx tools/cqa/prepare-storybook-coverage.ts` first.
2. Read it. `pairsWithGaps` is a flat list of candidates (`pairId`,
   `component`, `story`, `declaredProps`, `exercisedProps`, `uncoveredProps`,
   `variantCount`). `batches` groups their `pairId`s into fixed-size groups —
   this is your budget, same rule as the discovery pass: do not exceed the
   batch list, and subagents do not spawn further subagents.
3. If `pairsWithGaps` is empty, write `{"findings": []}` and stop — no
   subagents needed.
4. For EACH batch, launch ONE subagent with the "Per-batch task" below, giving
   it the full `StorybookCoverageCandidate` objects for that batch's `pairId`s
   (look them up in `pairsWithGaps`). Process sequentially, or in small
   parallel batches.
5. Each subagent writes `.claude/cqa/storybook-units/<batchId>.findings.json`.
6. When all batches are done, stop. Aggregation happens in code
   (`merge-storybook-coverage.ts`, next step).

## Per-batch task (for each subagent)
You are reviewing a batch of component/story pairs for Storybook prop
coverage. For EACH pair in your batch:
1. Read the component file and locate its `Props` type/interface.
2. Read the story file in full (not just the `args` blocks already extracted).
3. For each prop in `uncoveredProps`, decide whether it's a genuine gap:
   - **Genuine gap**: the prop meaningfully changes the component's rendered
     output or behavior, and no story sets it (directly in `args`, via a
     spread from a shared base-args object, or via a custom `render:`
     function that passes it explicitly).
   - **Not a gap** (discard, don't report): the prop is already covered via a
     mechanism the regex extraction couldn't see (spread args, `render:`),
     is effectively internal/plumbing despite not being in the standard
     ignore list, or is a union/boolean type where ANY story exercises at
     least one non-default value (partial coverage of a boolean's two states
     is still coverage, not a gap — only flag a prop no story touches at all).
4. For a prop with few possible values (boolean, small string union), note in
   `description` whether every value is exercised somewhere, or just some —
   e.g. "boolean prop, only `true` is ever set; no story exercises `false`."
   This is still a coverage observation, not a stylistic one.

Rules:
- Only report props you've confirmed genuinely are not exercised anywhere in
  the real story file — the point of this pass is to filter the regex
  extraction's false positives, not rubber-stamp its output.
- Do NOT comment on story quality, naming, organization, or whether a
  component "should" have more stories in general — only prop/variant
  coverage.
- A pair with no genuine gaps returns nothing for it. Do not manufacture
  findings to look thorough.

## Output (write to `.claude/cqa/storybook-units/<batchId>.findings.json`)
```json
{
  "batchId": "storybook-batch-0",
  "findings": [
    {
      "component": "src/components/Button/Button.tsx",
      "prop": "size",
      "description": "Button declares `size: 'sm' | 'md' | 'lg'` but every story in Button.stories.tsx either omits it or sets 'md'; 'sm' and 'lg' are never exercised.",
      "suggestedFix": "Add a story variant (or args permutation) that sets size to 'sm' and one that sets 'lg'."
    }
  ]
}
```
Always emit `findings` even if empty (`[]`).
