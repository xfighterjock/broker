import Foundation

struct RegisterSuccess: Decodable {
    let ok: Bool
    let tokenPreview: String
}

struct APIErrorBody: Decodable {
    let ok: Bool?
    let error: String?
    let outcome: String?
    let reason: String?
}

struct NotificationStatus: Decodable, Equatable {
    let provider: String
    let enabled: Bool
    let configured: Bool
    let dedupeWindowMinutes: Int
    let tokens: TokenCounts
}

struct TokenCounts: Decodable, Equatable {
    let total: Int
    let active: Int
    let revoked: Int
}

struct TestSendResult: Decodable, Equatable {
    let outcome: String
    let provider: String
    let attempted: Int
    let delivered: Int
    let failed: Int
    let skipped: Int
    let reason: String?
}

enum PermissionState: String {
    case notDetermined
    case denied
    case authorized
    case provisional
    case ephemeral
    case unknown

    var label: String {
        switch self {
        case .notDetermined: return "not determined"
        case .denied: return "denied"
        case .authorized: return "authorized"
        case .provisional: return "provisional"
        case .ephemeral: return "ephemeral"
        case .unknown: return "unknown"
        }
    }
}

enum BrokerAPIError: LocalizedError {
    case invalidBaseURL
    case missingCredentials
    case missingToken
    case httpStatus(Int, String)
    case decoding(String)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .invalidBaseURL:
            return "Base URL is not a valid http(s) address."
        case .missingCredentials:
            return "Sign in with your Event Gate username and password first."
        case .missingToken:
            return "No FCM token yet. Allow notifications and run on a physical iPhone."
        case .httpStatus(let code, let body):
            return "HTTP \(code): \(body)"
        case .decoding(let detail):
            return "Unexpected response: \(detail)"
        case .transport(let detail):
            return detail
        }
    }
}

struct LoginSuccess: Decodable {
    let ok: Bool
    let username: String?
    let token: String?
    let expiresAt: String?
    let authRequired: Bool?
}

struct AuthStatusResponse: Decodable {
    let authRequired: Bool
    let authed: Bool
    let mode: String?
    let username: String?
}

struct EtradeStartResult: Decodable {
    let ok: Bool?
    let authorizeUrl: String?
    let error: String?
}

struct CalendarEventSnap: Decodable {
    let id: String?
    let type: String?
    let flattenEt: String?
}

struct ClockSnapshot: Decodable {
    let nowEt: String?
    let mode: String?
    let countdownLabel: String?
    let flattenEt: String?
    let focusEvent: CalendarEventSnap?
}

struct RiskChecks: Decodable {
    let spyAbove200: Bool?
    let acwiAbove200: Bool?
    let hygAbove200: Bool?
    let uup20dPct: Double?
    let dollarVeto: Bool?
}

struct SleeveBook: Decodable {
    let equityUsd: Double?
    let pnlUsd: Double?
    let totalPnlUsd: Double?
    let dailyPnlUsd: Double?
}

struct BrokerPosition: Decodable {
    let id: String?
    let symbol: String?
    let qty: Double?
    let side: String?
    let sleeveId: String?
}

struct BrokerSnapshot: Decodable {
    let name: String
    let mode: String
    let positions: [BrokerPosition]?
}

struct StatusSnapshot: Decodable {
    let clock: ClockSnapshot?
    let gateEnabled: Bool
    let autoPaper: Bool?
    let autoPaperBySleeve: [String: Bool]?
    let riskOn: Bool
    let riskChecks: RiskChecks?
    let etradeAuth: String?
    let broker: BrokerSnapshot
    let sleeveBooks: [String: SleeveBook]?
}

enum TokenRedaction {
    /// Matches server `redactToken`: first 4 + ellipsis + last 4, or `***` if short.
    static func redact(_ token: String) -> String {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 10 else { return "***" }
        return "\(trimmed.prefix(4))…\(trimmed.suffix(4))"
    }
}
