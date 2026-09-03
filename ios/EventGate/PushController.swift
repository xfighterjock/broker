import Combine
import Foundation
import UIKit
import UserNotifications

@MainActor
final class PushController: ObservableObject {
    static let shared = PushController()

    @Published private(set) var permission: PermissionState = .unknown
    @Published private(set) var fcmToken: String?
    @Published private(set) var tokenPreview: String = "—"
    @Published private(set) var apnsReady = false
    @Published private(set) var lastMessage = "Idle"
    @Published private(set) var lastDeepLink: String?
    @Published private(set) var lastStatus: NotificationStatus?
    @Published private(set) var lastTest: TestSendResult?
    @Published private(set) var busy = false
    @Published var autoRegister = true

    private weak var application: UIApplication?
    private var settings: AppSettings?
    private var auth: AuthController?
    private var pendingToken: String?

    func bind(settings: AppSettings, auth: AuthController) {
        self.settings = settings
        self.auth = auth
        if let pending = pendingToken {
            pendingToken = nil
            applyFCMToken(pending, settings: settings)
        }
    }

    func attach(application: UIApplication) {
        self.application = application
        refreshPermission()
        requestPermissionAndRegister()
    }

    func requestPermissionAndRegister() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { [weak self] _, _ in
            Task { @MainActor in
                self?.refreshPermission()
                self?.application?.registerForRemoteNotifications()
            }
        }
    }

    func refreshPermission() {
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
            Task { @MainActor in
                self?.permission = PermissionState(authorizationStatus: settings.authorizationStatus)
            }
        }
    }

    func didRegisterAPNs() {
        apnsReady = true
        lastMessage = "APNs device token received"
    }

    func didFailAPNs(_ error: Error) {
        apnsReady = false
        lastMessage = "APNs registration failed (simulator has no APNs): \(error.localizedDescription)"
    }

    func didReceiveFCMToken(_ token: String?) {
        guard let token, !token.isEmpty else { return }
        if let settings {
            applyFCMToken(token, settings: settings)
        } else {
            pendingToken = token
            fcmToken = token
            tokenPreview = TokenRedaction.redact(token)
        }
    }

    func noteIncoming(_ notification: UNNotification) {
        let data = notification.request.content.userInfo
        if let route = data["deepLinkRoute"] as? String {
            lastDeepLink = route
        }
        lastMessage = "Push received: \(notification.request.content.title)"
    }

    func registerNow() async {
        await run("Register") { settings, api, token in
            let previous = settings.lastRegisteredToken()
            let result = try await api.register(
                token: token,
                deviceLabel: settings.deviceLabel,
                replaceToken: previous
            )
            settings.storeLastRegisteredToken(token)
            lastMessage = "Registered \(result.tokenPreview)"
            tokenPreview = result.tokenPreview
        }
    }

    func revokeNow() async {
        await run("Revoke") { settings, api, token in
            try await api.revoke(token: token)
            settings.clearLastRegisteredToken()
            lastMessage = "Revoked \(TokenRedaction.redact(token))"
        }
    }

    func sendTest() async {
        await run("Send test") { _, api, _ in
            let result = try await api.sendTest()
            lastTest = result
            if let reason = result.reason, !reason.isEmpty {
                lastMessage = "Test \(result.outcome) — \(reason) (delivered \(result.delivered)/\(result.attempted))"
            } else {
                lastMessage = "Test \(result.outcome) (delivered \(result.delivered)/\(result.attempted))"
            }
        }
    }

    func refreshStatus() async {
        await run("Refresh status") { _, api, _ in
            lastStatus = try await api.notificationStatus()
            lastMessage = "Status: provider=\(lastStatus?.provider ?? "?") enabled=\(lastStatus?.enabled ?? false) configured=\(lastStatus?.configured ?? false) tokens active=\(lastStatus?.tokens.active ?? 0)"
        }
    }

    private func applyFCMToken(_ token: String, settings: AppSettings) {
        let previous = fcmToken
        fcmToken = token
        tokenPreview = TokenRedaction.redact(token)
        lastMessage = "FCM token \(tokenPreview)"
        guard autoRegister, auth?.hasSession == true else { return }
        let rotated = previous.map { $0 != token } ?? (settings.lastRegisteredToken().map { $0 != token } ?? false)
        Task {
            await run("Register") { settings, api, token in
                let replace = rotated ? (previous ?? settings.lastRegisteredToken()) : settings.lastRegisteredToken()
                let result = try await api.register(
                    token: token,
                    deviceLabel: settings.deviceLabel,
                    replaceToken: replace
                )
                settings.storeLastRegisteredToken(token)
                lastMessage = "Registered \(result.tokenPreview)"
                tokenPreview = result.tokenPreview
            }
        }
    }

    private func run(_ label: String, work: (AppSettings, BrokerAPI, String) async throws -> Void) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            guard let settings else {
                throw BrokerAPIError.transport("Settings not bound")
            }
            guard let auth, auth.hasSession else {
                throw BrokerAPIError.missingCredentials
            }
            let needsToken = label != "Refresh status" && label != "Send test"
            let token: String
            if needsToken {
                guard let current = fcmToken, !current.isEmpty else { throw BrokerAPIError.missingToken }
                token = current
            } else {
                token = fcmToken ?? ""
            }
            let api = BrokerAPI(baseURL: settings.baseURL, bearerToken: auth.sessionToken)
            try await work(settings, api, token)
        } catch {
            lastMessage = "\(label) failed: \(error.localizedDescription)"
        }
    }
}

extension PermissionState {
    init(authorizationStatus: UNAuthorizationStatus) {
        switch authorizationStatus {
        case .notDetermined: self = .notDetermined
        case .denied: self = .denied
        case .authorized: self = .authorized
        case .provisional: self = .provisional
        case .ephemeral: self = .ephemeral
        @unknown default: self = .unknown
        }
    }
}
