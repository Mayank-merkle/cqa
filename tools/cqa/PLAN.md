# Code Quality Analyzer (CQA)

## 1. What we're building

An automated pipeline that produces a comprehensive, evidence-backed code
quality report for this codebase — in the spirit of a SonarQube scan, but
going further: it pairs deterministic static analysis with an AI review
layer that reads the code directly, so it catches logic bugs, race
conditions, and framework-version-specific issues that pattern-matching
tools structurally cannot express. Every finding is anchored to a specific
file and line, so the report is auditable, not a generic checklist.

It runs as a one-time baseline audit of the full codebase — the right shape
for an initial quality assessment, a handoff, or a periodic health check.

## 2. Architecture — how it works

> **Note:** the diagram and prose below predate the pipeline-hardening pass
> (see the note under section 3) and describe the original four-stage shape.
> The pipeline now also runs a discovery-judgment pass (skeptical review of
> the AI deep-read's own findings), a reconciliation pass (over the
> cross-cluster edges the coupling-based clustering produces), and a
> refutation pass (adversarial re-check of every High/Critical finding)
> before the report stage. `README.md`'s "Outputs" section lists the current
> six-pass order and is the source of truth for how the pipeline runs today;
> this section is kept as a high-level mental model, not a literal spec. The
> `×42` figure below in particular is a specific pre-hardening run's module
> count, not a fixed constant of the architecture.

```
                          ┌─ static analysis (ESLint / npm audit / pattern rules)
enumerate  ─►  dependency ─┤        → judgment layer ─────────────┐
 codebase       graph      │                                       ├─► report
                            └─ version-rules brief (Context7)       │
                                    │                                │
                                    ▼                                │
                           AI deep-read, per module (×42)            │
                                    → cross-cutting synthesis ───────┘
```

**Enumeration & mapping.** Every file in `src/` is walked, classified, and
accounted for, giving an honest coverage figure rather than a sampled guess.

**Dependency graph.** The codebase map is built with the TypeScript compiler
itself — the same resolution the project's own build uses — so path aliases,
barrel re-exports, and dynamic imports resolve exactly, not by pattern
matching:

```ts
import ts from 'typescript';

function loadProgram(repoRoot: string): ts.Program {
  const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'tsconfig.json')!;
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, repoRoot);
  return ts.createProgram(parsed.fileNames, parsed.options);
}

function internalImportsOf(program: ts.Program, filePath: string): string[] {
  const sf = program.getSourceFile(filePath);
  if (!sf) return [];
  const deps: string[] = [];
  const opts = program.getCompilerOptions();

  const visit = (node: ts.Node) => {
    const spec =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
        ? (node.moduleSpecifier as ts.StringLiteral).text
        : undefined;
    if (spec) {
      const resolved = ts.resolveModuleName(spec, filePath, opts, ts.sys).resolvedModule;
      if (resolved && !resolved.isExternalLibraryImport) deps.push(resolved.resolvedFileName);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return deps;
}
```

That graph is then split into bounded modules of related files, each small
enough for a focused, thorough AI read.

**Version-rules brief.** Before any code is read, the pipeline resolves a
version-specific rules brief via Context7 for the exact framework versions
this repo runs — `next@15.5.18`, `react@19.2`, `next-auth@5.0.0-beta.26` —
covering current APIs and known upcoming breaking changes. This means
findings are checked against the real, current contract for this stack, not
generic or outdated assumptions. For example, it lets the review proactively
note that Next.js 16 renames `middleware.ts` to `proxy.ts`, and that
`src/middleware.ts` will need that rename on the next major upgrade — a fact
invisible to a linter and easy to miss without version-specific grounding.

**Static analysis.** ESLint, npm audit, and first-party pattern rules run
across the whole codebase, producing reproducible, deterministic findings.

**AI deep-read.** Each bounded module is read independently by an AI
reviewer with no pre-filtering, looking specifically for the class of issue
static tools can't express: memory leaks, race conditions, unsafe data
handling, and misuse of framework APIs for the version in use.

**Judgment layer.** Every static finding is put through a skeptical
confirm/reject pass before it's allowed into the report, so the report
states only what the evidence actually supports.

**Cross-cutting synthesis.** One final pass reasons across all findings
together, surfacing systemic patterns that no single file reveals on its
own — the kind of observation that turns a list of bugs into an actual
architectural assessment.

## 3. Already validated on this codebase

> **Note:** the figures below predate the pipeline-hardening pass documented
> in `docs/superpowers/plans/2026-08-07-cqa-pipeline-hardening.md` — compiler-based
> import resolution, coupling-based clustering, and the new discovery-judgment,
> reconciliation, and refutation passes did not exist when this run happened.
> They shape which findings surface and survive (version-grounded checks
> instead of stale training assumptions, cross-cluster coverage, adversarial
> re-checks of every High/Critical item), so these numbers should not be
> cited as current. Re-run the pipeline end to end before quoting figures
> from it.

This pipeline isn't theoretical — it has already run end to end against this
repository and produced a full set of real, cited findings:

- **878 source files** enumerated and accounted for
- **196 total findings** — 51 from static analysis (confirmed after
  skeptical review), 145 from AI deep-read
- **23 High, 78 Medium, 95 Low** severity, including 16 High-severity
  vulnerable dependencies
- One cross-cutting architectural observation identifying a systemic
  reliability pattern across roughly a dozen components

## 4. What the report looks like

The final deliverable reads like a SonarQube-style quality report, built
from this pipeline's own output:

- **Executive summary** — a narrative assessment of the codebase's overall
  health, not just a number
- **Findings by severity and category** — Security, Reliability,
  Performance, Maintainability, Accessibility, each with counts and its most
  significant issues
- **Evidence-backed findings list** — every item cites its file, line, and
  the reasoning behind its severity
- **Coverage statement** — exactly what was reviewed and what was
  deliberately out of scope, so the report's scope is never in question

The severity/category tables and sample quote below are from the same
pre-hardening run described in the note under section 3 — see that note
before citing these figures as current.

**Sample, from this run's real data:**

> *"This is a well-structured, disciplined Next.js codebase whose defects
> cluster into a few identifiable cross-cutting concerns rather than
> spreading as pervasive low quality... The most material weakness is
> systemic: client-side async work is fired without cancellation or
> request-ordering guards across roughly a dozen search and reservation
> components... Genuine security risk is real but narrow, concentrated on
> the auth/crypto/preview-session boundary... The headline-grabbing
> vulnerable-dependency count is dominated by dev/transitive tooling and
> should be triaged down to the handful of runtime-reachable packages."*

| Severity | Count |
|---|---|
| High | 23 |
| Medium | 78 |
| Low | 95 |

| Category | Count |
|---|---|
| Reliability | 62 |
| Security | 61 |
| Correctness | 44 |
| Maintainability | 20 |
| Performance | 9 |

## 5. Scope of this delivery

- **In scope:** one comprehensive baseline report for this codebase, covering
  security, reliability, performance, maintainability, and accessibility.
- **Not in this phase:** continuous per-PR scanning. A one-time deep audit
  and a continuous CI gate are different tools with different cost profiles;
  this delivery is the former, and is the natural foundation for the latter
  if that's wanted later.
- TODO: Storybook coverage check — a pass that compares each component's real
  prop/variant surface against what its `.stories.tsx` actually exercises, and
  flags cases Storybook misses (not a quality-of-the-story check, a
  coverage-gap check). Not built yet; noted here as a future dimension, not
  folded into the existing discovery pass's "Look for" list until designed.
- TODO: AWS Lambda/AppSync `AdapterConfig` — extend `tools/cqa/config.ts`'s
  adapter registry with a second stack adapter for the `DotcomV2-AppSync`
  monorepo. Groundwork already done and verified against that real repo:
  `detectWorkspaces()`/`findWorkspaceRoots()` in `config.ts` correctly
  discover all 33 independently-deployable services/Lambdas in that monorepo
  (no root `package.json` — each service has its own, at varying depth, e.g.
  `hotel-api/cdk/lambdas/getCurrency`), and each currently reports "no
  adapter matched" rather than guessing wrong. What's still needed: (1) a
  `detect()` predicate for this stack (candidates: `aws-cdk-lib` in deps, a
  `cdk.json` file, `aws-lambda` type deps — note the repo isn't uniform, e.g.
  `contentful-search` is a plain Express app with none of these, so one
  predicate may not fit every service); (2) `entryMatchers`/`skip` tuned to
  CDK/Lambda conventions instead of Next.js App Router ones; (3) a
  Lambda/AppSync-specific "Look for" list for `DISCOVERY.md` (cold-start-
  sensitive init outside the handler, resolver N+1, missing DLQ/retry, overly
  broad IAM roles, env var secrets) in place of the Next.js-specific one;
  (4) `index.ts`'s `main()` currently assumes one `repoRoot` — running this
  against a monorepo means either driving it once per discovered workspace
  and merging manifests, or taking an explicit single-service path argument;
  not yet decided which.
