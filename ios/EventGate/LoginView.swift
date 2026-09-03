import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var auth: AuthController

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://broker.logikmancer.com", text: $settings.baseURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    TextField("username", text: $auth.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.username)
                    SecureField("password", text: $auth.password)
                        .textContentType(.password)
                } header: {
                    Text("Event Gate")
                } footer: {
                    Text("Users-table login. Session token is stored in the Keychain. GATE ON/OFF is a separate control, not this password.")
                }

                Section {
                    Button("Sign in") {
                        Task { await auth.login() }
                    }
                    .disabled(auth.busy || auth.username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || auth.password.isEmpty)

                    if auth.hasSession && auth.biometricEnabled && auth.canUseBiometrics {
                        Button("Unlock with Face ID / Touch ID") {
                            Task { await auth.unlockWithBiometrics() }
                        }
                    }
                }

                if !auth.lastMessage.isEmpty {
                    Section {
                        Text(auth.lastMessage)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Sign in")
        }
    }
}
