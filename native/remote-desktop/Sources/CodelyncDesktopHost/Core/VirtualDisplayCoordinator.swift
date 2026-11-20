import CoreGraphics
import Foundation
import CGVirtualDisplayRuntime

enum VirtualDisplayHardwareSpec {
    static let displayName = "Phone Screen"
    static let vendorID: UInt32 = 0x434C
    static let productID: UInt32 = 0x00F0
    static let serialPool: [UInt32] = [200_000_201, 200_000_202, 200_000_203]
    static let maxPixelsWide: UInt32 = 2160
    static let maxPixelsHigh: UInt32 = 5400
    static let referencePPI: Double = 220.0
    static let millimetersPerInch: Double = 25.4
    static let refreshRate: Double = 60.0
    static let minimumLifetime: Duration = .milliseconds(2500)

    static var sizeInMillimeters: CGSize {
        CGSize(
            width: Double(maxPixelsWide) / referencePPI * millimetersPerInch,
            height: Double(maxPixelsHigh) / referencePPI * millimetersPerInch
        )
    }

    static func descriptorSpec(serialNum: UInt32) -> CLVirtualDisplayDescriptorSpec {
        CLVirtualDisplayDescriptorSpec(
            maxPixelsWide: maxPixelsWide,
            maxPixelsHigh: maxPixelsHigh,
            sizeInMillimeters: sizeInMillimeters,
            vendorID: vendorID,
            productID: productID,
            serialNum: serialNum
        )
    }
}

@MainActor
protocol VirtualDisplayInstance: AnyObject {
    var displayID: CGDirectDisplayID { get }
    func applyModes(_ modes: [CLVirtualDisplayModeSpec], hiDPI: Bool) -> Bool
    func destroy()
}

@MainActor
protocol VirtualDisplayProviding: AnyObject {
    var isSupported: Bool { get }
    func createDisplay(
        name: String,
        spec: CLVirtualDisplayDescriptorSpec,
        modes: [CLVirtualDisplayModeSpec],
        hiDPI: Bool,
        onTermination: (@Sendable () -> Void)?
    ) -> (any VirtualDisplayInstance)?
}

@MainActor
final class LiveVirtualDisplayInstance: VirtualDisplayInstance {
    private let handle: CLVirtualDisplayHandle
    private(set) var isDestroyed = false

    init(handle: CLVirtualDisplayHandle) {
        self.handle = handle
    }

    var displayID: CGDirectDisplayID { handle.displayID }

    func applyModes(_ modes: [CLVirtualDisplayModeSpec], hiDPI: Bool) -> Bool {
        guard !isDestroyed, !modes.isEmpty else { return false }
        return autoreleasepool {
            modes.withUnsafeBufferPointer { buffer in
                handle.applyModes(buffer.baseAddress, modeCount: UInt(buffer.count), hiDPI: hiDPI)
            }
        }
    }

    func destroy() {
        guard !isDestroyed else { return }
        isDestroyed = true
        autoreleasepool {
            handle.destroy()
        }
    }
}

@MainActor
final class LiveCGVirtualDisplayProvider: VirtualDisplayProviding {
    var isSupported: Bool {
        CLVirtualDisplayRuntimeIsSupported()
    }

    func createDisplay(
        name: String,
        spec: CLVirtualDisplayDescriptorSpec,
        modes: [CLVirtualDisplayModeSpec],
        hiDPI: Bool,
        onTermination: (@Sendable () -> Void)?
    ) -> (any VirtualDisplayInstance)? {
        guard isSupported, !modes.isEmpty else { return nil }
        return autoreleasepool {
            let handle: CLVirtualDisplayHandle? = modes.withUnsafeBufferPointer { buffer in
                CLVirtualDisplayHandle.create(
                    withName: name,
                    descriptorSpec: spec,
                    modes: buffer.baseAddress,
                    modeCount: UInt(buffer.count),
                    hiDPI: hiDPI,
                    queue: .main,
                    terminationHandler: onTermination
                )
            }
            guard let handle else { return nil }
            return LiveVirtualDisplayInstance(handle: handle)
        }
    }
}

@MainActor
struct VirtualDisplayEnvironment {
    var now: @MainActor () -> ContinuousClock.Instant
    var sleep: @MainActor (Duration) async -> Void
    var isDisplayOnline: @MainActor (CGDirectDisplayID) -> Bool
    var switchMode: @MainActor (CGDirectDisplayID, Int, Int) async -> Bool
    var waitForModeConvergence: @MainActor (CGDirectDisplayID, Int, Int) async -> Bool
    var onlinePollTimeout: Duration
    var onlinePollInterval: Duration
    var onlineSettleDelay: Duration

    static let live = VirtualDisplayEnvironment(
        now: { ContinuousClock.now },
        sleep: { duration in try? await Task.sleep(for: duration) },
        isDisplayOnline: { id in
            onlineDisplayIDs(maxDisplays: 32).contains(id)
        },
        switchMode: { displayID, logicalWidth, logicalHeight in
            let args = [
                "--set-mode",
                String(displayID),
                String(logicalWidth),
                String(logicalHeight)
            ]
            return await runHelperSubprocess(arguments: args, timeout: .seconds(10)).succeeded
        },
        waitForModeConvergence: { displayID, logicalWidth, logicalHeight in
            await waitForVirtualDisplayModeConvergence(
                displayID: displayID,
                logicalWidth: logicalWidth,
                logicalHeight: logicalHeight
            )
        },
        onlinePollTimeout: .seconds(6),
        onlinePollInterval: .milliseconds(50),
        onlineSettleDelay: .milliseconds(800)
    )
}

struct MountedVirtualDisplay: Equatable, Sendable {
    let displayID: CGDirectDisplayID
    let logicalWidth: Int
    let logicalHeight: Int
    let ladder: PortraitModeLadder
}

@MainActor
final class VirtualDisplayCoordinator {
    let provider: any VirtualDisplayProviding
    let protector: PhysicalDisplayModeProtector
    private let env: VirtualDisplayEnvironment

    private(set) var activeInstance: (any VirtualDisplayInstance)?
    private var activeInstanceToken: UInt64?
    private(set) var createdAt: ContinuousClock.Instant?
    private(set) var currentLadder: PortraitModeLadder?
    private(set) var currentLogicalSize: (width: Int, height: Int)?
    private(set) var nextSerialIndex: Int = 0
    private(set) var retiringDisplayIDs: Set<CGDirectDisplayID> = []
    private var nextInstanceToken: UInt64 = 0
    private var mountingAttempt: (id: UUID, token: UInt64, instance: any VirtualDisplayInstance, startedAt: ContinuousClock.Instant)?
    private var retiringInstances: [UInt64: (instance: any VirtualDisplayInstance, startedAt: ContinuousClock.Instant?)] = [:]
    private var destroyedInstanceTokens: Set<UInt64> = []
    private var suppressingTerminationCounts: [CGDirectDisplayID: Int] = [:]
    var onUnexpectedTermination: (@MainActor (CGDirectDisplayID) -> Void)?

    init(
        provider: any VirtualDisplayProviding = LiveCGVirtualDisplayProvider(),
        protector: PhysicalDisplayModeProtector,
        environment: VirtualDisplayEnvironment = .live
    ) {
        self.provider = provider
        self.protector = protector
        self.env = environment
        protector.activeVirtualDisplayIDProvider = { [weak self] in
            self?.activeVirtualDisplayID
        }
    }

    var isSupported: Bool {
        provider.isSupported
    }

    var activeVirtualDisplayID: CGDirectDisplayID? {
        activeInstance?.displayID
    }

    var currentLadderWidths: [Int] {
        currentLadder?.ladderWidths ?? []
    }

    func now() -> ContinuousClock.Instant {
        env.now()
    }

    func sleep(_ duration: Duration) async {
        await env.sleep(duration)
    }

    var allTrackedVirtualIDs: Set<CGDirectDisplayID> {
        var ids = retiringDisplayIDs
            .union(protector.retiringVirtualDisplayIDs)
        for entry in retiringInstances.values {
            ids.insert(entry.instance.displayID)
        }
        if let mounting = mountingAttempt {
            ids.insert(mounting.instance.displayID)
        }
        if let activeID = activeInstance?.displayID {
            ids.insert(activeID)
        }
        return ids
    }

    func isOwnedVirtualDisplay(_ id: CGDirectDisplayID, vendorID: UInt32, modelID: UInt32) -> Bool {
        if allTrackedVirtualIDs.contains(id) {
            return true
        }
        return vendorID == VirtualDisplayHardwareSpec.vendorID &&
            modelID == VirtualDisplayHardwareSpec.productID
    }

    func mountOrUpdate(viewport: DesktopViewport) async throws -> MountedVirtualDisplay {
        guard provider.isSupported else {
            throw DesktopFailure.code("desktop-virtual-display-unavailable")
        }

        let ladder = PortraitModeLadder(viewport: viewport)

        // Live in-place update when virtual display is already online: update settings & mode without burning a serial.
        if let instance = activeInstance {
            if env.isDisplayOnline(instance.displayID) {
                var inPlaceOK = true
                let ladderChanged = currentLadder != ladder
                if ladderChanged {
                    inPlaceOK = instance.applyModes(ladder.modeSpecs, hiDPI: true)
                    if inPlaceOK && env.onlineSettleDelay > .zero {
                        await env.sleep(env.onlineSettleDelay)
                    }
                }
                let sizeChanged = currentLogicalSize?.width != ladder.baseWidth ||
                    currentLogicalSize?.height != ladder.baseHeight
                if inPlaceOK && (ladderChanged || sizeChanged) {
                    inPlaceOK = await env.switchMode(instance.displayID, ladder.baseWidth, ladder.baseHeight)
                    if inPlaceOK {
                        _ = await env.waitForModeConvergence(instance.displayID, ladder.baseWidth, ladder.baseHeight)
                    }
                }
                if inPlaceOK && env.isDisplayOnline(instance.displayID) {
                    currentLadder = ladder
                    currentLogicalSize = (ladder.baseWidth, ladder.baseHeight)
                    await protector.restoreDriftedAfterMount(excludedVirtualIDs: allTrackedVirtualIDs)
                    return MountedVirtualDisplay(
                        displayID: instance.displayID,
                        logicalWidth: ladder.baseWidth,
                        logicalHeight: ladder.baseHeight,
                        ladder: ladder
                    )
                }
            }

            // Existing instance went stale or rejected in-place update: retire cleanly before fresh mount.
            let staleToken = activeInstanceToken ?? {
                nextInstanceToken += 1
                return nextInstanceToken
            }()
            activeInstance = nil
            activeInstanceToken = nil
            let staleStart = createdAt
            createdAt = nil
            currentLadder = nil
            currentLogicalSize = nil
            await destroyInstanceEnforcingMinimumLifetime(instance, token: staleToken, startedAt: staleStart)
            advanceSerialIndex()
        }

        protector.capturePreMountSnapshot(excludedVirtualIDs: allTrackedVirtualIDs)

        let poolCount = VirtualDisplayHardwareSpec.serialPool.count
        for _ in 0..<poolCount {
            let serial = VirtualDisplayHardwareSpec.serialPool[nextSerialIndex % poolCount]
            let spec = VirtualDisplayHardwareSpec.descriptorSpec(serialNum: serial)
            let attemptStart = env.now()

            final class DisplayIDCell: @unchecked Sendable {
                private let lock = NSLock()
                private var value: CGDirectDisplayID = kCGNullDirectDisplay
                func set(_ id: CGDirectDisplayID) { lock.withLock { value = id } }
                func get() -> CGDirectDisplayID { lock.withLock { value } }
            }
            let assignedIDCell = DisplayIDCell()
            guard let instance = provider.createDisplay(
                name: VirtualDisplayHardwareSpec.displayName,
                spec: spec,
                modes: ladder.modeSpecs,
                hiDPI: true,
                onTermination: { [weak self] in
                    Task { @MainActor in
                        guard let self else { return }
                        let terminatedID = assignedIDCell.get()
                        guard terminatedID != kCGNullDirectDisplay,
                              (self.suppressingTerminationCounts[terminatedID] ?? 0) == 0,
                              self.activeInstance?.displayID == terminatedID else { return }
                        self.onUnexpectedTermination?(terminatedID)
                    }
                }
            ) else {
                advanceSerialIndex()
                continue
            }
            assignedIDCell.set(instance.displayID)
            nextInstanceToken += 1
            let instanceToken = nextInstanceToken
            let attemptID = UUID()
            mountingAttempt = (id: attemptID, token: instanceToken, instance: instance, startedAt: attemptStart)

            let online = await pollUntilOnline(instance.displayID, deadline: attemptStart + env.onlinePollTimeout)
            guard mountingAttempt?.id == attemptID else {
                throw DesktopFailure.code("desktop-disconnected")
            }
            var mountedOK = false
            if online {
                if env.onlineSettleDelay > .zero {
                    await env.sleep(env.onlineSettleDelay)
                    guard mountingAttempt?.id == attemptID else {
                        throw DesktopFailure.code("desktop-disconnected")
                    }
                }
                if await env.switchMode(instance.displayID, ladder.baseWidth, ladder.baseHeight) {
                    guard mountingAttempt?.id == attemptID else {
                        throw DesktopFailure.code("desktop-disconnected")
                    }
                    _ = await env.waitForModeConvergence(instance.displayID, ladder.baseWidth, ladder.baseHeight)
                    guard mountingAttempt?.id == attemptID else {
                        throw DesktopFailure.code("desktop-disconnected")
                    }
                    mountedOK = env.isDisplayOnline(instance.displayID)
                } else if mountingAttempt?.id != attemptID {
                    throw DesktopFailure.code("desktop-disconnected")
                }
            }

            if mountedOK {
                mountingAttempt = nil
                activeInstance = instance
                activeInstanceToken = instanceToken
                createdAt = attemptStart
                currentLadder = ladder
                currentLogicalSize = (ladder.baseWidth, ladder.baseHeight)
                await protector.restoreDriftedAfterMount(excludedVirtualIDs: allTrackedVirtualIDs)
                return MountedVirtualDisplay(
                    displayID: instance.displayID,
                    logicalWidth: ladder.baseWidth,
                    logicalHeight: ladder.baseHeight,
                    ladder: ladder
                )
            }

            mountingAttempt = nil
            await destroyInstanceEnforcingMinimumLifetime(instance, token: instanceToken, startedAt: attemptStart)
            advanceSerialIndex()
        }

        if !retiringDisplayIDs.isEmpty || protector.hasPendingRestores {
            await protector.restoreAfterTeardown(retiringVirtualIDs: retiringDisplayIDs, isShuttingDown: false)
            pruneOfflineRetiringIDs()
        }
        throw DesktopFailure.code("desktop-virtual-display-unavailable")
    }

    @discardableResult
    func upshiftWidth(to targetWidth: Int) async throws -> MountedVirtualDisplay {
        guard let instance = activeInstance,
              let ladder = currentLadder,
              env.isDisplayOnline(instance.displayID) else {
            throw DesktopFailure.code("desktop-virtual-display-unavailable")
        }
        let step = ladder.stepForUpshift(minimumWidth: targetWidth)
        let sizeChanged = currentLogicalSize?.width != step.logicalWidth || currentLogicalSize?.height != step.logicalHeight
        if sizeChanged {
            guard await env.switchMode(instance.displayID, step.logicalWidth, step.logicalHeight) else {
                throw DesktopFailure.code("desktop-virtual-display-unavailable")
            }
            _ = await env.waitForModeConvergence(instance.displayID, step.logicalWidth, step.logicalHeight)
            guard env.isDisplayOnline(instance.displayID) else {
                throw DesktopFailure.code("desktop-virtual-display-unavailable")
            }
        }
        currentLogicalSize = (step.logicalWidth, step.logicalHeight)
        if sizeChanged {
            await protector.restoreDriftedAfterMount(excludedVirtualIDs: allTrackedVirtualIDs)
        }
        return MountedVirtualDisplay(
            displayID: instance.displayID,
            logicalWidth: step.logicalWidth,
            logicalHeight: step.logicalHeight,
            ladder: ladder
        )
    }

    func teardownAndRestorePhysicalDisplays(
        isShuttingDown: Bool = false,
        deadline: ContinuousClock.Instant? = nil
    ) async {
        await teardownAndRestorePhysicalDisplays(
            isShuttingDownProvider: { isShuttingDown },
            deadlineProvider: { deadline }
        )
    }

    func teardownAndRestorePhysicalDisplays(
        isShuttingDownProvider: @MainActor () -> Bool,
        deadlineProvider: @MainActor () -> ContinuousClock.Instant? = { nil }
    ) async {
        let pendingMount = mountingAttempt
        mountingAttempt = nil

        let pendingActive = activeInstance
        let pendingActiveToken = activeInstanceToken
        let pendingActiveStart = createdAt
        activeInstance = nil
        activeInstanceToken = nil
        createdAt = nil
        currentLadder = nil
        currentLogicalSize = nil

        let inFlightRetiring = retiringInstances.map { (token: $0.key, instance: $0.value.instance, startedAt: $0.value.startedAt) }
        var excluded = allTrackedVirtualIDs
        if let pendingMount {
            excluded.insert(pendingMount.instance.displayID)
        }
        if let pendingActive {
            excluded.insert(pendingActive.displayID)
        }
        for entry in inFlightRetiring {
            excluded.insert(entry.instance.displayID)
        }

        let hadInstancesToTearDown = pendingMount != nil || pendingActive != nil || !inFlightRetiring.isEmpty
        if hadInstancesToTearDown {
            protector.capturePreRetireSnapshot(excludedVirtualIDs: excluded)
            if let pendingMount {
                await destroyInstanceEnforcingMinimumLifetime(
                    pendingMount.instance,
                    token: pendingMount.token,
                    startedAt: pendingMount.startedAt,
                    deadline: deadlineProvider()
                )
            }
            if let pendingActive {
                let tok = pendingActiveToken ?? {
                    nextInstanceToken += 1
                    return nextInstanceToken
                }()
                await destroyInstanceEnforcingMinimumLifetime(
                    pendingActive,
                    token: tok,
                    startedAt: pendingActiveStart,
                    deadline: deadlineProvider()
                )
            }
            for entry in inFlightRetiring where !destroyedInstanceTokens.contains(entry.token) {
                await destroyInstanceEnforcingMinimumLifetime(
                    entry.instance,
                    token: entry.token,
                    startedAt: entry.startedAt,
                    deadline: deadlineProvider()
                )
            }
            await protector.restoreAfterTeardown(
                retiringVirtualIDs: retiringDisplayIDs,
                isShuttingDownProvider: isShuttingDownProvider,
                deadlineProvider: deadlineProvider
            )
            pruneOfflineRetiringIDs()
        } else if !retiringDisplayIDs.isEmpty || protector.hasPendingRestores {
            await protector.restoreAfterTeardown(
                retiringVirtualIDs: retiringDisplayIDs,
                isShuttingDownProvider: isShuttingDownProvider,
                deadlineProvider: deadlineProvider
            )
            pruneOfflineRetiringIDs()
        }
    }

    private func advanceSerialIndex() {
        nextSerialIndex = (nextSerialIndex + 1) % VirtualDisplayHardwareSpec.serialPool.count
    }

    private func pollUntilOnline(_ displayID: CGDirectDisplayID, deadline: ContinuousClock.Instant) async -> Bool {
        while true {
            if env.isDisplayOnline(displayID) {
                return true
            }
            if env.now() >= deadline {
                return false
            }
            await env.sleep(env.onlinePollInterval)
        }
    }

    private func destroyOnce(_ instance: any VirtualDisplayInstance, token: UInt64) {
        guard !destroyedInstanceTokens.contains(token) else { return }
        destroyedInstanceTokens.insert(token)
        retiringDisplayIDs.insert(instance.displayID)
        retiringInstances.removeValue(forKey: token)
        instance.destroy()
    }

    private func destroyInstanceEnforcingMinimumLifetime(
        _ instance: any VirtualDisplayInstance,
        token: UInt64,
        startedAt: ContinuousClock.Instant?,
        deadline: ContinuousClock.Instant? = nil
    ) async {
        guard !destroyedInstanceTokens.contains(token) else { return }

        let id = instance.displayID
        retiringDisplayIDs.insert(id)
        retiringInstances[token] = (instance: instance, startedAt: startedAt)
        suppressingTerminationCounts[id, default: 0] += 1
        defer {
            if let next = suppressingTerminationCounts[id], next > 1 {
                suppressingTerminationCounts[id] = next - 1
            } else {
                suppressingTerminationCounts.removeValue(forKey: id)
            }
        }

        if let startedAt {
            let now = env.now()
            let elapsed = startedAt.duration(to: now)
            if elapsed < VirtualDisplayHardwareSpec.minimumLifetime {
                var wait = VirtualDisplayHardwareSpec.minimumLifetime - elapsed
                if let deadline {
                    let remaining = max(.zero, now.duration(to: deadline))
                    if remaining < wait {
                        wait = remaining
                    }
                }
                if wait > .zero {
                    await env.sleep(wait)
                }
            }
        }
        destroyOnce(instance, token: token)
    }

    private func pruneOfflineRetiringIDs() {
        retiringDisplayIDs = retiringDisplayIDs.filter { env.isDisplayOnline($0) }
    }
}
