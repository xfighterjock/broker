import SwiftUI
import UIKit

@main
struct EventGateApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var settings = AppSettings()
    @StateObject private var push = PushController.shared
    @StateObject private var auth = AuthController()
    @StateObject private var status = StatusController()
    @StateObject private var activity = ActivityLogController()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(settings)
                .environmentObject(push)
                .environmentObject(auth)
                .environmentObject(status)
                .environmentObject(activity)
                .preferredColorScheme(.dark)
                .onAppear {
                    auth.bind(settings: settings)
                    status.bind(settings: settings, auth: auth)
                    activity.bind(settings: settings, auth: auth)
                    push.bind(settings: settings, auth: auth)
                }
                .task {
                    // First frame already showed login or last-session essentials.
                    // Do not share this task with Firebase — configure/attach must
                    // not serialize the first GET /api/status on the MainActor.
                    if auth.unlocked {
                        status.startPolling()
                    }
                }
                .task {
                    appDelegate.startFirebaseAfterFirstFrame(application: UIApplication.shared)
                }
        }
    }
}
