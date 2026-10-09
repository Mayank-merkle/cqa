import type { Dimension, Severity } from './types';

// Map an eslint ruleId + eslint severity (1=warn, 2=error) to our dimension
// and severity. eslint never produces "Critical" here — we cap it at High;
// only first-party security patterns escalate to Critical elsewhere.

export function mapEslintRule(
  ruleId: string | null,
  eslintSeverity: number
): { dimension: Dimension; severity: Severity } {
  const id = ruleId ?? '';
  const isError = eslintSeverity === 2;

  if (id.startsWith('jsx-a11y/')) {
    return { dimension: 'Accessibility', severity: isError ? 'Medium' : 'Low' };
  }
  if (id.startsWith('react-hooks/')) {
    const sev: Severity = id.includes('exhaustive-deps') ? 'High' : 'Medium';
    return { dimension: 'Reliability', severity: sev };
  }
  if (id === '@next/next/no-img-element') return { dimension: 'Performance', severity: 'Medium' };
  if (id === '@next/next/no-html-link-for-pages') return { dimension: 'Reliability', severity: 'Medium' };
  if (id.startsWith('@next/next/')) return { dimension: 'Maintainability', severity: isError ? 'Medium' : 'Low' };

  if (/no-eval|no-implied-eval|no-danger|detect-|security\//.test(id)) {
    return { dimension: 'Security', severity: 'High' };
  }
  if (id.includes('no-explicit-any') || id.includes('no-unsafe')) {
    return { dimension: 'Maintainability', severity: 'Medium' };
  }
  if (id.includes('no-unused') || id.includes('no-dead') || id.includes('no-unreachable')) {
    return { dimension: 'Maintainability', severity: 'Low' };
  }

  // Default bucket.
  return { dimension: 'Maintainability', severity: isError ? 'Medium' : 'Low' };
}
