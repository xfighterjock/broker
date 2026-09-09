/**
 * Mirrors ios/EventGate/BrokerTransport.swift: URLSession.shared +
 * URLComponents absolute URLs. No ephemeral session, no cancel-and-retry.
 */

export const BROKER_REQUEST_TIMEOUT_SEC = 10;
export const BROKER_EXTRA_ATTEMPTS_ON_TIMEOUT = 0;
export const DEFAULT_BASE_URL = "https://broker.logikmancer.com";

export const NSURL_ERROR_TIMED_OUT = -1001;
export const NSURL_ERROR_DOMAIN = "NSURLErrorDomain";

export type TransportFailure = {
  code?: string | number;
  domain?: string;
  name?: string;
};

export function isTimeoutError(error: TransportFailure): boolean {
  if (error.code === "timedOut" || error.code === NSURL_ERROR_TIMED_OUT) return true;
  return error.domain === NSURL_ERROR_DOMAIN && error.code === NSURL_ERROR_TIMED_OUT;
}

/** Do not retry a timeout on the same session — that is not the diagnosis. */
export function shouldRetryTransport(
  _error: TransportFailure,
  _afterAttempt: number,
): boolean {
  return BROKER_EXTRA_ATTEMPTS_ON_TIMEOUT > 0 && isTimeoutError(_error);
}

export async function performWithTimeout<T>(work: () => Promise<T>): Promise<T> {
  return work();
}

/** Mirror of BrokerTransport.resolveURL — replace base path, do not resolve relatively. */
export function resolveBrokerURL(baseURL: string, path: string): string | null {
  const trimmed = baseURL.trim();
  let base: URL;
  try {
    base = new URL(trimmed);
  } catch {
    return null;
  }
  const scheme = base.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") return null;
  if (!base.hostname) return null;

  const q = path.indexOf("?");
  const rawPath = q >= 0 ? path.slice(0, q) : path;
  const rawQuery = q >= 0 ? path.slice(q + 1) : null;
  if (!rawPath.startsWith("/")) return null;

  try {
    const resolved = new URL(rawPath, `${base.protocol}//${base.host}`);
    resolved.search = rawQuery !== null && rawQuery.length > 0 ? `?${rawQuery}` : "";
    resolved.hash = "";
    return resolved.href;
  } catch {
    return null;
  }
}

/** Mirror of BrokerTransport.transportMessage */
export function transportMessage(detail: string, url: string): string {
  return `${detail} (${url})`;
}
