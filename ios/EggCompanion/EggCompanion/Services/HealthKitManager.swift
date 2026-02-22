import Foundation
import HealthKit

/// Manages HealthKit authorization and data export.
///
/// Requested data types:
/// - Steps, distance, flights climbed (activity)
/// - Heart rate, resting heart rate, HRV (vitals)
/// - Blood oxygen (SpO2)
/// - Sleep analysis
/// - Active energy, basal energy (calories)
/// - Workouts
/// - Dietary energy, protein, carbs, fat (nutrition)
class HealthKitManager: ObservableObject {
    private let store = HKHealthStore()

    @Published var authorized = false

    // Human-readable list shown in the UI
    static let requestedTypes: [String] = [
        "Steps",
        "Distance (walking/running)",
        "Flights climbed",
        "Heart rate",
        "Resting heart rate",
        "Heart rate variability (HRV)",
        "Blood oxygen (SpO2)",
        "Sleep analysis",
        "Active energy burned",
        "Basal energy burned",
        "Workouts",
        "Dietary energy",
        "Dietary protein",
        "Dietary carbohydrates",
        "Dietary fat",
    ]

    // The actual HKObjectTypes we request read access for
    private var readTypes: Set<HKObjectType> {
        let quantityTypes: [HKQuantityTypeIdentifier] = [
            .stepCount,
            .distanceWalkingRunning,
            .flightsClimbed,
            .heartRate,
            .restingHeartRate,
            .heartRateVariabilitySDNN,
            .oxygenSaturation,
            .activeEnergyBurned,
            .basalEnergyBurned,
            .dietaryEnergyConsumed,
            .dietaryProtein,
            .dietaryCarbohydrates,
            .dietaryFatTotal,
        ]
        var types = Set<HKObjectType>(quantityTypes.compactMap { HKQuantityType.quantityType(forIdentifier: $0) })
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            types.insert(sleep)
        }
        types.insert(HKObjectType.workoutType())
        return types
    }

    // MARK: - Authorization

    func requestAuthorization() {
        guard HKHealthStore.isHealthDataAvailable() else { return }

        store.requestAuthorization(toShare: nil, read: readTypes) { [weak self] success, error in
            DispatchQueue.main.async {
                self?.authorized = success
            }
            if let error {
                print("[HealthKit] Authorization error: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Data Export

    /// Queries the last 24 hours of each quantity type and returns JSON-serializable dictionaries.
    func exportRecentData() async -> [[String: Any]] {
        let now = Date()
        let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: now)!
        let predicate = HKQuery.predicateForSamples(withStart: yesterday, end: now, options: .strictStartDate)

        var results: [[String: Any]] = []

        // Export quantity samples
        let quantityIDs: [(HKQuantityTypeIdentifier, String, HKUnit)] = [
            (.stepCount, "steps", .count()),
            (.distanceWalkingRunning, "distance_m", .meter()),
            (.flightsClimbed, "flights", .count()),
            (.heartRate, "heart_rate_bpm", HKUnit.count().unitDivided(by: .minute())),
            (.restingHeartRate, "resting_hr_bpm", HKUnit.count().unitDivided(by: .minute())),
            (.heartRateVariabilitySDNN, "hrv_ms", .secondUnit(with: .milli)),
            (.oxygenSaturation, "spo2_pct", .percent()),
            (.activeEnergyBurned, "active_kcal", .kilocalorie()),
            (.basalEnergyBurned, "basal_kcal", .kilocalorie()),
            (.dietaryEnergyConsumed, "dietary_kcal", .kilocalorie()),
            (.dietaryProtein, "protein_g", .gram()),
            (.dietaryCarbohydrates, "carbs_g", .gram()),
            (.dietaryFatTotal, "fat_g", .gram()),
        ]

        for (id, key, unit) in quantityIDs {
            guard let quantityType = HKQuantityType.quantityType(forIdentifier: id) else { continue }
            let samples = await querySamples(type: quantityType, predicate: predicate)
            let values = samples.compactMap { sample -> [String: Any]? in
                guard let q = sample as? HKQuantitySample else { return nil }
                return [
                    "type": key,
                    "value": q.quantity.doubleValue(for: unit),
                    "start": ISO8601DateFormatter().string(from: q.startDate),
                    "end": ISO8601DateFormatter().string(from: q.endDate),
                ]
            }
            results.append(contentsOf: values)
        }

        // Export sleep
        if let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            let sleepSamples = await querySamples(type: sleepType, predicate: predicate)
            let sleepValues = sleepSamples.compactMap { sample -> [String: Any]? in
                guard let cat = sample as? HKCategorySample else { return nil }
                return [
                    "type": "sleep",
                    "value": cat.value, // Maps to HKCategoryValueSleepAnalysis
                    "start": ISO8601DateFormatter().string(from: cat.startDate),
                    "end": ISO8601DateFormatter().string(from: cat.endDate),
                ]
            }
            results.append(contentsOf: sleepValues)
        }

        // Export workouts
        let workoutSamples = await querySamples(type: HKObjectType.workoutType(), predicate: predicate)
        let workoutValues = workoutSamples.compactMap { sample -> [String: Any]? in
            guard let w = sample as? HKWorkout else { return nil }
            return [
                "type": "workout",
                "activity": w.workoutActivityType.rawValue,
                "duration_min": w.duration / 60.0,
                "total_kcal": w.totalEnergyBurned?.doubleValue(for: .kilocalorie()) ?? 0,
                "start": ISO8601DateFormatter().string(from: w.startDate),
                "end": ISO8601DateFormatter().string(from: w.endDate),
            ]
        }
        results.append(contentsOf: workoutValues)

        return results
    }

    /// Convenience wrapper that turns an HKSampleQuery into async/await.
    private func querySamples(type: HKSampleType, predicate: NSPredicate) async -> [HKSample] {
        await withCheckedContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: type,
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)]
            ) { _, samples, _ in
                continuation.resume(returning: samples ?? [])
            }
            store.execute(query)
        }
    }
}
