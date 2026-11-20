import CoreGraphics
import Darwin
import Foundation
import XCTest
import CGVirtualDisplayRuntime
@testable import CodelyncDesktopHostCore

@MainActor
final class MockAccessibilityWindowDriver: AccessibilityWindowDriving {
    struct SimulatedWindow {
        var key: WindowKey
        var title: String
        var frame: CGRect
        var minSize: CGSize = CGSize(width: 100, height: 100)
        var isMinimized: Bool = false
        var isFullScreen: Bool = false
        var windowedFrameAfterFullScreenExit: CGRect?
        var layer: Int = 0
        var onScreen: Bool = true
        var zIndex: Int = 0
        var subroleStandard: Bool = true
        var lagAttemptsBeforeAcceptingMove: Int = 0
        var pendingMoveAttempts: Int = 0
        var readError: AXDriverError?
        var setMinimizedError: AXDriverError?
        var setFullScreenError: AXDriverError?
        var setSizeError: AXDriverError?
        var setPositionError: AXDriverError?
        var raiseError: AXDriverError?
        var vanishOnPlacementAttempt: Int?
        var placementCallCounter: Int = 0
    }

    var trusted = true
    var apps: [RunningAppSnapshot] = []
    var enumerateErrorByPID: [Int32: AXDriverError] = [:]
    var windowsByKey: [WindowKey: SimulatedWindow] = [:]
    var topology = ScreenTopologySnapshot(
        displays: [
            1: ScreenDisplayFrames(
                displayId: 1,
                frame: CGRect(x: 0, y: 0, width: 1920, height: 1080),
                visibleFrame: CGRect(x: 0, y: 50, width: 1920, height: 1005),
                isVirtual: false
            ),
            9_001: ScreenDisplayFrames(
                displayId: 9_001,
                frame: CGRect(x: 1920, y: 0, width: 540, height: 1080),
                visibleFrame: CGRect(x: 1920, y: 0, width: 540, height: 1055),
                isVirtual: true
            )
        ],
        primaryScreenHeight: 1080,
        primaryPhysicalDisplayId: 1
    )

    var callCount = 0
    var timeoutHistory: [Float] = []
    var mutationLog: [String] = []
    var sleepLogMs: [UInt64] = []
    var onMutation: ((String) -> Void)?
    var onSleepMs: ((UInt64) -> Void)?

    func isProcessTrusted() -> Bool {
        callCount += 1
        return trusted
    }

    func setMessagingTimeout(seconds: Float) {
        callCount += 1
        timeoutHistory.append(seconds)
    }

    func runningRegularApps() -> [RunningAppSnapshot] {
        callCount += 1
        return apps
    }

    func cgWindowSnapshot() -> (onScreenZOrder: [WindowKey: Int], allByKey: [WindowKey: CGWindowEntry]) {
        callCount += 1
        var onScreen: [WindowKey: Int] = [:]
        var all: [WindowKey: CGWindowEntry] = [:]
        let sorted = windowsByKey.values.sorted { $0.zIndex < $1.zIndex }
        for win in sorted {
            let entry = CGWindowEntry(
                key: win.key,
                bounds: win.frame,
                layer: win.layer,
                title: win.title,
                zIndex: win.zIndex
            )
            all[win.key] = entry
            if win.onScreen && !win.isMinimized && win.layer == 0 {
                onScreen[win.key] = win.zIndex
            }
        }
        return (onScreen, all)
    }

    func liveCGWindow(for key: WindowKey) -> CGWindowEntry? {
        callCount += 1
        guard let win = windowsByKey[key] else { return nil }
        return CGWindowEntry(
            key: win.key,
            bounds: win.frame,
            layer: win.layer,
            title: win.title,
            zIndex: win.zIndex
        )
    }

    func enumerateStandardWindows(
        for app: RunningAppSnapshot,
        cgSnapshot: [WindowKey: CGWindowEntry]
    ) throws -> [WindowCandidateSnapshot] {
        callCount += 1
        guard trusted else { throw AXDriverError.untrusted }
        if let err = enumerateErrorByPID[app.pid] {
            throw err
        }
        return windowsByKey.values
            .filter { $0.key.pid == app.pid && $0.subroleStandard }
            .sorted { $0.zIndex < $1.zIndex }
            .map {
                WindowCandidateSnapshot(
                    key: $0.key,
                    title: $0.title,
                    frame: $0.frame,
                    isMinimized: $0.isMinimized,
                    isFullScreen: $0.isFullScreen
                )
            }
    }

    func readWindowState(_ key: WindowKey) throws -> WindowLiveState {
        callCount += 1
        guard trusted else { throw AXDriverError.untrusted }
        guard let win = windowsByKey[key] else {
            throw AXDriverError.windowUnavailable
        }
        if let err = win.readError {
            throw err
        }
        return WindowLiveState(
            frame: win.frame,
            isMinimized: win.isMinimized,
            isFullScreen: win.isFullScreen,
            title: win.title
        )
    }

    func setMinimized(_ key: WindowKey, _ minimized: Bool) throws {
        callCount += 1
        let event = "setMinimized:\(key.rawId):\(minimized)"
        mutationLog.append(event)
        onMutation?(event)
        guard var win = windowsByKey[key] else { throw AXDriverError.windowUnavailable }
        if let err = win.setMinimizedError { throw err }
        win.isMinimized = minimized
        windowsByKey[key] = win
    }

    func setFullScreen(_ key: WindowKey, _ fullScreen: Bool) throws {
        callCount += 1
        let event = "setFullScreen:\(key.rawId):\(fullScreen)"
        mutationLog.append(event)
        onMutation?(event)
        guard var win = windowsByKey[key] else { throw AXDriverError.windowUnavailable }
        if let err = win.setFullScreenError { throw err }
        win.isFullScreen = fullScreen
        if !fullScreen, let revealed = win.windowedFrameAfterFullScreenExit {
            win.frame = revealed
        }
        windowsByKey[key] = win
    }

    func setSize(_ key: WindowKey, _ size: CGSize) throws {
        callCount += 1
        let event = "setSize:\(key.rawId):\(Int(size.width))x\(Int(size.height))"
        mutationLog.append(event)
        onMutation?(event)
        guard var win = windowsByKey[key] else { throw AXDriverError.windowUnavailable }
        if let err = win.setSizeError { throw err }
        guard !win.isMinimized else { return }
        if win.pendingMoveAttempts < win.lagAttemptsBeforeAcceptingMove {
            return
        }
        let clampedW = max(win.minSize.width, size.width)
        let clampedH = max(win.minSize.height, size.height)
        win.frame.size = CGSize(width: clampedW, height: clampedH)
        windowsByKey[key] = win
    }

    func setPosition(_ key: WindowKey, _ origin: CGPoint) throws {
        callCount += 1
        let event = "setPosition:\(key.rawId):\(Int(origin.x)),\(Int(origin.y))"
        mutationLog.append(event)
        onMutation?(event)
        guard var win = windowsByKey[key] else { throw AXDriverError.windowUnavailable }
        win.placementCallCounter += 1
        if let vanishAttempt = win.vanishOnPlacementAttempt, win.placementCallCounter >= vanishAttempt {
            windowsByKey.removeValue(forKey: key)
            throw AXDriverError.windowUnavailable
        }
        if let err = win.setPositionError {
            windowsByKey[key] = win
            throw err
        }
        guard !win.isMinimized else {
            windowsByKey[key] = win
            return
        }
        if win.pendingMoveAttempts < win.lagAttemptsBeforeAcceptingMove {
            win.pendingMoveAttempts += 1
            windowsByKey[key] = win
            return
        }
        win.frame.origin = origin
        windowsByKey[key] = win
    }

    func raiseAndActivate(_ key: WindowKey) throws {
        callCount += 1
        let event = "raiseAndActivate:\(key.rawId)"
        mutationLog.append(event)
        onMutation?(event)
        guard let win = windowsByKey[key] else { throw AXDriverError.windowUnavailable }
        if let err = win.raiseError { throw err }
    }

    func screenTopology(virtualDisplayId: CGDirectDisplayID?) -> ScreenTopologySnapshot {
        callCount += 1
        return topology
    }

    func sleep(milliseconds: UInt64) async {
        callCount += 1
        sleepLogMs.append(milliseconds)
        onSleepMs?(milliseconds)
    }
}

final class WindowCoordinatorTests: XCTestCase {
    private func makeTempStateDir() throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("cl-m3-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    @MainActor
    private func makeHostRig(
        stateDir: String?,
        physicalDisplays: [CGDirectDisplayID] = [1]
    ) -> (
        host: DesktopHost,
        driver: MockAccessibilityWindowDriver,
        coordinator: WindowCoordinator,
        displaySystem: MockDisplaySystemImpl,
        permissions: MockPermissionProviderImpl,
        captureFactory: MockCaptureFactoryImpl,
        roomFactory: MockMediaRoomFactoryImpl,
        advanceClock: (Duration) -> Void,
        nowValue: () -> ContinuousClock.Instant,
        packets: () -> [[String: Any]]
    ) {
        var fakeNow = ContinuousClock.now
        var emitted: [[String: Any]] = []
        let displaySystem = MockDisplaySystemImpl()
        for (idx, id) in physicalDisplays.enumerated() {
            displaySystem.entries[id] = .init(
                bounds: CGRect(x: CGFloat(idx * 1920), y: 0, width: 1920, height: 1080),
                pixels: (3840, 2160),
                vendorID: 0x0610,
                modelID: 0xA034,
                active: true,
                online: true,
                shareable: true
            )
        }

        let driver = MockAccessibilityWindowDriver()
        if physicalDisplays.isEmpty {
            driver.topology = ScreenTopologySnapshot(
                displays: [
                    9_001: ScreenDisplayFrames(
                        displayId: 9_001,
                        frame: CGRect(x: 0, y: 0, width: 540, height: 1080),
                        visibleFrame: CGRect(x: 0, y: 0, width: 540, height: 1055),
                        isVirtual: true
                    )
                ],
                primaryScreenHeight: 1080,
                primaryPhysicalDisplayId: nil
            )
        }

        driver.onSleepMs = { ms in
            fakeNow += .milliseconds(Int64(ms))
        }

        let provider = MockVirtualDisplayProviderImpl(isSupported: true) { _, _, _, _ in
            let vID: CGDirectDisplayID = 9_001
            let xOrigin: CGFloat = physicalDisplays.isEmpty ? 0 : 1920
            displaySystem.entries[vID] = .init(
                bounds: CGRect(x: xOrigin, y: 0, width: 540, height: 1080),
                pixels: (1080, 2160),
                vendorID: 0x434C,
                modelID: 0x00F0,
                active: true,
                online: true,
                shareable: true
            )
            let handle = MockVirtualDisplayHandle(displayID: vID)
            handle.onDestroy = {
                displaySystem.entries.removeValue(forKey: vID)
            }
            return handle
        }

        let protectorEnv = PhysicalDisplayEnvironment(
            onlineDisplayIDs: { displaySystem.entries.keys.sorted().filter { displaySystem.entries[$0]?.online == true } },
            vendorID: { id in displaySystem.vendorID(of: id) },
            modelID: { id in displaySystem.modelID(of: id) },
            isAsleep: { _ in false },
            currentMode: { _ in nil },
            now: { fakeNow },
            sleep: { d in fakeNow += d },
            runRestoreSubprocess: { _, _ in .exited(0) },
            observeScreensDidWake: false,
            offlinePollTimeoutNormal: .milliseconds(50),
            offlinePollTimeoutShutdown: .milliseconds(50),
            offlinePollInterval: .milliseconds(10),
            topologySettleNormal: .zero,
            topologySettleShutdown: .zero,
            wakeSettleDelay: .zero
        )
        let protector = PhysicalDisplayModeProtector(stateDir: stateDir, environment: protectorEnv)

        let coordEnv = VirtualDisplayEnvironment(
            now: { fakeNow },
            sleep: { d in fakeNow += d },
            isDisplayOnline: { id in displaySystem.isOnline(id) },
            switchMode: { id, w, h in
                let xOrigin: CGFloat = physicalDisplays.isEmpty ? 0 : 1920
                displaySystem.entries[id]?.bounds = CGRect(x: xOrigin, y: 0, width: CGFloat(w), height: CGFloat(h))
                displaySystem.entries[id]?.pixels = (w * 2, h * 2)
                var nextDisplays = driver.topology.displays
                nextDisplays[id] = ScreenDisplayFrames(
                    displayId: id,
                    frame: CGRect(x: xOrigin, y: 0, width: CGFloat(w), height: CGFloat(h)),
                    visibleFrame: CGRect(x: xOrigin, y: 0, width: CGFloat(w), height: CGFloat(h - 25)),
                    isVirtual: true
                )
                let nextPrimaryH: CGFloat = physicalDisplays.isEmpty ? CGFloat(h) : driver.topology.primaryScreenHeight
                driver.topology = ScreenTopologySnapshot(
                    displays: nextDisplays,
                    primaryScreenHeight: nextPrimaryH,
                    primaryPhysicalDisplayId: driver.topology.primaryPhysicalDisplayId
                )
                return true
            },
            waitForModeConvergence: { _, _, _ in true },
            onlinePollTimeout: .milliseconds(50),
            onlinePollInterval: .milliseconds(10),
            onlineSettleDelay: .zero
        )
        let virtualCoord = VirtualDisplayCoordinator(provider: provider, protector: protector, environment: coordEnv)
        let permissions = MockPermissionProviderImpl()
        let captureFactory = MockCaptureFactoryImpl()
        let roomFactory = MockMediaRoomFactoryImpl()
        let windowCoord = WindowCoordinator(stateDir: stateDir, driver: driver, nowProvider: { fakeNow })

        let host = DesktopHost(
            stateDir: stateDir,
            displaySystem: displaySystem,
            permissionProvider: permissions,
            inputSink: MockInputSinkImpl(),
            captureFactory: captureFactory,
            roomFactory: roomFactory,
            virtualDisplayCoordinator: virtualCoord,
            windowCoordinator: windowCoord,
            observeWorkspaceSpaces: false,
            outputEmitter: { emitted.append($0) }
        )

        return (
            host: host,
            driver: driver,
            coordinator: windowCoord,
            displaySystem: displaySystem,
            permissions: permissions,
            captureFactory: captureFactory,
            roomFactory: roomFactory,
            advanceClock: { d in fakeNow += d },
            nowValue: { fakeNow },
            packets: { emitted }
        )
    }

    @MainActor
    private func startVirtualSession(_ host: DesktopHost, viewport: [String: Int] = ["width": 540, "height": 1080]) async {
        await host.handle([
            "id": "start-v",
            "operation": "start",
            "displayId": "virtual",
            "viewport": viewport,
            "url": "ws://127.0.0.1:7880",
            "token": "tok",
            "key": String(repeating: "k", count: 32),
            "connectionId": "conn-m3",
            "viewer": "viewer-m3",
            "quality": ["width": 1920, "fps": 30]
        ])
    }

    // 1. Trust check on listWindows
    @MainActor
    func testListWindowsRequiresAccessibilityTrustThrows409Code() async throws {
        let rig = makeHostRig(stateDir: nil)
        await startVirtualSession(rig.host)

        rig.permissions.accessibility = false
        await rig.host.handle(["id": "w-untrusted-1", "operation": "windows", "connectionId": "conn-m3"])
        XCTAssertEqual(rig.packets().last?["ok"] as? Bool, false)
        XCTAssertEqual(rig.packets().last?["error"] as? String, "desktop-accessibility-required")

        rig.permissions.accessibility = true
        rig.driver.trusted = false
        await rig.host.handle(["id": "w-untrusted-2", "operation": "windows", "connectionId": "conn-m3"])
        XCTAssertEqual(rig.packets().last?["ok"] as? Bool, false)
        XCTAssertEqual(rig.packets().last?["error"] as? String, "desktop-accessibility-required")

        await rig.host.stop()
    }

    // 2. App filtering (non-regular, terminated, Codelync self/helper exclusion, hung single-app skip)
    @MainActor
    func testListWindowsFiltersNonRegularTerminatedAndCodelyncSelfApps() async throws {
        let rig = makeHostRig(stateDir: nil)
        let ownPID = ProcessInfo.processInfo.processIdentifier

        rig.driver.apps = [
            RunningAppSnapshot(pid: ownPID, bundleId: "com.example.Other", appName: "Other", executableName: "Other"),
            RunningAppSnapshot(pid: 2001, bundleId: "com.codelync.mac", appName: "Helper", executableName: "Helper"),
            RunningAppSnapshot(pid: 2002, bundleId: "ai.codelync.desktop", appName: "Agent", executableName: "Agent"),
            RunningAppSnapshot(pid: 2003, bundleId: "org.example.tool", appName: "Codelync Helper", executableName: "tool"),
            RunningAppSnapshot(pid: 2004, bundleId: "org.example.agent", appName: "Tool", executableName: "CodelyncDesktopHost"),
            RunningAppSnapshot(pid: 2005, bundleId: "com.apple.Spotlight", appName: "Spotlight", executableName: "Spotlight", isRegular: false),
            RunningAppSnapshot(pid: 2006, bundleId: "com.apple.Preview", appName: "Preview", executableName: "Preview", isTerminated: true),
            RunningAppSnapshot(pid: 2007, bundleId: "com.hung.App", appName: "HungApp", executableName: "HungApp"),
            RunningAppSnapshot(pid: 2008, bundleId: nil, appName: "CustomCLIUI", executableName: "custom-ui")
        ]
        rig.driver.enumerateErrorByPID[2007] = .timedOutOrUnresponsive

        for pid: Int32 in [ownPID, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008] {
            let key = WindowKey(pid: pid, windowId: UInt32(5000 + pid))
            rig.driver.windowsByKey[key] = .init(
                key: key,
                title: "Win-\(pid)",
                frame: CGRect(x: 100, y: 100, width: 800, height: 600),
                zIndex: Int(pid)
            )
        }
        // Zero-sized window and non-standard subrole must also be excluded.
        let zeroKey = WindowKey(pid: 2008, windowId: 9001)
        rig.driver.windowsByKey[zeroKey] = .init(key: zeroKey, title: "Zero", frame: CGRect(x: 10, y: 10, width: 0, height: 400), zIndex: 1)
        let sheetKey = WindowKey(pid: 2008, windowId: 9002)
        rig.driver.windowsByKey[sheetKey] = .init(key: sheetKey, title: "Sheet", frame: CGRect(x: 10, y: 10, width: 300, height: 200), zIndex: 2, subroleStandard: false)

        let response = try await rig.coordinator.listWindows()
        let windows = try XCTUnwrap(response["windows"] as? [[String: Any]])
        XCTAssertEqual(windows.count, 1)
        XCTAssertEqual(windows[0]["id"] as? String, "2008:7008")
        XCTAssertEqual(windows[0]["appName"] as? String, "CustomCLIUI")
        XCTAssertTrue(windows[0]["bundleId"] is NSNull)
        XCTAssertTrue(response["activeWindowId"] is NSNull)
        // Verify JSONSerialization succeeds cleanly with NSNull values.
        XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: response))
    }

    // 3. Z-order sorting & onVirtualDisplay computation
    @MainActor
    func testListWindowsSortsByCGWindowZOrderAndComputesOnVirtualDisplay() async throws {
        let rig = makeHostRig(stateDir: nil)
        await startVirtualSession(rig.host)

        rig.driver.apps = [
            RunningAppSnapshot(pid: 101, bundleId: "com.apple.Safari", appName: "Safari", executableName: "Safari"),
            RunningAppSnapshot(pid: 102, bundleId: "com.apple.Terminal", appName: "Terminal", executableName: "Terminal")
        ]
        let winBack = WindowKey(pid: 101, windowId: 301)
        let winFrontVirtual = WindowKey(pid: 102, windowId: 302)
        let winMinimized = WindowKey(pid: 101, windowId: 303)

        // Virtual screen 9001 is at x=1920..2460, y=0..1080 in AX coordinates.
        rig.driver.windowsByKey[winBack] = .init(
            key: winBack,
            title: "Docs",
            frame: CGRect(x: 100.4, y: 80.6, width: 1200.2, height: 799.8),
            zIndex: 5
        )
        rig.driver.windowsByKey[winFrontVirtual] = .init(
            key: winFrontVirtual,
            title: "Shell",
            frame: CGRect(x: 1920, y: 25, width: 540, height: 1055),
            zIndex: 0
        )
        rig.driver.windowsByKey[winMinimized] = .init(
            key: winMinimized,
            title: "Minimized Tab",
            frame: CGRect(x: 200, y: 200, width: 900, height: 600),
            isMinimized: true,
            onScreen: false,
            zIndex: 50
        )

        let res = try await rig.coordinator.listWindows()
        let items = try XCTUnwrap(res["windows"] as? [[String: Any]])
        XCTAssertEqual(items.map { $0["id"] as? String }, ["102:302", "101:301", "101:303"])
        XCTAssertEqual(items[0]["onVirtualDisplay"] as? Bool, true)
        XCTAssertEqual(items[1]["onVirtualDisplay"] as? Bool, false)
        XCTAssertEqual(items[2]["minimized"] as? Bool, true)
        let bounds1 = try XCTUnwrap(items[1]["bounds"] as? [String: Int])
        XCTAssertEqual(bounds1, ["x": 100, "y": 81, "width": 1200, "height": 800])

        await rig.host.stop()
    }

    // 4. Title sanitization (format scalars stripped, ZWJ \u{200D} preserved, <= 200 chars & scalars)
    @MainActor
    func testSanitizeTitleStripsFormatScalarsPreservesZWJAndTruncatesAt200() {
        XCTAssertEqual(WindowCoordinator.sanitizeWindowTitle(nil), "")

        // Bidi/format scalars (U+202E RLO, U+200B ZWSP, U+FEFF BOM) stripped, while U+200D ZWJ is preserved!
        let familyEmoji = "👨‍👩‍👧‍👦" // 7 scalars including three U+200D ZWJs, 1 Character
        let raw = "\u{FEFF}Project\u{200B}\u{202E}Alpha\r\nBeta\t\(familyEmoji)\u{0000}"
        let cleaned = WindowCoordinator.sanitizeWindowTitle(raw)
        XCTAssertEqual(cleaned, "ProjectAlpha Beta \(familyEmoji)")
        XCTAssertTrue(cleaned.unicodeScalars.contains("\u{200D}"))
        XCTAssertFalse(cleaned.unicodeScalars.contains("\u{202E}"))
        XCTAssertFalse(cleaned.unicodeScalars.contains("\u{200B}"))

        // 220 ASCII chars -> truncated to 200 chars & 200 scalars.
        let longASCII = String(repeating: "A", count: 220)
        let truncASCII = WindowCoordinator.sanitizeWindowTitle(longASCII)
        XCTAssertEqual(truncASCII.count, 200)
        XCTAssertEqual(truncASCII.unicodeScalars.count, 200)

        // Repeated multi-scalar ZWJ emoji clusters -> truncated without splitting clusters and <= 200 scalars!
        let manyZWJ = String(repeating: familyEmoji, count: 40) // 40 Characters, 280 Unicode scalars
        let truncZWJ = WindowCoordinator.sanitizeWindowTitle(manyZWJ)
        XCTAssertLessThanOrEqual(truncZWJ.count, 200)
        XCTAssertLessThanOrEqual(truncZWJ.unicodeScalars.count, 200)
        XCTAssertEqual(truncZWJ.count, 28) // 28 * 7 = 196 <= 200 scalars, whole grapheme clusters intact
        XCTAssertTrue(truncZWJ.allSatisfy { String($0) == familyEmoji })
    }

    // 5. AppKit visibleFrame -> AX top-left conversion (standard multi-monitor + headless Mac, zero 28pt subtraction)
    @MainActor
    func testAppKitVisibleFrameToAXTopLeftConversionStandardAndHeadlessMac() {
        // Primary 1920x1080 (origin 0,0); Virtual 540x1080 to the right with 25pt menu bar at top (AppKit visibleFrame height 1055, maxY 1055).
        let virtualVisible = CGRect(x: 1920, y: 0, width: 540, height: 1055)
        let axStandard = WindowCoordinator.appKitRectToAX(virtualVisible, primaryScreenHeight: 1080)
        XCTAssertEqual(axStandard, CGRect(x: 1920, y: 25, width: 540, height: 1055))

        // Virtual monitor positioned above primary (AppKit y = 1080, height = 1080, menu bar 30pt -> visibleFrame y=1080, height=1050, maxY=2130).
        let aboveVisible = CGRect(x: -200, y: 1080, width: 540, height: 1050)
        let axAbove = WindowCoordinator.appKitRectToAX(aboveVisible, primaryScreenHeight: 1080)
        XCTAssertEqual(axAbove, CGRect(x: -200, y: -1050, width: 540, height: 1050))

        // Headless Mac: virtual screen is the ONLY screen at AppKit origin (0,0), frame 540x1080, menu bar 24pt, Dock 40pt at bottom -> visibleFrame (0, 40, 540, 1016), maxY = 1056.
        let headlessVisible = CGRect(x: 0, y: 40, width: 540, height: 1016)
        let axHeadless = WindowCoordinator.appKitRectToAX(headlessVisible, primaryScreenHeight: 1080)
        XCTAssertEqual(axHeadless, CGRect(x: 0, y: 24, width: 540, height: 1016))
    }

    // 6. Write-ahead RestoreRecord persisted BEFORE first AX mutation
    @MainActor
    func testFillWindowPersistsWriteAheadRestoreRecordBeforeFirstAXMutation() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        let rig = makeHostRig(stateDir: stateURL.path)
        await startVirtualSession(rig.host)

        let key = WindowKey(pid: 1234, windowId: 5678)
        rig.driver.apps = [RunningAppSnapshot(pid: 1234, bundleId: "com.apple.dt.Xcode", appName: "Xcode", executableName: "Xcode")]
        rig.driver.windowsByKey[key] = .init(
            key: key,
            title: "Workspace.xcodeproj",
            frame: CGRect(x: 120, y: 90, width: 1280, height: 820)
        )

        let restorePath = stateURL.appendingPathComponent("window-restore.json").path
        var snapshotAtFirstMutation: RestoreStoreFile?
        rig.driver.onMutation = { _ in
            if snapshotAtFirstMutation == nil {
                snapshotAtFirstMutation = DurableJSONStore.loadOrQuarantine(RestoreStoreFile.self, from: restorePath)
            }
        }

        await rig.host.handle([
            "id": "fill-1",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 1,
            "mode": "fill",
            "windowId": "1234:5678"
        ])

        let reply = try XCTUnwrap(rig.packets().last)
        XCTAssertEqual(reply["ok"] as? Bool, true)
        let savedBeforeMutation = try XCTUnwrap(snapshotAtFirstMutation, "RestoreRecord MUST exist on disk before first AX mutation")
        XCTAssertEqual(savedBeforeMutation.version, 1)
        XCTAssertEqual(savedBeforeMutation.records.count, 1)
        XCTAssertEqual(savedBeforeMutation.records[0].pid, 1234)
        XCTAssertEqual(savedBeforeMutation.records[0].windowId, 5678)
        XCTAssertEqual(savedBeforeMutation.records[0].bundleId, "com.apple.dt.Xcode")
        XCTAssertEqual(savedBeforeMutation.records[0].originalFrame, RestoreFrame(x: 120, y: 90, width: 1280, height: 820))

        // Verify on-disk JSON schema keys & 0o600 permissions.
        var st = Darwin.stat()
        XCTAssertEqual(Darwin.lstat(restorePath, &st), 0)
        XCTAssertEqual(st.st_mode & 0o777, 0o600)
        let rawJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: restorePath))) as? [String: Any])
        XCTAssertEqual(rawJSON["version"] as? Int, 1)
        let rawRecords = try XCTUnwrap(rawJSON["records"] as? [[String: Any]])
        let rawFrame = try XCTUnwrap(rawRecords.first?["originalFrame"] as? [String: Double])
        XCTAssertEqual(rawFrame["width"], 1280)

        await rig.host.stop()
    }

    // 7. Missing or unwritable stateDir aborts with 409 desktop-restore-persist-failed BEFORE mutating window
    @MainActor
    func testFillWindowAbortsWithRestorePersistFailedWhenStateDirMissingOrUnwritable() async throws {
        // Case A: stateDir == nil
        let nilRig = makeHostRig(stateDir: nil)
        await startVirtualSession(nilRig.host)
        let key = WindowKey(pid: 1234, windowId: 5678)
        nilRig.driver.apps = [RunningAppSnapshot(pid: 1234, bundleId: "com.apple.TextEdit", appName: "TextEdit", executableName: "TextEdit")]
        nilRig.driver.windowsByKey[key] = .init(key: key, title: "Note", frame: CGRect(x: 50, y: 60, width: 700, height: 500))

        await nilRig.host.handle([
            "id": "fill-nil",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": nilRig.host.geometry,
            "sequence": 1,
            "mode": "fill",
            "windowId": "1234:5678"
        ])
        XCTAssertEqual(nilRig.packets().last?["ok"] as? Bool, false)
        XCTAssertEqual(nilRig.packets().last?["error"] as? String, "desktop-restore-persist-failed")
        XCTAssertTrue(nilRig.driver.mutationLog.isEmpty)
        XCTAssertFalse(nilRig.host.viewDirty, "Pre-mutation persist failure must not invalidate view")
        await nilRig.host.stop()

        // Case B: symlinked stateDir rejected by DurableJSONStore (ELOOP) -> 409 desktop-restore-persist-failed, 0 mutations!
        let root = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let targetDir = root.appendingPathComponent("real", isDirectory: true)
        try FileManager.default.createDirectory(at: targetDir, withIntermediateDirectories: true)
        let symlinkStateDir = root.appendingPathComponent("sym-state").path
        try FileManager.default.createSymbolicLink(atPath: symlinkStateDir, withDestinationPath: targetDir.path)

        let symRig = makeHostRig(stateDir: symlinkStateDir)
        await startVirtualSession(symRig.host)
        symRig.driver.apps = [RunningAppSnapshot(pid: 1234, bundleId: "com.apple.TextEdit", appName: "TextEdit", executableName: "TextEdit")]
        symRig.driver.windowsByKey[key] = .init(key: key, title: "Note", frame: CGRect(x: 50, y: 60, width: 700, height: 500))

        await symRig.host.handle([
            "id": "fill-sym",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": symRig.host.geometry,
            "sequence": 1,
            "mode": "fill",
            "windowId": "1234:5678"
        ])
        XCTAssertEqual(symRig.packets().last?["ok"] as? Bool, false)
        XCTAssertEqual(symRig.packets().last?["error"] as? String, "desktop-restore-persist-failed")
        XCTAssertTrue(symRig.driver.mutationLog.isEmpty)
        XCTAssertEqual(symRig.driver.windowsByKey[key]?.frame, CGRect(x: 50, y: 60, width: 700, height: 500))
        await symRig.host.stop()
    }

    // 8. Minimized window unminimized before move and re-minimized on restore
    @MainActor
    func testFillMinimizedWindowUnminimizesBeforeMoveAndRestoresMinimized() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        let rig = makeHostRig(stateDir: stateURL.path)
        await startVirtualSession(rig.host)

        let key = WindowKey(pid: 310, windowId: 610)
        rig.driver.apps = [RunningAppSnapshot(pid: 310, bundleId: "com.apple.Notes", appName: "Notes", executableName: "Notes")]
        rig.driver.windowsByKey[key] = .init(
            key: key,
            title: "Todo",
            frame: CGRect(x: 220, y: 140, width: 680, height: 520),
            isMinimized: true
        )

        await rig.host.handle([
            "id": "fill-min",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 1,
            "mode": "fill",
            "windowId": "310:610"
        ])
        XCTAssertEqual(rig.packets().last?["ok"] as? Bool, true)
        XCTAssertEqual(rig.driver.mutationLog.first, "setMinimized:310:610:false")
        XCTAssertEqual(rig.driver.windowsByKey[key]?.isMinimized, false)
        XCTAssertEqual(rig.driver.windowsByKey[key]?.frame, CGRect(x: 1920, y: 25, width: 540, height: 1055))

        // Restore must move back to physical frame and re-minimize!
        await rig.host.handle([
            "id": "restore-min",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 2,
            "mode": "restore"
        ])
        XCTAssertEqual(rig.packets().last?["ok"] as? Bool, true)
        XCTAssertEqual(rig.driver.windowsByKey[key]?.frame, CGRect(x: 220, y: 140, width: 680, height: 520))
        XCTAssertEqual(rig.driver.windowsByKey[key]?.isMinimized, true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stateURL.appendingPathComponent("window-restore.json").path))

        await rig.host.stop()
    }

    // 9. Fullscreen window exits fullscreen, atomically updates originalFrame to windowed rect, and restores fullscreen
    @MainActor
    func testFillFullScreenWindowExitsFullScreenUpdatesOriginalFrameAtomicallyAndRestores() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        let rig = makeHostRig(stateDir: stateURL.path)
        await startVirtualSession(rig.host)

        let key = WindowKey(pid: 410, windowId: 710)
        rig.driver.apps = [RunningAppSnapshot(pid: 410, bundleId: "com.apple.Safari", appName: "Safari", executableName: "Safari")]
        rig.driver.windowsByKey[key] = .init(
            key: key,
            title: "Article",
            frame: CGRect(x: 0, y: 0, width: 1920, height: 1080),
            isFullScreen: true,
            windowedFrameAfterFullScreenExit: CGRect(x: 160, y: 110, width: 1180, height: 760)
        )

        await rig.host.handle([
            "id": "fill-fs",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 1,
            "mode": "fill",
            "windowId": "410:710"
        ])
        XCTAssertEqual(rig.packets().last?["ok"] as? Bool, true)

        let restorePath = stateURL.appendingPathComponent("window-restore.json").path
        let saved = try XCTUnwrap(DurableJSONStore.loadOrQuarantine(RestoreStoreFile.self, from: restorePath))
        XCTAssertEqual(saved.records.first?.wasFullScreen, true)
        XCTAssertEqual(saved.records.first?.originalFrame, RestoreFrame(x: 160, y: 110, width: 1180, height: 760))
        XCTAssertEqual(rig.driver.windowsByKey[key]?.frame, CGRect(x: 1920, y: 25, width: 540, height: 1055))

        await rig.host.handle([
            "id": "restore-fs",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 2,
            "mode": "restore"
        ])
        XCTAssertEqual(rig.packets().last?["ok"] as? Bool, true)
        XCTAssertEqual(rig.driver.windowsByKey[key]?.frame, CGRect(x: 160, y: 110, width: 1180, height: 760))
        XCTAssertEqual(rig.driver.windowsByKey[key]?.isFullScreen, true)

        await rig.host.stop()
    }

    // 10. Untracked window already centered on virtual display uses centered physical visibleFrame or headless fallback
    @MainActor
    func testFillUntrackedWindowAlreadyOnVirtualDisplayUsesCenteredPhysicalOrHeadlessFallback() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        // Part A: With physical screen (1920x1080, AppKit visibleFrame y=50, h=1005 -> AX visibleFrame x=0, y=25, w=1920, h=1005)
        let rig = makeHostRig(stateDir: stateURL.path, physicalDisplays: [1])
        await startVirtualSession(rig.host)
        let key = WindowKey(pid: 510, windowId: 810)
        rig.driver.apps = [RunningAppSnapshot(pid: 510, bundleId: "com.apple.Finder", appName: "Finder", executableName: "Finder")]
        rig.driver.windowsByKey[key] = .init(
            key: key,
            title: "Downloads",
            frame: CGRect(x: 1950, y: 100, width: 500, height: 600)
        )

        await rig.host.handle([
            "id": "fill-already-on-v",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 1,
            "mode": "fill",
            "windowId": "510:810"
        ])
        let savedPhys = try XCTUnwrap(
            DurableJSONStore.loadOrQuarantine(RestoreStoreFile.self, from: stateURL.appendingPathComponent("window-restore.json").path)
        )
        // Centered on physical AX visibleFrame (0, 25, 1920, 1005) for 500x600: x = (1920-500)/2 = 710, y = 25 + floor((1005-600)/2) = 227
        XCTAssertEqual(savedPhys.records.first?.originalFrame, RestoreFrame(x: 710, y: 227, width: 500, height: 600))
        await rig.host.stop()

        // Part B: Headless Mac (physicalDisplays = []) -> fallback (80, 80, 1280, 820)
        let headlessState = stateURL.appendingPathComponent("headless", isDirectory: true)
        let headlessRig = makeHostRig(stateDir: headlessState.path, physicalDisplays: [])
        await startVirtualSession(headlessRig.host)
        headlessRig.driver.apps = [RunningAppSnapshot(pid: 510, bundleId: "com.apple.Finder", appName: "Finder", executableName: "Finder")]
        headlessRig.driver.windowsByKey[key] = .init(
            key: key,
            title: "Downloads",
            frame: CGRect(x: 10, y: 50, width: 500, height: 600)
        )

        await headlessRig.host.handle([
            "id": "fill-headless",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": headlessRig.host.geometry,
            "sequence": 1,
            "mode": "fill",
            "windowId": "510:810"
        ])
        let savedHeadless = try XCTUnwrap(
            DurableJSONStore.loadOrQuarantine(RestoreStoreFile.self, from: headlessState.appendingPathComponent("window-restore.json").path)
        )
        XCTAssertEqual(savedHeadless.records.first?.originalFrame, RestoreFrame(x: 80, y: 80, width: 1280, height: 820))
        await headlessRig.host.stop()
    }

    // 11. Re-filling an already-tracked window preserves original pre-virtual frame
    @MainActor
    func testRefillAlreadyTrackedWindowPreservesOriginalPreVirtualFrame() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        let rig = makeHostRig(stateDir: stateURL.path)
        await startVirtualSession(rig.host)

        let key = WindowKey(pid: 610, windowId: 910)
        rig.driver.apps = [RunningAppSnapshot(pid: 610, bundleId: "com.apple.Terminal", appName: "Terminal", executableName: "Terminal")]
        rig.driver.windowsByKey[key] = .init(
            key: key,
            title: "zsh",
            frame: CGRect(x: 88, y: 77, width: 1024, height: 740)
        )

        await rig.host.handle([
            "id": "fill-first",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 1,
            "mode": "fill",
            "windowId": "610:910"
        ])
        XCTAssertEqual(rig.driver.windowsByKey[key]?.frame, CGRect(x: 1920, y: 25, width: 540, height: 1055))

        // User drags window slightly inside virtual screen, then taps Fill again on same window.
        rig.driver.windowsByKey[key]?.frame = CGRect(x: 1930, y: 40, width: 500, height: 900)
        await rig.host.handle([
            "id": "fill-second",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 2,
            "mode": "fill",
            "windowId": "610:910"
        ])
        XCTAssertEqual(rig.packets().last?["ok"] as? Bool, true)

        let saved = try XCTUnwrap(
            DurableJSONStore.loadOrQuarantine(RestoreStoreFile.self, from: stateURL.appendingPathComponent("window-restore.json").path)
        )
        XCTAssertEqual(saved.records.count, 1)
        XCTAssertEqual(saved.records[0].originalFrame, RestoreFrame(x: 88, y: 77, width: 1024, height: 740))

        await rig.host.stop()
        XCTAssertEqual(rig.driver.windowsByKey[key]?.frame, CGRect(x: 88, y: 77, width: 1024, height: 740))
    }

    // 12. Switching Window A -> Window B restores & settles A before write-ahead and fill of B
    @MainActor
    func testSwitchWindowAToWindowBRestoresAndSettlesABeforeWriteAheadAndFillB() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        let rig = makeHostRig(stateDir: stateURL.path)
        await startVirtualSession(rig.host)

        let keyA = WindowKey(pid: 701, windowId: 1001)
        let keyB = WindowKey(pid: 702, windowId: 1002)
        rig.driver.apps = [
            RunningAppSnapshot(pid: 701, bundleId: "com.apple.Safari", appName: "Safari", executableName: "Safari"),
            RunningAppSnapshot(pid: 702, bundleId: "com.apple.Terminal", appName: "Terminal", executableName: "Terminal")
        ]
        rig.driver.windowsByKey[keyA] = .init(key: keyA, title: "A", frame: CGRect(x: 40, y: 50, width: 900, height: 700))
        rig.driver.windowsByKey[keyB] = .init(key: keyB, title: "B", frame: CGRect(x: 300, y: 120, width: 850, height: 640))

        await rig.host.handle([
            "id": "fill-a",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 1,
            "mode": "fill",
            "windowId": "701:1001"
        ])
        XCTAssertEqual(rig.coordinator.activeWindowId, "701:1001")

        let restorePath = stateURL.appendingPathComponent("window-restore.json").path
        var storeWhenBMutated: RestoreStoreFile?
        var frameAWhenBMutated: CGRect?
        rig.driver.mutationLog.removeAll()
        rig.driver.onMutation = { event in
            if event.contains("702:1002"), storeWhenBMutated == nil {
                storeWhenBMutated = DurableJSONStore.loadOrQuarantine(RestoreStoreFile.self, from: restorePath)
                frameAWhenBMutated = rig.driver.windowsByKey[keyA]?.frame
            }
        }

        await rig.host.handle([
            "id": "fill-b",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 2,
            "mode": "fill",
            "windowId": "702:1002"
        ])
        let replyB = try XCTUnwrap(rig.packets().last)
        XCTAssertEqual(replyB["ok"] as? Bool, true)
        let resB = try XCTUnwrap(replyB["result"] as? [String: Any])
        XCTAssertEqual(resB["activeWindowId"] as? String, "702:1002")

        // When B's first AX mutation fired, A was ALREADY restored to (40,50,900,700) and settled out of window-restore.json, while B was persisted!
        XCTAssertEqual(frameAWhenBMutated, CGRect(x: 40, y: 50, width: 900, height: 700))
        XCTAssertEqual(storeWhenBMutated?.records.map(\.key), [keyB])
        XCTAssertEqual(rig.driver.windowsByKey[keyB]?.frame, CGRect(x: 1920, y: 25, width: 540, height: 1055))

        await rig.host.stop()
    }

    // 13. Placement retry loop converges for lagging windows & exits early after 2 consecutive clamped reads
    @MainActor
    func testPlacementRetryLoopConvergesAndDetectsClampedMinSizeEarly() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        // Subcase A: Window lags for 2 attempts before accepting move on attempt 3 -> converges!
        let rig = makeHostRig(stateDir: stateURL.path)
        await startVirtualSession(rig.host)
        let keyLag = WindowKey(pid: 801, windowId: 2001)
        rig.driver.apps = [RunningAppSnapshot(pid: 801, bundleId: "com.electron.App", appName: "ElectronApp", executableName: "ElectronApp")]
        rig.driver.windowsByKey[keyLag] = .init(
            key: keyLag,
            title: "Lagging",
            frame: CGRect(x: 100, y: 100, width: 800, height: 600),
            lagAttemptsBeforeAcceptingMove: 2
        )

        await rig.host.handle([
            "id": "fill-lag",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 1,
            "mode": "fill",
            "windowId": "801:2001"
        ])
        XCTAssertEqual(rig.packets().last?["ok"] as? Bool, true)
        XCTAssertEqual(rig.driver.windowsByKey[keyLag]?.frame, CGRect(x: 1920, y: 25, width: 540, height: 1055))
        XCTAssertEqual(rig.driver.sleepLogMs, [250, 250])

        // Subcase B: Clamped window at 1080pt ceiling exits after 2 consecutive reads (1 sleep of 250ms, NOT 9 sleeps!)
        rig.driver.sleepLogMs.removeAll()
        _ = try await rig.host.upshiftVirtualDisplayForWindowFill(minimumWidth: 1080)
        _ = try await rig.host.completeWindowMutationViewRefresh()

        let keyClamp = WindowKey(pid: 801, windowId: 2002)
        rig.driver.windowsByKey[keyClamp] = .init(
            key: keyClamp,
            title: "Clamped",
            frame: CGRect(x: 200, y: 150, width: 1200, height: 800),
            minSize: CGSize(width: 1200, height: 800)
        )
        rig.driver.sleepLogMs.removeAll()

        await rig.host.handle([
            "id": "fill-clamp",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 2,
            "mode": "fill",
            "windowId": "801:2002"
        ])
        XCTAssertEqual(rig.packets().last?["ok"] as? Bool, true)
        // Restoring keyLag took 0 sleeps, and placing keyClamp exited early after 1 sleep (250ms)!
        XCTAssertEqual(rig.driver.sleepLogMs, [250])

        await rig.host.stop()
    }

    // 14. Multiply-before-divide auto-upshift selects smallest 10pt step & triggers view refresh
    @MainActor
    func testAutoUpshiftMultiplyBeforeDivideSelectsSmallest10ptStepAndTriggersViewRefresh() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        let rig = makeHostRig(stateDir: stateURL.path)
        await startVirtualSession(rig.host, viewport: ["width": 540, "height": 1080])
        let preTrackSid = try XCTUnwrap(rig.host.currentTrackSid)
        let preGeometry = rig.host.geometry

        // Window has minWidth = 725pt (> 540pt) -> needed = 540 * 725 / 540 = 725 -> smallest 10pt step is 730pt (730x1460 logical, 1460x2920 px).
        let key = WindowKey(pid: 901, windowId: 3001)
        rig.driver.apps = [RunningAppSnapshot(pid: 901, bundleId: "com.microsoft.VSCode", appName: "Code", executableName: "Code")]
        rig.driver.windowsByKey[key] = .init(
            key: key,
            title: "main.swift",
            frame: CGRect(x: 100, y: 80, width: 1100, height: 780),
            minSize: CGSize(width: 725, height: 500)
        )

        await rig.host.handle([
            "id": "fill-upshift",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": preGeometry,
            "sequence": 1,
            "mode": "fill",
            "windowId": "901:3001"
        ])

        let reply = try XCTUnwrap(rig.packets().last)
        XCTAssertEqual(reply["ok"] as? Bool, true)
        let res = try XCTUnwrap(reply["result"] as? [String: Any])
        XCTAssertEqual(res["upshifted"] as? Bool, true)
        XCTAssertEqual(res["activeWindowId"] as? String, "901:3001")
        XCTAssertEqual(res["viewPending"] as? Bool, false)
        let display = try XCTUnwrap(res["display"] as? [String: Any])
        XCTAssertEqual(display["logicalWidth"] as? Int, 730)
        XCTAssertEqual(display["logicalHeight"] as? Int, 1460)
        XCTAssertEqual(display["width"] as? Int, 1460)
        XCTAssertEqual(display["height"] as? Int, 2920)
        XCTAssertNotEqual(res["geometry"] as? String, preGeometry)
        XCTAssertNotEqual(res["trackSid"] as? String, preTrackSid)

        // Refilled into expanded 730x1435 visibleFrame! (primaryScreenHeight=1080, frame height=1460 -> visibleFrame height=1435, maxY=1435 -> AX y = 1080 - 1435 = -355)
        XCTAssertEqual(rig.driver.windowsByKey[key]?.frame, CGRect(x: 1920, y: -355, width: 730, height: 1435))

        await rig.host.stop()
    }

    // 15. Auto-upshift caps at 1080pt and top-left aligns oversized minWidth window (zero zoom keystrokes)
    @MainActor
    func testAutoUpshiftCapsAt1080ptAndTopLeftAlignsOversizedMinWidthWindow() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        let rig = makeHostRig(stateDir: stateURL.path)
        await startVirtualSession(rig.host, viewport: ["width": 540, "height": 1080])

        let key = WindowKey(pid: 902, windowId: 3002)
        rig.driver.apps = [RunningAppSnapshot(pid: 902, bundleId: "com.jetbrains.intellij", appName: "IntelliJ IDEA", executableName: "idea")]
        rig.driver.windowsByKey[key] = .init(
            key: key,
            title: "WideIDE",
            frame: CGRect(x: 50, y: 50, width: 1400, height: 900),
            minSize: CGSize(width: 1240, height: 800)
        )

        await rig.host.handle([
            "id": "fill-1080-cap",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 1,
            "mode": "fill",
            "windowId": "902:3002"
        ])

        let reply = try XCTUnwrap(rig.packets().last)
        XCTAssertEqual(reply["ok"] as? Bool, true)
        let res = try XCTUnwrap(reply["result"] as? [String: Any])
        XCTAssertEqual(res["upshifted"] as? Bool, true)
        let display = try XCTUnwrap(res["display"] as? [String: Any])
        XCTAssertEqual(display["logicalWidth"] as? Int, 1080)
        XCTAssertEqual(display["logicalHeight"] as? Int, 2160)

        // Expanded visibleFrame at 1080x2160 has height 2135 -> AX origin (1920, 1080 - 2135 = -1055).
        // Window width stays clamped at 1240, height expands to 2135, and top-left origin is aligned to (1920, -1055)!
        let finalFrame = try XCTUnwrap(rig.driver.windowsByKey[key]?.frame)
        XCTAssertEqual(finalFrame.origin, CGPoint(x: 1920, y: -1055))
        XCTAssertEqual(finalFrame.width, 1240)
        XCTAssertEqual(finalFrame.height, 2135)

        await rig.host.stop()
    }

    // 16. Restore on switchDisplay to physical + fast teardown within <= 4.3s deadline when window is hung
    @MainActor
    func testRestoreOnSwitchToPhysicalDisplayAndFastTeardownWithinDeadlineBudget() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        // Part A: virtual -> physical switch restores active window and clears window-restore.json.
        let rig = makeHostRig(stateDir: stateURL.path, physicalDisplays: [1])
        await startVirtualSession(rig.host)

        let key = WindowKey(pid: 950, windowId: 4050)
        rig.driver.apps = [RunningAppSnapshot(pid: 950, bundleId: "com.apple.Notes", appName: "Notes", executableName: "Notes")]
        rig.driver.windowsByKey[key] = .init(key: key, title: "Note", frame: CGRect(x: 140, y: 95, width: 760, height: 580))

        await rig.host.handle([
            "id": "fill-sw",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 1,
            "mode": "fill",
            "windowId": "950:4050"
        ])
        XCTAssertEqual(rig.driver.windowsByKey[key]?.frame, CGRect(x: 1920, y: 25, width: 540, height: 1055))

        await rig.host.handle([
            "id": "sw-phys",
            "operation": "display",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "displayId": "1"
        ])
        let swReply = try XCTUnwrap(rig.packets().last)
        XCTAssertEqual(swReply["ok"] as? Bool, true)
        XCTAssertEqual(rig.driver.windowsByKey[key]?.frame, CGRect(x: 140, y: 95, width: 760, height: 580))
        XCTAssertNil(rig.coordinator.activeWindowId)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stateURL.appendingPathComponent("window-restore.json").path))
        await rig.host.stop()

        // Part B: stop(isShuttingDown: true) with a hung window uses 0.25s AX timeout, retains record on disk, and finishes <= 4,300ms!
        let hungState = stateURL.appendingPathComponent("hung", isDirectory: true)
        let hungRig = makeHostRig(stateDir: hungState.path, physicalDisplays: [1])
        await startVirtualSession(hungRig.host)
        hungRig.driver.apps = [RunningAppSnapshot(pid: 950, bundleId: "com.apple.Notes", appName: "Notes", executableName: "Notes")]
        hungRig.driver.windowsByKey[key] = .init(key: key, title: "Hung", frame: CGRect(x: 140, y: 95, width: 760, height: 580))

        await hungRig.host.handle([
            "id": "fill-hung",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": hungRig.host.geometry,
            "sequence": 1,
            "mode": "fill",
            "windowId": "950:4050"
        ])
        // Simulate app hanging (250ms timeout per AX call) right before SIGTERM shutdown!
        hungRig.driver.windowsByKey[key]?.readError = .timedOutOrUnresponsive
        let originalOnSleep = hungRig.driver.onSleepMs
        hungRig.driver.timeoutHistory.removeAll()
        let stopStart = hungRig.nowValue()
        hungRig.advanceClock(.milliseconds(250)) // Simulate 250ms AX call latency inside hung read
        await hungRig.host.stop(isShuttingDown: true)
        _ = originalOnSleep
        let totalElapsed = stopStart.duration(to: hungRig.nowValue())

        XCTAssertTrue(hungRig.driver.timeoutHistory.contains(0.25), "Shutdown restore must lower AX timeout to 0.25s")
        XCTAssertLessThanOrEqual(totalElapsed, .milliseconds(4300))
        let retained = DurableJSONStore.loadOrQuarantine(
            RestoreStoreFile.self,
            from: hungState.appendingPathComponent("window-restore.json").path
        )
        XCTAssertEqual(retained?.records.map(\.key), [key], "Hung live window record must be retained on disk for crash recovery")
    }

    // 17. Startup crash recovery restores matching live window and deletes window-restore.json
    @MainActor
    func testRecoverIfTrustedRestoresMatchingLiveWindowAndDeletesStore() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        let restorePath = stateURL.appendingPathComponent("window-restore.json").path
        let key = WindowKey(pid: 1100, windowId: 5100)
        let crashedStore = RestoreStoreFile(
            version: 1,
            records: [
                RestoreRecord(
                    pid: 1100,
                    windowId: 5100,
                    bundleId: "com.apple.dt.Xcode",
                    appName: "Xcode",
                    title: "CrashProj",
                    originalFrame: RestoreFrame(x: 110, y: 70, width: 1300, height: 840),
                    wasFullScreen: false,
                    wasMinimized: false,
                    savedAt: "2026-11-18T12:00:00Z"
                )
            ]
        )
        try DurableJSONStore.writeAtomic(crashedStore, to: restorePath)

        let rig = makeHostRig(stateDir: stateURL.path)
        rig.driver.apps = [RunningAppSnapshot(pid: 1100, bundleId: "com.apple.dt.Xcode", appName: "Xcode", executableName: "Xcode")]
        rig.driver.windowsByKey[key] = .init(key: key, title: "CrashProj", frame: CGRect(x: 1920, y: 25, width: 540, height: 1055))

        await rig.host.reconcileStartupStateIfNeeded()

        XCTAssertEqual(rig.driver.windowsByKey[key]?.frame, CGRect(x: 110, y: 70, width: 1300, height: 840))
        XCTAssertFalse(FileManager.default.fileExists(atPath: restorePath))
    }

    // 18. Startup crash recovery drops closed windows and prevents recycled-PID mis-targeting
    @MainActor
    func testRecoverIfTrustedDropsClosedWindowAndPreventsRecycledPIDMisTargeting() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        let restorePath = stateURL.appendingPathComponent("window-restore.json").path
        let closedKey = WindowKey(pid: 1201, windowId: 6201)
        let recycledKey = WindowKey(pid: 1202, windowId: 6202)
        let store = RestoreStoreFile(
            version: 1,
            records: [
                RestoreRecord(
                    pid: 1201,
                    windowId: 6201,
                    bundleId: "com.apple.Safari",
                    appName: "Safari",
                    title: "Closed",
                    originalFrame: RestoreFrame(x: 50, y: 50, width: 800, height: 600),
                    wasFullScreen: false,
                    wasMinimized: false,
                    savedAt: "2026-11-18T12:00:00Z"
                ),
                RestoreRecord(
                    pid: 1202,
                    windowId: 6202,
                    bundleId: "com.apple.dt.Xcode",
                    appName: "Xcode",
                    title: "OldXcode",
                    originalFrame: RestoreFrame(x: 80, y: 80, width: 1200, height: 800),
                    wasFullScreen: false,
                    wasMinimized: false,
                    savedAt: "2026-11-18T12:00:00Z"
                )
            ]
        )
        try DurableJSONStore.writeAtomic(store, to: restorePath)

        let rig = makeHostRig(stateDir: stateURL.path)
        // PID 1202 was recycled by a completely different app ("com.tinyspeck.slackmacgap") that happens to have window 6202!
        rig.driver.apps = [
            RunningAppSnapshot(pid: 1201, bundleId: "com.apple.Safari", appName: "Safari", executableName: "Safari"),
            RunningAppSnapshot(pid: 1202, bundleId: "com.tinyspeck.slackmacgap", appName: "Slack", executableName: "Slack")
        ]
        // closedKey is absent from windowsByKey; recycledKey belongs to Slack at (400, 200, 960, 700).
        rig.driver.windowsByKey[recycledKey] = .init(
            key: recycledKey,
            title: "General",
            frame: CGRect(x: 400, y: 200, width: 960, height: 700)
        )
        let closedCheck = rig.driver.liveCGWindow(for: closedKey)
        XCTAssertNil(closedCheck)
        rig.driver.mutationLog.removeAll()

        await rig.coordinator.recoverIfTrusted()

        // Zero mutations on Slack's window, and both stale records removed from disk!
        XCTAssertTrue(rig.driver.mutationLog.isEmpty)
        XCTAssertEqual(rig.driver.windowsByKey[recycledKey]?.frame, CGRect(x: 400, y: 200, width: 960, height: 700))
        XCTAssertFalse(FileManager.default.fileExists(atPath: restorePath))
    }

    // 19. Startup crash recovery retains record ONLY when matching live window times out in AX
    @MainActor
    func testRecoverIfTrustedRetainsRecordOnlyWhenLiveWindowTimesOutInAX() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        let restorePath = stateURL.appendingPathComponent("window-restore.json").path
        let hungKey = WindowKey(pid: 1301, windowId: 7301)
        let okKey = WindowKey(pid: 1302, windowId: 7302)
        let store = RestoreStoreFile(
            version: 1,
            records: [
                RestoreRecord(
                    pid: 1301,
                    windowId: 7301,
                    bundleId: "com.hung.Editor",
                    appName: "Editor",
                    title: "HungDoc",
                    originalFrame: RestoreFrame(x: 60, y: 60, width: 900, height: 650),
                    wasFullScreen: false,
                    wasMinimized: false,
                    savedAt: "2026-11-18T12:00:00Z"
                ),
                RestoreRecord(
                    pid: 1302,
                    windowId: 7302,
                    bundleId: "com.apple.Terminal",
                    appName: "Terminal",
                    title: "Shell",
                    originalFrame: RestoreFrame(x: 200, y: 120, width: 840, height: 560),
                    wasFullScreen: false,
                    wasMinimized: false,
                    savedAt: "2026-11-18T12:00:00Z"
                )
            ]
        )
        try DurableJSONStore.writeAtomic(store, to: restorePath)

        let rig = makeHostRig(stateDir: stateURL.path)
        rig.driver.apps = [
            RunningAppSnapshot(pid: 1301, bundleId: "com.hung.Editor", appName: "Editor", executableName: "Editor"),
            RunningAppSnapshot(pid: 1302, bundleId: "com.apple.Terminal", appName: "Terminal", executableName: "Terminal")
        ]
        rig.driver.windowsByKey[hungKey] = .init(
            key: hungKey,
            title: "HungDoc",
            frame: CGRect(x: 1920, y: 25, width: 540, height: 1055),
            readError: .timedOutOrUnresponsive
        )
        rig.driver.windowsByKey[okKey] = .init(
            key: okKey,
            title: "Shell",
            frame: CGRect(x: 1920, y: 25, width: 540, height: 1055)
        )

        await rig.coordinator.recoverIfTrusted()

        // okKey restored & settled; hungKey retained on disk!
        XCTAssertEqual(rig.driver.windowsByKey[okKey]?.frame, CGRect(x: 200, y: 120, width: 840, height: 560))
        let remaining = try XCTUnwrap(DurableJSONStore.loadOrQuarantine(RestoreStoreFile.self, from: restorePath))
        XCTAssertEqual(remaining.records.map(\.key), [hungKey])

        // Once hungKey becomes responsive again, a subsequent recoverIfTrusted() finishes restoring and deletes store.
        rig.driver.windowsByKey[hungKey]?.readError = nil
        await rig.coordinator.recoverIfTrusted()
        XCTAssertEqual(rig.driver.windowsByKey[hungKey]?.frame, CGRect(x: 60, y: 60, width: 900, height: 650))
        XCTAssertFalse(FileManager.default.fileExists(atPath: restorePath))
    }

    // 20. Corrupt window-restore.json is quarantined to .corrupt-<ms> without throwing
    @MainActor
    func testRecoverIfTrustedQuarantinesCorruptRestoreJSONWithoutThrowing() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        let restorePath = stateURL.appendingPathComponent("window-restore.json").path
        try Data("{corrupt-json-payload".utf8).write(to: URL(fileURLWithPath: restorePath))

        let rig = makeHostRig(stateDir: stateURL.path)
        await rig.coordinator.recoverIfTrusted()

        XCTAssertFalse(FileManager.default.fileExists(atPath: restorePath))
        let files = try FileManager.default.contentsOfDirectory(atPath: stateURL.path)
        let quarantined = files.filter { $0.hasPrefix("window-restore.json.corrupt-") }
        XCTAssertEqual(quarantined.count, 1)
        var qStat = Darwin.stat()
        XCTAssertEqual(Darwin.lstat(stateURL.appendingPathComponent(quarantined[0]).path, &qStat), 0)
        XCTAssertEqual(qStat.st_mode & 0o777, 0o600)
    }

    // 21. Schema validation, sequence +1024 sync, status() activeWindowId, and viewPending == false invariant
    @MainActor
    func testHandleWindowSchemaValidationSequenceSyncAndViewPendingFalseAfterRefresh() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        let rig = makeHostRig(stateDir: stateURL.path, physicalDisplays: [1])
        let key = WindowKey(pid: 1400, windowId: 8400)
        rig.driver.apps = [RunningAppSnapshot(pid: 1400, bundleId: "com.apple.Notes", appName: "Notes", executableName: "Notes")]
        rig.driver.windowsByKey[key] = .init(key: key, title: "Spec", frame: CGRect(x: 100, y: 100, width: 640, height: 480))

        // Disconnected check before start
        await rig.host.handle(["id": "w-disc", "operation": "window", "mode": "restore"])
        XCTAssertEqual(rig.packets().last?["error"] as? String, "desktop-disconnected")

        // Start on physical display "1" -> window requires virtual display (409 desktop-virtual-display-required)
        await rig.host.handle([
            "id": "start-p",
            "operation": "start",
            "displayId": "1",
            "url": "ws://127.0.0.1:7880",
            "token": "tok",
            "key": String(repeating: "k", count: 32),
            "connectionId": "conn-m3",
            "viewer": "viewer-m3",
            "quality": ["width": 1920, "fps": 30]
        ])
        await rig.host.handle([
            "id": "w-phys",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 1,
            "mode": "restore"
        ])
        XCTAssertEqual(rig.packets().last?["error"] as? String, "desktop-virtual-display-required")

        // Switch to virtual display
        await rig.host.handle([
            "id": "sw-v",
            "operation": "display",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "displayId": "virtual"
        ])

        // Invalid schema cases -> 400 invalid-desktop-window
        let invalidPayloads: [[String: Any]] = [
            ["id": "inv-1", "operation": "window", "mode": "bogus"],
            ["id": "inv-2", "operation": "window", "mode": "fill"],
            ["id": "inv-3", "operation": "window", "mode": "fill", "windowId": "abc:123"],
            ["id": "inv-4", "operation": "window", "mode": "fill", "windowId": "0:123"],
            ["id": "inv-5", "operation": "window", "mode": "restore", "windowId": "1400:8400"],
            ["id": "inv-6", "operation": "window", "mode": "restore", "sequence": true],
            ["id": "inv-7", "operation": "window", "mode": "restore", "geometry": ""]
        ]
        for payload in invalidPayloads {
            await rig.host.handle(payload)
            XCTAssertEqual(rig.packets().last?["error"] as? String, "invalid-desktop-window")
        }

        // Sequence out of order (0 and 1025 when lastInput == 0)
        await rig.host.handle([
            "id": "seq-0",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 0,
            "mode": "restore"
        ])
        XCTAssertEqual(rig.packets().last?["error"] as? String, "desktop-sequence-out-of-order")

        await rig.host.handle([
            "id": "seq-1025",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 1025,
            "mode": "restore"
        ])
        XCTAssertEqual(rig.packets().last?["error"] as? String, "desktop-sequence-out-of-order")

        // Valid jump to sequence = 1024 updates host.lastInput so subsequent input at sequence = 1025 succeeds!
        await rig.host.handle([
            "id": "fill-1024",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 1024,
            "mode": "fill",
            "windowId": "1400:8400"
        ])
        let fillRes = try XCTUnwrap(rig.packets().last?["result"] as? [String: Any])
        XCTAssertEqual(fillRes["viewPending"] as? Bool, false)
        XCTAssertEqual(fillRes["activeWindowId"] as? String, "1400:8400")
        XCTAssertEqual(rig.host.status()["activeWindowId"] as? String, "1400:8400")

        await rig.host.handle([
            "id": "in-1025",
            "operation": "input",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 1025,
            "action": "pointer",
            "phase": "move",
            "x": 0.5,
            "y": 0.5
        ])
        XCTAssertEqual(rig.packets().last?["ok"] as? Bool, true)

        await rig.host.stop()
    }

    // 22. Pre-mutation vs Post-mutation 409 errors enforce exact invalidateView() contract
    @MainActor
    func testPreMutationVsPostMutationErrorsEnforceInvalidateViewContract() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        let rig = makeHostRig(stateDir: stateURL.path)
        await startVirtualSession(rig.host)

        let missingKey = "1500:9500"
        let preCount = rig.packets().count
        // 1. Pre-mutation window unavailable -> NO desktop-view-invalidated, viewDirty stays false!
        await rig.host.handle([
            "id": "pre-missing",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 1,
            "mode": "fill",
            "windowId": missingKey
        ])
        let preSlice = Array(rig.packets().dropFirst(preCount))
        XCTAssertFalse(preSlice.contains { $0["type"] as? String == "desktop-view-invalidated" })
        XCTAssertEqual(preSlice.last?["error"] as? String, "desktop-window-unavailable")
        XCTAssertFalse(rig.host.viewDirty)

        // 2. Post-mutation window vanishes during placement (after unminimize mutated window state) -> MUST emit desktop-view-invalidated BEFORE error reply!
        let vanishKey = WindowKey(pid: 1501, windowId: 9501)
        rig.driver.apps = [RunningAppSnapshot(pid: 1501, bundleId: "com.apple.Preview", appName: "Preview", executableName: "Preview")]
        rig.driver.windowsByKey[vanishKey] = .init(
            key: vanishKey,
            title: "Transient.pdf",
            frame: CGRect(x: 80, y: 80, width: 700, height: 500),
            isMinimized: true,
            vanishOnPlacementAttempt: 1
        )
        let postCount = rig.packets().count
        await rig.host.handle([
            "id": "post-vanish",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 2,
            "mode": "fill",
            "windowId": "1501:9501"
        ])
        let postSlice = Array(rig.packets().dropFirst(postCount))
        XCTAssertEqual(postSlice.count, 2)
        XCTAssertEqual(postSlice[0]["type"] as? String, "desktop-view-invalidated")
        XCTAssertEqual(postSlice[1]["ok"] as? Bool, false)
        XCTAssertEqual(postSlice[1]["error"] as? String, "desktop-window-unavailable")
        XCTAssertTrue(rig.host.viewDirty)

        await rig.host.stop()
    }

    // 23. DesktopHost.monitor 15s idle check is guarded by inFlightOperations
    @MainActor
    func testDesktopHostMonitorInFlightOperationsGuardPreventsMidRPCStop() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        let rig = makeHostRig(stateDir: stateURL.path)
        await startVirtualSession(rig.host)

        let staleLastSeen = Date().addingTimeInterval(-18)
        rig.host.lastSeen = staleLastSeen

        // When no RPC is in flight and 18s have elapsed since lastSeen, monitor stops session.
        XCTAssertEqual(rig.host.inFlightOperations, 0)
        XCTAssertTrue(rig.host.shouldStopForMonitorTick(now: Date(), sawViewer: true, viewerPresent: true))

        // While an async window/windows RPC is in flight, shouldStopForMonitorTick returns false even at +18s!
        var observedDuringWindowRPC: Bool?
        let key = WindowKey(pid: 1600, windowId: 9600)
        rig.driver.apps = [RunningAppSnapshot(pid: 1600, bundleId: "com.apple.Terminal", appName: "Terminal", executableName: "Terminal")]
        rig.driver.windowsByKey[key] = .init(
            key: key,
            title: "SlowMove",
            frame: CGRect(x: 100, y: 100, width: 640, height: 480),
            lagAttemptsBeforeAcceptingMove: 1
        )
        rig.driver.onSleepMs = { _ in
            rig.host.lastSeen = staleLastSeen
            observedDuringWindowRPC = rig.host.shouldStopForMonitorTick(now: Date(), sawViewer: true, viewerPresent: true)
        }

        await rig.host.handle([
            "id": "fill-inflight",
            "operation": "window",
            "connectionId": "conn-m3",
            "geometry": rig.host.geometry,
            "sequence": 1,
            "mode": "fill",
            "windowId": "1600:9600"
        ])
        XCTAssertEqual(observedDuringWindowRPC, false)
        XCTAssertEqual(rig.host.inFlightOperations, 0)

        await rig.host.stop()
    }

    // 24. M2 § 3.2 advisories: upshift drift check, restoreAfterTeardown convergence re-check + single-destroy, and EarlyStopBox
    @MainActor
    func testM2AdvisoriesUpshiftDriftRestoreTeardownConvergenceAndEarlyCaptureStop() async throws {
        let stateURL = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: stateURL) }

        var fakeNow = ContinuousClock.now
        let baseline1 = PhysicalScreenMode(
            displayID: 1, ioModeID: -10, ioModeIDBitPattern: UInt32(bitPattern: -10),
            width: 1728, height: 1117, pixelWidth: 3456, pixelHeight: 2234, refreshRate: 120.0,
            asleep: false, vendorID: 0x0610, modelID: 0xA034
        )
        let drifted1 = PhysicalScreenMode(
            displayID: 1, ioModeID: 55, ioModeIDBitPattern: 55,
            width: 1728, height: 1117, pixelWidth: 1728, pixelHeight: 1117, refreshRate: 60.0,
            asleep: false, vendorID: 0x0610, modelID: 0xA034
        )
        var currentPhysMode = baseline1
        var onlineIDs: Set<CGDirectDisplayID> = [1]
        var restoreCalls: [RestoreModeCommand] = []
        final class FlagBox: @unchecked Sendable { var value = false }
        let convergeOnPermanent = FlagBox()

        let protectorEnv = PhysicalDisplayEnvironment(
            onlineDisplayIDs: { Array(onlineIDs).sorted() },
            vendorID: { id in id == 9_001 ? 0x434C : 0x0610 },
            modelID: { id in id == 9_001 ? 0x00F0 : 0xA034 },
            isAsleep: { _ in false },
            currentMode: { id in id == 1 ? currentPhysMode : nil },
            now: { fakeNow },
            sleep: { d in fakeNow += d },
            runRestoreSubprocess: { cmd, _ in
                restoreCalls.append(cmd)
                if cmd.scope == .session {
                    currentPhysMode = baseline1
                } else if convergeOnPermanent.value {
                    currentPhysMode = baseline1
                }
                return .exited(0)
            },
            observeScreensDidWake: false,
            offlinePollTimeoutNormal: .milliseconds(50),
            offlinePollTimeoutShutdown: .milliseconds(50),
            offlinePollInterval: .milliseconds(10),
            topologySettleNormal: .zero,
            topologySettleShutdown: .zero,
            wakeSettleDelay: .zero
        )
        let protector = PhysicalDisplayModeProtector(stateDir: stateURL.path, environment: protectorEnv)
        var lastHandle: MockVirtualDisplayHandle?
        let provider = MockVirtualDisplayProviderImpl(isSupported: true) { _, _, _, _ in
            onlineIDs.insert(9_001)
            let h = MockVirtualDisplayHandle(displayID: 9_001)
            h.onDestroy = {
                onlineIDs.remove(9_001)
                currentPhysMode = drifted1
            }
            lastHandle = h
            return h
        }
        let coordEnv = VirtualDisplayEnvironment(
            now: { fakeNow },
            sleep: { d in fakeNow += d },
            isDisplayOnline: { id in onlineIDs.contains(id) },
            switchMode: { _, w, _ in
                if w > 540 {
                    // Companion monitor drifts during --set-mode upshift!
                    currentPhysMode = drifted1
                }
                return true
            },
            waitForModeConvergence: { _, _, _ in true },
            onlinePollTimeout: .milliseconds(50),
            onlinePollInterval: .milliseconds(10),
            onlineSettleDelay: .zero
        )
        let coordinator = VirtualDisplayCoordinator(provider: provider, protector: protector, environment: coordEnv)

        _ = try await coordinator.mountOrUpdate(viewport: .defaultPortrait)
        restoreCalls.removeAll()

        // Advisory #1: upshiftWidth triggers protector.restoreDriftedAfterMount!
        _ = try await coordinator.upshiftWidth(to: 700)
        XCTAssertEqual(restoreCalls.map(\.scope), [.session])
        XCTAssertEqual(currentPhysMode, baseline1)

        // Advisory #2: Teardown when .permanent exits 0 WITHOUT converging keeps baseline & snapshot on disk, and destroyCount == 1!
        convergeOnPermanent.value = false
        restoreCalls.removeAll()
        await coordinator.teardownAndRestorePhysicalDisplays(isShuttingDown: false)
        XCTAssertEqual(lastHandle?.destroyCount, 1)
        XCTAssertEqual(restoreCalls.map(\.scope), [.permanent])
        XCTAssertEqual(protector.baselineByDisplayID[1], baseline1, "Unconverged permanent restore must retain baseline")
        XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(protector.snapshotPath)))

        // Follow-up teardown converges and clears snapshot while keeping destroyCount == 1.
        convergeOnPermanent.value = true
        await coordinator.teardownAndRestorePhysicalDisplays(isShuttingDown: false)
        XCTAssertEqual(lastHandle?.destroyCount, 1)
        XCTAssertNil(protector.baselineByDisplayID[1])
        XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(protector.snapshotPath)))

        // Advisory #3: Early SCStream stop inside startCapture must NOT emit spurious desktop-stopped!
        final class EarlyFailingCaptureFactory: DesktopCaptureFactory, @unchecked Sendable {
            func startCapture(
                displayId: CGDirectDisplayID,
                width: Int,
                height: Int,
                fps: Int,
                stopped: @escaping @Sendable () -> Void
            ) async throws -> any DesktopCaptureHandle {
                stopped() // Fires BEFORE startCapture returns/throws!
                try? await Task.sleep(for: .milliseconds(10))
                throw DesktopFailure.code("desktop-capture-unavailable")
            }
        }
        var emittedEarly: [[String: Any]] = []
        let dispSys = MockDisplaySystemImpl()
        dispSys.entries[1] = .init(
            bounds: CGRect(x: 0, y: 0, width: 1920, height: 1080),
            pixels: (3840, 2160), vendorID: 0x0610, modelID: 0xA034, active: true, online: true, shareable: true
        )
        let hostEarly = DesktopHost(
            stateDir: nil,
            displaySystem: dispSys,
            permissionProvider: MockPermissionProviderImpl(),
            inputSink: MockInputSinkImpl(),
            captureFactory: EarlyFailingCaptureFactory(),
            roomFactory: MockMediaRoomFactoryImpl(),
            virtualDisplayCoordinator: coordinator,
            windowCoordinator: nil,
            observeWorkspaceSpaces: false,
            outputEmitter: { emittedEarly.append($0) }
        )
        await hostEarly.handle([
            "id": "early-fail",
            "operation": "start",
            "displayId": "1",
            "url": "ws://127.0.0.1:7880",
            "token": "tok",
            "key": String(repeating: "k", count: 32),
            "connectionId": "conn-e",
            "viewer": "viewer-e",
            "quality": ["width": 1920, "fps": 30]
        ])
        await Task.yield()
        XCTAssertFalse(emittedEarly.contains { $0["type"] as? String == "desktop-stopped" })
    }

    // 25. Zero-arg init side-effect safety & dynamic HIServices AX symbol resolution
    @MainActor
    func testZeroArgInitHasZeroSideEffectsAndHIServicesRuntimeResolvesSymbols() async {
        let driver = MockAccessibilityWindowDriver()
        let coord = WindowCoordinator(stateDir: nil, driver: driver)
        XCTAssertEqual(driver.callCount, 0, "WindowCoordinator.init(stateDir: nil) must perform zero driver/AX calls")
        await coord.restoreAllBeforeVirtualTeardown()
        XCTAssertEqual(driver.callCount, 0, "Empty restoreAllBeforeVirtualTeardown fast path must make zero AX calls")
        XCTAssertTrue(HIServicesAXRuntime.shared.isCoreAXAvailable)
    }

    // 26. Fallback CGWindowListCopyWindowInfo matching (exact title+frame, unique frame, near-frame disambiguation)
    @MainActor
    func testFallbackCGWindowIDMatchingByExactTitleFrameUniqueFrameAndNearMatch() {
        let pid: Int32 = 4200
        let cgEntries: [CGWindowEntry] = [
            CGWindowEntry(
                key: WindowKey(pid: pid, windowId: 701),
                bounds: CGRect(x: 100, y: 100, width: 800, height: 600),
                layer: 0,
                title: "Alpha",
                zIndex: 0
            ),
            CGWindowEntry(
                key: WindowKey(pid: pid, windowId: 702),
                bounds: CGRect(x: 100, y: 100, width: 800, height: 600),
                layer: 0,
                title: "Beta",
                zIndex: 1
            ),
            CGWindowEntry(
                key: WindowKey(pid: pid, windowId: 703),
                bounds: CGRect(x: 500, y: 240, width: 900, height: 700),
                layer: 0,
                title: nil,
                zIndex: 2
            ),
            CGWindowEntry(
                key: WindowKey(pid: pid, windowId: 704),
                bounds: CGRect(x: 50, y: 50, width: 400, height: 300),
                layer: 25, // non-normal layer must be ignored
                title: "Overlay",
                zIndex: 3
            )
        ]

        // Exact title + frame disambiguates stacked identical-frame windows.
        var used: Set<CGWindowID> = []
        let matchBeta = WindowCoordinator.matchFallbackCGWindowID(
            axFrame: CGRect(x: 100.5, y: 99.5, width: 800, height: 600),
            sanitizedTitle: "Beta",
            pidCGEntries: cgEntries,
            consumedWindowIDs: used
        )
        XCTAssertEqual(matchBeta, 702)
        used.insert(702)

        // Unique frame match succeeds even when CGWindowList omits kCGWindowName under Screen Recording denial.
        let matchUntitled = WindowCoordinator.matchFallbackCGWindowID(
            axFrame: CGRect(x: 501, y: 241, width: 900, height: 700),
            sanitizedTitle: "Private Doc",
            pidCGEntries: cgEntries,
            consumedWindowIDs: used
        )
        XCTAssertEqual(matchUntitled, 703)
        used.insert(703)

        // Non-zero layer window is never matched; near-match within 16pt resolves remaining unused layer-0 window.
        let matchNear = WindowCoordinator.matchFallbackCGWindowID(
            axFrame: CGRect(x: 104, y: 103, width: 798, height: 602),
            sanitizedTitle: "Alpha",
            pidCGEntries: cgEntries,
            consumedWindowIDs: used
        )
        XCTAssertEqual(matchNear, 701)

        let noMatchOverlay = WindowCoordinator.matchFallbackCGWindowID(
            axFrame: CGRect(x: 50, y: 50, width: 400, height: 300),
            sanitizedTitle: "Overlay",
            pidCGEntries: cgEntries,
            consumedWindowIDs: [701, 702, 703]
        )
        XCTAssertNil(noMatchOverlay)
    }

    // 27. Deferred hung RestoreRecord is preserved on disk across new window fill and settled later once responsive
    @MainActor
    func testDeferredHungRecordPreservedAcrossNewWindowFillAndSettledLater() async throws {
        let dir = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let rig = makeHostRig(stateDir: dir.path)
        await startVirtualSession(rig.host)

        let appA = RunningAppSnapshot(pid: 610, bundleId: "com.example.AppA", appName: "AppA", executableName: "AppA")
        let appB = RunningAppSnapshot(pid: 611, bundleId: "com.example.AppB", appName: "AppB", executableName: "AppB")
        rig.driver.apps = [appA, appB]

        let keyA = WindowKey(pid: 610, windowId: 11)
        let keyB = WindowKey(pid: 611, windowId: 22)
        rig.driver.windowsByKey[keyA] = .init(
            key: keyA,
            title: "Window A",
            frame: CGRect(x: 120, y: 90, width: 900, height: 650),
            zIndex: 0
        )
        rig.driver.windowsByKey[keyB] = .init(
            key: keyB,
            title: "Window B",
            frame: CGRect(x: 240, y: 140, width: 850, height: 620),
            zIndex: 1
        )

        // Fill Window A, then make Window A temporarily unresponsive and switch fill to Window B.
        _ = try await rig.coordinator.handleWindow(["mode": "fill", "windowId": "610:11"])
        rig.driver.windowsByKey[keyA]?.readError = .timedOutOrUnresponsive

        _ = try await rig.coordinator.handleWindow(["mode": "fill", "windowId": "611:22"])

        let restorePath = dir.appendingPathComponent("window-restore.json").path
        let persistedDuringHung = try XCTUnwrap(DurableJSONStore.loadOrQuarantine(RestoreStoreFile.self, from: restorePath))
        XCTAssertEqual(Set(persistedDuringHung.records.map { $0.key }), Set([keyA, keyB]))

        // Once Window A recovers, explicit restore settles both Window B and deferred Window A and removes the store file.
        rig.driver.windowsByKey[keyA]?.readError = nil
        _ = try await rig.coordinator.handleWindow(["mode": "restore"])

        XCTAssertFalse(FileManager.default.fileExists(atPath: restorePath))
        let restoredA = try XCTUnwrap(rig.driver.windowsByKey[keyA]?.frame)
        let restoredB = try XCTUnwrap(rig.driver.windowsByKey[keyB]?.frame)
        XCTAssertEqual(restoredA.origin.x, 120, accuracy: 1)
        XCTAssertEqual(restoredA.origin.y, 90, accuracy: 1)
        XCTAssertEqual(restoredB.origin.x, 240, accuracy: 1)
        XCTAssertEqual(restoredB.origin.y, 140, accuracy: 1)
    }

    // 28. listWindows enforces max window cap and UTF-8 JSON stdout byte budget (< 262,144 bytes)
    @MainActor
    func testListWindowsEnforcesMaxCountAndStdoutByteBudgetUnder262KiB() async throws {
        let rig = makeHostRig(stateDir: nil)
        await startVirtualSession(rig.host)

        let heavyTitle = String(repeating: "👩‍💻", count: 200)
        rig.driver.apps = [
            RunningAppSnapshot(pid: 777, bundleId: "com.example.Many", appName: String(repeating: "App", count: 60), executableName: "Many")
        ]
        for idx in 1...230 {
            let key = WindowKey(pid: 777, windowId: UInt32(idx))
            rig.driver.windowsByKey[key] = .init(
                key: key,
                title: heavyTitle,
                frame: CGRect(x: 40, y: 40, width: 640, height: 480),
                zIndex: idx
            )
        }

        let payload = try await rig.coordinator.listWindows()
        let windows = try XCTUnwrap(payload["windows"] as? [[String: Any]])
        XCTAssertFalse(windows.isEmpty)
        XCTAssertLessThanOrEqual(windows.count, 200)

        let envelope: [String: Any] = [
            "id": "req-windows-heavy",
            "type": "response",
            "ok": true,
            "payload": payload
        ]
        let encoded = try JSONSerialization.data(withJSONObject: envelope, options: [])
        XCTAssertLessThan(encoded.count, 262_144, "Serialized windows response envelope must stay strictly below MAX_STDOUT_LINE_BYTES")
    }
}
