const REDACTED = "[REDACTED]";

/** Strips known secret shapes (tokens, client secrets, OAuth codes) from text. */
export function redact(text: string): string {
  return text
    .replace(/ya29\.[\w.-]+/g, REDACTED)
    .replace(/1\/\/[\w-]+/g, REDACTED)
    .replace(/GOCSPX-[\w-]+/g, REDACTED)
    .replace(
      /"(access_token|refresh_token|id_token|client_secret|code_verifier|code)"\s*:\s*"[^"]*"/g,
      `"$1":"${REDACTED}"`,
    )
    .replace(
      /([?&](?:code|code_verifier|refresh_token|client_secret)=)[^&\s]+/g,
      `$1${REDACTED}`,
    );
}

/**
 * Returns a new Error whose message and stack are redacted. Keeps `name` and
 * `code`; the original error object (which may hold secrets) is not retained.
 */
export function safeCause(err: unknown): Error {
  if (err instanceof Error) {
    const out = new Error(redact(err.message));
    out.name = err.name;
    if (err.stack) out.stack = redact(err.stack);
    const code = (err as { code?: unknown }).code;
    if (code !== undefined) (out as Error & { code?: unknown }).code = code;
    return out;
  }
  return new Error(redact(String(err)));
}
