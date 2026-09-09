/**
 * Mirrors ios/EventGate/BrokerTransport.swift timeout policy (safety net only).
 * A blackholed first request of a new process must fail, not retry on the same route.
 */

export const BROKER_REQUEST_TIMEOUT_SEC = 10;
export const BROKER_RESOURCE_TIMEOUT_SEC = 15;
export const BROKER_EXTRA_ATTEMPTS_ON_TIMEOUT = 0;

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

/** Timeout is a safety net only — do not retry the same blackholed route. */
export function shouldRetryTransport(
  _error: TransportFailure,
  _afterAttempt: number,
): boolean {
  return BROKER_EXTRA_ATTEMPTS_ON_TIMEOUT > 0 && isTimeoutError(_error);
}

export async function performWithTimeout<T>(work: () => Promise<T>): Promise<T> {
  return work();
}
