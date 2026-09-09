import SwiftUI

struct ActivityLogView: View {
    @EnvironmentObject private var activity: ActivityLogController

    var body: some View {
        Group {
            if activity.loading && activity.entries.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if activity.entries.isEmpty {
                VStack(spacing: 8) {
                    Text("No activity yet.")
                        .foregroundStyle(Color(red: 0.49, green: 0.54, blue: 0.60))
                    if let err = activity.lastError, !err.isEmpty {
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(Color(red: 0.89, green: 0.29, blue: 0.29))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(activity.entries) { entry in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(entry.message)
                                .font(.subheadline)
                                .foregroundStyle(Color.white)
                            Text(EssentialsFormat.formatActivityTs(entry.ts))
                                .font(.caption.monospaced())
                                .foregroundStyle(Color(red: 0.49, green: 0.54, blue: 0.60))
                        }
                        .listRowBackground(Color(red: 0.05, green: 0.06, blue: 0.09))
                        .onAppear {
                            if entry.id == activity.entries.last?.id {
                                Task { await activity.loadMore() }
                            }
                        }
                    }
                    if activity.loadingMore {
                        HStack {
                            Spacer()
                            ProgressView()
                            Spacer()
                        }
                        .listRowBackground(Color.clear)
                    }
                    if let err = activity.lastError, !err.isEmpty {
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(Color(red: 0.89, green: 0.29, blue: 0.29))
                            .listRowBackground(Color.clear)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(Color(red: 0.03, green: 0.035, blue: 0.047))
        .navigationTitle("Activity")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color(red: 0.05, green: 0.06, blue: 0.09), for: .navigationBar)
        .task { await activity.reload() }
        .refreshable { await activity.reload() }
    }
}
