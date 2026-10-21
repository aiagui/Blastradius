/**
 * Token-shaped substrings that must never appear in CLI text or report fields.
 *
 * Prefixed provider tokens and 40-hex values are always redacted. A bare
 * 24-char alphanumeric run (legacy Vercel tokens) is redacted only when it
 * looks random: it mixes upper and lower case, has a digit or at least six
 * capitals, and is not all hex. That keeps names like PaymentReconciliationApp and MongoDB ObjectIds
 * readable in paths and in the JSON report.
 *
 * Boundaries use "not alphanumeric" rather than \b, so a token after "_"
 * (x_<token>) is still caught.
 */
export const SECRETISH =
  /(?:gh[pousr]_|github_pat_|[srp]k_(?:live|test)_|whsec_|vc[piar]_)[A-Za-z0-9_\-/+]{8,}|(?<![A-Za-z0-9])(?:[0-9a-f]{40}|[A-Za-z0-9]{24})(?![A-Za-z0-9])/gi;

/** True for a 24-char run that looks like a random token rather than a word or an id. */
export function looksRandom24(s: string): boolean {
  if (!/[A-Z]/.test(s) || !/[a-z]/.test(s) || /^[0-9a-f]+$/i.test(s)) return false;
  // Random tokens without a digit still have many capitals; CamelCase names have a few.
  return /[0-9]/.test(s) || (s.match(/[A-Z]/g)?.length ?? 0) >= 6;
}

/** Redact secret-shaped spans in a string (paths, messages, report fields). */
export function redactSecrets(text: string): string {
  return text.replace(SECRETISH, (m) => (m.length === 24 && /^[A-Za-z0-9]+$/.test(m) && !looksRandom24(m) ? m : "[REDACTED]"));
}
