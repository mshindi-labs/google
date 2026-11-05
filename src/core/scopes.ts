import { MissingScopeError } from "./errors.js";

export const BASE_SCOPES: readonly string[] = ["openid", "email"];

export const SERVICE_SCOPES = {
  gmail: ["https://www.googleapis.com/auth/gmail.send"],
  calendar: [
    "https://www.googleapis.com/auth/calendar.events.owned",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
  ],
} as const;

export type GoogleService = keyof typeof SERVICE_SCOPES;

/** Base scopes plus every requested service's scopes, de-duplicated. */
export function scopesFor(services: GoogleService[]): string[] {
  const out = new Set<string>(BASE_SCOPES);
  for (const s of services)
    for (const scope of SERVICE_SCOPES[s]) out.add(scope);
  return [...out];
}

/**
 * Throws MissingScopeError listing the service scopes absent from `granted`.
 * Base scopes (and Google's `userinfo.email` alias for `email`) are never checked.
 */
export function assertServiceScopes(
  granted: string[],
  services: GoogleService[],
  ids: { tenantId?: string; connectionId?: string } = {},
): void {
  const have = new Set(granted);
  const required = new Set<string>();
  for (const s of services)
    for (const scope of SERVICE_SCOPES[s]) required.add(scope);
  const missing = [...required].filter((s) => !have.has(s));
  if (missing.length > 0) {
    throw new MissingScopeError(missing, undefined, ids);
  }
}
