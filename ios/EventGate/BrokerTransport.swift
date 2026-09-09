import Foundation

/// Injectable `URLSession.data(for:)` so tests can stub JSON calls.
protocol BrokerHTTPPerforming: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: BrokerHTTPPerforming {}

/// Fail-fast timeouts for Event Gate JSON calls.
///
/// A swipe-closed launch is a new process — not a leftover URLSession from the
/// previous open. The first request of this process can still be bound to the
/// current default route and sit with no RST until iOS gets a path-update
/// (wifi ↔ cellular). Timeouts are a safety net so that blackholed attempt
/// cannot hold the UI. First paint must not wait on this request, Firebase,
/// or FCM.
enum BrokerTransport {
    static let requestTimeout: TimeInterval = 10
    static let resourceTimeout: TimeInterval = 15

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

    static func data(
        for request: URLRequest,
        using http: any BrokerHTTPPerforming
    ) async throws -> (Data, URLResponse) {
        try await http.data(for: request)
    }
}
