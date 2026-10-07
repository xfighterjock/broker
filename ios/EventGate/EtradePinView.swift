import SafariServices
import SwiftUI
import UIKit

/// Presents the E*TRADE authorize page inside the app.
/// The handshake is OAuth 1.0a `oob`: E*TRADE shows a verifier PIN on that page
/// and there is no redirect back. Done returns to the native PIN field.
@MainActor
enum EtradeSafariPresenter {
    static var onDismiss: () -> Void = {}

    private static var finishProxy: EtradeSafariFinishProxy?

    @discardableResult
    static func present(url: URL) -> Bool {
        guard let root = keyRoot() else { return false }
        let safari = SFSafariViewController(url: url)
        safari.dismissButtonStyle = .done
        safari.preferredControlTintColor = UIColor(red: 0.37, green: 0.78, blue: 0.86, alpha: 1)
        safari.modalPresentationStyle = .pageSheet
        let proxy = EtradeSafariFinishProxy()
        finishProxy = proxy
        safari.delegate = proxy

        var top = root
        while let next = top.presentedViewController {
            top = next
        }
        if top is SFSafariViewController {
            top.dismiss(animated: false) {
                var host = root
                while let next = host.presentedViewController {
                    host = next
                }
                host.present(safari, animated: true)
            }
            return true
        }
        top.present(safari, animated: true)
        return true
    }

    private static func keyRoot() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.flatMap(\.windows).first
        return window?.rootViewController
    }
}

/// Retained because `SFSafariViewController.delegate` is weak.
/// Kept outside the main-actor presenter so the Safari delegate stays nonisolated.
private final class EtradeSafariFinishProxy: NSObject, SFSafariViewControllerDelegate {
    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        Task { @MainActor in
            EtradeSafariPresenter.onDismiss()
        }
    }
}

struct EtradePinView: View {
    @EnvironmentObject private var status: StatusController
    @FocusState private var pinFocused: Bool

    var body: some View {
        let banner = EssentialsFormat.etradeReauthBanner(status.snapshot?.etradeAuth)
        if let banner {
            VStack(alignment: .leading, spacing: 10) {
                Button {
                    Task { await status.startEtradeAuthorize() }
                } label: {
                    HStack(alignment: .center, spacing: 8) {
                        Text(banner)
                            .font(.subheadline.weight(.semibold))
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 8)
                        Image(systemName: "arrow.up.right.square")
                            .accessibilityHidden(true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color(red: 0.90, green: 0.69, blue: 0.24))
                .disabled(status.busy)
                .accessibilityIdentifier("etrade-reauth")

                Text("E*TRADE shows a verifier PIN. Type it below. This does not place an order.")
                    .font(.footnote)
                    .foregroundStyle(Color(red: 0.86, green: 0.75, blue: 0.45))

                if status.authorizeOpened {
                    Button("Open again") {
                        Task { await status.retryEtradeAuthorize() }
                    }
                    .disabled(status.busy)
                }

                HStack {
                    TextField("PIN", text: $status.pin)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.oneTimeCode)
                        .focused($pinFocused)
                        .accessibilityIdentifier("etrade-pin-field")
                    Button("Submit PIN") {
                        Task { await status.submitEtradePin() }
                    }
                    .disabled(status.busy || status.pin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(red: 0.16, green: 0.12, blue: 0.04))
            .accessibilityElement(children: .contain)
            .onAppear {
                EtradeSafariPresenter.onDismiss = { pinFocused = true }
            }
            .onChange(of: status.authorizeTicket?.id) { _, _ in
                guard let url = status.authorizeTicket?.url else { return }
                if !EtradeSafariPresenter.present(url: url) {
                    status.noteAuthorizePresentFailed()
                }
            }
        }
    }
}
