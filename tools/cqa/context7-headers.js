// Supplies the Context7 Authorization header for the project-scoped MCP
// server declared in ../../.mcp.json. Checked into the repo so Context7
// grounding (VERSION_BRIEF.md) works for anyone who clones this project —
// each person supplies their own key, never committed:
//   - set CONTEXT7_API_KEY in your shell before launching Claude Code, or
//   - copy env.example to .env.local or .env at the repo root and fill it in.
// process.env wins over either file; .env.local wins over .env (same
// precedence as the common .env.local-overrides-.env convention), so a CI
// secret or shell export always takes priority over a stray local file.
// Prints nothing (and exits non-zero) when no key is available anywhere, so
// the server just runs unauthenticated at the free-tier rate limit instead
// of failing the connection.
const fs = require('fs');
const path = require('path');

function readKeyFromFile(filename) {
  const filePath = path.join(__dirname, '..', '..', filename);
  if (!fs.existsSync(filePath)) return '';
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^CONTEXT7_API_KEY=(.*)$/m);
  return match ? match[1].trim() : '';
}

const key = process.env.CONTEXT7_API_KEY || readKeyFromFile('.env.local') || readKeyFromFile('.env');

if (!key) {
  // Exit 0 with no auth header rather than failing the connection — an
  // unauthenticated Context7 connection still works, just at the free-tier
  // rate limit (see tools/cqa/PIPELINE.md's Context7 FAQ).
  process.stderr.write('CONTEXT7_API_KEY not set (env var or .env) — connecting to Context7 unauthenticated.\n');
  process.stdout.write('{}');
  process.exit(0);
}

process.stdout.write(JSON.stringify({ Authorization: `Bearer ${key}` }));
