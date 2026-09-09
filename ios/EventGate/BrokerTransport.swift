import Foundation

/// Injectable `URLSession.data(for:)` surface so login/status can be tested
/// without `URLSession.shared`.
protocol BrokerHTTPPerforming: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: BrokerHTTPPerforming {}

/// Dedicated session + fail-fast policy for Event Gate JSON calls.
/// `URLSession.shared` has no request timeout and a 7-day resource timeout, so a
/// dead cellular/wifi path can sit until the OS drops the socket.
enum BrokerTransport {
    static let requestTimeout: TimeInterval = 10
    static let resourceTimeout: TimeInterval = 15
    static let extraAttemptsOnTimeout = 1

    static let session: URLSession = makeSession()

    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = requestTimeout
        config.timeoutIntervalForResource = resourceTimeout
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        return URLSession(configuration: config)
    }

    static func applyTimeouts(to request: inout URLRequest) {
        request.timeoutInterval = requestTimeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
    }

    static func isTimeout(_ error: Error) -> Bool {
        if let urlError = error as? URLError {
            return urlError.code == .timedOut
        }
        let ns = error as NSError
        return ns.domain == NSURLErrorDomain && ns.code == NSURLErrorTimedOut
    }

    /// `afterAttempt` is 1-based for the call that just failed.
    static func shouldRetry(_ error: Error, afterAttempt attempt: Int) -> Bool {
        attempt <= extraAttemptsOnTimeout && isTimeout(error)
    }

    static func data(
        for request: URLRequest,
        using http: any BrokerHTTPPerforming
    ) async throws -> (Data, URLResponse) {
        var attempt = 0
        while true {
            attempt += 1
            do {
                return try await http.data(for: request)
            } catch {
                if shouldRetry(error, afterAttempt: attempt) {
                    continue
                }
                throw error
            }
        }
    }
}
