/**
 * Mirrors ios/EventGate/BrokerTransport.swift hard-cancel policy.
 * URLRequest.timeoutInterval does not abort a TCP/TLS connect that never
 * completes. Cancel the task after requestTimeout, then retry once on a
 * fresh session.
 */

export const BROKER_REQUEST_TIMEOUT_SEC = 8;
export const BROKER_RESOURCE_TIMEOUT_SEC = 12;
export const BROKER_EXTRA_ATTEMPTS_ON_TIMEOUT = 1;

export const NSURL_ERROR_TIMED_OUT = -1001;
export const NSURL_ERROR_CANCELLED = -999;
export const NSURL_ERROR_DOMAIN = "NSURLErrorDomain";

export type TransportFailure = {
  code?: string | number;
  domain?: string;
  name?: string;
};

export type AttemptContext = {
  attempt: number;
  sessionId: number;
  signal: AbortSignal;
};

export function isTimeoutError(error: TransportFailure): boolean {
  if (error.code === "timedOut" || error.code === NSURL_ERROR_TIMED_OUT) return true;
  if (error.code === "cancelled" || error.code === NSURL_ERROR_CANCELLED) return true;
  if (error.name === "CancellationError") return true;
  return (
    error.domain === NSURL_ERROR_DOMAIN &&
    (error.code === NSURL_ERROR_TIMED_OUT || error.code === NSURL_ERROR_CANCELLED)
  );
}

export function shouldRetryTransport(
  error: TransportFailure,
  afterAttempt: number,
): boolean {
  return afterAttempt <= BROKER_EXTRA_ATTEMPTS_ON_TIMEOUT && isTimeoutError(error);
}

export function hangUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => {
      const err = new Error("cancelled");
      Object.assign(err, {
        code: NSURL_ERROR_CANCELLED,
        domain: NSURL_ERROR_DOMAIN,
      });
      reject(err);
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

export async function withHardTimeout<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      const err = new Error("The request timed out.");
      Object.assign(err, { code: "timedOut", domain: NSURL_ERROR_DOMAIN });
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(ac.signal), timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!ac.signal.aborted) ac.abort();
  }
}

export async function performWithTimeout<T>(
  work: (ctx: AttemptContext) => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? BROKER_REQUEST_TIMEOUT_SEC * 1000;
  const attempts = 1 + BROKER_EXTRA_ATTEMPTS_ON_TIMEOUT;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const sessionId = attempt;
    try {
      return await withHardTimeout(timeoutMs, (signal) =>
        work({ attempt, sessionId, signal }),
      );
    } catch (e) {
      lastErr = e;
      if (attempt === attempts || !isTimeoutError(e as TransportFailure)) {
        throw e;
      }
    }
  }
  throw lastErr;
}
