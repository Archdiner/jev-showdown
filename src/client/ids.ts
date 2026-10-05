/** Showdown userid: lowercase letters and digits only. */
export function toID(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Remove credential-bearing substrings before anything is logged. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(pass(?:word)?=)[^&\s]*/gi, '$1***')
    .replace(/(assertion=)[^&\s]*/gi, '$1***')
    .replace(/(challstr=)[^&\s]*/gi, '$1***');
}

export function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return redactSecrets(message);
}
