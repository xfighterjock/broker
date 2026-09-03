import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var push: PushController

    var body: some View {
        NavigationStack {
            Form {
                settingsSection
                pushSection
                actionsSection
                serverSection
            }
            .navigationTitle("Event Gate")
            .onAppear {
                push.bind(settings: settings)
                push.refreshPermission()
            }
        }
    }

    private var settingsSection: some View {
        Section {
            TextField("https://broker.logikmancer.com", text: $settings.baseURL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
            TextField("nginx username", text: $settings.username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.username)
            SecureField("nginx password (Keychain only)", text: $settings.password)
                .textContentType(.password)
            TextField("device label (optional)", text: $settings.deviceLabel)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Toggle("Register when FCM token arrives", isOn: $push.autoRegister)
        } header: {
            Text("Broker")
        } footer: {
            Text("Username and password are stored in the Keychain. They are sent as nginx basic auth. Token principal is \(EventGateIdentity.tokenPrincipal), not the nginx user.")
        }
    }

    private var pushSection: some View {
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
    }

    private var actionsSection: some View {
        Section("Actions") {
            Button("Register") {
                Task { await push.registerNow() }
            }
            .disabled(push.busy)
            Button("Revoke", role: .destructive) {
                Task { await push.revokeNow() }
            }
            .disabled(push.busy)
            Button("Send test") {
                Task { await push.sendTest() }
            }
            .disabled(push.busy)
            Button("Refresh status") {
                Task { await push.refreshStatus() }
            }
            .disabled(push.busy)
            Button("Request notification permission") {
                push.requestPermissionAndRegister()
            }
        }
    }

    private var serverSection: some View {
        Section("Server status") {
            if let status = push.lastStatus {
                LabeledContent("Provider", value: status.provider)
                LabeledContent("Enabled", value: status.enabled ? "yes" : "no")
                LabeledContent("Configured", value: status.configured ? "yes" : "no")
                LabeledContent("Dedupe window", value: "\(status.dedupeWindowMinutes) min")
                LabeledContent("Tokens", value: "\(status.tokens.active) active / \(status.tokens.total) total / \(status.tokens.revoked) revoked")
            } else {
                Text("Tap Refresh status after saving credentials.")
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
    }
}
