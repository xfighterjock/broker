import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var push: PushController
    @EnvironmentObject private var auth: AuthController
    @EnvironmentObject private var status: StatusController

    var body: some View {
        Group {
            if auth.unlocked {
                NavigationStack {
                    EssentialsView()
                        .navigationTitle("Event Gate")
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                NavigationLink {
                                    SettingsView()
                                } label: {
                                    Image(systemName: "gearshape")
                                }
                                .accessibilityLabel("Settings")
                            }
                        }
                }
            } else {
                LoginView()
            }
        }
        .onAppear {
            auth.bind(settings: settings)
            status.bind(settings: settings, auth: auth)
            push.bind(settings: settings, auth: auth)
            push.refreshPermission()
            auth.restoreSessionOnLaunch()
            if auth.hasSession && auth.biometricEnabled && auth.canUseBiometrics && !auth.unlocked {
                Task { await auth.unlockWithBiometrics() }
            }
        }
        .onChange(of: auth.unlocked) { _, unlocked in
            if unlocked {
                status.startPolling()
                if push.autoRegister, push.fcmToken != nil {
                    Task { await push.registerNow() }
                }
            } else {
                status.stopPolling()
            }
        }
        .onChange(of: push.lastDeepLink) { _, route in
            guard let route, EssentialsFormat.wantsEssentials(route) else { return }
            if auth.hasSession && !auth.unlocked && auth.biometricEnabled {
                Task { await auth.unlockWithBiometrics() }
            }
        }
    }
}
