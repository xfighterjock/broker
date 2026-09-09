import Foundation

/// Injectable `URLSession.data(for:)` so tests can stub JSON calls.
protocol BrokerHTTPPerforming: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: BrokerHTTPPerforming {}

/// Fail-fast JSON transport.
///
/// `URLRequest.timeoutInterval` and `timeoutIntervalForRequest` do **not** abort
/// a TCP/TLS connect that never completes. iOS can hold that attempt until a
/// path-update (wifi ↔ cellular), so the interval never fires. A racing Task
/// cancels the `URLSessionTask` after `requestTimeout`, then one retry runs on
/// a fresh session. First paint must not wait on this.
enum BrokerTransport {
    static let requestTimeout: TimeInterval = 8
    static let resourceTimeout: TimeInterval = 12
    static let extraAttemptsOnTimeout = 1

    /// Default injector for `BrokerAPI`. Live I/O does not use this instance —
    /// each attempt builds a fresh ephemeral session that can be cancelled.
    static let session: URLSession = makeSession()

    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = requestTimeout
        config.timeoutIntervalForResource = resourceTimeout
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        return URLSession(configuration: config)
    }

    static func applyTimeouts(to request: inout URLRequest) {
        request.timeoutInterval = requestTimeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
    }

    static func data(
        for request: URLRequest,
        using http: any BrokerHTTPPerforming
    ) async throws -> (Data, URLResponse) {
        var lastError: Error = URLError(.timedOut)
        let attempts = 1 + extraAttemptsOnTimeout
        for attempt in 1...attempts {
            let session: URLSession?
            let performer: any BrokerHTTPPerforming
            if http is URLSession {
                session = makeSession()
                performer = session!
            } else {
                session = nil
                performer = http
            }
            do {
                let result = try await dataCancellingAfterTimeout(
                    for: request,
                    using: performer,
                    session: session
                )
                session?.finishTasksAndInvalidate()
                return result
            } catch {
                session?.invalidateAndCancel()
                lastError = error
                if attempt == attempts || !isRetryable(error) {
                    throw normalizedTimeout(error)
                }
            }
        }
        throw normalizedTimeout(lastError)
    }

    static func isRetryable(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if let url = error as? URLError {
            return url.code == .timedOut || url.code == .cancelled
        }
        let ns = error as NSError
        return ns.domain == NSURLErrorDomain
            && (ns.code == NSURLErrorTimedOut || ns.code == NSURLErrorCancelled)
    }

    private static func normalizedTimeout(_ error: Error) -> Error {
        isRetryable(error) ? URLError(.timedOut) : error
    }

    private static func dataCancellingAfterTimeout(
        for request: URLRequest,
        using http: any BrokerHTTPPerforming,
        session: URLSession?
    ) async throws -> (Data, URLResponse) {
        if let session {
            return try await dataCancellingURLSessionTask(for: request, session: session)
        }
        return try await raceTimeout {
            try await http.data(for: request)
        }
    }

    /// Explicitly cancel the `URLSessionTask` when the racing timer fires.
    /// `timeoutInterval` is not enough for a blackholed TCP/TLS connect.
    private static func dataCancellingURLSessionTask(
        for request: URLRequest,
        session: URLSession
    ) async throws -> (Data, URLResponse) {
        let box = URLSessionTaskBox()
        let onceHolder = OnceResumeHolder()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let once = OnceResume(continuation)
                onceHolder.store(once)
                let task = session.dataTask(with: request) { data, response, error in
                    if let error {
                        once.resume(throwing: error)
                        return
                    }
                    guard let data, let response else {
                        once.resume(throwing: URLError(.badServerResponse))
                        return
                    }
                    once.resume(returning: (data, response))
                }
                box.store(task)
                let timeoutTask = Task {
                    do {
                        try await Task.sleep(nanoseconds: UInt64(requestTimeout * 1_000_000_000))
                    } catch {
                        return
                    }
                    box.cancel()
                    session.invalidateAndCancel()
                    once.resume(throwing: URLError(.timedOut))
                }
                once.storeTimeoutTask(timeoutTask)
                task.resume()
            }
        } onCancel: {
            box.cancel()
            session.invalidateAndCancel()
            onceHolder.resume(throwing: CancellationError())
        }
    }

    private static func raceTimeout(
        _ work: @escaping @Sendable () async throws -> (Data, URLResponse)
    ) async throws -> (Data, URLResponse) {
        try await withThrowingTaskGroup(of: HTTPPair.self) { group in
            group.addTask {
                let pair = try await work()
                return HTTPPair(data: pair.0, response: pair.1)
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(requestTimeout * 1_000_000_000))
                throw URLError(.timedOut)
            }
            defer { group.cancelAll() }
            guard let pair = try await group.next() else {
                throw URLError(.timedOut)
            }
            return (pair.data, pair.response)
        }
    }
}

private struct HTTPPair: @unchecked Sendable {
    let data: Data
    let response: URLResponse
}

private final class URLSessionTaskBox: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionTask?

    func store(_ task: URLSessionTask) {
        lock.lock()
        self.task = task
        lock.unlock()
    }

    func cancel() {
        lock.lock()
        let task = self.task
        lock.unlock()
        task?.cancel()
    }
}

private final class OnceResumeHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var once: OnceResume?

    func store(_ once: OnceResume) {
        lock.lock()
        self.once = once
        lock.unlock()
    }

    func resume(throwing error: Error) {
        lock.lock()
        let once = self.once
        lock.unlock()
        once?.resume(throwing: error)
    }
}

private final class OnceResume: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<(Data, URLResponse), Error>?
    private var timeoutTask: Task<Void, Never>?

    init(_ continuation: CheckedContinuation<(Data, URLResponse), Error>) {
        self.continuation = continuation
    }

    func storeTimeoutTask(_ task: Task<Void, Never>) {
        lock.lock()
        timeoutTask = task
        lock.unlock()
    }

    func resume(returning value: (Data, URLResponse)) {
        finish(cancelTimeout: true) { $0.resume(returning: value) }
    }

    func resume(throwing error: Error) {
        finish(cancelTimeout: true) { $0.resume(throwing: error) }
    }

    private func finish(
        cancelTimeout: Bool,
        _ body: (CheckedContinuation<(Data, URLResponse), Error>) -> Void
    ) {
        lock.lock()
        let cont = continuation
        continuation = nil
        let sleeper = timeoutTask
        timeoutTask = nil
        lock.unlock()
        if cancelTimeout {
            sleeper?.cancel()
        }
        if let cont {
            body(cont)
        }
    }
}
