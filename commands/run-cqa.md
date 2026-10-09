---
description: Run the full Code Quality Analyzer pipeline end to end against the current project and produce .claude/cqa/report.html
---

You are running the complete CQA pipeline from scratch against **the user's current project** (`${CLAUDE_PROJECT_DIR}`) — a one-time baseline code-quality audit, per the bundled `${CLAUDE_PLUGIN_ROOT}/tools/cqa/PLAN.md`. This is a long task (dozens of subagent dispatches, roughly 30-60+ minutes, a few dollars of token spend). Read `${CLAUDE_PLUGIN_ROOT}/tools/cqa/README.md` once at the start for the authoritative pipeline order and file list; the steps below are the exact sequence, including operational lessons already learned the hard way.

**Where things live — this is the single most important thing to get right:** the engine scripts and `.md` playbooks are bundled with this plugin at `${CLAUDE_PLUGIN_ROOT}/tools/cqa/` — always invoke them from there. All output (`manifest.json`, `report.html`, etc.) belongs in the user's own project under `.claude/cqa/` (i.e. `${CLAUDE_PROJECT_DIR}/.claude/cqa/`) — never write pipeline output into the plugin's own directory. Every script already accepts the target repo root as its first CLI argument, so invoke them as `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/<script>.ts" "${CLAUDE_PROJECT_DIR}"` — don't rely on the current working directory alone, be explicit.

**Project rules:** do not edit anything under `${CLAUDE_PLUGIN_ROOT}/tools/cqa/*.ts` or `${CLAUDE_PLUGIN_ROOT}/tools/cqa/__tests__/` — that's the pipeline's own code, already built and tested; this command only *runs* it and produces data outputs under the user's `.claude/cqa/`. Check the user's own project's CLAUDE.md (if one exists) for commit/push conventions before running any git command in their repo — this command itself never needs to commit anything.

**Critical operational rule — read this before dispatching anything:** when you dispatch your own subagents for a batch (discovery units, discovery-judgment batches, reconciliation), send all of that batch's `Agent` calls together in **one message, in the foreground** (i.e. do not pass `run_in_background: true`, and do not use the `Monitor` tool or any background-wait-and-poll pattern on your own dispatched children). Foreground calls sent together in one message run concurrently and return their results directly in that same tool round. Using background dispatch + waiting on your own subagents has been observed to repeatedly trigger a harness handback mid-task, stalling progress across many turns for no benefit. Keep each batch to a handful of agents (roughly 6-10) rather than firing all of them at once.

## Step 0 — Bootstrap the plugin's own dependencies

The engine's `graph.ts` imports the `typescript` npm package to resolve the *target* project's own `tsconfig.json`/import paths — that's a dependency of the plugin itself, not of the project being scanned. If `${CLAUDE_PLUGIN_ROOT}/node_modules` doesn't exist yet, run `npm install` with `${CLAUDE_PLUGIN_ROOT}` as the working directory before anything else (e.g. `cd "${CLAUDE_PLUGIN_ROOT}" && npm install`). Skip this if `node_modules` is already present.

## Step 1 — Preserve any existing run

If `${CLAUDE_PROJECT_DIR}/.claude/cqa/manifest.json` already exists, move the entire `.claude/cqa/` directory (inside the user's project) to `.claude/cqa.bak-<today's date, YYYY-MM-DD>/` (plain filesystem rename, not git) before writing anything new. This is always a fresh baseline run, not an incremental update.

## Step 2 — Deterministic driver

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/index.ts" "${CLAUDE_PROJECT_DIR}"`

This writes `manifest.json` and `candidates.json` into the project's `.claude/cqa/`. If it fails with "no stack adapter matched this repo," stop and report that back — it means this project's stack isn't supported yet (check `${CLAUDE_PLUGIN_ROOT}/tools/cqa/config.ts`'s adapter registry and `PLAN.md`'s TODO list for what's planned), don't try to force it.

Sanity-check: spot-check a few `workUnits` entries in the new `manifest.json` and confirm `crossClusterEdges` is populated (non-empty array) on at least some units — if the field is missing entirely or empty on every unit, the deterministic driver's graph step may be broken; stop and report rather than continuing into a reconciliation pass with nothing to review.

## Step 3 — Version brief

Follow `${CLAUDE_PLUGIN_ROOT}/tools/cqa/VERSION_BRIEF.md` exactly: read the project's `manifest.json`'s `detectedVersions`, use the Context7 MCP tools (`resolve-library-id` / `query-docs`) per package, write `${CLAUDE_PROJECT_DIR}/.claude/cqa/version-brief.json`. If Context7 isn't available, write the file anyway with `"currentApiNotes": "unavailable — Context7 lookup failed"` entries per that doc's fallback instruction — never skip the file.

## Step 3.5 — Project docs brief

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/prepare-docs-brief.ts" "${CLAUDE_PROJECT_DIR}"` → `project-docs-input.json`.

Follow `${CLAUDE_PLUGIN_ROOT}/tools/cqa/PROJECT_DOCS_BRIEF.md` exactly: skim the discovered markdown files in the user's own project, read and summarize the ones with real operational/architectural content, tag each with the file patterns it's relevant to, write `${CLAUDE_PROJECT_DIR}/.claude/cqa/project-docs-brief.json`. This exists because a project's own docs explain *why* a pattern is built the way it is — e.g. a documented multi-query fan-out workaround for a CMS response-size limit — which the discovery pass needs to avoid misreading a deliberate design as a bug. Don't skip this even if nothing is worth summarizing; write the file with empty `entries` either way.

## Step 4 — Discovery pass (per work unit)

Follow `${CLAUDE_PLUGIN_ROOT}/tools/cqa/DISCOVERY.md`'s orchestration exactly, reading work units from the project's `manifest.json`. For each work unit, extract the matching version-brief entries AND any project-docs-brief entries whose `relevantTo` patterns match the unit's files, then dispatch one subagent per unit with the "Per-unit task" from that doc, **model sonnet, foreground, batched ~6-10 at a time per the operational rule above**. Each writes `${CLAUDE_PROJECT_DIR}/.claude/cqa/units/<unitId>.findings.json`. Hard rule from the doc: subagents must not spawn further subagents, and you must not exceed the fixed work-unit list.

Then: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/merge-discovery.ts" "${CLAUDE_PROJECT_DIR}"` → `discovery-findings.json` + `unit-summaries.json`.

## Step 5 — Static judgment (small, no subagents needed)

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/prepare-judgment.ts" "${CLAUDE_PROJECT_DIR}"` → `judgment-input.json`.

Per `${CLAUDE_PLUGIN_ROOT}/tools/cqa/JUDGMENT.md`, this input is small — judge it yourself directly in one pass (the doc explicitly says no subagent fan-out is needed here). Write `${CLAUDE_PROJECT_DIR}/.claude/cqa/verdicts.json`, then run `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/apply-verdicts.ts" "${CLAUDE_PROJECT_DIR}"` → `findings.json`.

## Step 6 — Discovery-judgment (the AI-found findings, skeptical re-review)

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/prepare-discovery-judgment.ts" "${CLAUDE_PROJECT_DIR}"` → `discovery-judgment-input.json`.

Split the array into batches of ~35-40 items. Dispatch one subagent per batch, **model sonnet, foreground**, each following `${CLAUDE_PLUGIN_ROOT}/tools/cqa/DISCOVERY_JUDGMENT.md` exactly for its slice and writing its own batch-verdicts file (use the scratchpad directory for intermediate batch files — not the project, not the plugin). After all batches return: verify every input `id` has a matching verdict by diffing ids per batch (do not just trust the counts) — if any are missing, judge those specific items yourself directly by reading the cited file. Merge all batches into one array, write `${CLAUDE_PROJECT_DIR}/.claude/cqa/discovery-verdicts.json`, then run `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/apply-discovery-verdicts.ts" "${CLAUDE_PROJECT_DIR}"` → `discovery-findings.judged.json`.

## Step 7 — Reconciliation

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/prepare-reconciliation.ts" "${CLAUDE_PROJECT_DIR}"` → `reconciliation-input.json`.

Process **every** group in `targetGroups`, exhaustively — never pre-filter by guessing which files sound stateful; that was tried once and silently skipped 81 of 98 high-fan-in files including plausible real candidates. Grouping by target file (not edge) is what keeps this affordable: a real run collapses ~2400 raw edges into ~370 target groups, and review cost scales with groups, not edges — processing every group covers every edge, by construction. Batch `targetGroups` into subagent dispatches of ~10-15 groups each (model sonnet, foreground, per the operational rule above — expect on the order of 25-40 batches for a codebase this size, the same order of magnitude as the discovery pass), each following `${CLAUDE_PLUGIN_ROOT}/tools/cqa/RECONCILIATION.md` exactly. Write `${CLAUDE_PROJECT_DIR}/.claude/cqa/reconciliation.json` (`{ "findings": [...] }` — an empty array for a given group is a legitimate, honest result; don't manufacture findings to look thorough). Then run `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/merge-reconciliation.ts" "${CLAUDE_PROJECT_DIR}"` → `reconciliation-findings.json`.

If cost genuinely forces a reduced scope on a given run, that must be an explicit, disclosed choice you report back at the end (e.g. "reviewed the top N target groups by fan-in, skipped M") — never a silent partial pass presented as if it were complete.

## Step 8 — Holistic synthesis

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/prepare-holistic.ts" "${CLAUDE_PROJECT_DIR}"` → `holistic-input.json`.

Follow `${CLAUDE_PLUGIN_ROOT}/tools/cqa/HOLISTIC.md` exactly — one pass, no subagent needed (small compressed input). Write `${CLAUDE_PROJECT_DIR}/.claude/cqa/holistic.json`.

## Step 9 — Refutation

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/prepare-refute.ts" "${CLAUDE_PROJECT_DIR}"` → `refute-input.json` (requires `findings.json`, `discovery-findings.judged.json`, and `reconciliation-findings.json` to already exist — they will by this point).

Follow `${CLAUDE_PLUGIN_ROOT}/tools/cqa/REFUTE.md` exactly for every High/Critical finding (one subagent is usually enough unless the list is large, in which case batch it the same way as Step 6). Write `${CLAUDE_PROJECT_DIR}/.claude/cqa/refute-verdicts.json`, then run `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/apply-refute.ts" "${CLAUDE_PROJECT_DIR}"` → `refute-result.json`.

## Step 10 — Cost accounting

Tally the token usage actually reported back to you (via task-notification `<subagent_tokens>` tags) for every subagent you directly dispatched in Steps 4, 6, 7, and 9 — this is your "measured" figure. Nested work you can't see (e.g. if a dispatched agent itself spawned further agents, which it shouldn't per the rules above) has no visibility; note that explicitly rather than guessing at it. Write `${CLAUDE_PROJECT_DIR}/.claude/cqa/cost.json` matching this shape:

```json
{
  "generatedAt": "<ISO timestamp>",
  "model": "claude-sonnet-5-5",
  "pricing": { "inputPerMTok": 2, "outputPerMTok": 10, "assumedBlendedPerMTok": 3.6, "assumptionNote": "Blended rate assumes a read-heavy ~80% input / 20% output split; actual split per call isn't recorded." },
  "measured": { "tokens": <sum of all subagent_tokens you observed>, "description": "<what's included — be specific about which steps/batches>" },
  "estimatedNested": { "tokens": 0, "description": "No nested dispatch occurred this run — every subagent you dispatched reported directly.", "breakdown": [] },
  "totalEstimateTokens": <measured + estimatedNested>,
  "costEstimateUsd": { "low": <total*2/1e6>, "central": <total*3.6/1e6>, "high": <total*10/1e6> },
  "caveat": "<note any genuinely unobserved nested cost, or state there was none>"
}
```

## Step 11 — Score and report

Run: `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/scorer.ts" "${CLAUDE_PROJECT_DIR}"` then `npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cqa/report.ts" "${CLAUDE_PROJECT_DIR}"`.

## Step 12 — Verify and summarize

Confirm all of these exist under `${CLAUDE_PROJECT_DIR}/.claude/cqa/` (`project-docs-brief.json` may legitimately have empty `entries` if no project docs were worth summarizing, but the file itself must exist): `manifest.json`, `candidates.json`, `version-brief.json`, `project-docs-brief.json`, `discovery-findings.json`, `unit-summaries.json`, `findings.json`, `discovery-findings.judged.json`, `reconciliation-findings.json`, `holistic.json`, `refute-result.json`, `score.json`, `cost.json`, `report.html`.

Report back to the user: the overall grade, per-category grades, total scored findings (AI-found vs tool-found split), and the cost estimate — then tell them `.claude/cqa/report.html` (in their own project) is ready and offer to open it.
