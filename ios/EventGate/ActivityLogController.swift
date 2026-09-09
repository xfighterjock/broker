import Combine
import Foundation

@MainActor
final class ActivityLogController: ObservableObject {
    static let pageLimit = 50

    @Published private(set) var entries: [ActivityLogEntry] = []
    @Published var lastError: String?
    @Published var loading = false
    @Published var loadingMore = false
    @Published var hasMore = false

    private var settings: AppSettings?
    private var auth: AuthController?
    private var nextBefore: Int?

    func bind(settings: AppSettings, auth: AuthController) {
        self.settings = settings
        self.auth = auth
    }

    func reload() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        guard let api = makeAPI() else { return }
        do {
            let page = try await api.activityLog(limit: Self.pageLimit, before: nil)
            entries = page.entries
            nextBefore = page.nextBefore
            hasMore = page.hasMore
            lastError = nil
        } catch {
            handle(error)
        }
    }

    func loadMore() async {
        guard hasMore, let before = nextBefore, !loading, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        guard let api = makeAPI() else { return }
        do {
            let page = try await api.activityLog(limit: Self.pageLimit, before: before)
            let seen = Set(entries.map(\.id))
            entries.append(contentsOf: page.entries.filter { !seen.contains($0.id) })
            nextBefore = page.nextBefore
            hasMore = page.hasMore
            lastError = nil
        } catch {
            handle(error)
        }
    }

    private func makeAPI() -> BrokerAPI? {
        guard let settings, let auth, auth.hasSession else { return nil }
        return BrokerAPI(baseURL: settings.baseURL, bearerToken: auth.sessionToken)
    }

    private func handle(_ error: Error) {
        if let api = error as? BrokerAPIError, case .httpStatus(401, _) = api {
            auth?.invalidateLocalSession()
            lastError = "Session expired. Sign in again."
            return
        }
        lastError = "Activity failed: \(error.localizedDescription)"
    }
}
