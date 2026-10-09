# CQA Version-Rules Brief (run inside Claude Code, before the discovery pass)

The discovery pass (`DISCOVERY.md`) checks findings against the real, current
contract for this stack — not stale training assumptions. This step is what
makes that true; skipping it means every "is this a Next.js 16 anti-pattern"
call the discovery pass makes is a guess from training data instead of a
grounded check.

## Steps (for the main Claude Code agent)
1. Read `.claude/cqa/manifest.json` → `detectedVersions` (e.g.
   `{ "next": "15.5.18", "react": "19.2.0", "next-auth": "5.0.0-beta.26" }`).
2. For each package, use the Context7 MCP tools:
   - `resolve-library-id` to find the library's Context7 ID for that package.
   - `query-docs` scoped to that ID and version, asking specifically for:
     current API surface for the areas this codebase uses (routing, data
     fetching, middleware, auth), any deprecated-but-still-working APIs, and
     known breaking changes in the next major version.
3. Write the result to `.claude/cqa/version-brief.json`:

```json
{
  "generatedAt": "2026-08-07T00:00:00.000Z",
  "entries": [
    {
      "package": "next",
      "version": "15.5.18",
      "currentApiNotes": "App Router is stable; middleware.ts is the current entry point for edge middleware.",
      "deprecations": [],
      "upcomingBreakingChanges": [
        "Next.js 16 renames middleware.ts to proxy.ts — src/middleware.ts will need that rename."
      ]
    }
  ]
}
```

4. If Context7 is unavailable or a package can't be resolved, still write the
   file with an entry noting `"currentApiNotes": "unavailable — Context7 lookup failed"`
   rather than skipping the file — the discovery pass checks for this file's
   existence and should know grounding was attempted.

This step has no code to write or test — it's an AI/tool-call orchestration
step, same shape as `DISCOVERY.md`'s subagent dispatch.
