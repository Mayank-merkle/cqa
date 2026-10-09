# CQA Reconciliation Pass — Pass 3 of the AI scan (run inside Claude Code)

Every unit was reviewed in isolation. This pass is the one place that looks
at what crosses those boundaries — it exists specifically to catch bugs that
only show up when two units are considered together (e.g. an unmemoized
value in one cluster causing re-renders in another). Skipping this pass is
the difference between the architecture actually catching cross-file bugs
and quietly not doing so.

## Input
`.claude/cqa/reconciliation-input.json`:
- `targetGroups` — **the processing unit for this pass.** Every unique file
  that's imported across a work-unit boundary, as one group:
  `{ file, importedByCount, incomingEdges: [{ from, fromUnit }] }`, sorted
  highest fan-in first. Grouping by target means the shared file is read
  **once per group**, not once per edge — a real run collapses ~2400 raw
  edges into ~370 target groups, which is what actually bounds the cost.
- `crossClusterEdges` — the flat, ungrouped edge list `targetGroups` was
  built from. Reference only; don't process this directly.
- `highFanInFiles` — the subset of `targetGroups` with `importedByCount >= 4`.
  A priority hint for batch ordering (review the biggest groups first), not a
  filter — every group in `targetGroups` must still be reviewed.
- `unitSummaries` — one-line description of what each unit does

## Task
Process **every** group in `targetGroups` — this is a baseline audit; silently
skipping most of the cross-cluster structure to save cost defeats the point
of this pass. For each group, read the actual source (not a summary) for the
target file and each file in its `incomingEdges`, and check specifically for:
- A value/context/hook that isn't memoized where it's defined, causing
  unnecessary re-renders in the consumers that import it
- A shared resource (subscription, listener, connection) whose lifecycle is
  owned in one unit but consumed in another, with unclear cleanup ownership
- A contract mismatch between what the exporting file provides and what an
  importing file assumes

Rules:
- Anchor EVERY finding to a real `file` + `line`, same as the discovery pass.
- Only report on relationships that actually cross a unit boundary — this
  pass does not re-review what a single unit's subagent already covered.
- A clean group returns no findings for it. Do not manufacture concerns to
  look thorough.
- If cost genuinely forces a reduced scope on a given run, that must be an
  explicit, disclosed decision (e.g. "reviewed the top N groups by fan-in,
  skipped the rest") recorded in the run's own output — never a silent,
  undocumented partial pass.

## Output (write to `.claude/cqa/reconciliation.json`)
```json
{
  "findings": [
    {
      "category": "Unmemoized context causing cross-module re-renders",
      "dimension": "Performance",
      "severity": "Medium",
      "file": "src/context/SearchContext.tsx",
      "line": 18,
      "snippet": "const value = { results, setResults };",
      "description": "New object identity every render; consumed by 6 components across 3 other units.",
      "suggestedFix": "Wrap in useMemo keyed on results."
    }
  ]
}
```
