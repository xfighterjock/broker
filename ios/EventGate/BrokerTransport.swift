import Foundation

/// Injectable `URLSession.data(for:)` so tests can stub JSON calls.
protocol BrokerHTTPPerforming: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: BrokerHTTPPerforming {}

/// Shared-session JSON transport for Event Gate.
///
/// Use `URLSession.shared` so requests share the system connection path
/// Safari uses. An ephemeral session does not, and is not a connectivity fix.
/// `waitsForConnectivity` cannot be set on the shared session; its default
/// is already false. First paint must not wait on this request, Firebase, or FCM.
enum BrokerTransport {
    static let requestTimeout: TimeInterval = 10

    /// Absolute http(s) URL from a stored base + API path.
    /// Replaces the base path/query instead of resolving the path as relative.
    static func resolveURL(baseURL: String, path: String) -> URL? {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed) else { return nil }
        let scheme = components.scheme?.lowercased()
        guard scheme == "http" || scheme == "https" else { return nil }
        guard let host = components.host, !host.isEmpty else { return nil }

        var pathParts = URLComponents()
        if let queryStart = path.firstIndex(of: "?") {
            pathParts.path = String(path[..<queryStart])
            pathParts.query = String(path[path.index(after: queryStart)...])
        } else {
            pathParts.path = path
        }
        guard pathParts.path.hasPrefix("/") else { return nil }

        components.path = pathParts.path
        components.query = pathParts.query
        components.fragment = nil
        return components.url
    }

    static func applyTimeouts(to request: inout URLRequest) {
        request.timeoutInterval = requestTimeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
    }

    static func transportMessage(_ error: Error, url: URL) -> String {
        "\(error.localizedDescription) (\(url.absoluteString))"
    }

    static func data(
        for request: URLRequest,
        using http: any BrokerHTTPPerforming
    ) async throws -> (Data, URLResponse) {
        try await http.data(for: request)
    }
}
