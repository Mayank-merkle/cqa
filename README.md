# CQA — Code Quality Analyzer (Claude Code plugin)

A one-time, deep code-quality baseline audit for a project: deterministic
static analysis (first-party pattern rules, eslint, npm audit, import-graph
orphan detection) paired with an AI review layer that reads the code
directly — catching logic bugs, race conditions, and framework-version-
specific issues that pattern-matching tools structurally can't express.
Every finding is anchored to a specific file and line. Output is a
self-contained HTML report with a deterministic A–E grade.

See [`tools/cqa/PLAN.md`](tools/cqa/PLAN.md) for the full design, and
[`tools/cqa/README.md`](tools/cqa/README.md) for how the pipeline itself
works internally.

## Supported stacks

Currently: **Next.js (App Router)**. See `tools/cqa/config.ts` — it's a
registry of stack adapters, so adding support for another stack doesn't
require touching the rest of the pipeline. Check `tools/cqa/PLAN.md`'s
"Scope of this delivery" section for what's planned next (an AWS
Lambda/AppSync adapter) and what's explicitly still a TODO.

## Install

In a Claude Code session, add this repo as a plugin marketplace and install it:

```
/plugin marketplace add https://github.com/Mayank-merkle/cqa.git
/plugin install cqa@cqa
```

Install at **user scope** (the default) so `/run-cqa` becomes available in
every project on your machine, not just the one you installed it from.

### Getting updates

Marketplaces added by URL don't auto-update by default, so new commits here
won't reach you automatically. To pick up the latest version:

```
/plugin marketplace update cqa
/reload-plugins
```

(or `claude plugin marketplace update cqa && claude plugin update cqa@cqa`
from a shell). To stop having to do this manually, turn on auto-update once:
`/plugin` → **Marketplaces** → `cqa` → **Enable auto-update**.

To try it without installing (for development):

```bash
claude --plugin-dir /path/to/this/repo
```

## Use

In any supported project, run:

```
/run-cqa
```

This is a long-running task — dozens of subagent dispatches, roughly
30-60+ minutes, a few dollars of token spend for a mid-size codebase. It
always does a fresh baseline run (backing up any previous one), not an
incremental re-scan. At the end you get `.claude/cqa/report.html` in
*your* project.

## Developing this plugin

```bash
npm install
npm test
```

The engine scripts (`tools/cqa/*.ts`) are plain Node/TypeScript, runnable
standalone against any repo root:

```bash
npx tsx tools/cqa/index.ts /path/to/some/repo
```

They never assume they're running inside the project being scanned — every
script takes the target repo root as an explicit argument — which is what
makes this installable as a plugin and usable against a different project
than the one it's bundled into.
