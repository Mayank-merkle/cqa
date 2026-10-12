# CQA Project-Docs Brief (run inside Claude Code, before the discovery pass)

A project's own markdown docs are a far higher-fidelity source of domain
context than guessing at framework/CMS foot-guns from training knowledge or a
hardcoded regex rule. A doc explaining *why* a multi-query fan-out pattern
exists (e.g. a CMS response-size limit) lets the discovery pass recognize
that pattern as a deliberate solution instead of misreading it as a bug.
Skipping this step means the discovery pass reasons about project-specific
architecture blind, the same gap a version brief closes for framework APIs.

This pass does two distinct things with the same sweep of docs, and both
matter — don't conflate them:

1. **Exonerating context** (the original purpose above) — explains why
   something that *looks* like a bug isn't one.
2. **Custom house rules** (new) — a project's docs, and especially its root
   `CLAUDE.md`, often state explicit normative expectations ("all API routes
   must validate input with zod", "components over 300 lines must be split",
   "never fetch directly in a client component") that no regex or generic
   framework knowledge could know to check for. These are standing checks the
   discovery pass should actively look for violations of, not just context
   that explains away a false positive.

**Always read the target repo's root `CLAUDE.md` if one exists, even if
`findProjectDocs` also lists other docs that look more "technical."**
`CLAUDE.md` is the project's own canonical AI-facing instruction file — the
highest-confidence source of explicit house rules this pipeline has, since
the project's own team wrote it specifically to be followed. Never skip it
as "generic" the way a changelog or PR template would be skipped.

## Input

`.claude/cqa/project-docs-input.json` — an array of `{ path, bytes, firstHeading }`
for every markdown file found in the project (deterministically enumerated by
`prepare-docs-brief.ts`; the CQA engine's own bundled docs are already excluded).

## Task

1. Skim the list. Skip anything clearly not useful operational/architectural
   context: PR/issue templates, a changelog, a license file, a trivial
   one-line stub. Use `firstHeading` and `bytes` as a cheap first filter, but
   open anything ambiguous rather than guessing from the filename alone.
   **Never skip the root `CLAUDE.md`** even if it looks generic at a glance.
2. For each doc worth keeping, read it and produce BOTH of:
   - `summary` — **operationally relevant facts a code reviewer should know**:
     architecture decisions, non-obvious constraints, domain-specific
     gotchas, naming/config conventions. Not a table of contents, not prose
     praise — the kind of thing that would make you say "oh, that's why it's
     built that way" before flagging something as a bug.
   - `rules` — **explicit normative statements** the doc states as standing
     expectations, not rationale: look for imperative/obligation language
     ("must", "should always", "never", "required", "don't do X") about how
     code in this project is supposed to be written. Quote or closely
     paraphrase each one; don't infer a rule from a description of how
     things currently happen to work. An empty array is a legitimate result
     for a doc that's pure rationale/architecture notes with no normative
     statements (e.g. the `page-querying-and-restitching.md` example below).
3. Tag each summarized doc with the directories/file patterns it's actually
   relevant to, so the discovery pass can hand the right excerpt to the right
   work unit instead of every unit getting every doc. A `CLAUDE.md` with
   repo-wide rules should be tagged `["**"]`.

## Output (write to `.claude/cqa/project-docs-brief.json`)

```json
{
  "generatedAt": "2026-10-09T00:00:00.000Z",
  "entries": [
    {
      "doc": "docs/page-querying-and-restitching.md",
      "relevantTo": ["src/lib/pageRendering/**", "src/lib/contentful/**"],
      "summary": "Page content is fetched via a stub-then-fan-out-then-restitch pattern: one lightweight query for the page shell, then one smaller query per content type actually present, restitched back into shape. This is a deliberate workaround for a Contentful response-size/complexity limit, not an accidental N+1 — multiple queries firing from getPageBySlug for one page render is expected and correct, not a parallelization bug.",
      "rules": []
    },
    {
      "doc": "CLAUDE.md",
      "relevantTo": ["**"],
      "summary": "House conventions for this repo's API layer and component structure.",
      "rules": [
        "All API routes must validate their request body with the project's zod schemas before use.",
        "Client components must not call fetch directly; data fetching belongs in a server component or route handler.",
        "A component file should not exceed roughly 300 lines; split it into sub-components instead."
      ]
    }
  ],
  "skipped": [
    { "doc": ".github/pull_request_template.md", "reason": "not architectural/operational context" }
  ]
}
```

If no project docs are found, or none are worth summarizing, still write the
file with empty `entries` and note why in `skipped` (or an empty array if
`project-docs-input.json` itself was empty) — the discovery pass checks for
this file's existence and should know grounding was attempted, same as
`version-brief.json`. Every entry must include `rules` (possibly `[]`), even
when it's only ever been used for `summary` historically.

This step has no code to write or test — it's an AI/tool-call orchestration
step, same shape as `VERSION_BRIEF.md`.
