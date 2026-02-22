import Foundation
import FamilyControls
import DeviceActivity
import ManagedSettings

/// Manages Screen Time / DeviceActivity access.
///
/// DeviceActivity + FamilyControls enables:
/// - Monitoring which apps the user opens and how long they're used
/// - Tracking Safari web domains visited
/// - Setting up schedules to observe usage in time windows
/// - Reading usage reports without requiring MDM
///
/// NOTE: FamilyControls requires the "Family Controls" capability in the
/// entitlements file AND Apple approval for distribution (request access
/// via https://developer.apple.com/contact/request/family-controls-distribution).
/// During development, the Personal (individual) authorization works on device.
class ScreenTimeManager: ObservableObject {
    @Published var authorized = false

    /// Selected apps/categories/web domains to monitor.
    /// In a real implementation, this would be populated from a FamilyActivityPicker.
    @Published var selectedApps: FamilyActivitySelection = .init()

    private let center = DeviceActivityCenter()

    // MARK: - Authorization

    /// Requests FamilyControls authorization (individual/personal mode).
    /// This prompts the user to allow Screen Time data access.
    func requestAuthorization() async {
        do {
            try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
            await MainActor.run { self.authorized = true }
        } catch {
            print("[ScreenTime] Authorization failed: \(error.localizedDescription)")
            await MainActor.run { self.authorized = false }
        }
    }

    // MARK: - Activity Monitoring

    /// Starts monitoring a DeviceActivity schedule.
    /// The system will call your DeviceActivityMonitor extension at interval boundaries.
    ///
    /// To receive callbacks, you'll need a DeviceActivityMonitor app extension target
    /// that subclasses DeviceActivityMonitor and overrides:
    ///   - intervalDidStart(for:)
    ///   - intervalDidEnd(for:)
    ///   - eventDidReachThreshold(_:activity:)
    func startMonitoring() {
        let schedule = DeviceActivitySchedule(
            intervalStart: DateComponents(hour: 0, minute: 0),   // midnight
            intervalEnd: DateComponents(hour: 23, minute: 59),    // end of day
            repeats: true
        )

        do {
            try center.startMonitoring(
                .init("com.egg.companion.daily"),
                during: schedule
            )
            print("[ScreenTime] Monitoring started")
        } catch {
            print("[ScreenTime] Failed to start monitoring: \(error.localizedDescription)")
        }
    }

    /// Stops all active monitoring schedules.
    func stopMonitoring() {
        center.stopMonitoring()
        print("[ScreenTime] Monitoring stopped")
    }

    // MARK: - Data Export (stub)

    /// Returns a summary of tracked app/domain usage.
    /// In production this would read from the DeviceActivityReport or
    /// a shared App Group container written to by the monitor extension.
    func exportUsageData() async -> [[String: Any]] {
        // TODO: Implement once DeviceActivityMonitor extension is added.
        // The monitor extension writes usage events to shared storage,
        // and this method reads + formats them for sync.
        return [
            [
                "type": "screen_time_stub",
                "note": "DeviceActivityMonitor extension required for real data",
                "timestamp": ISO8601DateFormatter().string(from: Date()),
            ]
        ]
    }
}
