import Combine
import Foundation
import UIKit

@MainActor
final class StatusController: ObservableObject {
    static let pollInterval: TimeInterval = 3

    @Published private(set) var snapshot: StatusSnapshot?
    @Published var lastError: String?
    @Published var busy = false
    @Published var pin = ""
    @Published var authorizeOpened = false
    @Published var lastAuthorizeURL: String?

    private var settings: AppSettings?
    private var auth: AuthController?
    private var timer: Timer?

    func bind(settings: AppSettings, auth: AuthController) {
        self.settings = settings
        self.auth = auth
    }

    func startPolling() {
        stopPolling()
        Task { await refresh() }
        timer = Timer.scheduledTimer(withTimeInterval: Self.pollInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.refresh()
            }
        }
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
    }

    func refresh() async {
        guard let api = makeAPI() else { return }
        do {
            snapshot = try await api.gateStatus()
            lastError = nil
        } catch {
            handle(error, label: "Status")
        }
    }

    func toggleGate() async {
        guard let snap = snapshot, let api = makeAPI() else { return }
        await mutate {
            try await api.setGate(enabled: !snap.gateEnabled)
        }
    }

    func toggleAutoPaper() async {
        guard let snap = snapshot, let api = makeAPI() else { return }
        await mutate {
            try await api.setAutoPaper(enabled: !EssentialsFormat.autoPaperAnyOn(snap))
        }
    }

    func toggleAutoSleeve(_ id: String, enabled: Bool) async {
        guard let api = makeAPI() else { return }
        await mutate {
            try await api.setAutoSleeve(sleeveId: id, enabled: enabled)
        }
    }

    func flatten() async {
        guard let api = makeAPI() else { return }
        await mutate {
            try await api.flatten()
        }
    }

    func startEtradeAuthorize() async {
        guard let api = makeAPI() else { return }
        busy = true
        defer { busy = false }
        do {
            let result = try await api.startEtradeOAuth()
            let url = result.authorizeUrl ?? ""
            guard EssentialsFormat.isValidEtradeAuthorizeURL(url), let parsed = URL(string: url) else {
                lastError = result.error ?? "E*TRADE authorize failed"
                return
            }
            lastAuthorizeURL = url
            authorizeOpened = true
            lastError = nil
            await openURL(parsed)
        } catch {
            handle(error, label: "E*TRADE authorize")
        }
    }

    func retryEtradeAuthorize() async {
        if let raw = lastAuthorizeURL, let url = URL(string: raw) {
            await openURL(url)
            return
        }
        await startEtradeAuthorize()
    }

    func submitEtradePin() async {
        let value = pin.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, let api = makeAPI() else { return }
        busy = true
        defer { busy = false }
        do {
            try await api.submitEtradePin(value)
            pin = ""
            lastAuthorizeURL = nil
            authorizeOpened = false
            lastError = nil
            snapshot = try await api.gateStatus()
        } catch {
            handle(error, label: "E*TRADE PIN")
        }
    }

    private func mutate(_ work: () async throws -> StatusSnapshot) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            snapshot = try await work()
            lastError = nil
        } catch {
            handle(error, label: "Update")
        }
    }

    private func makeAPI() -> BrokerAPI? {
        guard let settings, let auth, auth.hasSession else { return nil }
        return BrokerAPI(baseURL: settings.baseURL, bearerToken: auth.sessionToken)
    }

    private func handle(_ error: Error, label: String) {
        if let api = error as? BrokerAPIError, case .httpStatus(401, _) = api {
            auth?.invalidateLocalSession()
            lastError = "Session expired. Sign in again."
            return
        }
        lastError = "\(label) failed: \(error.localizedDescription)"
    }

    private func openURL(_ url: URL) async {
        await MainActor.run {
            UIApplication.shared.open(url)
        }
    }
}
