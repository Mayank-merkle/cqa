import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// This is a notice, never a gate: any failure here (offline, private repo,
// GitHub down, repository field pointing somewhere other than github.com)
// must leave the pipeline running exactly as if this step didn't exist.
const FETCH_TIMEOUT_MS = 5000;

export function parseVersion(v: string): number[] | undefined {
  const parts = v.trim().split('.').map((n) => Number(n));
  return parts.length === 3 && parts.every((n) => Number.isInteger(n)) ? parts : undefined;
}

// > 0 iff `remote` is strictly newer than `local`. Returns undefined (no
// opinion) if either string isn't a plain x.y.z we can compare.
export function isNewer(local: string, remote: string): boolean | undefined {
  const a = parseVersion(local);
  const b = parseVersion(remote);
  if (!a || !b) return undefined;
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

// GitHub's raw.githubusercontent.com serves the HEAD ref directly, so this
// doesn't need to know or guess the default branch name.
export function rawPluginJsonUrl(repositoryUrl: string): string | undefined {
  const match = repositoryUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) return undefined;
  const [, owner, repo] = match;
  return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/.claude-plugin/plugin.json`;
}

async function fetchRemoteVersion(url: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return undefined;
    const json = JSON.parse(await res.text());
    return typeof json.version === 'string' ? json.version : undefined;
  } catch {
    return undefined; // offline, timeout, private repo, malformed JSON — all non-fatal
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  // Always the plugin's own manifest, not the target project being scanned —
  // this check has nothing to do with which project /run-cqa is pointed at.
  const pluginJsonPath = join(__dirname, '..', '..', '.claude-plugin', 'plugin.json');
  let local: { version?: string; repository?: string };
  try {
    local = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
  } catch {
    return; // not installed as a plugin (e.g. --plugin-dir dev mode without this file) — nothing to check
  }
  if (!local.version || !local.repository) return;

  const url = rawPluginJsonUrl(local.repository);
  if (!url) return;

  const remoteVersion = await fetchRemoteVersion(url);
  if (!remoteVersion) return;

  if (isNewer(local.version, remoteVersion)) {
    console.log(
      `[cqa] A newer version is available: you're running v${local.version}, v${remoteVersion} has been published. ` +
        `Run "/plugin marketplace update cqa" then "/reload-plugins" to get it (takes effect next session).`
    );
  }
}

if (require.main === module) {
  main();
}
