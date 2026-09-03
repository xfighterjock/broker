import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var push: PushController
    @EnvironmentObject private var auth: AuthController

    var body: some View {
        Form {
            Section {
                TextField("https://broker.logikmancer.com", text: $settings.baseURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                LabeledContent("Signed in", value: auth.username.isEmpty ? "—" : auth.username)
                TextField("device label (optional)", text: $settings.deviceLabel)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Toggle("Unlock with Face ID / Touch ID", isOn: $auth.biometricEnabled)
                    .disabled(!auth.canUseBiometrics)
                Toggle("Register when FCM token arrives", isOn: $push.autoRegister)
            } header: {
                Text("Account")
            } footer: {
                Text("Session token stays in the Keychain. Face ID / Touch ID only unlocks this phone — it is not a remote password. Token principal is \(EventGateIdentity.tokenPrincipal).")
            }

            Section("This phone") {
                LabeledContent("Permission", value: push.permission.label)
                LabeledContent("APNs", value: push.apnsReady ? "ready" : "not registered")
                LabeledContent("FCM token", value: push.tokenPreview)
                if let route = push.lastDeepLink {
                    LabeledContent("Last deep link", value: route)
                }
                Text(push.lastMessage)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            Section("Push") {
                Button("Register") {
                    Task { await push.registerNow() }
                }
                .disabled(push.busy || !auth.hasSession)
                Button("Revoke", role: .destructive) {
                    Task { await push.revokeNow() }
                }
                .disabled(push.busy || !auth.hasSession)
                Button("Send test") {
                    Task { await push.sendTest() }
                }
                .disabled(push.busy || !auth.hasSession)
                Button("Refresh status") {
                    Task { await push.refreshStatus() }
                }
                .disabled(push.busy || !auth.hasSession)
                Button("Request notification permission") {
                    push.requestPermissionAndRegister()
                }
            }

            Section("Server status") {
                if let status = push.lastStatus {
                    LabeledContent("Provider", value: status.provider)
                    LabeledContent("Enabled", value: status.enabled ? "yes" : "no")
                    LabeledContent("Configured", value: status.configured ? "yes" : "no")
                    LabeledContent("Dedupe window", value: "\(status.dedupeWindowMinutes) min")
                    LabeledContent("Tokens", value: "\(status.tokens.active) active / \(status.tokens.total) total / \(status.tokens.revoked) revoked")
                } else {
                    Text("Tap Refresh status after signing in.")
                        .foregroundStyle(.secondary)
                }
                if let test = push.lastTest {
                    LabeledContent("Last test", value: test.outcome)
                    LabeledContent("Delivered", value: "\(test.delivered)/\(test.attempted)")
                    if let reason = test.reason {
                        LabeledContent("Reason", value: reason)
                    }
                }
            }

            Section {
                Button("Sign out", role: .destructive) {
                    Task { await auth.logout() }
                }
            }
        }
        .navigationTitle("Settings")
        .onAppear {
            push.bind(settings: settings, auth: auth)
            push.refreshPermission()
        }
    }
}
