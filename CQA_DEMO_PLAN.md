# CQA Technical Demo: Plan and Talk Track

Audience: technical manager. Cares about the steps, what each one does, why it exists, and how it is run.
Length: about 30 to 40 minutes total (roughly 20 minutes of slides and demo, 15 minutes of questions).

---

## 1. Demo goals

By the end, the manager should be able to say:

1. What CQA produces: an A to E grade plus file:line-anchored findings, in one self-contained HTML report.
2. Why it is a pipeline and not "send the repo to an LLM": deterministic tools do the cheap, reproducible work, and AI is used only where pattern matching cannot reach.
3. How a run is controlled: budget cap, exhaustive review, skeptical re-checks, and explicit disclosure of anything skipped.
4. What is proven today (Next.js, dotcomV2-payment) and what is not yet (AppSync).

---

## 2. Deck outline (about 14 slides)

| # | Slide | What to say | Source |
|---|---|---|---|
| 1 | Title and one-line purpose | CQA is a one-time, deep code-quality baseline audit. It is not a CI gate. | README.md, PLAN.md section 5 |
| 2 | The problem | Linters miss logic bugs and framework-specific mistakes. Manual reviews do not scale. A single LLM pass is hard to trust and hard to reproduce. | Your framing |
| 3 | Design principle | Deterministic first, AI where needed, every finding anchored to file:line, and a skeptical second pass. | PIPELINE.md intro |
| 4 | Pipeline at a glance | Seven stages plus verify (diagram below). | PIPELINE.md, run-cqa.md |
| 5 | Stage 1 and 2: Setup and deterministic scan | Enumerate files, build the real TypeScript import graph, cluster by coupling, run four collectors (regex rules, ESLint, npm audit, orphans). No AI here. | PIPELINE.md section 2 |
| 6 | Why cluster by coupling and not folder | Reviews happen per module (work unit), so related files are seen together. Edges that cross units go to reconciliation. | PIPELINE.md FAQ |
| 7 | Stage 3: Grounding briefs | Version brief (Context7 API notes for next, react, typescript, next-auth) and project docs brief (the repo's own CLAUDE.md and docs, so documented decisions are not reported as bugs). Degrades gracefully if Context7 is down. | VERSION_BRIEF.md, PROJECT_DOCS_BRIEF.md |
| 8 | Stage 4 to 6: Discovery, judgment, and skeptical re-check | Discovery: one subagent per work unit. Static judgment confirms or rejects tool hits. Discovery-judgment is a separate skeptical pass over AI findings. Merge steps diff ids, not counts, so nothing is silently dropped. | PIPELINE.md section 4 |
| 9 | Stage 5: Reconciliation | Bugs that only appear across two units. Edges are grouped by target file (about 2,400 edges collapse to about 370 groups) so the cost stays bounded. Every group is processed, not sampled. | PIPELINE.md section 5, run-cqa.md Step 7 |
| 10 | Stage 6: Holistic synthesis and refutation | Holistic gives architecture-level narrative, not scored. Refutation tries to disprove every High or Critical finding, using only the captured context. Default is STANDS. Dismissed findings stay visible. | PIPELINE.md section 6 |
| 11 | Stage 7: Scoring | Severity weights Critical 10, High 5, Medium 2, Low 1. Points are divided by kLOC so repos of different size compare fairly. Bands A to E are coarse on purpose. Test coverage is shown separately and not in the grade. | scoring.ts, PIPELINE.md section 7 |
| 12 | Live output: the report | Show report.html for dotcomV2-payment. Walk through the grade, categories, findings, the dismissed section, and the coverage section. | Real run output |
| 13 | Cost and control | Real run: about 1.17M subagent tokens, central estimate about $4.21 (range $2.34 to $11.70), against a $100 hard cap. The cap logic and disclosure rules are explained here. | cost.json |
| 14 | What is proven, what is next, and honest limits | Next.js: proven end to end. AppSync: adapter exists and smoke-tested, full run TBD. Known gaps listed on slide 15. | PLAN.md |
| 15 | Known limits (say these before he asks) | See section 5 below. | Section 5 |

Pipeline diagram for slide 4 (use as a simple flow, one box per stage):

```
Setup -> Deterministic scan -> Grounding briefs -> Discovery + judgment
  -> Reconciliation -> Holistic + Refutation -> Scoring + report -> Verify
```

---

## 3. Per-step talk track (what / why / how)

Use this as speaker notes. Each line is: what it does, why it exists, how it is run.

**Step 0 and 1: Bootstrap and preserve**
- What: installs the plugin's own dependencies. Moves any previous `.claude/cqa/` to a dated backup.
- Why: every later stage finds inputs by filename. A stale file could silently corrupt a new run.
- How: `npm install` in the plugin, then rename of the old output directory.

**Step 2: Deterministic scan (`index.ts`)**
- What: four collectors plus the import graph.
  - Regex first-party rules (`patterns.ts`)
  - Project's own ESLint
  - `npm audit --json`
  - Orphan detection from the graph
  - Test coverage (Next adapter only, runs the project's own test suite)
- Why: cheap, reproducible, and every hit has evidence. Each collector can be skipped with a recorded reason, so one missing tool does not fail the run.
- How: `npx tsx tools/cqa/index.ts <repo>`. Writes `manifest.json` and `candidates.json`.
- Why the TypeScript compiler and not regex for imports: path aliases and barrel files would fool a regex scanner.

**Step 3: Version brief**
- What: for each detected framework package, looks up current API notes and deprecations.
- Why: "is this a valid Next.js 16 pattern" needs grounding, not model memory.
- How: Context7 MCP. If unavailable, the file is still written with an explicit "unavailable" note.

**Step 3.5: Project docs brief**
- What: summarizes the repo's own markdown, including its root CLAUDE.md, and extracts house rules.
- Why: a documented workaround (for example, a CMS response-size limit) looks like a bug to a generic reviewer. The project's own rationale should win. House rules are checked actively.
- How: deterministic skim, then a short AI summary of the relevant files.

**Step 4: Discovery (one subagent per work unit)**
- What: each subagent reviews a whole module cluster with its brief excerpts.
- Why: finds issues a linter cannot express, such as "this retry does not back off" or "this hook recreates a callback every render."
- How: sonnet subagents, batches of 6 to 10, foreground. Subagents may not spawn subagents. Output: `units/<id>.findings.json`.

**Step 5: Static judgment**
- What: confirms or rejects each deterministic hit (ESLint, audit, regex).
- Why: tools produce false positives that a human would dismiss in context.
- How: one pass for 40 items or fewer. Larger lists are split into batches and each verdict is checked by id.

**Step 6: Discovery-judgment (skeptical re-check)**
- What: a separate pass that re-reviews the AI's own findings.
- Why: a model reviewing its own work in the same pass tends to agree with itself.
- How: batches of about 35 to 40. Verdicts are merged and diffed by id.
- Important: see section 5. In the Next.js run this step was done in the orchestrator's own context, not by a fresh subagent.

**Step 7: Reconciliation**
- What: reviews the edges between units that Step 2 recorded.
- Why: some bugs exist only because two separate modules interact (one assumes a field is always set, and the other sets it conditionally). Per-unit review cannot see them.
- How: edges grouped by target file, then batches of 10 to 15 groups. Every group is processed. Skipping by guessing "stateful" files was tried and missed real cases (81 of 98 high fan-in files).

**Step 7.5: Storybook coverage (optional)**
- What: checks whether each component's stories exercise its full prop surface.
- Why: coverage gaps are a different kind of signal, so they are reported separately and not in the grade.

**Step 8: Holistic synthesis**
- What: 3 to 8 architecture-level observations from one-line unit summaries.
- Why: patterns that repeat across modules do not show up in any single finding.
- How: one pass, no subagents. Narrative only, not scored.

**Step 9: Refutation**
- What: adversarial pass on every High and Critical finding.
- Why: a wrong High is expensive. This pass has to actively prove a finding wrong.
- How: it only sees the context captured for that finding and cannot re-read the file. Default verdict is STANDS. Refuted findings move to a "dismissed" section with the rationale, so a human can check.

**Step 10: Cost accounting**
- What: sums subagent tokens and writes `cost.json` with a budget block.
- Why: AI cost must be visible and capped.
- How: running total across batches. At $100 the pipeline stops dispatching but still produces a complete report, and the report says so at the top.

**Step 11: Score and report**
- What: severity-weighted points divided by kLOC, banded to A to E. Then `report.html`.
- Why: normalizing by size makes repos comparable. Coarse bands mean a one-point change cannot flip the letter.
- How: `scorer.ts` then `report.ts`. Self-contained HTML file.

**Step 12: Verify (`diagnose.ts`)**
- What: checks that required files exist, collectors ran, the graph is not broken, reviewed coverage is not suspiciously low, and the budget cap was not hit.
- Why: a silent partial run must not look like a complete one.

---

## 4. Next.js run: real numbers (dotcomV2-payment)

Source: `C:\lhw\dotcomV2-payment\.claude\cqa\` (Next 16.3.0, React 19.2.4, TypeScript 5).

| Metric | Value | Source |
|---|---|---|
| Files total / source / excluded | 412 / 166 / 246 | manifest.json |
| Excluded by reason | 153 non-source, 53 stories, 36 tests, 4 type declarations | manifest.json |
| Share of repo reviewed | 40% of files (by count) | manifest.json |
| Overall grade | **D** (83 weighted points, 8.42 kLOC, 9.86 pts/kLOC) | score.json |
| Security | D, 30 findings | score.json |
| Reliability | C, 8 findings | score.json |
| Maintainability | B, 9 findings | score.json |
| Performance | A, 1 finding | score.json |
| Test coverage | 76.7% overall vs 80% threshold; several 0% files (layouts, tokens) | score.json |
| Subagent tokens | 1,169,602 measured | cost.json |
| Cost estimate | $4.21 central ($2.34 to $11.70). Cap $100, not reached | cost.json |
| Dispatches | 8 discovery, 4 reconciliation, 1 storybook | cost.json |

Presenter check before the demo: the 30 Security findings are very likely the 30 `npm audit` candidates. If so, the D security grade is mostly dependency advisories and not code defects. Verify this in `candidates.json` (filter by collector) and say it out loud. This is an important point to make. A "D" that is mostly dependency CVEs is a different conversation from a "D" that is code flaws.

---

## 5. Known limits: say these before he asks

These are the things most likely to undermine trust if discovered in Q&A.

1. **Discovery-judgment ran in the orchestrator, not a fresh subagent.** `cost.json` says Steps 5, 6, 8, and 9 were judged directly in the orchestrating agent's own context. The design intent (PIPELINE.md section 4) is a separate skeptical pass. The same model re-checking its own findings is weaker than the design describes. Say this plainly and offer the fix: dispatch those batches to fresh subagents.
2. **Only 40% of files are reviewed.** The grade covers source files only. Tests, stories, and non-source files are excluded by design, which is correct for a code-quality grade but needs stating.
3. **The grade is for source code, not for runtime behavior.** Runtime performance is listed as "not measured" in the manifest. The Performance A is based on static patterns only.
4. **No exact duplication metric in the Next.js report.** `notMeasured` lists "Exact duplication %" for this run. Duplication detection is now in the AppSync/monorepo work (uncommitted, see section 6).
5. **Model cost and data flow.** Source code is read by subagents running on the Claude API. Confirm with your security or compliance owner that this is acceptable before presenting. He will ask.
6. **It is a baseline, not a gate.** There is no per-PR scan. Per PLAN.md section 5 that is intentional, and a CI gate would be a separate tool.
7. **SonarQube and custom Next.js rules are TODO.** The SonarQube profile is not yet mapped to ESLint's sonarjs. Custom React rules are not written.
8. **The report's coverage rendering has no unit tests.** `testCoverageHtml` and `storybookGapsHtml` in `report.ts` are untested (PLAN.md TODO). Earlier report layout bugs were found by visual check, not by tests.

---

## 6. AppSync: where it stands (present as in progress)

Status from PLAN.md and the repo:

- **Adapter: done.** `awsLambdaCdk` in `tools/cqa/config.ts`, registered alongside `nextContentful`. Matches local `cdk.json`, `aws-cdk-lib`, `aws-lambda`, or an ancestor `cdk.json` within 3 levels.
- **Smoke test: done.** On `DotcomV2-AppSync`: 33 workspaces found, 28 matched, 5 correctly unmatched (for example `contentful-search`, three migration scripts). One full single-service run (`ssm-params`).
- **Multi-workspace fleet scan (Phase A): run.** `DotcomV2-AppSync\.claude\cqa\system-manifest.json` and `report.html` exist. Phase A is free and deterministic.
- **Per-workspace AI passes (Phase B): not run for the fleet.** No fleet-level `system-holistic.json` is present, so the fleet synthesis (Phase C) should not be presented as complete. Check `report.html` before saying anything about it.
- **Uncommitted.** The monorepo, cross-service, duplication, and system-report work is in the working tree but not committed (see section 7).

How to present AppSync: "The adapter and the fleet deterministic scan work across 33 workspaces. The full AI review for AppSync is the next step, and this is what it will add." Show the Phase A numbers only. Do not show a grade for AppSync until a full run has produced one.

AppSync Lambda-specific checks (from DISCOVERY.md): cold-start-harmful initialization, resolver and handler N+1 patterns, missing DLQ or retry, overly broad IAM, and env-var secrets.

Phase A results (shown in the demo, from smoke tests and `system-manifest.json`):
- Workspaces: 33 found, 28 matched, 5 unmatched.
- Fleet analysis includes duplication, cross-service coupling, and dependency drift across all 33 workspaces, not just the 28 matched.

---

## 7. Before the demo: checklist

- [ ] **Decide the code state.** The CQA changes for monorepo, cross-service, duplication, and system-report are uncommitted in `C:\lhw\cqa` (`git status`). The last commit is v1.1.3. If the manager asks "is this on main," the honest answer is no. Either commit and tag these first, or present only what is on main. This is your call.
- [ ] **Re-check the numbers.** Open `C:\lhw\dotcomV2-payment\.claude\cqa\report.html` and confirm the grade and category numbers match section 4. Confirm the Security finding split (npm audit vs code) from `candidates.json`.
- [ ] **Run the deterministic scan live (about 1 to 3 minutes)** as the only live part. Do not run the full AI pipeline live. It takes 30 to 60 minutes and costs real money. Use a pre-generated report for the walkthrough.
- [ ] **Have a dismissed-findings example ready.** Show one refuted finding and its rationale. This proves the refutation step works and is not decoration.
- [ ] **Have one real finding walked end to end**: the candidate, the file and line, the AI verdict, the rationale, and where it lands in the report. This is the most convincing single slide.
- [ ] **Prepare the AppSync Phase A slide** with the 33/28/5 numbers and nothing more.
- [ ] **Clear the data-flow question** with your security owner before the meeting (section 5, item 5).

---

## 8. Likely questions from a technical manager

**Why not just run a linter or SonarQube?**
Linters and SonarQube catch patterns. They do not catch "this retry does not back off" or "this unit assumes a field that another unit sets conditionally." CQA runs the deterministic tools too, so the AI layer adds to them rather than replacing them. SonarQube rules are not yet mapped (TODO).

**How do you know the AI is not making things up?**
Every finding is anchored to a file and line. Static hits go through a judgment pass. AI findings go through a second pass. High and Critical findings go through refutation, which defaults to STANDS and only drops a finding when it can be positively disproved. Dismissed findings stay visible. Caveat: see section 5, item 1. The second pass in the Next.js run was done by the same orchestrator.

**What does a run cost and can it run away?**
Next.js: about 1.17M subagent tokens, about $4.21 central. Hard cap of $100, checked after every batch. If hit, the run stops dispatching, still produces a report, and says so at the top.

**Is the grade fair across different repo sizes?**
Points are divided by kLOC, so size is normalized. Bands are deliberately coarse so a single finding cannot flip a letter. Grades are for comparing a repo to itself over time and to other repos, not absolute truth.

**Can this run in CI?**
Not in this version. It is a one-time baseline. A CI gate would be a different tool with a different cost profile (PLAN.md section 5). It is the natural next step if wanted.

**Does it see the whole codebase?**
It reviews source files only, which is 40% of files in the Next.js run. Tests, stories, and non-source files are excluded on purpose, and that is shown in the report.

**What about runtime performance and security testing?**
Not measured. Static patterns only. Performance grade reflects static findings, not profiling. Security findings are static plus dependency advisories (npm audit), not dynamic testing or penetration testing.

**What happens when a stack is not supported?**
Detection fails with a clear message. The adapter registry in `config.ts` is the one stack-specific file, so a new stack is an added adapter, not a rewrite.

**How long does a run take?**
About 30 to 60 minutes, mostly subagent batches (Step 4 and Step 7).

---

## 9. Open decisions for you

1. **Code state for the demo:** commit and tag the uncommitted CQA work first, or demo only what is on main?
2. **Fix the orchestrator-judged skeptical pass before the demo, or disclose it?** Fixing means dispatching Steps 5, 6, 8, and 9 to fresh subagents. Disclosing is faster and is what section 5 recommends if there is no time.
3. **Live or recorded?** Recommended: live deterministic scan (2 minutes) plus a pre-generated report.
4. **Should the AppSync section include a grade?** Recommended no, until a full run is complete.

When you decide these, the next step is to build the slide deck (about 14 slides) from section 2, with speaker notes from section 3.
