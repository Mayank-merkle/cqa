# Code Quality Analyzer — deterministic driver (v0.3)

The non-AI foundation of the analyzer. It does the work LLMs are bad at —
enumerating files, resolving imports, and gathering mechanical findings
exhaustively and reproducibly — and hands the AI passes small, bounded inputs.

No AI in this directory. It runs in Claude Code (or any Node 22 shell) and
writes two files the AI passes consume.

## What it does

1. **Enumerate** every file under `src/`, classify each (entry / source /
   test / story / generated / mock), and exclude the non-source ones with a
   recorded reason. Coverage is reported honestly (source vs excluded).
2. **Build an import graph** using the TypeScript compiler itself — the same
   resolution the project's own build uses — so path aliases (`@/`), barrel
   re-exports, and dynamic imports resolve exactly, not by pattern matching.
3. **Cluster the graph** by actual coupling (not directory structure or
   traversal order) and **pack clusters** into bounded **work units** under a
   token budget, excluding high fan-in hub files from merging unrelated
   clusters together. Every import that crosses a unit boundary is recorded
   as a cross-cluster edge for the reconciliation pass to examine.
4. **Collect candidates** from several deterministic sources, normalized into
   one schema:
   - **regex** — first-party patterns (`patterns.ts`). Most are stack-agnostic
     language/runtime smells (SQL-by-concatenation, weak hashes, suppressed
     type checks, `any`, ...); a rule tied to a specific framework/CMS (Next.js
     image/data-fetching conventions, Contentful token exposure, AWS IAM/ARN
     patterns) is tagged with the stack(s) it applies to via `stacks`, and
     `rulesForStack()` filters the set run against a given repo so a Next.js
     rule never fires against a Lambda repo and vice versa.
   - **eslint** — runs your configured eslint (custom rules included) and
     harvests its AST-grade findings (hooks deps, a11y, react/next rules).
   - **npm audit** — dependency vulnerabilities, mapped to Security severities.
   - **graph** — promotes import-orphans to a "possibly unused module" finding.

Every candidate is anchored to `file:line` evidence. These are *candidates*,
not confirmed findings — the AI judgment pass decides which are real.

Collectors are best-effort: if eslint or npm audit can't run, that collector is
skipped and the reason is recorded in the manifest. Nothing crashes.

## Run it

From the repo root:

```bash
npx tsx tools/cqa/index.ts
node --experimental-strip-types tools/cqa/index.ts   # zero-dep, Node 22.18+
npx tsx tools/cqa/index.ts C:/lhw/dotcomV2           # explicit root
```

eslint runs over `src` and can take a minute. To change how it's invoked, edit
`eslintCmd` in `config.ts`. To turn a collector off, flip its flag in
`config.collectors`.

## Outputs (`.claude/cqa/`)

- **`manifest.json`** — stack/versions, honest coverage breakdown, per-collector
  status (ran / skipped + why), and the clustered work units.
- **`candidates.json`** — all candidates grouped by rule, each with evidence and
  a `collector` provenance tag. Sorted by severity then count.
- **`coverage-summary.json`** — real Jest/Istanbul line coverage (`collectTestCoverage`
  in `collectors.ts`): overall %, and every file below `coverageThreshold`.
  Reported, never severity-weighted — see the comment on `TestCoverageResult`
  for why a continuous % doesn't belong in the defect-density score.

These feed the AI passes, run in this order inside Claude Code:

1. **`VERSION_BRIEF.md`** — Context7-grounded version-rules brief →
   `.claude/cqa/version-brief.json`.
2. **`PROJECT_DOCS_BRIEF.md`** — summarizes the project's own markdown docs
   (always including a root `CLAUDE.md` if present) into exonerating context
   *and* explicit house rules → `.claude/cqa/project-docs-brief.json`. The
   `rules` field is how a project's own stated conventions ("API routes must
   validate input with zod") get actively checked by Discovery, not just
   used to dismiss false positives.
3. **`DISCOVERY.md`** — per-unit semantic read → `merge-discovery.ts` →
   `.claude/cqa/discovery-findings.json`.
4. **`JUDGMENT.md`** (static candidates) and **`DISCOVERY_JUDGMENT.md`**
   (semantic findings) — both confirm/reject passes →
   `.claude/cqa/findings.json` / `.claude/cqa/discovery-findings.judged.json`.
5. **`RECONCILIATION.md`** — cross-cluster pass → `merge-reconciliation.ts` →
   `.claude/cqa/reconciliation-findings.json`.
6. **`HOLISTIC.md`** — cross-cutting synthesis → `.claude/cqa/holistic.json`.
7. **`REFUTE.md`** — adversarial re-check of every High/Critical finding →
   `apply-refute.ts` → `.claude/cqa/refute-result.json`.
8. **`STORYBOOK_COVERAGE.md`** — optional, only when
   `npx tsx tools/cqa/prepare-storybook-coverage.ts` found component/story
   pairs with a candidate prop gap — AI-confirmed Storybook prop/variant
   coverage gaps → `merge-storybook-coverage.ts` →
   `.claude/cqa/storybook-coverage-findings.json`. Same scoring treatment as
   Jest coverage: a coverage-gap check, reported not weighted.

Once all passes have run, two deterministic (no-AI) steps turn the result
into a client-facing report:

9. **`scorer.ts`** — severity-weighted-density scoring (fixed point weights per
   severity, normalized per thousand lines of source), graded A–E per category
   and overall, plus the unweighted Jest/Storybook coverage figures passed
   through → `.claude/cqa/score.json`. Run: `npx tsx tools/cqa/scorer.ts`.
10. **`report.ts`** — renders `score.json` plus every judged/reconciled finding
   (minus anything the refute pass rejected) into a single self-contained HTML
   report, including a "reviewed and dismissed" section for refuted and
   needs-context findings, and a Coverage section with Jest line coverage and
   Storybook prop gaps → `.claude/cqa/report.html`. Run:
   `npx tsx tools/cqa/report.ts`.

## Monorepo / fleet mode

A target with no root `package.json` (a collection of independently-
deployable services, e.g. a fleet of Lambda/CDK packages) is driven by
`monorepo.ts` instead of the single-package path in `index.ts`'s `main()` —
`commands/run-cqa.md`'s "Monorepo mode" section is the authoritative
orchestration doc. Two things exist only in this mode, both running across
**every** discovered workspace (adapter-matched or not — a workspace with no
matching adapter still gets these two, just not the full AI pipeline):

- **`duplication.ts`** — shingled/hashed near-duplicate code-block detection.
  Works for a single workspace too (closes the `notMeasured: 'Exact
  duplication %'` gap every `AdapterConfig` has always had), but its real
  value in monorepo mode is cross-service: the same block of logic
  re-implemented in two unrelated Lambda packages.
- **`cross-service.ts`** — heuristic coupling detection for services that
  don't talk via TypeScript imports (the compiler-based `graph.ts` is
  correctly blind to this — each workspace is its own separate
  `ts.createProgram`): CDK cross-stack `exportName`/`Fn.importValue` pairs,
  two services independently referencing the same SSM/DynamoDB/SQS/SNS/
  EventBridge resource name, and a CDK stack's `NodejsFunction` `entry:`
  path resolving to a sibling lambda workspace.

`monorepo.ts` also aggregates two fleet-level rollups from data each
workspace's own run already produces (no new detection logic): dependency/
runtime version drift across the fleet, and a per-workspace posture summary
(candidate counts by dimension, test coverage %). Everything is written to
`system-manifest.json`; `prepare-system-holistic.ts` + `SYSTEM_HOLISTIC.md`
(the fleet-scale counterpart to the per-workspace `HOLISTIC.md`) synthesize
it into a narrative, and `system-report.ts` renders the fleet-level
`report.html`, linking out to each fully-reviewed workspace's own report.

## Extending it

- **More collectors:** add to `collectors.ts` (e.g. Snyk `snyk test --json`).
  Return `Candidate[]` and a `CollectorStatus`; the pipeline merges them.
- **More first-party rules:** add to `patterns.ts`.
- **Another stack (WordPress):** add a sibling config to `config.ts` selected by
  detection; `enumerate`, `graph`, the collectors framework, and the schema are
  stack-agnostic.

## Known limits (v0.3)

- A genuinely large, tightly-coupled cluster can still exceed the token
  budget and get split internally by `packClusters` — hub-file exclusion in
  `clusterFiles` keeps this to the rare feature area rather than most of the
  codebase, but when it happens the import that got split across units is
  recorded as a cross-cluster edge, so the reconciliation pass still covers it.
- Cross-collector dedupe covers a declarative allowlist of known regex/eslint
  rule overlaps (`collectors.ts`'s `KNOWN_OVERLAPS`), not every possible
  overlap; full semantic dedupe is the judgment pass's job either way — it
  won't confirm the same issue twice even for an overlap not on that list.
- eslint output can be high-volume; curating it to a client-appropriate set is
  the judgment pass's job, not the driver's.
- `duplication.ts` is exact/near-exact text matching (post-normalization),
  not semantic/renamed-identifier matching — a copy-pasted-then-renamed block
  won't be caught. It also reports N-way duplicates (the same block in 3+
  locations) as separate pairwise blocks rather than one unified block.
- `cross-service.ts` is heuristic: a shared literal string (an SSM path, a
  table name) could coincidentally match across two genuinely unrelated
  services. Candidates, not verified architecture — same trust model as
  every other collector.
