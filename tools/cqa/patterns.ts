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
];

export default rules;
