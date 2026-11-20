import CoreGraphics
import Foundation
import XCTest
import CGVirtualDisplayRuntime
@testable import CodelyncDesktopHostCore

@MainActor
final class MockVirtualDisplayHandle: VirtualDisplayInstance {
    let displayID: CGDirectDisplayID
    var applyModesResult: Bool = true
    private(set) var appliedModeLists: [[CLVirtualDisplayModeSpec]] = []
    private(set) var appliedHiDPIFlags: [Bool] = []
    private(set) var destroyCount = 0
    var onDestroy: (() -> Void)?

    init(displayID: CGDirectDisplayID) {
        self.displayID = displayID
    }

    func applyModes(_ modes: [CLVirtualDisplayModeSpec], hiDPI: Bool) -> Bool {
        appliedModeLists.append(modes)
        appliedHiDPIFlags.append(hiDPI)
        return applyModesResult
    }

    func destroy() {
        destroyCount += 1
        onDestroy?()
    }
}

@MainActor
final class MockVirtualDisplayProviderImpl: VirtualDisplayProviding {
    var isSupported: Bool
    var createBehavior: (String, CLVirtualDisplayDescriptorSpec, [CLVirtualDisplayModeSpec], Bool) -> MockVirtualDisplayHandle?
    private(set) var createCalls: [(name: String, spec: CLVirtualDisplayDescriptorSpec, modes: [CLVirtualDisplayModeSpec], hiDPI: Bool)] = []

    init(
        isSupported: Bool = true,
        createBehavior: @escaping (String, CLVirtualDisplayDescriptorSpec, [CLVirtualDisplayModeSpec], Bool) -> MockVirtualDisplayHandle? = { _, spec, _, _ in
            MockVirtualDisplayHandle(displayID: 5_000 + (spec.serialNum % 10))
        }
    ) {
        self.isSupported = isSupported
        self.createBehavior = createBehavior
    }

    func createDisplay(
        name: String,
        spec: CLVirtualDisplayDescriptorSpec,
        modes: [CLVirtualDisplayModeSpec],
        hiDPI: Bool,
        onTermination: (@Sendable () -> Void)?
    ) -> (any VirtualDisplayInstance)? {
        createCalls.append((name: name, spec: spec, modes: modes, hiDPI: hiDPI))
        guard isSupported else { return nil }
        return createBehavior(name, spec, modes, hiDPI)
    }
}

final class RuntimeAndLadderTests: XCTestCase {
    func testLiveObjCRuntimeCapabilityProbeAndNegativeFallbacks() {
        XCTAssertTrue(CLVirtualDisplayRuntimeIsSupported())
        XCTAssertTrue(CLVirtualDisplayRuntimeProbeClassNames(
            "CGVirtualDisplay",
            "CGVirtualDisplayDescriptor",
            "CGVirtualDisplaySettings",
            "CGVirtualDisplayMode"
        ))

        // Missing classes must return false cleanly without crashing.
        XCTAssertFalse(CLVirtualDisplayRuntimeProbeClassNames(
            "CLNonExistentVirtualDisplay",
            "CGVirtualDisplayDescriptor",
            "CGVirtualDisplaySettings",
            "CGVirtualDisplayMode"
        ))
        XCTAssertFalse(CLVirtualDisplayRuntimeProbeClassNames(
            "CGVirtualDisplay",
            "CLNonExistentDescriptor",
            "CGVirtualDisplaySettings",
            "CGVirtualDisplayMode"
        ))
        XCTAssertFalse(CLVirtualDisplayRuntimeProbeClassNames("", "", "", ""))

        // Existing class ("NSObject") lacking required selectors must fail closed in every slot.
        XCTAssertFalse(CLVirtualDisplayRuntimeProbeClassNames(
            "NSObject",
            "CGVirtualDisplayDescriptor",
            "CGVirtualDisplaySettings",
            "CGVirtualDisplayMode"
        ))
        XCTAssertFalse(CLVirtualDisplayRuntimeProbeClassNames(
            "CGVirtualDisplay",
            "NSObject",
            "CGVirtualDisplaySettings",
            "CGVirtualDisplayMode"
        ))
        XCTAssertFalse(CLVirtualDisplayRuntimeProbeClassNames(
            "CGVirtualDisplay",
            "CGVirtualDisplayDescriptor",
            "NSObject",
            "CGVirtualDisplayMode"
        ))
        XCTAssertFalse(CLVirtualDisplayRuntimeProbeClassNames(
            "CGVirtualDisplay",
            "CGVirtualDisplayDescriptor",
            "CGVirtualDisplaySettings",
            "NSObject"
        ))
    }

    func testPortraitModeLadderAcrossEdgeRatiosAndHardwareBounds() {
        // Ratio 1.0 (square foldable): smallest step >= 540 with height >= 800 is 800x800.
        let square = PortraitModeLadder(viewport: DesktopViewport(width: 540, height: 540))
        XCTAssertEqual(square.clampedRatio, 1.0, accuracy: 1e-9)
        XCTAssertEqual(square.baseWidth, 800)
        XCTAssertEqual(square.baseHeight, 800)
        XCTAssertEqual(square.steps.count, 29)
        XCTAssertEqual(square.steps.last, PortraitModeStep(logicalWidth: 1080, logicalHeight: 1080))

        // Ratio 1.33: 600 * 1.33 = 798 < 800, 610 * 1.33 = 811 >= 800.
        let r133 = PortraitModeLadder(viewport: DesktopViewport(width: 100, height: 133))
        XCTAssertEqual(r133.baseWidth, 610)
        XCTAssertEqual(r133.baseHeight, 811)
        XCTAssertEqual(r133.steps.last, PortraitModeStep(logicalWidth: 1080, logicalHeight: 1436))

        // Ratio 1.48 threshold: 540 * 1.48 = 799.2 -> 799 < 800, 550 * 1.48 = 814 >= 800.
        let r148 = PortraitModeLadder(viewport: DesktopViewport(width: 500, height: 740))
        XCTAssertEqual(r148.baseWidth, 550)
        XCTAssertEqual(r148.baseHeight, 814)

        // Ratio ~1.9338 (393x760 safe-area): baseWidth = 540, baseHeight = 1044.
        let r193 = PortraitModeLadder(viewport: DesktopViewport(width: 393, height: 760))
        XCTAssertEqual(r193.baseWidth, 540)
        XCTAssertEqual(r193.baseHeight, 1044)
        XCTAssertEqual(r193.steps.count, 55)

        // Default 2.0 (540x1080): 55 steps 540..1080 step 10.
        let r200 = PortraitModeLadder(viewport: .defaultPortrait)
        XCTAssertEqual(r200.baseWidth, 540)
        XCTAssertEqual(r200.baseHeight, 1080)
        XCTAssertEqual(r200.steps.count, 55)
        XCTAssertEqual(r200.steps.last, PortraitModeStep(logicalWidth: 1080, logicalHeight: 2160))

        // Ratio 2.15 (400x860): baseWidth = 540, baseHeight = 1161.
        let r215 = PortraitModeLadder(viewport: DesktopViewport(width: 400, height: 860))
        XCTAssertEqual(r215.baseWidth, 540)
        XCTAssertEqual(r215.baseHeight, 1161)

        // Ratio > 2.5 clamps to 2.5: widest mode 1080x2700 -> 2160x5400 backing pixels.
        let clampedTall = PortraitModeLadder(viewport: DesktopViewport(width: 100, height: 10_000))
        XCTAssertEqual(clampedTall.clampedRatio, 2.5, accuracy: 1e-9)
        XCTAssertEqual(clampedTall.baseWidth, 540)
        XCTAssertEqual(clampedTall.baseHeight, 1350)
        XCTAssertEqual(clampedTall.steps.last, PortraitModeStep(logicalWidth: 1080, logicalHeight: 2700))

        // Raw ratio < 1.0 clamps to 1.0.
        let clampedWide = PortraitModeLadder(rawRatio: 0.4)
        XCTAssertEqual(clampedWide.clampedRatio, 1.0, accuracy: 1e-9)
        XCTAssertEqual(clampedWide.baseWidth, 800)

        // Verify 2x backing pixels fit maxPixels (2160x5400) across all ratios and ~220 PPI mm sizing.
        for ladder in [square, r133, r148, r193, r200, r215, clampedTall] {
            for step in ladder.steps {
                XCTAssertGreaterThanOrEqual(step.logicalWidth, 540)
                XCTAssertGreaterThanOrEqual(step.logicalHeight, 800)
                XCTAssertLessThanOrEqual(UInt32(step.pixelWidth), VirtualDisplayHardwareSpec.maxPixelsWide)
                XCTAssertLessThanOrEqual(UInt32(step.pixelHeight), VirtualDisplayHardwareSpec.maxPixelsHigh)
                XCTAssertEqual(step.modeSpec.refreshRate, 60.0)
            }
        }

        let mm = VirtualDisplayHardwareSpec.sizeInMillimeters
        XCTAssertEqual(mm.width, 2160.0 / 220.0 * 25.4, accuracy: 1e-6)
        XCTAssertEqual(mm.height, 5400.0 / 220.0 * 25.4, accuracy: 1e-6)
        XCTAssertGreaterThan(mm.width, 240.0) // Explicitly ~220 PPI (~249.38mm), never ~460 PPI (~119mm)
        XCTAssertEqual(VirtualDisplayHardwareSpec.vendorID, 0x434C)
        XCTAssertEqual(VirtualDisplayHardwareSpec.productID, 0x00F0)
        XCTAssertEqual(VirtualDisplayHardwareSpec.serialPool, [200_000_201, 200_000_202, 200_000_203])
    }

    @MainActor
    func testCoordinatorSerialFallbackInPlaceUpdateUpshiftAndMinimumLifetime() async throws {
        var fakeNow = ContinuousClock.now
        var sleepLog: [Duration] = []
        var onlineIDs: Set<CGDirectDisplayID> = []
        var switchedModes: [(CGDirectDisplayID, Int, Int)] = []
        var createdHandles: [UInt32: MockVirtualDisplayHandle] = [:]

        let provider = MockVirtualDisplayProviderImpl(isSupported: true) { _, spec, _, _ in
            // Serial 1 returns nil; Serial 2 creates display 5002 that never comes online; Serial 3 creates 5003 online.
            if spec.serialNum == 200_000_201 {
                return nil
            }
            let id: CGDirectDisplayID = spec.serialNum == 200_000_202 ? 5002 : 5003
            let handle = MockVirtualDisplayHandle(displayID: id)
            handle.onDestroy = {
                onlineIDs.remove(id)
            }
            if id == 5003 {
                onlineIDs.insert(id)
            }
            createdHandles[spec.serialNum] = handle
            return handle
        }

        let protectorEnv = PhysicalDisplayEnvironment(
            onlineDisplayIDs: { Array(onlineIDs) },
            vendorID: { id in id >= 5000 ? 0x434C : 0x0610 },
            modelID: { id in id >= 5000 ? 0x00F0 : 0xA034 },
            isAsleep: { _ in false },
            currentMode: { _ in nil },
            now: { fakeNow },
            sleep: { d in sleepLog.append(d); fakeNow += d },
            runRestoreSubprocess: { _, _ in .exited(0) },
            observeScreensDidWake: false,
            offlinePollTimeoutNormal: .milliseconds(50),
            offlinePollTimeoutShutdown: .milliseconds(50),
            offlinePollInterval: .milliseconds(10),
            topologySettleNormal: .zero,
            topologySettleShutdown: .zero,
            wakeSettleDelay: .zero
        )
        let protector = PhysicalDisplayModeProtector(stateDir: nil, environment: protectorEnv)

        let coordEnv = VirtualDisplayEnvironment(
            now: { fakeNow },
            sleep: { d in sleepLog.append(d); fakeNow += d },
            isDisplayOnline: { id in onlineIDs.contains(id) },
            switchMode: { id, w, h in
                switchedModes.append((id, w, h))
                return true
            },
            waitForModeConvergence: { _, _, _ in true },
            onlinePollTimeout: .milliseconds(100),
            onlinePollInterval: .milliseconds(25),
            onlineSettleDelay: .zero
        )
        let coordinator = VirtualDisplayCoordinator(provider: provider, protector: protector, environment: coordEnv)

        let mounted = try await coordinator.mountOrUpdate(viewport: DesktopViewport(width: 540, height: 1080))
        XCTAssertEqual(mounted.displayID, 5003)
        XCTAssertEqual(mounted.logicalWidth, 540)
        XCTAssertEqual(mounted.logicalHeight, 1080)
        XCTAssertEqual(provider.createCalls.map(\.spec.serialNum), [200_000_201, 200_000_202, 200_000_203])
        // Serial 2 failed online poll after 100ms, so coordinator enforced remaining 2400ms before destroying 5002!
        XCTAssertEqual(createdHandles[200_000_202]?.destroyCount, 1)
        XCTAssertTrue(sleepLog.contains(.milliseconds(2400)))
        XCTAssertEqual(switchedModes.count, 1)
        XCTAssertEqual(switchedModes[0].0, 5003)
        XCTAssertEqual(switchedModes[0].1, 540)
        XCTAssertEqual(switchedModes[0].2, 1080)

        // Live in-place ratio update reuses 5003 via applyModes + --set-mode without burning a serial!
        let createCountBeforeUpdate = provider.createCalls.count
        let updated = try await coordinator.mountOrUpdate(viewport: DesktopViewport(width: 393, height: 760))
        XCTAssertEqual(provider.createCalls.count, createCountBeforeUpdate)
        XCTAssertEqual(updated.displayID, 5003)
        XCTAssertEqual(updated.logicalWidth, 540)
        XCTAssertEqual(updated.logicalHeight, 1044)
        XCTAssertEqual(createdHandles[200_000_203]?.appliedModeLists.count, 1)

        // M3 seam: upshiftWidth(to: 725) picks 730pt step.
        let upshifted = try await coordinator.upshiftWidth(to: 725)
        XCTAssertEqual(upshifted.logicalWidth, 730)
        XCTAssertEqual(coordinator.currentLogicalSize?.width, 730)

        // Advance fake clock by 700ms since 5003 creation; teardown must sleep remaining 1800ms before destroy!
        sleepLog.removeAll()
        fakeNow += .milliseconds(700)
        await coordinator.teardownAndRestorePhysicalDisplays(isShuttingDown: false)
        XCTAssertEqual(sleepLog, [.milliseconds(1800)])
        XCTAssertEqual(createdHandles[200_000_203]?.destroyCount, 1)
        XCTAssertNil(coordinator.activeVirtualDisplayID)
    }

    @MainActor
    func testCoordinatorThrowsWhenUnsupportedOrAllThreeSerialsFail() async {
        let unsupportedProvider = MockVirtualDisplayProviderImpl(isSupported: false)
        let mockProtectorEnv = PhysicalDisplayEnvironment(
            onlineDisplayIDs: { [] },
            vendorID: { _ in 0 },
            modelID: { _ in 0 },
            isAsleep: { _ in false },
            currentMode: { _ in nil },
            now: { ContinuousClock.now },
            sleep: { _ in },
            runRestoreSubprocess: { _, _ in .exited(0) },
            observeScreensDidWake: false,
            offlinePollTimeoutNormal: .zero,
            offlinePollTimeoutShutdown: .zero,
            offlinePollInterval: .milliseconds(10),
            topologySettleNormal: .zero,
            topologySettleShutdown: .zero,
            wakeSettleDelay: .zero
        )
        let protector = PhysicalDisplayModeProtector(stateDir: nil, environment: mockProtectorEnv)
        let mockCoordEnv = VirtualDisplayEnvironment(
            now: { ContinuousClock.now },
            sleep: { _ in },
            isDisplayOnline: { _ in false },
            switchMode: { _, _, _ in false },
            waitForModeConvergence: { _, _, _ in false },
            onlinePollTimeout: .milliseconds(10),
            onlinePollInterval: .milliseconds(5),
            onlineSettleDelay: .zero
        )
        let unsupportedCoordinator = VirtualDisplayCoordinator(
            provider: unsupportedProvider,
            protector: protector,
            environment: mockCoordEnv
        )

        do {
            _ = try await unsupportedCoordinator.mountOrUpdate(viewport: .defaultPortrait)
            XCTFail("Expected desktop-virtual-display-unavailable")
        } catch let error as DesktopFailure {
            XCTAssertEqual(error, .code("desktop-virtual-display-unavailable"))
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
        XCTAssertTrue(unsupportedProvider.createCalls.isEmpty)

        // Supported == true, but all 3 serials fail creation.
        let failingProvider = MockVirtualDisplayProviderImpl(isSupported: true) { _, _, _, _ in nil }
        let failingCoordinator = VirtualDisplayCoordinator(
            provider: failingProvider,
            protector: protector,
            environment: mockCoordEnv
        )
        do {
            _ = try await failingCoordinator.mountOrUpdate(viewport: .defaultPortrait)
            XCTFail("Expected desktop-virtual-display-unavailable")
        } catch let error as DesktopFailure {
            XCTAssertEqual(error, .code("desktop-virtual-display-unavailable"))
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
        XCTAssertEqual(failingProvider.createCalls.map(\.spec.serialNum), [200_000_201, 200_000_202, 200_000_203])
    }
}
