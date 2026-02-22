import SwiftUI

struct ContentView: View {
    @StateObject private var healthKit = HealthKitManager()
    @StateObject private var screenTime = ScreenTimeManager()
    @StateObject private var sync = EggSyncService()

    var body: some View {
        NavigationStack {
            List {
                // -- Status --
                Section("Status") {
                    Label("Egg Companion", systemImage: "egg")
                        .font(.headline)
                    Text("Bridge app for health & screen time data")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                // -- HealthKit --
                Section("HealthKit") {
                    ForEach(HealthKitManager.requestedTypes, id: \.self) { type in
                        Label(type, systemImage: "heart.fill")
                    }
                    Button("Request HealthKit Access") {
                        healthKit.requestAuthorization()
                    }
                    if healthKit.authorized {
                        Label("Authorized", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                        Button("Export Recent Data") {
                            Task { await healthKit.exportRecentData() }
                        }
                    }
                }

                // -- Screen Time --
                Section("Screen Time / DeviceActivity") {
                    Label("App usage monitoring", systemImage: "hourglass")
                    Label("Safari domain tracking", systemImage: "globe")
                    Button("Request Screen Time Access") {
                        Task { await screenTime.requestAuthorization() }
                    }
                    if screenTime.authorized {
                        Label("Authorized", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                }

                // -- Sync --
                Section("Sync") {
                    Label(sync.serverURL, systemImage: "server.rack")
                        .font(.caption)
                    Text("Last sync: \(sync.lastSync?.formatted() ?? "never")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Sync Now") {
                        Task { await sync.syncNow(healthKit: healthKit, screenTime: screenTime) }
                    }
                }
            }
            .navigationTitle("Egg")
        }
    }
}

#Preview {
    ContentView()
}
