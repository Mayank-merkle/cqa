// Heuristic cross-service coupling detection for a monorepo of
// independently-deployable services (the `aws-lambda-cdk` adapter's typical
// shape). Services in a repo like this don't couple via TypeScript imports
// — graph.ts's compiler-based import graph is correctly blind to them,
// since each workspace is its own separate `ts.createProgram` — they couple
// via infrastructure: CDK cross-stack exports, a shared SSM/DynamoDB/queue
// name baked into two services independently, or a CDK stack's own
// `NodejsFunction` construct pointing at another workspace's lambda entry
// file.
//
// Same trust model as patterns.ts: these are CANDIDATE edges from regex
// matching, not verified architecture — a human or a later AI pass judges
// them, this module just surfaces them with evidence.

import { dirname, basename } from 'node:path';
import type { Evidence } from './types';

export interface WorkspaceFileInput {
  workspace: string; // short id (e.g. a repo-relative path like "hotel-api/cdk")
  workspaceRoot: string; // same value, kept distinct from `workspace` only so callers can pass a richer id separately in future
  file: string; // workspace-relative path
  text: string;
}

export type CouplingMechanism = 'cdk-cross-stack-reference' | 'shared-resource-name' | 'cdk-lambda-entry-reference';

export interface CrossServiceEdge {
  mechanism: CouplingMechanism;
  fromWorkspace: string;
  toWorkspace: string;
  detail: string; // the shared name/path that ties the two together
  evidence: Evidence[];
}

function addEvidence(map: Map<string, { workspace: string; evidence: Evidence }[]>, key: string, workspace: string, evidence: Evidence) {
  const list = map.get(key) ?? [];
  list.push({ workspace, evidence });
  map.set(key, list);
}

// Every unordered pair of distinct workspaces sharing `key`, one edge per
// pair (not per file) — a name referenced by many files in the same two
// workspaces should produce one edge, not a combinatorial file-level mess.
function pairwiseEdges(
  byKey: Map<string, { workspace: string; evidence: Evidence }[]>,
  mechanism: CouplingMechanism
): CrossServiceEdge[] {
  const edges: CrossServiceEdge[] = [];
  for (const [key, hits] of byKey) {
    const byWorkspace = new Map<string, Evidence[]>();
    for (const h of hits) {
      const list = byWorkspace.get(h.workspace) ?? [];
      list.push(h.evidence);
      byWorkspace.set(h.workspace, list);
    }
    const workspaces = [...byWorkspace.keys()];
    if (workspaces.length < 2) continue;
    for (let i = 0; i < workspaces.length; i++) {
      for (let j = i + 1; j < workspaces.length; j++) {
        edges.push({
          mechanism,
          fromWorkspace: workspaces[i],
          toWorkspace: workspaces[j],
          detail: key,
          evidence: [byWorkspace.get(workspaces[i])![0], byWorkspace.get(workspaces[j])![0]],
        });
      }
    }
  }
  return edges;
}

const EXPORT_NAME_RE = /exportName\s*:\s*['"`]([^'"`]+)['"`]/;
const IMPORT_VALUE_RE = /Fn\.importValue\s*\(\s*['"`]([^'"`]+)['"`]/;

const RESOURCE_NAME_RE = /\b(tableName|queueName|topicName|eventBusName)\s*:\s*['"`]([^'"`]+)['"`]/;
// The "look up an existing resource by name" counterpart to the construct
// props above — e.g. `dynamodb.Table.fromTableName(this, 'id', 'the-name')`
// — where the name is a positional arg, not a keyed prop.
const RESOURCE_LOOKUP_RE = /\bfrom(TableName|QueueName|TopicName|EventBusName)\s*\([^)]*['"`]([^'"`]+)['"`]\s*\)/;
const LOOKUP_CATEGORY: Record<string, string> = {
  TableName: 'tableName',
  QueueName: 'queueName',
  TopicName: 'topicName',
  EventBusName: 'eventBusName',
};
// An SSM-parameter-path-shaped literal: a leading slash, 2+ segments,
// reasonable length — deliberately loose (this is a candidate, not a verified
// read of what the string is actually for).
const SSM_PATH_RE = /['"`](\/[A-Za-z0-9][A-Za-z0-9/_-]{3,})['"`]/g;

const NODEJS_FUNCTION_ENTRY_RE = /\bentry\s*:\s*['"`]([^'"`]+)['"`]/;

function evidenceAt(file: string, line: number, snippet: string): Evidence {
  return { file, line, snippet: snippet.trim().slice(0, 200) };
}

export function findCrossServiceEdges(files: WorkspaceFileInput[]): CrossServiceEdge[] {
  const exportNames = new Map<string, { workspace: string; evidence: Evidence }[]>();
  const importNames = new Map<string, { workspace: string; evidence: Evidence }[]>();
  const resourceNames = new Map<string, { workspace: string; evidence: Evidence }[]>();

  // workspaceRoot basename -> workspace id, used to resolve a NodejsFunction
  // `entry:` path to the sibling workspace it actually deploys.
  const basenameToWorkspace = new Map<string, string>();
  for (const f of files) {
    const b = basename(f.workspaceRoot);
    if (!basenameToWorkspace.has(b)) basenameToWorkspace.set(b, f.workspace);
  }

  const entryEdges: CrossServiceEdge[] = [];

  for (const f of files) {
    const lines = f.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;

      const exp = EXPORT_NAME_RE.exec(line);
      if (exp) addEvidence(exportNames, exp[1], f.workspace, evidenceAt(f.file, lineNo, line));

      const imp = IMPORT_VALUE_RE.exec(line);
      if (imp) addEvidence(importNames, imp[1], f.workspace, evidenceAt(f.file, lineNo, line));

      const res = RESOURCE_NAME_RE.exec(line);
      if (res) addEvidence(resourceNames, `${res[1]}:${res[2]}`, f.workspace, evidenceAt(f.file, lineNo, line));

      const lookup = RESOURCE_LOOKUP_RE.exec(line);
      if (lookup) addEvidence(resourceNames, `${LOOKUP_CATEGORY[lookup[1]]}:${lookup[2]}`, f.workspace, evidenceAt(f.file, lineNo, line));

      SSM_PATH_RE.lastIndex = 0;
      let ssmMatch: RegExpExecArray | null;
      while ((ssmMatch = SSM_PATH_RE.exec(line))) {
        addEvidence(resourceNames, `ssmPath:${ssmMatch[1]}`, f.workspace, evidenceAt(f.file, lineNo, line));
      }

      const entry = NODEJS_FUNCTION_ENTRY_RE.exec(line);
      if (entry) {
        const targetBasename = basename(dirname(entry[1]));
        const targetWorkspace = basenameToWorkspace.get(targetBasename);
        if (targetWorkspace && targetWorkspace !== f.workspace) {
          entryEdges.push({
            mechanism: 'cdk-lambda-entry-reference',
            fromWorkspace: f.workspace,
            toWorkspace: targetWorkspace,
            detail: entry[1],
            evidence: [evidenceAt(f.file, lineNo, line)],
          });
        }
      }
    }
  }

  // Cross-stack references correlate an exporter to an importer by shared
  // name, not by symmetric co-occurrence — handled separately from
  // pairwiseEdges' same-key symmetric logic since export/import are distinct roles.
  const crossStackEdges: CrossServiceEdge[] = [];
  for (const [name, exporters] of exportNames) {
    const importers = importNames.get(name);
    if (!importers) continue;
    const exporterWorkspaces = new Map<string, Evidence>();
    for (const e of exporters) if (!exporterWorkspaces.has(e.workspace)) exporterWorkspaces.set(e.workspace, e.evidence);
    const importerWorkspaces = new Map<string, Evidence>();
    for (const e of importers) if (!importerWorkspaces.has(e.workspace)) importerWorkspaces.set(e.workspace, e.evidence);
    for (const [exporterWs, exporterEv] of exporterWorkspaces) {
      for (const [importerWs, importerEv] of importerWorkspaces) {
        if (exporterWs === importerWs) continue;
        crossStackEdges.push({
          mechanism: 'cdk-cross-stack-reference',
          fromWorkspace: exporterWs,
          toWorkspace: importerWs,
          detail: name,
          evidence: [exporterEv, importerEv],
        });
      }
    }
  }

  return [...crossStackEdges, ...pairwiseEdges(resourceNames, 'shared-resource-name'), ...entryEdges];
}
