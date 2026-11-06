const ADDRESS_FORBIDDEN = /[\s\u0000-\u001f\u007f-\u009f<>,;"()[\]\\]/;
const LINE_BREAKS = /[\r\n\0]/;
const MAX_ADDRESS = 254;

/**
 * Validates a bare email address and returns `local@lowercased-domain`, or null
 * when it is not a string, contains CR/LF/NUL or forbidden characters, exceeds
 * 254 chars, or lacks exactly one `@` with a dotted domain.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string" || LINE_BREAKS.test(raw)) return null;
  if (raw.length > MAX_ADDRESS || ADDRESS_FORBIDDEN.test(raw)) return null;
  const parts = raw.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts as [string, string];
  if (!local || !domain.includes(".")) return null;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes(".."))
    return null;
  return `${local}@${domain.toLowerCase()}`;
}
