# CQA pipeline walkthrough — what happens, why, and what it produces

This is the narrative companion to `README.md` (which is the terse
file/command reference) and the per-stage playbooks (`DISCOVERY.md`,
`JUDGMENT.md`, etc., which are the actual prompts dispatched to each AI
pass). Read this when you want to understand *why* a stage exists and how
its output gets used later, not just what command to run.

The orchestrating runbook is `../../commands/run-cqa.md` — every stage below
corresponds to one or more of its numbered steps.

## 1. Setup

Installs the plugin's own dependencies (`npm install` in the plugin dir,
used internally by `graph.ts` to resolve the *target* project's TypeScript
config — not the target project's own deps). If `.claude/cqa/manifest.json`
already exists from a previous run, the whole `.claude/cqa/` directory is
renamed to `.claude/cqa.bak-<date>/` first.

**Why:** every later stage reads files written by earlier stages purely by
filename convention (e.g. "does `findings.json` exist yet?"). A stale
leftover from a previous run could get silently picked up and corrupt the
new run's output, so each run starts from a guaranteed-clean directory.

## 2. Deterministic scan (`index.ts`)

The only stage that's pure code — no AI involved. Runs four steps in order:

1. **Enumerate** (`enumerate.ts`) — classifies every file as
   entry/source/test/story/generated/mock/excluded, so later stages know
   what's reviewable code versus build output or fixtures.
2. **Build the import graph** (`graph.ts`) — not a regex scan for `import`
   statements. It invokes the real TypeScript compiler to resolve what each
   import actually points to: path aliases (`@/foo`), barrel re-exports
   (an `index.ts` that just re-exports other modules), and dynamic
   `import()` calls. A regex-based scanner would be fooled by aliases and
   barrels into missing real dependencies or inventing fake ones, which
   would break the next step.
3. **Cluster by actual coupling, not folder structure** — once the graph has
   true edges, files that import each other heavily get grouped into the
   same cluster. This is effectively rediscovering "modules"/"features" from
   how the code actually behaves, which can disagree with how it's
   organized on disk: two files in different folders that are tightly
   coupled can end up in the same cluster; two files in the same folder
   that don't really interact might not. Clusters get packed into **work
   units** sized to a token budget (a unit is usually a whole cluster unless
   it's too big, in which case it's split). Every import that crosses a
   unit boundary is recorded as a **cross-cluster edge** — this list is what
   the Reconciliation stage (5) later examines.
4. **Collectors** (`collectors.ts`) — four independent, best-effort tools:
   first-party regex rules (`patterns.ts`), the project's own configured
   ESLint, `npm audit --json`, and orphan-promotion from the graph step. A
   fifth, test coverage, only runs if the detected stack adapter enables it
   (`config.ts`: on for the Next+Contentful adapter, off for AWS
   Lambda/CDK, since many Lambda packages have no test script). Each
   collector is skipped with a recorded reason if its tool isn't available,
   rather than failing the whole scan.

**Outputs:** `manifest.json` (stack id, detected versions, work units with
cross-cluster edges, per-collector status) and `candidates.json` (every
deterministic finding with file:line evidence and collector provenance).
For monorepos with no root `package.json`, this whole process repeats per
workspace, plus a `workspaces.json` index.

**Consumed by:** `manifest.json`'s work units feed Discovery (3) and the
`prepare-*` scripts; `candidates.json` feeds static Judgment (4).

## 3. Grounding briefs

Two briefs, both meant to stop the AI discovery pass from hallucinating or
pattern-matching naively:

- **Version brief** (`VERSION_BRIEF.md`) — for each package version in
  `manifest.json`, queries the Context7 MCP tools (`resolve-library-id`,
  `query-docs`) for current API surface, deprecations, and upcoming breaking
  changes. **If Context7 is unavailable (no key, no network, package not
  found), the step does not fail** — it writes an explicit
  `"currentApiNotes": "unavailable — Context7 lookup failed"` entry instead
  of skipping the file, because Discovery checks for the file's existence
  and should know grounding was attempted either way. See the FAQ below for
  why Context7 needs live network access at all rather than a local cache.
- **Project docs brief** (`PROJECT_DOCS_BRIEF.md`) — a deterministic script
  (`prepare-docs-brief.ts`) first skims the target repo's own markdown,
  then the AI summarizes only the entries with real operational/
  architectural content, tagging each with which file patterns it applies
  to. **Why:** a project might have a documented, intentional workaround
  (e.g. "we cap this response size because of a CMS limit") that looks like
  a bug to a generic pattern-matcher. This lets the project's own
  documented rationale override surface-level suspicion.

**Outputs:** `version-brief.json`, `project-docs-brief.json` — always
written, even if empty/unavailable.

**Consumed by:** sliced per work unit and injected into that unit's
Discovery subagent prompt — only the parts relevant to that unit's files.

## 4. Discovery and judgment

Discovery dispatches **one subagent per work unit** (batched ~6-10 at a
time), each given its unit's files plus the matching brief excerpts, asked
to do the kind of semantic review a linter structurally can't express
("this retry logic doesn't actually back off", "this hook recreates a
callback every render for no reason"). Because a unit is a whole cluster of
coupled files, this is a module-level review, not a single-file one — see
the FAQ below for how this relates to Reconciliation.

Separately, the static candidates from Stage 2 get judged in **one single
pass** (no fan-out — one list, not one-per-unit): the agent confirms or
rejects each regex/lint/audit hit, since deterministic tools produce false
positives a human would dismiss in context.

A third, skeptical pass (`DISCOVERY_JUDGMENT.md`) re-reviews the AI's own
discovery findings in batches of ~35-40. **Why a separate pass instead of
folding this into Discovery itself:** an AI reviewing its own work in the
same pass tends to rubber-stamp it; a distinct, skeptical re-check catches
the AI being wrong about its own earlier read. The merge step explicitly
diffs every input id against the output verdicts (not just counts), so a
batch that silently dropped an item is caught rather than undercounted.

**Outputs:** `discovery-findings.json` (raw AI findings),
`unit-summaries.json` (one-line summary per unit), `findings.json`
(confirmed static findings), `discovery-findings.judged.json` (confirmed AI
findings).

**Consumed by:** `unit-summaries.json` feeds Holistic (6); `findings.json`
and `discovery-findings.judged.json` feed scoring (7), the report (7), and
Refutation (6).

## 5. Reconciliation and coverage

Stage 4 reviews each work unit in isolation, which means a bug that only
exists because of how *two separate units* interact — unit A assumes a
field is always present, unit B is the only place that sets it, and does so
conditionally — would never surface there. Reconciliation
(`RECONCILIATION.md`) closes this gap: it takes every cross-cluster edge
left over from Stage 2 (potentially thousands on a large codebase) and
groups them **by target file** rather than by individual edge — this
collapses ~2400 edges down to ~370 groups, which is the only way this stays
affordable token-wise. Each group gets one subagent asking "given everyone
who imports this file, is there a mismatch between what they assume and
what it actually provides."

Coverage (real Jest line coverage from `collectTestCoverage`, and Storybook
prop-surface gaps if the project has colocated `.stories.tsx` files) is
also collected around this stage, but is deliberately **kept out of the
severity-weighted score** — it's reported in its own section, because low
coverage is a different kind of signal than a confirmed bug, and folding it
into the defect-density grade would distort it.

**Outputs:** `reconciliation-findings.json`, `coverage-summary.json`
(optional), `storybook-coverage-findings.json` (optional, `[]` is a
legitimate result if there's nothing to check).

**Consumed by:** scoring (7) and the report (7) — reconciliation findings
are treated as already-confirmed (tagged `CONFIRMED` directly, no separate
judgment pass of their own).

## 6. Holistic synthesis and refutation

**Holistic** (`HOLISTIC.md`) takes a step back from file-level findings:
fed a one-line summary of every work unit plus digests of confirmed and
judged findings, it names 3-8 things only visible at the architecture level
— patterns repeating across units, a cross-cutting risk no single finding
captures. This never becomes a scored defect; it's narrative context in the
final report.

**Refutation** (`REFUTE.md`) runs in the opposite direction: every
High/Critical finding across the whole pipeline is handed to an adversarial
pass whose only job is to try to prove it wrong, using strictly the code
context already captured for that finding (it does not get to re-read the
file — this prevents it from finding new justifications rather than
checking the original claim). The default is **STANDS unless positively
disproved** — a deliberate asymmetry, since silently dropping a true bug is
worse than keeping a borderline one. Refuted findings don't disappear; they
move to a "reviewed and dismissed" section with the rationale, so a human
can double-check the refutation itself if they disagree.

**Outputs:** `holistic.json`, `refute-result.json` (`{ stands, refuted }`).

**Consumed by:** scoring (7) excludes refuted ids; the report (7) renders
both `holistic.json` (narrative) and the dismissed section.

## 7. Scoring and report

`scorer.ts` takes every surviving finding (excluding anything refuted),
weights it by severity, and normalizes by lines of code (points per kloc).
**Why normalize:** a 500-line project and a 50,000-line project with the
same raw finding count are not equally healthy — normalizing is what makes
the grade comparable across codebases of different sizes. This produces an
overall letter grade (A-E) plus a grade per category.

`report.ts` assembles everything produced by every prior stage — scored
findings grouped by category, the dismissed section, the coverage numbers,
the holistic narrative, and the token/cost tally — into one self-contained
`report.html`.

**Outputs:** `score.json`, `report.html`.

**Consumed by:** the end user — `report.html` is the actual deliverable
opened directly; nothing downstream reads it.

---

## FAQ

### Is a work unit reviewed file-by-file, or module-wise?

Module-wise, by construction — not file-in-isolation. The graph is built
first (Stage 2), clusters are derived from actual import coupling (not
folder layout), and a work unit is a whole cluster (or a split piece of an
oversized one). Discovery subagents (Stage 4) get an entire unit at once,
which is what lets them catch things like "this hook is defined in file A
but misused in file B," provided A and B landed in the same unit.

The part that's genuinely file-in-isolation is the *boundary* between
units: anything that only breaks because of how two *different* units
interact isn't visible to either unit's subagent alone. That gap is closed
by Reconciliation (Stage 5), which specifically takes the leftover
cross-cluster edges from Stage 2 and reviews them separately. So the full
shape is: graph → cluster (module-level review) → reconciliation
(cross-module review) — not a flat per-file pass.

### Why these specific packages and not every dependency in package.json?

`detectVersions()` only reports versions for an adapter's
`versionRelevantPackages` (`config.ts`) — framework/runtime packages whose
version-specific API surface and breaking-change history actually matter to
Discovery's judgment calls (e.g. "is this a valid Next.js 16 pattern"), not
every library in `package.json`. Two reasons this is deliberately narrow
rather than exhaustive:

- **Cost.** Each package costs 2 Context7 calls (`resolve-library-id` +
  `query-docs`) in `VERSION_BRIEF.md`. A typical `package.json` has dozens of
  dependencies; querying all of them would multiply API usage for little
  benefit, since most dependencies (utility libraries, build tooling) don't
  have version-contingent behavioral assumptions worth grounding Discovery
  against.
- **Relevance.** Only a handful of packages define the kind of API surface
  Discovery actually reasons about — framework conventions, data-fetching
  patterns, auth flows. A date-formatting library's version rarely changes
  what counts as a code-quality issue; `next`'s does.

Each adapter defines its own list:
`nextContentful` → `next`, `react`, `typescript`, `next-auth`;
`awsLambdaCdk` → `aws-cdk-lib`, `constructs`, `aws-lambda`,
`@types/aws-lambda`, `typescript`. At 2 calls/package, that's at most 8 calls
per run for either stack.

### Does the pipeline require a Context7 API key?

No. `VERSION_BRIEF.md` is written to degrade gracefully: if Context7 is
unavailable for any reason (missing key, no network, unresolvable
package), the step still writes `version-brief.json`, just with an
explicit `"currentApiNotes": "unavailable — Context7 lookup failed"` entry
per affected package instead of failing the run. Discovery proceeds either
way, with less grounding for that package.

### Why does Context7 need live network access / an API key instead of a local cache of docs for known versions?

- **It's a live index, not a static snapshot.** Context7 continuously
  re-indexes docs and repos across a large number of packages and versions;
  a one-time local download would go stale the moment upstream docs
  changed, requiring you to re-implement Context7's own ingestion pipeline
  just to keep it fresh.
- **The set of package+version combinations isn't known in advance.** This
  plugin runs against arbitrary target repos, so the first time it hits a
  given package+version it has no local cache for it — querying a live
  service is unavoidable at least once; a cache only pays off on repeat
  runs against the same project, and even then only until the package
  updates.
- **The key authenticates the service, not the content.** Context7 is a
  hosted API; the key is standard rate-limiting/authentication for the
  service itself, same as any hosted doc/search API — it's not specific to
  how the documentation happens to be stored.

A fully offline alternative is possible (e.g. a collector that reads each
detected package's own README/CHANGELOG out of `node_modules` instead of
querying Context7) but would be a different, separate design from what
exists today — see "Extending it" in `README.md`.
