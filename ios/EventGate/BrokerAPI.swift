import Foundation

struct BrokerAPI {
    var baseURL: String
    var bearerToken: String?

    func login(username: String, password: String) async throws -> LoginSuccess {
        try await post("/api/auth/login", json: [
            "username": username,
            "password": password,
        ], authorized: false)
    }

    func logout() async throws {
        let _: Ack = try await post("/api/auth/logout", json: [:] as [String: String])
    }

    func authStatus() async throws -> AuthStatusResponse {
        try await get("/api/auth/status", authorized: false)
    }

    func gateStatus() async throws -> StatusSnapshot {
        try await get("/api/status")
    }

    func setGate(enabled: Bool) async throws -> StatusSnapshot {
        try await post("/api/gate/enable", json: ["enabled": enabled])
    }

    func setAutoPaper(enabled: Bool) async throws -> StatusSnapshot {
        try await post("/api/paper/auto", json: ["enabled": enabled])
    }

    func setAutoSleeve(sleeveId: String, enabled: Bool) async throws -> StatusSnapshot {
        try await post("/api/paper/auto", json: [
            "sleeveId": sleeveId,
            "enabled": enabled,
        ])
    }

    func flatten() async throws -> StatusSnapshot {
        try await post("/api/flatten", json: [:] as [String: String])
    }

    func startEtradeOAuth() async throws -> EtradeStartResult {
        try await post("/api/etrade/oauth/start", json: [:] as [String: String])
    }

    func submitEtradePin(_ pin: String) async throws {
        let _: Ack = try await post("/api/etrade/oauth/pin", json: ["pin": pin])
    }

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

    func notificationStatus() async throws -> NotificationStatus {
        try await get("/api/notifications/status")
    }

    private struct Ack: Decodable {
        let ok: Bool?
        let error: String?
    }

    private func get<T: Decodable>(_ path: String, authorized: Bool = true) async throws -> T {
        try await send(path, method: "GET", body: nil, authorized: authorized)
    }

    private func post<T: Decodable>(_ path: String, json: Any, authorized: Bool = true) async throws -> T {
        let data = try JSONSerialization.data(withJSONObject: json, options: [])
        return try await send(path, method: "POST", body: data, authorized: authorized)
    }

    private func send<T: Decodable>(_ path: String, method: String, body: Data?, authorized: Bool) async throws -> T {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let root = URL(string: trimmed),
              let scheme = root.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              let url = URL(string: path, relativeTo: root)?.absoluteURL
        else {
            throw BrokerAPIError.invalidBaseURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // Keep FCM tokens on the VPS default principal so existing registrations stay valid.
        request.setValue(EventGateIdentity.tokenPrincipal, forHTTPHeaderField: "x-remote-user")
        if authorized {
            let token = bearerToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !token.isEmpty else { throw BrokerAPIError.missingCredentials }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
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
            throw BrokerAPIError.httpStatus(401, summarizeBody(data))
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

    private func summarizeBody(_ data: Data) -> String {
        if let parsed = try? JSONDecoder().decode(APIErrorBody.self, from: data) {
            return parsed.error ?? parsed.reason ?? parsed.outcome ?? "request failed"
        }
        let text = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? "empty body" : String(text.prefix(180))
    }
}
