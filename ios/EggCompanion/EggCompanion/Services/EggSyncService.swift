import Foundation

/// Syncs collected health and screen time data to the Egg server.
///
/// The sync payload is a JSON array of typed records (health samples,
/// screen time events, etc.) POSTed to the server endpoint.
/// The server-side intake is handled by `egg sense` commands.
class EggSyncService: ObservableObject {
    // TODO: Replace with actual server URL once the sync endpoint is built
    let serverURL = "http://localhost:3000/api/sense/ios"

    @Published var lastSync: Date?
    @Published var syncing = false

    // MARK: - Sync

    /// Collects data from all managers and POSTs to the Egg server.
    func syncNow(healthKit: HealthKitManager, screenTime: ScreenTimeManager) async {
        await MainActor.run { syncing = true }

        // Gather all data
        let healthData = await healthKit.exportRecentData()
        let screenData = await screenTime.exportUsageData()

        let payload: [String: Any] = [
            "device": UIDevice.current.name,
            "timestamp": ISO8601DateFormatter().string(from: Date()),
            "health": healthData,
            "screenTime": screenData,
        ]

        // Serialize to JSON
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
            print("[Sync] Failed to serialize payload")
            await MainActor.run { syncing = false }
            return
        }

        // POST to server
        guard let url = URL(string: serverURL) else {
            print("[Sync] Invalid server URL")
            await MainActor.run { syncing = false }
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse {
                print("[Sync] Server responded: \(http.statusCode)")
            }
            await MainActor.run {
                self.lastSync = Date()
                self.syncing = false
            }
        } catch {
            print("[Sync] Failed: \(error.localizedDescription)")
            await MainActor.run { syncing = false }
        }
    }
}
