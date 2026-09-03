import SwiftUI

@main
struct EventGateApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var settings = AppSettings()
    @StateObject private var push = PushController.shared
    @StateObject private var auth = AuthController()
    @StateObject private var status = StatusController()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(settings)
                .environmentObject(push)
                .environmentObject(auth)
                .environmentObject(status)
                .preferredColorScheme(.dark)
        }
    }
}
