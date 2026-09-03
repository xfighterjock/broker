import Foundation
import Combine

enum EventGateIdentity {
    static let defaultBaseURL = "https://broker.logikmancer.com"
    /// Must match the VPS default when nginx does not inject x-remote-user.
    static let tokenPrincipal = "event-gate"
}

@MainActor
final class AppSettings: ObservableObject {

    private static let baseURLKey = "eventgate.baseURL"
    private static let deviceLabelKey = "eventgate.deviceLabel"
    private static let usernameAccount = "nginx-basic-username"
    private static let passwordAccount = "nginx-basic-password"
    private static let lastFCMAccount = "fcm-last-registered"

    @Published var baseURL: String {
        didSet { UserDefaults.standard.set(baseURL, forKey: Self.baseURLKey) }
    }

    @Published var username: String {
        didSet { persistSecret(username, account: Self.usernameAccount) }
    }

    @Published var password: String {
        didSet { persistSecret(password, account: Self.passwordAccount) }
    }

    @Published var deviceLabel: String {
        didSet { UserDefaults.standard.set(deviceLabel, forKey: Self.deviceLabelKey) }
    }

    init() {
        let stored = UserDefaults.standard.string(forKey: Self.baseURLKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
        baseURL = (stored?.isEmpty == false) ? stored! : EventGateIdentity.defaultBaseURL
        username = KeychainStore.get(account: Self.usernameAccount) ?? ""
        password = KeychainStore.get(account: Self.passwordAccount) ?? ""
        deviceLabel = UserDefaults.standard.string(forKey: Self.deviceLabelKey) ?? ""
    }

    var hasCredentials: Bool {
        !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func lastRegisteredToken() -> String? {
        KeychainStore.get(account: Self.lastFCMAccount)
    }

    func storeLastRegisteredToken(_ token: String) {
        persistSecret(token, account: Self.lastFCMAccount)
    }

    func clearLastRegisteredToken() {
        KeychainStore.delete(account: Self.lastFCMAccount)
    }

    private func persistSecret(_ value: String, account: String) {
        do {
            try KeychainStore.set(value, account: account)
        } catch {
            // Surface via logs only as a generic failure — never the secret.
            NSLog("EventGate keychain write failed for \(account)")
        }
    }
}
