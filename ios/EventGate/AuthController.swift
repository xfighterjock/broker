import Combine
import Foundation
import LocalAuthentication

@MainActor
final class AuthController: ObservableObject {
    private static let tokenAccount = "session-bearer-token"
    private static let usernameAccount = "login-username"
    private static let biometricKey = "eventgate.biometricEnabled"

    @Published var username: String
    @Published var password = ""
    @Published private(set) var sessionToken: String?
    @Published var unlocked = false
    @Published var biometricEnabled: Bool {
        didSet { UserDefaults.standard.set(biometricEnabled, forKey: Self.biometricKey) }
    }
    @Published var lastMessage = ""
    @Published var busy = false
    @Published var canUseBiometrics = false

    private var settings: AppSettings?

    init() {
        username = KeychainStore.get(account: Self.usernameAccount) ?? ""
        sessionToken = KeychainStore.get(account: Self.tokenAccount)
        biometricEnabled = UserDefaults.standard.bool(forKey: Self.biometricKey)
        evaluateBiometrics()
    }

    var hasSession: Bool {
        !(sessionToken ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func bind(settings: AppSettings) {
        self.settings = settings
        if username.isEmpty, !settings.username.isEmpty {
            username = settings.username
        }
    }

    func evaluateBiometrics() {
        let ctx = LAContext()
        var err: NSError?
        canUseBiometrics = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
    }

    func restoreSessionOnLaunch() {
        evaluateBiometrics()
        guard hasSession else {
            unlocked = false
            return
        }
        if biometricEnabled && canUseBiometrics {
            unlocked = false
            return
        }
        unlocked = true
    }

    func unlockWithBiometrics() async {
        evaluateBiometrics()
        guard hasSession else {
            lastMessage = "Sign in with username and password."
            return
        }
        guard canUseBiometrics else {
            lastMessage = "Biometrics unavailable. Use your password."
            unlocked = false
            return
        }
        let ctx = LAContext()
        ctx.localizedFallbackTitle = "Use Password"
        do {
            let ok = try await ctx.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: "Unlock Event Gate to reuse your saved session."
            )
            if ok {
                unlocked = true
                lastMessage = "Unlocked"
            } else {
                unlocked = false
                lastMessage = "Biometric unlock failed. Use your password."
            }
        } catch {
            unlocked = false
            lastMessage = "Biometric unlock failed. Use your password."
        }
    }

    func login() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            guard let settings else { throw BrokerAPIError.transport("Settings not bound") }
            let api = BrokerAPI(baseURL: settings.baseURL, bearerToken: nil)
            let result = try await api.login(username: username, password: password)
            guard let token = result.token, !token.isEmpty else {
                throw BrokerAPIError.decoding("login did not return a session token")
            }
            persistSession(token: token, username: result.username ?? username)
            password = ""
            unlocked = true
            lastMessage = "Signed in as \(result.username ?? username)"
        } catch {
            lastMessage = error.localizedDescription
            unlocked = false
        }
    }

    func logout() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        if let settings, hasSession {
            let api = BrokerAPI(baseURL: settings.baseURL, bearerToken: sessionToken)
            try? await api.logout()
        }
        clearSession()
        lastMessage = "Signed out"
    }

    func invalidateLocalSession() {
        clearSession()
        lastMessage = "Session expired. Sign in again."
    }

    private func persistSession(token: String, username: String) {
        sessionToken = token
        self.username = username
        do {
            try KeychainStore.set(token, account: Self.tokenAccount)
            try KeychainStore.set(username, account: Self.usernameAccount)
        } catch {
            NSLog("EventGate keychain write failed for session")
        }
        settings?.username = username
    }

    private func clearSession() {
        sessionToken = nil
        unlocked = false
        password = ""
        KeychainStore.delete(account: Self.tokenAccount)
    }
}
