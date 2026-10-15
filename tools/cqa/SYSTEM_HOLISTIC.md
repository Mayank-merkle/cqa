# CQA System-Holistic Pass — monorepo/fleet synthesis (run inside Claude Code)

This is the monorepo-scale counterpart to `HOLISTIC.md`. `HOLISTIC.md` runs
once **per workspace** and reasons across that workspace's own modules;
by design it has zero visibility into sibling workspaces. This pass runs
**once for the whole fleet** and reasons across every workspace's own
one-line unit summaries plus the cross-cutting signals no single workspace's
pipeline can see on its own: duplicated logic between services, how
services actually couple to each other, and dependency/runtime drift across
the fleet. It does not replace any workspace's own `HOLISTIC.md` run or its
per-workspace `report.html` — this is additive, system-level context.

## Input

`.claude/cqa/system-holistic-input.json`:
- `workspaces` — every workspace found, matched or not, with
  `{ workspace, adapterId, reason?, sourceFiles, workUnits?, candidates? }`.
  An `adapterId: null` entry (`reason` explains why) got mechanical
  duplication/cross-service scanning only, never a full AI review — treat
  these as real, relevant code (e.g. a standalone Contentful-migration
  script directory is still part of the system), not as noise to ignore.
- `unitSummaries` — every workspace's own one-line-per-unit summaries,
  flattened to `{ workspace, unitId, summary }`, so you know what each part
  of each service actually does without reading source.
- `duplication` — the biggest shared-code spans across the fleet, each
  `{ lines, locations: [{ workspace, file, startLine, endLine }, ...] }`,
  sorted biggest-first. This is mechanical exact/near-duplicate detection
  (hash-of-normalized-lines), not a judged finding — some will be
  coincidental boilerplate; use judgment about what's actually worth
  recommending for extraction.
- `crossService` — heuristic coupling edges,
  `{ mechanism, fromWorkspace, toWorkspace, detail, evidence }`, where
  `mechanism` is one of `cdk-cross-stack-reference` (CDK stack export/import),
  `shared-resource-name` (two services independently reference the same
  SSM/DynamoDB/SQS/SNS/EventBridge name), or `cdk-lambda-entry-reference`
  (a CDK stack's own construct wires to another workspace's lambda entry
  file — this is how a CDK-app-root workspace like `hotel-api/cdk` relates
  to its own nested lambda workspaces). These are candidates from regex
  matching, not verified architecture — a shared literal string could
  coincidentally match across two unrelated services.
- `dependencyDrift` — packages at genuinely different versions across the
  fleet, `{ package, versions: [{ version, workspaces }] }` — only packages
  already confirmed to differ (not every dependency).
- `fleetPosture` — per-workspace candidate counts by dimension, plus Jest
  coverage % where measured — a rollup of data each workspace's own run
  already produced, not new detection.

## Task

Produce four distinct kinds of output — don't collapse them into generic
prose, the report needs to render them as separate sections:

1. **Duplication findings** — for each `duplication` entry (or cluster of
   related ones) worth acting on, name what's actually duplicated (infer
   from the file paths/context, you don't have the literal duplicated text),
   which workspaces are involved, and whether it looks like something worth
   extracting into a shared internal package/layer versus coincidental
   boilerplate not worth the extraction effort. Skip entries that are
   clearly trivial (e.g. identical config/boilerplate with no real logic).
2. **Communication topology** — describe the actual shape implied by
   `crossService`: which workspaces are hubs (many edges in/out — a shared
   dependency failing has a wide blast radius), any producer/consumer
   pairing visible through a shared queue/topic/table name, and any CDK
   app roots paired with their nested lambda workspaces via
   `cdk-lambda-entry-reference`. Call out missing-DLQ or fan-out-with-no-
   concurrency-cap risk only if evidence actually suggests a queue/event
   pattern — don't speculate beyond what the edges show.
3. **Dependency drift** — for each `dependencyDrift` entry, say whether the
   spread looks risky (e.g. a security-relevant package years apart) or
   benign (a patch-version difference), and what it would take to converge.
4. **General architecture observations** — same shape as `HOLISTIC.md`'s
   `observations`: cross-cutting patterns across the fleet that don't fit
   the three categories above (e.g. a consistent strength, or a systemic
   weakness repeating across many services).

Rules (same as `HOLISTIC.md`):
- Ground every claim in the input; reference specific workspaces/files.
  Do NOT invent specifics you can't point to.
- This is judgment, not a defect list — each item is a paragraph of
  reasoning, not a counted issue.
- Be honest about a clean fleet. If duplication is minimal and coupling is
  sane, say so.
- Explicitly mention unmatched (`adapterId: null`) workspaces somewhere in
  the output if they participated in any duplication/cross-service finding,
  and note in `overallNarrative` how many workspaces got mechanical-only
  scanning versus full review, so a reader knows the coverage shape of this
  report.

## Output (write to `.claude/cqa/system-holistic.json`)

```json
{
  "duplicationFindings": [
    {
      "title": "Short headline",
      "assessment": "What's duplicated, where, and whether extraction is worth it.",
      "workspacesInvolved": ["hotel-api/cdk/lambdas/getCurrency", "profile-api/cdk/lambdas/getAgentProfile"],
      "recommendedAction": "Extract to a shared internal package, or 'leave as-is — coincidental boilerplate'."
    }
  ],
  "communicationTopology": {
    "narrative": "3-6 sentences describing the actual coupling shape.",
    "hubs": ["workspace ids with unusually high edge count, if any"],
    "risks": ["specific risk statements grounded in actual edges, or [] if none"]
  },
  "dependencyDriftFindings": [
    { "package": "aws-cdk-lib", "assessment": "Is this spread risky or benign, and what convergence would take." }
  ],
  "observations": [
    { "title": "Short headline", "assessment": "2-4 sentences, grounded in the input.", "supporting": ["workspace or finding ids"], "weight": "High | Medium | Low" }
  ],
  "overallNarrative": "3-6 sentences: the honest one-paragraph story of this fleet's quality, including the coverage shape (N/M workspaces fully reviewed)."
}
```

## Scale

One pass, no subagent fan-out — the input is small, pre-aggregated data
(summaries and counts, not raw source), the same shape of input
`HOLISTIC.md` already handles in one pass today.
