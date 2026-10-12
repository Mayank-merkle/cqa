import type { Dimension, Severity, FindingSource } from './types';

// Deterministic, line-based pattern rules. These produce CANDIDATES — the AI
// judgment pass decides which are real findings. Mechanical detection is the
// reproducible part of the pipeline; keeping it in code (not the LLM) is what
// makes the bulk of the report stable run-to-run.
//
// This is a starter set. Add rules here; anything that needs syntax-level
// analysis (missing useEffect deps, prop drilling) belongs in a future AST
// pass, noted inline.

export interface PatternRule {
  id: string;
  category: string;
  dimension: Dimension;
  severity: Severity;
  regex: RegExp;
  description: string;
  suggestedFix: string;
  source: FindingSource; // always 'pattern' here
  includeComments?: boolean; // scan comment lines too (e.g. TODO markers)
  // Adapter ids (AdapterConfig.id, e.g. 'next-contentful') this rule applies
  // to. Omitted = stack-agnostic (plain language/runtime smell, checked for
  // every stack). A rule naming a specific framework/CMS (Next.js, AWS CDK)
  // must list the stacks it's actually relevant to — otherwise it either
  // never fires outside that stack (harmless but noise in the rule list) or,
  // worse, is a false signal if its syntax happens to appear incidentally in
  // an unrelated stack's code.
  stacks?: string[];
}

// Returns the subset of `rules` relevant to a given stack: every stack-agnostic
// rule (no `stacks` field) plus every rule whose `stacks` includes `stackId`.
export function rulesForStack(allRules: PatternRule[], stackId: string): PatternRule[] {
  return allRules.filter((r) => !r.stacks || r.stacks.includes(stackId));
}

export const rules: PatternRule[] = [
  // --- Security ---
  {
    id: 'general.innerhtml',
    category: 'Direct innerHTML assignment',
    dimension: 'Security',
    severity: 'Critical',
    regex: /\.innerHTML\s*=/,
    description: 'Direct innerHTML assignment can introduce XSS if the value is user-controlled.',
    suggestedFix: 'Use textContent, or sanitize with DOMPurify before assigning.',
    source: 'pattern',
  },
  {
    id: 'react.dangerously-set-inner-html',
    category: 'dangerouslySetInnerHTML usage',
    dimension: 'Security',
    severity: 'High',
    regex: /dangerouslySetInnerHTML/,
    description: 'Renders raw HTML; XSS risk unless the input is trusted or sanitized.',
    suggestedFix: 'Sanitize the HTML (e.g. DOMPurify) before rendering, or render structured content instead.',
    source: 'pattern',
    stacks: ['next-contentful'],
  },
  {
    id: 'general.dynamic-eval',
    category: 'Dynamic code execution',
    dimension: 'Security',
    severity: 'Critical',
    regex: /\beval\s*\(|new\s+Function\s*\(/,
    description: 'eval / new Function executes arbitrary code and is a code-injection vector.',
    suggestedFix: 'Replace with explicit logic; never execute strings as code.',
    source: 'pattern',
  },
  {
    id: 'next.public-secret-env',
    category: 'Secret-named NEXT_PUBLIC env var',
    dimension: 'Security',
    severity: 'High',
    regex: /process\.env\.NEXT_PUBLIC_[A-Z0-9_]*(SECRET|TOKEN|KEY|PASSWORD)/,
    description: 'NEXT_PUBLIC_ vars are inlined into the client bundle; a secret here is exposed to the browser.',
    suggestedFix: 'Move the secret to a server-only env var (no NEXT_PUBLIC_ prefix) and read it server-side.',
    source: 'pattern',
    stacks: ['next-contentful'],
  },
  {
    id: 'contentful.public-token',
    category: 'Contentful token in NEXT_PUBLIC var',
    dimension: 'Security',
    severity: 'High',
    regex: /NEXT_PUBLIC_[A-Z0-9_]*CONTENTFUL/,
    description: 'A Contentful token exposed via NEXT_PUBLIC_ is readable in the client bundle.',
    suggestedFix: 'Keep Contentful tokens server-side; fetch via a server component or route handler.',
    source: 'pattern',
    stacks: ['next-contentful'],
  },
  {
    id: 'general.hardcoded-secret-literal',
    category: 'Hardcoded secret-like literal',
    dimension: 'Security',
    severity: 'High',
    regex: /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{12,}['"]/i,
    description: 'A long literal assigned to a secret-named field may be a committed credential.',
    suggestedFix: 'Move to an environment variable; rotate the credential if it was committed.',
    source: 'pattern',
  },
  {
    id: 'general.sql-string-concat',
    category: 'SQL built by string concatenation',
    dimension: 'Security',
    severity: 'Critical',
    regex: /\b(query|execute|raw)\s*\(\s*(`[^`]*\$\{|['"][^'"]*['"]\s*\+)/i,
    description: 'A query string built by concatenation/interpolation instead of a parameterized call is a SQL-injection vector if any part is externally influenced.',
    suggestedFix: 'Use a parameterized query / prepared statement or the ORM’s query builder instead of building SQL from strings.',
    source: 'pattern',
  },
  {
    id: 'general.command-injection',
    category: 'Shell command built from a variable',
    dimension: 'Security',
    severity: 'Critical',
    regex: /\b(child_process\.)?(exec|execSync)\s*\(\s*(`[^`]*\$\{|[A-Za-z_$][\w.]*\s*\+)/,
    description: 'exec/execSync invoked with a concatenated or interpolated command string is a command-injection vector if any part is externally influenced.',
    suggestedFix: 'Use execFile/spawn with an argument array instead of a shell string, or strictly allowlist the interpolated value.',
    source: 'pattern',
  },
  {
    id: 'general.weak-hash-for-secret',
    category: 'MD5/SHA1 used near secret-shaped data',
    dimension: 'Security',
    severity: 'High',
    regex: /createHash\s*\(\s*['"](md5|sha1)['"]\s*\)/i,
    description: 'MD5/SHA1 are not suitable for passwords, tokens, or signatures — they are fast to brute-force and (SHA1) collision-broken.',
    suggestedFix: 'Use a dedicated password hash (bcrypt/scrypt/argon2) for credentials, or SHA-256+ for integrity checks.',
    source: 'pattern',
  },
  {
    id: 'general.jwt-decode-not-verify',
    category: 'JWT decoded without verification',
    dimension: 'Security',
    severity: 'High',
    regex: /jwt\.decode\s*\(/,
    description: 'jwt.decode() reads the payload without checking the signature — trusting it for auth/authorization decisions lets a caller forge any claim.',
    suggestedFix: 'Use jwt.verify() with the expected algorithm and key/secret instead of decode() wherever the result drives a security decision.',
    source: 'pattern',
  },
  {
    id: 'general.client-storage-token',
    category: 'Token/secret written to browser storage',
    dimension: 'Security',
    severity: 'Medium',
    regex: /(localStorage|sessionStorage)\.setItem\s*\(\s*['"][^'"]*(token|secret|password)/i,
    description: 'Tokens/secrets in localStorage or sessionStorage are readable by any script on the page (XSS exfiltration risk) and persist outside HTTP-only cookie protections.',
    suggestedFix: 'Prefer an HTTP-only, Secure cookie for session/auth tokens.',
    source: 'pattern',
  },
  // --- Reliability ---
  {
    id: 'general.hardcoded-http-url',
    category: 'Hardcoded http:// URL',
    dimension: 'Reliability',
    severity: 'Medium',
    regex: /['"]http:\/\/(?!localhost|127\.0\.0\.1)/,
    description: 'A hardcoded non-local http URL is insecure and brittle across environments.',
    suggestedFix: 'Use https and source the base URL from config/env.',
    source: 'pattern',
  },
  {
    id: 'general.unguarded-json-parse',
    category: 'JSON.parse without error handling',
    dimension: 'Reliability',
    severity: 'Low',
    regex: /\bJSON\.parse\s*\(/,
    description: 'JSON.parse throws on malformed input; a call on external/user data with no surrounding try/catch can crash the request instead of failing gracefully (judgment pass should check the surrounding code for a guard).',
    suggestedFix: 'Wrap in try/catch (or a safe-parse helper) when the input isn’t a value this code itself just serialized.',
    source: 'pattern',
  },
  // --- Performance ---
  {
    id: 'next.raw-img-tag',
    category: 'Raw <img> instead of next/image',
    dimension: 'Performance',
    severity: 'Medium',
    regex: /<img(\s|>)/,
    description: 'Raw <img> skips Next.js image optimization (sizing, lazy-loading, formats).',
    suggestedFix: 'Use next/image where the image is optimizable.',
    source: 'pattern',
    stacks: ['next-contentful'],
  },
  {
    id: 'general.await-in-loop',
    category: 'Sequential await inside a loop',
    dimension: 'Performance',
    severity: 'Medium',
    regex: /\bfor\s*\([^)]*\)\s*\{[^}]*\bawait\b/,
    description: 'Awaiting one call per loop iteration serializes work that is often independent and could run concurrently.',
    suggestedFix: 'Collect the promises and use Promise.all (or a bounded-concurrency helper) instead of awaiting inside the loop body.',
    source: 'pattern',
  },
  // --- Maintainability ---
  {
    id: 'next.legacy-data-fetching',
    category: 'Pages Router data fetching',
    dimension: 'Maintainability',
    severity: 'High',
    regex: /\b(getServerSideProps|getStaticProps|getInitialProps)\b/,
    description: 'Pages Router data-fetching APIs in an App Router project; should use server components / fetch.',
    suggestedFix: 'Fetch in a server component or route handler instead.',
    source: 'pattern',
    stacks: ['next-contentful'],
  },
  {
    id: 'next.next-head-in-app-router',
    category: 'next/head in App Router',
    dimension: 'Maintainability',
    severity: 'Medium',
    regex: /from\s+['"]next\/head['"]/,
    description: 'App Router uses the metadata API rather than next/head.',
    suggestedFix: 'Export metadata / generateMetadata from the route segment.',
    source: 'pattern',
    stacks: ['next-contentful'],
  },
  {
    id: 'general.ts-suppression',
    category: 'Suppressed type/lint check',
    dimension: 'Maintainability',
    severity: 'Low',
    regex: /@ts-ignore\b|@ts-nocheck\b|eslint-disable\b/,
    description: 'A suppressed type or lint check hides whatever it was protecting against from future changes, not just the original violation.',
    suggestedFix: 'Fix the underlying issue, or narrow the suppression to the specific rule with a comment explaining why.',
    source: 'pattern',
    includeComments: true,
  },
  {
    id: 'general.any-type',
    category: 'any type annotation',
    dimension: 'Maintainability',
    severity: 'Low',
    regex: /:\s*any\b|<any>|\bas\s+any\b/,
    description: '`any` disables type checking for that value, silently defeating the purpose of TypeScript at that point.',
    suggestedFix: 'Replace with the real type, `unknown` plus a narrowing check, or a generic.',
    source: 'pattern',
  },
  {
    id: 'general.debugger-statement',
    category: 'debugger statement',
    dimension: 'Maintainability',
    severity: 'Low',
    regex: /^\s*debugger\s*;?\s*$/,
    description: 'A debugger statement left in source halts execution for anyone with devtools open.',
    suggestedFix: 'Remove it.',
    source: 'pattern',
  },
  {
    id: 'general.console-log',
    category: 'console.log / console.debug',
    dimension: 'Maintainability',
    severity: 'Low',
    regex: /\bconsole\.(log|debug)\s*\(/,
    description: 'Debug logging left in production source.',
    suggestedFix: 'Remove or route through a structured logger.',
    source: 'pattern',
  },
  {
    id: 'general.var-keyword',
    category: 'var declaration',
    dimension: 'Maintainability',
    severity: 'Medium',
    regex: /\bvar\s+[A-Za-z_$]/,
    description: 'var has function scope and hoisting quirks; use const/let.',
    suggestedFix: 'Replace with const or let.',
    source: 'pattern',
  },
  {
    id: 'general.stale-todo',
    category: 'TODO / FIXME / HACK',
    dimension: 'Maintainability',
    severity: 'Low',
    regex: /\b(TODO|FIXME|HACK)\b/,
    description: 'Unresolved TODO/FIXME/HACK marker.',
    suggestedFix: 'Resolve, or convert to a tracked ticket and reference it.',
    source: 'pattern',
    includeComments: true,
  },
  // --- AWS Lambda/CDK ---
  {
    id: 'aws.wildcard-iam',
    category: 'Wildcard IAM action/resource',
    dimension: 'Security',
    severity: 'High',
    regex: /\b(actions|resources)\s*:\s*\[\s*['"]\*['"]/,
    description: 'A wildcard IAM action or resource grants far more than a single Lambda/construct typically needs, widening the blast radius of a compromised function.',
    suggestedFix: 'Scope the policy to the specific actions and resource ARNs this function actually needs.',
    source: 'pattern',
    stacks: ['aws-lambda-cdk'],
  },
  {
    id: 'aws.hardcoded-account-arn',
    category: 'Hardcoded AWS account ID in an ARN',
    dimension: 'Maintainability',
    severity: 'Medium',
    regex: /arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:/,
    description: 'An ARN with a literal 12-digit account ID hardcodes a specific AWS account into the code, breaking portability across accounts/stages (dev/staging/prod) and leaking account identifiers into source.',
    suggestedFix: 'Build the ARN from the stack’s own account/region context (e.g. `Stack.of(this).account`) or an environment-specific config value instead of a literal.',
    source: 'pattern',
    stacks: ['aws-lambda-cdk'],
  },
];

export default rules;
