/**
 * Mirrors ios/EventGate/BrokerTransport.swift so the timeout/retry policy is
 * unit-testable without Xcode. Keep constants and shouldRetry in lockstep.
 */

export const BROKER_REQUEST_TIMEOUT_SEC = 10;
export const BROKER_RESOURCE_TIMEOUT_SEC = 15;
export const BROKER_EXTRA_ATTEMPTS_ON_TIMEOUT = 1;

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

/** `afterAttempt` is 1-based for the call that just failed. */
export function shouldRetryTransport(
  error: TransportFailure,
  afterAttempt: number,
): boolean {
  return afterAttempt <= BROKER_EXTRA_ATTEMPTS_ON_TIMEOUT && isTimeoutError(error);
}

export async function performWithTimeoutRetry<T>(
  work: () => Promise<T>,
): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await work();
    } catch (error) {
      if (shouldRetryTransport(error as TransportFailure, attempt)) {
        continue;
      }
      throw error;
    }
  }
}
