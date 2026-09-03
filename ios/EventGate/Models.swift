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
            return "Enter nginx basic-auth username and password first."
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

enum TokenRedaction {
    /// Matches server `redactToken`: first 4 + ellipsis + last 4, or `***` if short.
    static func redact(_ token: String) -> String {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 10 else { return "***" }
        return "\(trimmed.prefix(4))…\(trimmed.suffix(4))"
    }
}
