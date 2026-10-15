---
description: Run the full Code Quality Analyzer pipeline end to end against the current project and produce .claude/cqa/report.html
---

You are running the complete CQA pipeline from scratch against **the user's current project** (`${CLAUDE_PROJECT_DIR}`) — a one-time baseline code-quality audit, per the bundled `${CLAUDE_PLUGIN_ROOT}/tools/cqa/PLAN.md`. This is a long task (dozens of subagent dispatches, roughly 30-60+ minutes, a few dollars of token spend). Read `${CLAUDE_PLUGIN_ROOT}/tools/cqa/README.md` once at the start for the authoritative pipeline order and file list; the steps below are the exact sequence, including operational lessons already learned the hard way.

**Where things live — this is the single most important thing to get right:** the engine scripts and `.md` playbooks are bundled with this plugin at `${CLAUDE_PLUGIN_ROOT}/tools/cqa/` — always invoke them from there. All output (`manifest.json`, `report.html`, etc.) belongs in the user's own project under `.claude/cqa/` (i.e. `${CLAUDE_PROJECT_DIR}/.claude/cqa/`) — never write pipeline output into the plugin's own directory. Every script already accepts the target repo root as its first CLI argument, so invoke them as `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/<script>.ts" "${CLAUDE_PROJECT_DIR}"` — don't rely on the current working directory alone, be explicit.

**Project rules:** do not edit anything under `${CLAUDE_PLUGIN_ROOT}/tools/cqa/*.ts` or `${CLAUDE_PLUGIN_ROOT}/tools/cqa/__tests__/` — that's the pipeline's own code, already built and tested; this command only *runs* it and produces data outputs under the user's `.claude/cqa/`. Check the user's own project's CLAUDE.md (if one exists) for commit/push conventions before running any git command in their repo — this command itself never needs to commit anything.

**Critical operational rule — read this before dispatching anything:** when you dispatch your own subagents for a batch (discovery units, discovery-judgment batches, reconciliation), send all of that batch's `Agent` calls together in **one message, in the foreground** (i.e. do not pass `run_in_background: true`, and do not use the `Monitor` tool or any background-wait-and-poll pattern on your own dispatched children). Foreground calls sent together in one message run concurrently and return their results directly in that same tool round. Using background dispatch + waiting on your own subagents has been observed to repeatedly trigger a harness handback mid-task, stalling progress across many turns for no benefit. Keep each batch to a handful of agents (roughly 6-10) rather than firing all of them at once.

**Budget cap — $100 per full run, never a reason to bail:** this run has a hard spend cap of **$100** (blended at the Step 10 pricing table's $3.6/MTok rate, i.e. roughly 27.8M total tokens). After *every* subagent batch you dispatch in Steps 4, 6, 7, and 9, add that batch's `subagent_tokens` to a running total you keep for the whole run, and convert it to an estimated dollar figure (`runningTokens * 3.6 / 1e6`). The moment that running estimate reaches $100:
- **Stop dispatching any further subagent batches** — for the rest of the pipeline, not just the current stage (e.g. if the cap is hit partway through Reconciliation, also skip any Discovery/Discovery-judgment/Refutation batches that hadn't been dispatched yet, if the stages are still pending; if they already ran, their results stand).
- **Do not stop the pipeline.** Every remaining deterministic step still runs on whatever was actually collected: run the `merge-*.ts` / `apply-*.ts` script for every stage as normal (a stage with zero dispatched batches simply merges an empty result — that's a legitimate, honest partial output, same principle as the existing "empty array is a legitimate result" rule in Step 7), then proceed through Steps 10, 11, and 12 unconditionally. The deliverable is always a complete, valid `report.html` — on a partial scan if the cap was hit, never no report at all.
- **Disclose it, loudly, in both places that need it:** record it in `cost.json`'s `budget` field (shape in Step 10) with which stage dispatch stopped at and what was skipped, and say it plainly in your final summary to the user (don't bury it) — per the existing Step 7 principle that a reduced scope must be an explicit, disclosed choice, never a silent partial pass presented as complete.

**Status reporting — keep this table visible throughout the run, not just at the end:** this is a long, mostly-silent task from the user's point of view otherwise. Print the table below to the chat once you reach Step 2 (fill in `Work units` once `manifest.json` exists), then **re-print the full table** (not a diff, not a single line) every time a step or sub-stage completes — after Steps 0, 1, 2, 3, 3.5, 4, 5, 6, each major milestone within Step 7 (e.g. every ~25% of target groups processed, not every single batch — Reconciliation can be 25-40+ batches and reprinting on every one would flood the chat), 7.5, 8, 9, 10, 11, and 12. Status values: `⏳ pending`, `🔄 in progress` (with a short detail, e.g. `batch 12/31`), `✅ done` (with a one-line result metric), `⏭️ skipped` (with the reason — only legitimate for 3.5 and 7.5 when there's genuinely nothing to summarize/check). Always include the running budget line underneath.

```
| Step | Status | Detail |
|---|---|---|
| 0. Bootstrap | ⏳ | |
| 1. Preserve existing run | ⏳ | |
| 2. Deterministic scan | ⏳ | |
| 3. Version brief | ⏳ | |
| 3.5. Project docs brief | ⏳ | |
| 4. Discovery | ⏳ | |
| 5. Static judgment | ⏳ | |
| 6. Discovery-judgment | ⏳ | |
| 7. Reconciliation | ⏳ | |
| 7.5. Storybook coverage | ⏳ | |
| 8. Holistic synthesis | ⏳ | |
| 9. Refutation | ⏳ | |
| 10. Cost accounting | ⏳ | |
| 11. Score + report | ⏳ | |
| 12. Verify | ⏳ | |

Budget: $0.00 / $100 spent so far
```

Example of a filled-in row once known: `| 2. Deterministic scan | ✅ | 58 work units, stack: next-contentful |`, `| 7. Reconciliation | 🔄 | batch 12 of 31 (370 target groups) |`. This table is informational only — it never replaces the actual disclosure obligations elsewhere in this doc (the budget-cap paragraph above, the Step 7 exhaustiveness rule, Step 12's final summary); it's the running view of the same facts.

## Step 0 — Bootstrap the plugin's own dependencies

The engine's `graph.ts` imports the `typescript` npm package to resolve the *target* project's own `tsconfig.json`/import paths — that's a dependency of the plugin itself, not of the project being scanned. If `${CLAUDE_PLUGIN_ROOT}/node_modules` doesn't exist yet, run `npm install` with `${CLAUDE_PLUGIN_ROOT}` as the working directory before anything else (e.g. `cd "${CLAUDE_PLUGIN_ROOT}" && npm install`). Skip this if `node_modules` is already present.

Then run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/check-version.ts"` — a non-blocking check against the published repo for a newer release. It prints nothing if it can't reach GitHub, the install isn't from a github.com marketplace, or this is already the latest version; never treat its failure or silence as a problem. If it does print a newer-version notice, **relay that to the user in your first status update** (plugin marketplaces added by URL don't auto-update, so this is the only signal they'll get) — but keep running the pipeline regardless, this never blocks or delays the run itself.

## Step 1 — Preserve any existing run

If `${CLAUDE_PROJECT_DIR}/.claude/cqa/manifest.json` already exists, move the entire `.claude/cqa/` directory (inside the user's project) to `.claude/cqa.bak-<today's date, YYYY-MM-DD>/` (plain filesystem rename, not git) before writing anything new. This is always a fresh baseline run, not an incremental update.

## Step 2 — Deterministic driver

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/index.ts" "${CLAUDE_PROJECT_DIR}"`

This writes `manifest.json` and `candidates.json` into the project's `.claude/cqa/`, and — if the adapter's `testCoverage` collector is enabled — runs the project's own test suite with coverage and writes `coverage-summary.json` (this can take a while on a large suite; it's expected). If it fails with "no stack adapter matched this repo," stop and report that back — it means this project's stack isn't supported yet (check `${CLAUDE_PLUGIN_ROOT}/tools/cqa/config.ts`'s adapter registry and `PLAN.md`'s TODO list for what's planned), don't try to force it.

Sanity-check: spot-check a few `workUnits` entries in the new `manifest.json` and confirm `crossClusterEdges` is populated (non-empty array) on at least some units — if the field is missing entirely or empty on every unit, the deterministic driver's graph step may be broken; stop and report rather than continuing into a reconciliation pass with nothing to review.

## Step 3 — Version brief

Follow `${CLAUDE_PLUGIN_ROOT}/tools/cqa/VERSION_BRIEF.md` exactly: read the project's `manifest.json`'s `detectedVersions`, use the Context7 MCP tools (`resolve-library-id` / `query-docs`) per package, write `${CLAUDE_PROJECT_DIR}/.claude/cqa/version-brief.json`. If Context7 isn't available, write the file anyway with `"currentApiNotes": "unavailable — Context7 lookup failed"` entries per that doc's fallback instruction — never skip the file.

## Step 3.5 — Project docs brief

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/prepare-docs-brief.ts" "${CLAUDE_PROJECT_DIR}"` → `project-docs-input.json`.

Follow `${CLAUDE_PLUGIN_ROOT}/tools/cqa/PROJECT_DOCS_BRIEF.md` exactly: skim the discovered markdown files in the user's own project, read and summarize the ones with real operational/architectural content, tag each with the file patterns it's relevant to, write `${CLAUDE_PROJECT_DIR}/.claude/cqa/project-docs-brief.json`. This exists for two reasons: a project's own docs explain *why* a pattern is built the way it is — e.g. a documented multi-query fan-out workaround for a CMS response-size limit — which the discovery pass needs to avoid misreading a deliberate design as a bug (the `summary` field); and a project's own docs, especially a root `CLAUDE.md`, often state explicit house rules ("API routes must validate input with zod") that the discovery pass should actively check for violations of (the `rules` field). **Always read the target repo's root `CLAUDE.md` if one exists** — it's the project's canonical AI-facing instruction file and the highest-confidence source of house rules, never skip it as "generic." Don't skip this step even if nothing is worth summarizing; write the file with empty `entries` either way.

## Step 4 — Discovery pass (per work unit)

Follow `${CLAUDE_PLUGIN_ROOT}/tools/cqa/DISCOVERY.md`'s orchestration exactly, reading work units from the project's `manifest.json`. For each work unit, extract the matching version-brief entries AND any project-docs-brief entries whose `relevantTo` patterns match the unit's files, then dispatch one subagent per unit with the "Per-unit task" from that doc, **model sonnet, foreground, batched ~6-10 at a time per the operational rule above**. Each writes `${CLAUDE_PROJECT_DIR}/.claude/cqa/units/<unitId>.findings.json`. Hard rule from the doc: subagents must not spawn further subagents, and you must not exceed the fixed work-unit list.

Then: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/merge-discovery.ts" "${CLAUDE_PROJECT_DIR}"` → `discovery-findings.json` + `unit-summaries.json`.

## Step 5 — Static judgment (small, no subagents needed)

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/prepare-judgment.ts" "${CLAUDE_PROJECT_DIR}"` → `judgment-input.json`.

Per `${CLAUDE_PLUGIN_ROOT}/tools/cqa/JUDGMENT.md`'s "Scale" section: if `judgment-input.json` has 40 items or fewer, judge it yourself directly in one pass — no subagent fan-out needed. If it has more than 40 (a large eslint/npm-audit candidate volume), split into batches of ~35-40 and dispatch one subagent per batch, **model sonnet, foreground, batched per the operational rule above**, each writing its own batch-verdicts file to the scratchpad directory and following the doc exactly; then verify every input `id` has a matching verdict by diffing ids per batch (not just counts) before merging into one array. Either way, write the combined result to `${CLAUDE_PROJECT_DIR}/.claude/cqa/verdicts.json`, then run `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/apply-verdicts.ts" "${CLAUDE_PROJECT_DIR}"` → `findings.json`.

## Step 6 — Discovery-judgment (the AI-found findings, skeptical re-review)

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/prepare-discovery-judgment.ts" "${CLAUDE_PROJECT_DIR}"` → `discovery-judgment-input.json`.

Split the array into batches of ~35-40 items. Dispatch one subagent per batch, **model sonnet, foreground**, each following `${CLAUDE_PLUGIN_ROOT}/tools/cqa/DISCOVERY_JUDGMENT.md` exactly for its slice and writing its own batch-verdicts file (use the scratchpad directory for intermediate batch files — not the project, not the plugin). After all batches return: verify every input `id` has a matching verdict by diffing ids per batch (do not just trust the counts) — if any are missing, judge those specific items yourself directly by reading the cited file. Merge all batches into one array, write `${CLAUDE_PROJECT_DIR}/.claude/cqa/discovery-verdicts.json`, then run `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/apply-discovery-verdicts.ts" "${CLAUDE_PROJECT_DIR}"` → `discovery-findings.judged.json`.

## Step 7 — Reconciliation

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/prepare-reconciliation.ts" "${CLAUDE_PROJECT_DIR}"` → `reconciliation-input.json`.

Process **every** group in `targetGroups`, exhaustively — never pre-filter by guessing which files sound stateful; that was tried once and silently skipped 81 of 98 high-fan-in files including plausible real candidates. Grouping by target file (not edge) is what keeps this affordable: a real run collapses ~2400 raw edges into ~370 target groups, and review cost scales with groups, not edges — processing every group covers every edge, by construction. Batch `targetGroups` into subagent dispatches of ~10-15 groups each (model sonnet, foreground, per the operational rule above — expect on the order of 25-40 batches for a codebase this size, the same order of magnitude as the discovery pass), each following `${CLAUDE_PLUGIN_ROOT}/tools/cqa/RECONCILIATION.md` exactly. Write `${CLAUDE_PROJECT_DIR}/.claude/cqa/reconciliation.json` (`{ "findings": [...] }` — an empty array for a given group is a legitimate, honest result; don't manufacture findings to look thorough). Then run `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/merge-reconciliation.ts" "${CLAUDE_PROJECT_DIR}"` → `reconciliation-findings.json`.

If cost genuinely forces a reduced scope on a given run, that must be an explicit, disclosed choice you report back at the end (e.g. "reviewed the top N target groups by fan-in, skipped M") — never a silent partial pass presented as if it were complete.

## Step 7.5 — Storybook coverage (optional, skip if the project has no stories)

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/prepare-storybook-coverage.ts" "${CLAUDE_PROJECT_DIR}"` → `storybook-coverage-input.json`.

If `pairsWithGaps` is empty (no colocated `.stories.tsx` files, or every one already exercises its component's full prop surface), write `${CLAUDE_PROJECT_DIR}/.claude/cqa/storybook-coverage-findings.json` as `[]` directly and skip straight to Step 8 — no subagents needed. Otherwise dispatch one subagent per batch in `batches`, **model sonnet, foreground, batched per the operational rule above**, each following `${CLAUDE_PLUGIN_ROOT}/tools/cqa/STORYBOOK_COVERAGE.md`'s "Per-batch task" exactly for its slice of `pairsWithGaps` (looked up by `pairId`) and writing `${CLAUDE_PROJECT_DIR}/.claude/cqa/storybook-units/<batchId>.findings.json`. This is a coverage-gap check, not a story-quality review — do not let it drift into commenting on story structure or naming. Then run `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/merge-storybook-coverage.ts" "${CLAUDE_PROJECT_DIR}"` → `storybook-coverage-findings.json`.

## Step 8 — Holistic synthesis

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/prepare-holistic.ts" "${CLAUDE_PROJECT_DIR}"` → `holistic-input.json`.

Follow `${CLAUDE_PLUGIN_ROOT}/tools/cqa/HOLISTIC.md` exactly — one pass, no subagent needed (small compressed input). Write `${CLAUDE_PROJECT_DIR}/.claude/cqa/holistic.json`.

## Step 9 — Refutation

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/prepare-refute.ts" "${CLAUDE_PROJECT_DIR}"` → `refute-input.json` (requires `findings.json`, `discovery-findings.judged.json`, and `reconciliation-findings.json` to already exist — they will by this point).

Follow `${CLAUDE_PLUGIN_ROOT}/tools/cqa/REFUTE.md` exactly for every High/Critical finding (one subagent is usually enough unless the list is large, in which case batch it the same way as Step 6). Write `${CLAUDE_PROJECT_DIR}/.claude/cqa/refute-verdicts.json`, then run `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/apply-refute.ts" "${CLAUDE_PROJECT_DIR}"` → `refute-result.json`.

## Step 10 — Cost accounting

Tally the token usage actually reported back to you (via task-notification `<subagent_tokens>` tags) for every subagent you directly dispatched in Steps 4, 6, 7, and 9 — this is your "measured" figure (the same running total you were already keeping for the budget cap above). Nested work you can't see (e.g. if a dispatched agent itself spawned further agents, which it shouldn't per the rules above) has no visibility; note that explicitly rather than guessing at it. Write `${CLAUDE_PROJECT_DIR}/.claude/cqa/cost.json` matching this shape:

```json
{
  "generatedAt": "<ISO timestamp>",
  "model": "claude-sonnet-5-5",
  "pricing": { "inputPerMTok": 2, "outputPerMTok": 10, "assumedBlendedPerMTok": 3.6, "assumptionNote": "Blended rate assumes a read-heavy ~80% input / 20% output split; actual split per call isn't recorded." },
  "measured": { "tokens": <sum of all subagent_tokens you observed>, "description": "<what's included — be specific about which steps/batches>" },
  "estimatedNested": { "tokens": 0, "description": "No nested dispatch occurred this run — every subagent you dispatched reported directly.", "breakdown": [] },
  "totalEstimateTokens": <measured + estimatedNested>,
  "costEstimateUsd": { "low": <total*2/1e6>, "central": <total*3.6/1e6>, "high": <total*10/1e6> },
  "caveat": "<note any genuinely unobserved nested cost, or state there was none>",
  "budget": {
    "capUsd": 100,
    "exceeded": <true iff the running estimate reached $100 at any point and you stopped dispatching further batches>,
    "stoppedAtStage": "<e.g. 'Reconciliation (batch 12 of 31)' — omit if not exceeded>",
    "skipped": "<plain-English description of exactly what was skipped as a result, e.g. 'Reconciliation batches 13-31 and Refutation were not run; scoring/report cover only what was collected through batch 12.' — omit if not exceeded>"
  }
}
```

`budget.exceeded: false` is the common case and should still be written (with `capUsd` only) so the report can positively confirm the cap wasn't hit, not just omit the field.

## Step 11 — Score and report

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/scorer.ts" "${CLAUDE_PROJECT_DIR}"` then `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/report.ts" "${CLAUDE_PROJECT_DIR}"`.

## Step 12 — Verify and summarize

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/diagnose.ts" "${CLAUDE_PROJECT_DIR}"`. This checks for exactly the file-existence set below plus collector failures, a broken graph step, suspiciously low reviewed-file coverage, and a reached budget cap — it supersedes manually eyeballing the file list (`project-docs-brief.json` may legitimately have empty `entries` if no project docs were worth summarizing, and `storybook-coverage-findings.json` may legitimately be `[]`, but both files must exist; `coverage-summary.json` exists only if the adapter's `testCoverage` collector is enabled, and `diagnose.ts` already knows not to treat its absence as an error otherwise).

If `diagnose.ts` reports any issues, it writes `.claude/cqa/diagnostic-report.txt` (metadata only — no source code or finding content) — **surface this to the user plainly, don't bury it**: say what was found, and suggest they email that file to the address `diagnose.ts` printed so the pipeline itself can be fixed.

Report back to the user: the overall grade, per-category grades, total scored findings (AI-found vs tool-found split), and the cost estimate — then tell them `.claude/cqa/report.html` (in their own project) is ready and offer to open it. **If the $100 budget cap was reached, lead with that** (don't let it be a footnote): say plainly that this is a partial run, what stage it stopped at, and what was skipped — the same disclosure that's already in `cost.json`'s `budget` field and the report's own top-of-page banner.
