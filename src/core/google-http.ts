// Shared readers for raw Google/gaxios error shapes. Internal: not part of /core.
export type ErrLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  status?: unknown;
  errors?: { reason?: unknown }[];
  cause?: { code?: unknown } | null;
  response?: {
    status?: unknown;
    headers?: Record<string, unknown>;
    data?: { error?: { message?: unknown; errors?: { reason?: unknown }[] } };
  };
};

export const asErr = (err: unknown): ErrLike =>
  typeof err === "object" && err !== null ? (err as ErrLike) : {};

export function readStatus(e: ErrLike): number | null {
  const s = e.response?.status ?? e.status ?? e.code;
  return typeof s === "number" ? s : null;
}

export function readReason(e: ErrLike): string | null {
  const r =
    e.response?.data?.error?.errors?.[0]?.reason ?? e.errors?.[0]?.reason;
  return typeof r === "string" ? r : null;
}

export function readNetCode(e: ErrLike): string | null {
  const c = e.code ?? e.cause?.code;
  return typeof c === "string" ? c : null;
}

export function readMessages(e: ErrLike): string {
  const a = typeof e.message === "string" ? e.message : "";
  const b = e.response?.data?.error?.message;
  return `${a} ${typeof b === "string" ? b : ""}`;
}

export function readRetryAfterMs(e: ErrLike): number | null {
  const raw = e.response?.headers?.["retry-after"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  if (s === "") return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const at = Date.parse(s);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}
