import Foundation

struct BrokerAPI {
    var baseURL: String
    var username: String
    var password: String

    func register(token: String, deviceLabel: String?, replaceToken: String?) async throws -> RegisterSuccess {
        var body: [String: String] = [
            "platform": "ios",
            "token": token,
        ]
        if let deviceLabel, !deviceLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            body["deviceLabel"] = deviceLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let replaceToken, !replaceToken.isEmpty, replaceToken != token {
            body["replaceToken"] = replaceToken
        }
        return try await post("/api/notifications/tokens/register", json: body)
    }

    func revoke(token: String) async throws {
        let _: Ack = try await post("/api/notifications/tokens/revoke", json: [
            "platform": "ios",
            "token": token,
        ])
    }

    func sendTest() async throws -> TestSendResult {
        try await post("/api/notifications/test", json: [:] as [String: String])
    }

    func status() async throws -> NotificationStatus {
        try await get("/api/notifications/status")
    }

    private struct Ack: Decodable {
        let ok: Bool?
        let error: String?
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await send(path, method: "GET", body: nil)
    }

    private func post<T: Decodable>(_ path: String, json: [String: String]) async throws -> T {
        let data = try JSONSerialization.data(withJSONObject: json, options: [])
        return try await send(path, method: "POST", body: data)
    }

    private func send<T: Decodable>(_ path: String, method: String, body: Data?) async throws -> T {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let root = URL(string: trimmed),
              let scheme = root.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              let url = URL(string: path, relativeTo: root)?.absoluteURL
        else {
            throw BrokerAPIError.invalidBaseURL
        }
        let user = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !user.isEmpty, !password.isEmpty else {
            throw BrokerAPIError.missingCredentials
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(basicAuthHeader(user: user, password: password), forHTTPHeaderField: "Authorization")
        // Keep tokens under the VPS default principal, not the nginx username (`broker`).
        request.setValue(EventGateIdentity.tokenPrincipal, forHTTPHeaderField: "x-remote-user")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw BrokerAPIError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw BrokerAPIError.transport("Non-HTTP response")
        }
        if http.statusCode == 401 {
            throw BrokerAPIError.httpStatus(401, "nginx basic auth failed (check username/password)")
        }
        if !(200...299).contains(http.statusCode) {
            throw BrokerAPIError.httpStatus(http.statusCode, summarizeBody(data))
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw BrokerAPIError.decoding(summarizeBody(data))
        }
    }

    private func basicAuthHeader(user: String, password: String) -> String {
        let raw = "\(user):\(password)"
        return "Basic \(Data(raw.utf8).base64EncodedString())"
    }

    private func summarizeBody(_ data: Data) -> String {
        if let parsed = try? JSONDecoder().decode(APIErrorBody.self, from: data) {
            return parsed.error ?? parsed.reason ?? parsed.outcome ?? "request failed"
        }
        let text = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? "empty body" : String(text.prefix(180))
    }
}
