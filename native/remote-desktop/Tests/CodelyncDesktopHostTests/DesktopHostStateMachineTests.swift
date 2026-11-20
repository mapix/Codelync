import CoreGraphics
import Foundation
import XCTest
import CGVirtualDisplayRuntime
@testable import CodelyncDesktopHostCore

@MainActor
final class MockDisplaySystemImpl: DesktopDisplaySystem {
    struct Entry {
        var bounds: CGRect
        var pixels: (width: Int, height: Int)
        var vendorID: UInt32
        var modelID: UInt32
        var active: Bool
        var online: Bool
        var shareable: Bool
    }

    var headlessFallbackPollTimeout: Duration = .milliseconds(120)
    var headlessFallbackPollInterval: Duration = .milliseconds(20)
    var mainID: CGDirectDisplayID = 1
    var entries: [CGDirectDisplayID: Entry] = [:]
    var activeListError = false
    var onSleep: ((Duration) -> Void)?

    func activeDisplayIDs() -> [CGDirectDisplayID]? {
        if activeListError { return nil }
        return entries.keys.sorted().filter { entries[$0]?.active == true }
    }

    func isOnline(_ id: CGDirectDisplayID) -> Bool {
        entries[id]?.online == true
    }

    func mainDisplayID() -> CGDirectDisplayID {
        mainID
    }

    func bounds(of id: CGDirectDisplayID) -> CGRect {
        entries[id]?.bounds ?? .zero
    }

    func pixels(of id: CGDirectDisplayID) -> (width: Int, height: Int) {
        entries[id]?.pixels ?? (0, 0)
    }

    func vendorID(of id: CGDirectDisplayID) -> UInt32 {
        entries[id]?.vendorID ?? 0
    }

    func modelID(of id: CGDirectDisplayID) -> UInt32 {
        entries[id]?.modelID ?? 0
    }

    func isShareableDisplayAvailable(_ id: CGDirectDisplayID) async -> Bool {
        entries[id]?.shareable == true
    }

    func sleep(_ duration: Duration) async {
        onSleep?(duration)
    }
}

@MainActor
final class MockPermissionProviderImpl: DesktopPermissionProviding {
    var screenRecording = true
    var accessibility = true
    var locked = false

    func screenRecordingGranted() -> Bool { screenRecording }
    func accessibilityGranted() -> Bool { accessibility }
    func isSessionLocked() -> Bool { locked }
    func requestScreenRecording() {}
    func requestAccessibility() {}
}

@MainActor
final class MockInputSinkImpl: DesktopInputEventSink {
    struct MouseRecord: Equatable {
        let type: CGEventType
        let location: CGPoint
        let button: CGMouseButton
    }
    struct ScrollRecord: Equatable {
        let deltaY: Int32
        let location: CGPoint
    }

    var mouseEvents: [MouseRecord] = []
    var scrollEvents: [ScrollRecord] = []
    var unicodeEvents: [[UniChar]] = []
    var keyEvents: [(code: CGKeyCode, flags: CGEventFlags)] = []

    func postMouse(type: CGEventType, location: CGPoint, button: CGMouseButton) {
        mouseEvents.append(MouseRecord(type: type, location: location, button: button))
    }

    func postScroll(deltaY: Int32, location: CGPoint) {
        scrollEvents.append(ScrollRecord(deltaY: deltaY, location: location))
    }

    func postUnicodeText(_ utf16Units: [UniChar]) {
        unicodeEvents.append(utf16Units)
    }

    func postKey(code: CGKeyCode, flags: CGEventFlags) {
        keyEvents.append((code, flags))
    }

    func topWindowOwnerPID(at location: CGPoint) -> pid_t? {
        nil
    }
}

final class MockCaptureHandleImpl: DesktopCaptureHandle, @unchecked Sendable {
    let id: Int
    let stoppedCallback: @Sendable () -> Void
    private let onStopLog: @Sendable (Int) -> Void
    private let lock = NSLock()
    private var stopCountValue = 0

    init(id: Int, stoppedCallback: @escaping @Sendable () -> Void, onStopLog: @escaping @Sendable (Int) -> Void) {
        self.id = id
        self.stoppedCallback = stoppedCallback
        self.onStopLog = onStopLog
    }

    var stopCount: Int { lock.withLock { stopCountValue } }

    func stopCapture() async {
        lock.withLock { stopCountValue += 1 }
        onStopLog(id)
    }
}

final class MockCaptureFactoryImpl: DesktopCaptureFactory, @unchecked Sendable {
    struct StartRecord: Equatable, Sendable {
        let id: Int
        let displayId: CGDirectDisplayID
        let width: Int
        let height: Int
        let fps: Int
    }

    private let lock = NSLock()
    private var nextID = 0
    private var pendingStartError: (any Error)?
    private(set) var records: [StartRecord] = []
    private(set) var handles: [MockCaptureHandleImpl] = []
    var onEventLog: (@Sendable (String) -> Void)?

    func setNextStartError(_ error: (any Error)?) {
        lock.withLock { pendingStartError = error }
    }

    func startCapture(
        displayId: CGDirectDisplayID,
        width: Int,
        height: Int,
        fps: Int,
        stopped: @escaping @Sendable () -> Void
    ) async throws -> any DesktopCaptureHandle {
        if let injectedError: any Error = lock.withLock({
            let err = pendingStartError
            pendingStartError = nil
            return err
        }) {
            throw injectedError
        }
        let assignedID: Int = lock.withLock {
            nextID += 1
            let id = nextID
            records.append(StartRecord(id: id, displayId: displayId, width: width, height: height, fps: fps))
            return id
        }
        onEventLog?("startCapture:\(displayId):\(width)x\(height)")
        let handle = MockCaptureHandleImpl(id: assignedID, stoppedCallback: stopped) { [weak self] id in
            self?.onEventLog?("stopCapture:\(id)")
        }
        lock.withLock { handles.append(handle) }
        return handle
    }
}

@MainActor
final class MockMediaRoomImpl: DesktopMediaRoom {
    var isConnected = false
    var viewerPresent = true
    private var nextTrackCounter = 0
    var nextPublishError: (any Error)?
    var onDisconnect: (() async -> Void)?
    var onEventLog: ((String) -> Void)?

    func hasRemoteParticipant(identity: String) -> Bool {
        viewerPresent && !identity.isEmpty
    }

    func connect(url: String, token: String) async throws {
        isConnected = true
        onEventLog?("roomConnect")
    }

    func publishCapture(_ capture: any DesktopCaptureHandle, bitrate: Int, fps: Int) async throws -> String {
        if let err = nextPublishError {
            nextPublishError = nil
            throw err
        }
        nextTrackCounter += 1
        let sid = "TR_mock_\(nextTrackCounter)"
        onEventLog?("publish:\(sid)")
        return sid
    }

    func unpublishCurrent() async throws {
        onEventLog?("unpublish")
    }

    func disconnect() async {
        await onDisconnect?()
        isConnected = false
        onEventLog?("roomDisconnect")
    }
}

@MainActor
final class MockMediaRoomFactoryImpl: DesktopMediaRoomFactory {
    var lastRoom: MockMediaRoomImpl?
    var initialPublishError: (any Error)?
    var onEventLog: ((String) -> Void)?

    func createRoom(sharedKey: String) -> any DesktopMediaRoom {
        let room = MockMediaRoomImpl()
        room.nextPublishError = initialPublishError
        initialPublishError = nil
        room.onEventLog = onEventLog
        lastRoom = room
        return room
    }
}

@MainActor
final class MockWindowCoordinatorImpl: DesktopWindowCoordinating {
    var onEventLog: ((String) -> Void)?
    var onRestoreBeforeTeardown: (() async -> Void)?
    private(set) var recoverCount = 0
    private(set) var restoreBeforeTeardownCount = 0

    func recoverIfTrusted() async {
        recoverCount += 1
        onEventLog?("windowRecover")
    }

    func restoreAllBeforeVirtualTeardown() async {
        restoreBeforeTeardownCount += 1
        onEventLog?("windowRestoreBeforeTeardown")
        await onRestoreBeforeTeardown?()
    }
}

final class DesktopHostStateMachineTests: XCTestCase {
    @MainActor
    private func buildTestRig(virtualSupported: Bool = true, initialPhysicalDisplays: [CGDirectDisplayID] = [1, 2]) -> (
        host: DesktopHost,
        displaySystem: MockDisplaySystemImpl,
        permissions: MockPermissionProviderImpl,
        captureFactory: MockCaptureFactoryImpl,
        roomFactory: MockMediaRoomFactoryImpl,
        windowCoordinator: MockWindowCoordinatorImpl,
        emitted: () -> [[String: Any]],
        eventLog: () -> [String]
    ) {
        final class ThreadSafeLog: @unchecked Sendable {
            private let lock = NSLock()
            private var entries: [String] = []
            func append(_ entry: String) { lock.withLock { entries.append(entry) } }
            func snapshot() -> [String] { lock.withLock { entries } }
        }
        let logBox = ThreadSafeLog()
        let appendLog: @Sendable (String) -> Void = { entry in
            logBox.append(entry)
        }

        var emittedPackets: [[String: Any]] = []
        let displaySystem = MockDisplaySystemImpl()
        for (idx, id) in initialPhysicalDisplays.enumerated() {
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

        var fakeNow = ContinuousClock.now
        let provider = MockVirtualDisplayProviderImpl(isSupported: virtualSupported) { _, spec, _, _ in
            let virtualID: CGDirectDisplayID = 9_001
            appendLog("virtualCreate:\(virtualID):\(spec.serialNum)")
            displaySystem.entries[virtualID] = .init(
                bounds: CGRect(x: 3840, y: 0, width: 540, height: 1080),
                pixels: (1080, 2160),
                vendorID: 0x434C,
                modelID: 0x00F0,
                active: true,
                online: true,
                shareable: true
            )
            let handle = MockVirtualDisplayHandle(displayID: virtualID)
            handle.onDestroy = {
                appendLog("virtualDestroy:\(virtualID)")
                displaySystem.entries.removeValue(forKey: virtualID)
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
        let protector = PhysicalDisplayModeProtector(stateDir: nil, environment: protectorEnv)

        let coordEnv = VirtualDisplayEnvironment(
            now: { fakeNow },
            sleep: { d in fakeNow += d },
            isDisplayOnline: { id in displaySystem.isOnline(id) },
            switchMode: { id, w, h in
                appendLog("virtualSetMode:\(id):\(w)x\(h)")
                displaySystem.entries[id]?.bounds = CGRect(x: 3840, y: 0, width: CGFloat(w), height: CGFloat(h))
                displaySystem.entries[id]?.pixels = (w * 2, h * 2)
                return true
            },
            waitForModeConvergence: { _, _, _ in true },
            onlinePollTimeout: .milliseconds(50),
            onlinePollInterval: .milliseconds(10),
            onlineSettleDelay: .zero
        )
        let coordinator = VirtualDisplayCoordinator(provider: provider, protector: protector, environment: coordEnv)

        let permissions = MockPermissionProviderImpl()
        let inputSink = MockInputSinkImpl()
        let captureFactory = MockCaptureFactoryImpl()
        captureFactory.onEventLog = appendLog
        let roomFactory = MockMediaRoomFactoryImpl()
        roomFactory.onEventLog = { appendLog($0) }
        let windowCoordinator = MockWindowCoordinatorImpl()
        windowCoordinator.onEventLog = { appendLog($0) }

        let host = DesktopHost(
            stateDir: nil,
            displaySystem: displaySystem,
            permissionProvider: permissions,
            inputSink: inputSink,
            captureFactory: captureFactory,
            roomFactory: roomFactory,
            virtualDisplayCoordinator: coordinator,
            windowCoordinator: windowCoordinator,
            observeWorkspaceSpaces: false,
            outputEmitter: { packet in
                if let type = packet["type"] as? String {
                    appendLog("emit:\(type)")
                }
                emittedPackets.append(packet)
            }
        )
        return (
            host,
            displaySystem,
            permissions,
            captureFactory,
            roomFactory,
            windowCoordinator,
            { emittedPackets },
            { logBox.snapshot() }
        )
    }

    func testViewportAndStrictJSONValidationRejectsCFBooleansFloatsAndLandscape() throws {
        // Default when omitted on virtual; nil on physical.
        XCTAssertEqual(try DesktopViewport.resolve(from: [:], isVirtual: true), .defaultPortrait)
        XCTAssertNil(try DesktopViewport.resolve(from: [:], isVirtual: false))

        // Valid portrait & square foldable viewports.
        XCTAssertEqual(
            try DesktopViewport.resolve(from: ["viewport": ["width": 393, "height": 760]], isVirtual: true),
            DesktopViewport(width: 393, height: 760)
        )
        XCTAssertEqual(
            try DesktopViewport.resolve(from: ["viewport": ["width": 540, "height": 540]], isVirtual: true),
            DesktopViewport(width: 540, height: 540)
        )

        // JSON-decoded CFBoolean must be rejected!
        let boolPayload = try JSONSerialization.jsonObject(
            with: Data(#"{"viewport":{"width":true,"height":1080}}"#.utf8)
        ) as! [String: Any]
        XCTAssertThrowsError(try DesktopViewport.resolve(from: boolPayload, isVirtual: true)) { error in
            XCTAssertEqual(error as? DesktopFailure, .code("invalid-desktop-viewport"))
        }

        let invalidPayloads: [[String: Any]] = [
            ["viewport": NSNull()],
            ["viewport": [540, 1080]],
            ["viewport": "540x1080"],
            ["viewport": ["width": 540.5, "height": 1080]],
            ["viewport": ["width": 540]],
            ["viewport": ["width": 540, "height": 1080, "extra": 1]],
            ["viewport": ["width": 99, "height": 1080]],
            ["viewport": ["width": 540, "height": 10_001]],
            ["viewport": ["width": 1080, "height": 540]] // Landscape height < width
        ]
        for bad in invalidPayloads {
            XCTAssertThrowsError(try DesktopViewport.resolve(from: bad, isVirtual: true)) { error in
                XCTAssertEqual(error as? DesktopFailure, .code("invalid-desktop-viewport"))
            }
        }
    }

    @MainActor
    func testDisplaysInventoryFilteringUnsupportedFallbackAndHeadlessSupport() async {
        // 1. Supported == true: returns physical rows + "virtual" row, and never duplicates mounted virtual CGID.
        let rig = buildTestRig(virtualSupported: true, initialPhysicalDisplays: [1, 2])
        await rig.host.handle(["id": "d1", "operation": "displays"])
        let reply1 = rig.emitted().last!
        XCTAssertEqual(reply1["ok"] as? Bool, true)
        let res1 = reply1["result"] as! [String: Any]
        XCTAssertEqual(res1["virtualDisplaySupported"] as? Bool, true)
        let rows1 = res1["displays"] as! [[String: Any]]
        XCTAssertEqual(rows1.map { $0["id"] as? String }, ["1", "2", "virtual"])
        XCTAssertEqual(rows1.map { $0["kind"] as? String }, ["physical", "physical", "virtual"])
        XCTAssertEqual(rows1[2]["width"] as? Int, 1080)
        XCTAssertEqual(rows1[2]["height"] as? Int, 2160)
        XCTAssertEqual(rows1[2]["logicalWidth"] as? Int, 540)
        XCTAssertEqual(rows1[2]["logicalHeight"] as? Int, 1080)

        // 2. Supported == false: omits "virtual", rejects virtual start with desktop-virtual-display-unavailable, physical works!
        let unsupportedRig = buildTestRig(virtualSupported: false, initialPhysicalDisplays: [1])
        await unsupportedRig.host.handle(["id": "d2", "operation": "displays"])
        let res2 = unsupportedRig.emitted().last!["result"] as! [String: Any]
        XCTAssertEqual(res2["virtualDisplaySupported"] as? Bool, false)
        let rows2 = res2["displays"] as! [[String: Any]]
        XCTAssertEqual(rows2.map { $0["id"] as? String }, ["1"])

        await unsupportedRig.host.handle([
            "id": "s-virt-fail",
            "operation": "start",
            "displayId": "virtual",
            "url": "ws://127.0.0.1:7880",
            "token": "tok",
            "key": String(repeating: "k", count: 32),
            "connectionId": "conn-1",
            "viewer": "viewer-1",
            "quality": ["width": 1920, "fps": 30]
        ])
        XCTAssertEqual(unsupportedRig.emitted().last?["ok"] as? Bool, false)
        XCTAssertEqual(unsupportedRig.emitted().last?["error"] as? String, "desktop-virtual-display-unavailable")

        // Physical start on unsupported host succeeds cleanly!
        await unsupportedRig.host.handle([
            "id": "s-phys-ok",
            "operation": "start",
            "displayId": "1",
            "url": "ws://127.0.0.1:7880",
            "token": "tok",
            "key": String(repeating: "k", count: 32),
            "connectionId": "conn-phys",
            "viewer": "viewer-1",
            "quality": ["width": 1920, "fps": 30]
        ])
        XCTAssertEqual(unsupportedRig.emitted().last?["ok"] as? Bool, true)
        await unsupportedRig.host.stop()

        // 3. Headless Mac (0 physical displays): returns [virtualRow] when supported, throws desktop-display-unavailable when unsupported.
        let headlessSupported = buildTestRig(virtualSupported: true, initialPhysicalDisplays: [])
        await headlessSupported.host.handle(["id": "h1", "operation": "displays"])
        let hRes = headlessSupported.emitted().last!["result"] as! [String: Any]
        let hRows = hRes["displays"] as! [[String: Any]]
        XCTAssertEqual(hRows.count, 1)
        XCTAssertEqual(hRows[0]["id"] as? String, "virtual")

        let headlessUnsupported = buildTestRig(virtualSupported: false, initialPhysicalDisplays: [])
        await headlessUnsupported.host.handle(["id": "h2", "operation": "displays"])
        XCTAssertEqual(headlessUnsupported.emitted().last?["ok"] as? Bool, false)
        XCTAssertEqual(headlessUnsupported.emitted().last?["error"] as? String, "desktop-display-unavailable")
    }

    @MainActor
    func testM1Advisory1StatusDisplayParityAndTeardownOrderBeforeVirtualDisplayMutation() async throws {
        let rig = buildTestRig(virtualSupported: true, initialPhysicalDisplays: [1])

        // Idle status omits "display" and "geometry", capturing == false (verifyDesktopHelper contract).
        await rig.host.handle(["id": "idle-probe", "operation": "status"])
        let idleResult = rig.emitted().last!["result"] as! [String: Any]
        XCTAssertEqual(idleResult["capturing"] as? Bool, false)
        XCTAssertNil(idleResult["display"])
        XCTAssertNil(idleResult["geometry"])

        // Start on "virtual" with custom portrait viewport (393x760 -> 540x1044 logical, 1080x2088 px).
        await rig.host.handle([
            "id": "start-v",
            "operation": "start",
            "displayId": "virtual",
            "viewport": ["width": 393, "height": 760],
            "url": "ws://127.0.0.1:7880",
            "token": "tok",
            "key": String(repeating: "k", count: 32),
            "connectionId": "conn-v",
            "viewer": "viewer-v",
            "quality": ["width": 1920, "fps": 30]
        ])
        let startReply = rig.emitted().last!
        XCTAssertEqual(startReply["ok"] as? Bool, true)
        let startRes = startReply["result"] as! [String: Any]
        let startDisp = startRes["display"] as! [String: Any]
        let startGeom = startRes["geometry"] as! String
        XCTAssertEqual(startDisp["id"] as? String, "virtual")
        XCTAssertEqual(startDisp["kind"] as? String, "virtual")
        XCTAssertEqual(startDisp["width"] as? Int, 1080)
        XCTAssertEqual(startDisp["height"] as? Int, 2088)
        XCTAssertEqual(startDisp["logicalWidth"] as? Int, 540)
        XCTAssertEqual(startDisp["logicalHeight"] as? Int, 1044)
        XCTAssertEqual(startDisp["geometry"] as? String, startGeom)
        XCTAssertEqual(rig.host.geometry, startGeom)

        // Mounted virtual display (9001) must NEVER appear twice in `displays`!
        await rig.host.handle(["id": "inv-mounted", "operation": "displays"])
        let invMounted = (rig.emitted().last!["result"] as! [String: Any])["displays"] as! [[String: Any]]
        XCTAssertEqual(invMounted.map { $0["id"] as? String }, ["1", "virtual"])

        // Verify heartbeat and quality keep M1 Advisory #1 invariant: self.geometry == result["geometry"] == result["display"]["geometry"].
        await rig.host.handle(["id": "hb-1", "operation": "heartbeat", "connectionId": "conn-v", "geometry": startGeom])
        let hbRes = rig.emitted().last!["result"] as! [String: Any]
        XCTAssertEqual((hbRes["display"] as? [String: Any])?["geometry"] as? String, hbRes["geometry"] as? String)
        XCTAssertEqual(hbRes["geometry"] as? String, rig.host.geometry)

        await rig.host.handle([
            "id": "q-1",
            "operation": "quality",
            "connectionId": "conn-v",
            "geometry": rig.host.geometry,
            "quality": ["width": 1280, "fps": 30]
        ])
        let qRes = rig.emitted().last!["result"] as! [String: Any]
        let qGeom = qRes["geometry"] as! String
        XCTAssertEqual((qRes["display"] as? [String: Any])?["geometry"] as? String, qGeom)
        XCTAssertEqual(rig.host.geometry, qGeom)

        // Grab handle of active virtual capture before switching "virtual" -> "virtual" (live viewport resize).
        let captureBeforeResize = rig.captureFactory.handles.last!
        let logCountBeforeResize = rig.eventLog().count

        await rig.host.handle([
            "id": "disp-resize",
            "operation": "display",
            "connectionId": "conn-v",
            "geometry": qGeom,
            "displayId": "virtual",
            "viewport": ["width": 540, "height": 1080]
        ])
        XCTAssertEqual(rig.emitted().last?["ok"] as? Bool, true)
        let resizeSlice = Array(rig.eventLog().dropFirst(logCountBeforeResize))
        let stopIdxResize = try XCTUnwrap(resizeSlice.firstIndex(where: { $0.hasPrefix("stopCapture:") }))
        let setModeIdxResize = try XCTUnwrap(resizeSlice.firstIndex(where: { $0.hasPrefix("virtualSetMode:") }))
        let winRestoreIdxResize = try XCTUnwrap(resizeSlice.firstIndex(of: "windowRestoreBeforeTeardown"))
        XCTAssertLessThan(winRestoreIdxResize, stopIdxResize)
        XCTAssertLessThan(stopIdxResize, setModeIdxResize)

        // Late SCStreamDelegate didStopWithError on retired capture MUST NOT emit desktop-stopped!
        captureBeforeResize.stoppedCallback()
        await Task.yield()
        XCTAssertFalse(rig.eventLog().contains("emit:desktop-stopped"))
        XCTAssertEqual(rig.host.room?.isConnected, true)

        // Switch "virtual" -> Physical "1": verify windowRestore -> invalidateView -> stopCapture -> virtualDestroy -> startCapture(1)!
        let captureBeforeSwitchToPhys = rig.captureFactory.handles.last!
        let logCountBeforePhys = rig.eventLog().count
        await rig.host.handle([
            "id": "disp-phys",
            "operation": "display",
            "connectionId": "conn-v",
            "geometry": rig.host.geometry,
            "displayId": "1"
        ])
        let physReply = rig.emitted().last!
        XCTAssertEqual(physReply["ok"] as? Bool, true)
        let physRes = physReply["result"] as! [String: Any]
        let physDisp = physRes["display"] as! [String: Any]
        XCTAssertEqual(physDisp["id"] as? String, "1")
        XCTAssertEqual(physDisp["kind"] as? String, "physical")
        XCTAssertEqual(physDisp["geometry"] as? String, physRes["geometry"] as? String)
        XCTAssertEqual(rig.host.geometry, physRes["geometry"] as? String)

        let physSlice = Array(rig.eventLog().dropFirst(logCountBeforePhys))
        let invIdx = try XCTUnwrap(physSlice.firstIndex(of: "emit:desktop-view-invalidated"))
        let stopIdx = try XCTUnwrap(physSlice.firstIndex(where: { $0.hasPrefix("stopCapture:") }))
        let destroyIdx = try XCTUnwrap(physSlice.firstIndex(of: "virtualDestroy:9001"))
        let startPhysIdx = try XCTUnwrap(physSlice.firstIndex(where: { $0.hasPrefix("startCapture:1:") }))
        XCTAssertLessThan(invIdx, destroyIdx)
        XCTAssertLessThan(stopIdx, destroyIdx)
        XCTAssertLessThan(destroyIdx, startPhysIdx)

        captureBeforeSwitchToPhys.stoppedCallback()
        await Task.yield()
        XCTAssertFalse(rig.eventLog().contains("emit:desktop-stopped"))

        // Switch back to "virtual", then test concurrent coalesced stop() ordering!
        await rig.host.handle([
            "id": "disp-back-v",
            "operation": "display",
            "connectionId": "conn-v",
            "geometry": rig.host.geometry,
            "displayId": "virtual"
        ])
        XCTAssertEqual(rig.emitted().last?["ok"] as? Bool, true)

        let logCountBeforeStop = rig.eventLog().count
        let hostRef = rig.host
        let s1 = Task { @MainActor in await hostRef.stop(isShuttingDown: true) }
        let s2 = Task { @MainActor in await hostRef.stop(isShuttingDown: true) }
        await s1.value
        await s2.value

        let stopSlice = Array(rig.eventLog().dropFirst(logCountBeforeStop))
        let stopCaptureInStop = try XCTUnwrap(stopSlice.firstIndex(where: { $0.hasPrefix("stopCapture:") }))
        let destroyInStop = try XCTUnwrap(stopSlice.firstIndex(of: "virtualDestroy:9001"))
        XCTAssertLessThan(stopCaptureInStop, destroyInStop)
        // Coalesced stop only destroyed virtual display once.
        XCTAssertEqual(stopSlice.filter { $0 == "virtualDestroy:9001" }.count, 1)
    }

    @MainActor
    func testHeadlessMacSwitchFromVirtualToDefaultDisplayReEmergenceAndZeroDisplaySafety() async {
        // Case 1: Headless Mac has 0 physical displays while virtual is mounted, then synthesized display 1 re-emerges after virtual teardown.
        let rig = buildTestRig(virtualSupported: true, initialPhysicalDisplays: [])
        var sleepPollTicks = 0
        rig.displaySystem.onSleep = { _ in
            sleepPollTicks += 1
            if sleepPollTicks == 2 {
                rig.displaySystem.entries[1] = .init(
                    bounds: CGRect(x: 0, y: 0, width: 1920, height: 1080),
                    pixels: (1920, 1080),
                    vendorID: 0x756E,
                    modelID: 0x0001,
                    active: true,
                    online: true,
                    shareable: true
                )
            }
        }

        await rig.host.handle([
            "id": "h-start",
            "operation": "start",
            "displayId": "virtual",
            "url": "ws://127.0.0.1:7880",
            "token": "tok",
            "key": String(repeating: "k", count: 32),
            "connectionId": "conn-h",
            "viewer": "viewer-h",
            "quality": ["width": 1920, "fps": 30]
        ])
        XCTAssertEqual(rig.emitted().last?["ok"] as? Bool, true)

        await rig.host.handle([
            "id": "h-switch",
            "operation": "display",
            "connectionId": "conn-h",
            "geometry": rig.host.geometry,
            "displayId": "1"
        ])
        let switchReply = rig.emitted().last!
        XCTAssertEqual(switchReply["ok"] as? Bool, true)
        let switchDisp = (switchReply["result"] as! [String: Any])["display"] as! [String: Any]
        XCTAssertEqual(switchDisp["id"] as? String, "1")
        XCTAssertGreaterThanOrEqual(sleepPollTicks, 2)
        await rig.host.stop()

        // Case 2: Truly zero physical displays even after virtual teardown -> stops stream before teardown and fails cleanly without crash.
        let zeroRig = buildTestRig(virtualSupported: true, initialPhysicalDisplays: [])
        await zeroRig.host.handle([
            "id": "z-start",
            "operation": "start",
            "displayId": "virtual",
            "url": "ws://127.0.0.1:7880",
            "token": "tok",
            "key": String(repeating: "k", count: 32),
            "connectionId": "conn-z",
            "viewer": "viewer-z",
            "quality": ["width": 1920, "fps": 30]
        ])
        await zeroRig.host.handle([
            "id": "z-switch",
            "operation": "display",
            "connectionId": "conn-z",
            "geometry": zeroRig.host.geometry,
            "displayId": "1"
        ])
        XCTAssertEqual(zeroRig.emitted().last?["ok"] as? Bool, false)
        XCTAssertEqual(zeroRig.emitted().last?["error"] as? String, "desktop-display-unavailable")
        XCTAssertNil(zeroRig.host.capture)
        XCTAssertNil(zeroRig.host.virtualDisplayCoordinator.activeVirtualDisplayID)
        await zeroRig.host.stop()
    }

    @MainActor
    func testCoalescedStopShutdownUpgradeConcurrentRoomDisconnectAndBoundedDeadline() async throws {
        let tempRoot = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("cl-stop-budget-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempRoot) }

        // Subcase A: Coalesced stop(false) + stop(true) dynamically upgrades shutdownRequested,
        // runs hardware teardown concurrently with a hung room.disconnect(), splits remaining
        // deadline fairly across 2 drifted displays, and completes strictly within <= 4,350ms.
        let stateDirA = tempRoot.appendingPathComponent("state-a", isDirectory: true).path
        var fakeNowA = ContinuousClock.now
        let displaySystemA = MockDisplaySystemImpl()
        displaySystemA.entries[1] = .init(
            bounds: CGRect(x: 0, y: 0, width: 1728, height: 1117),
            pixels: (3456, 2234),
            vendorID: 0x0610,
            modelID: 0xA034,
            active: true,
            online: true,
            shareable: true
        )
        displaySystemA.entries[2] = .init(
            bounds: CGRect(x: 1728, y: 0, width: 2560, height: 1440),
            pixels: (5120, 2880),
            vendorID: 0x10AC,
            modelID: 0xD0B3,
            active: true,
            online: true,
            shareable: true
        )

        let baselineMode1 = PhysicalScreenMode(
            displayID: 1, ioModeID: -10, ioModeIDBitPattern: UInt32(bitPattern: -10),
            width: 1728, height: 1117, pixelWidth: 3456, pixelHeight: 2234, refreshRate: 120.0,
            asleep: false, vendorID: 0x0610, modelID: 0xA034
        )
        let baselineMode2 = PhysicalScreenMode(
            displayID: 2, ioModeID: 25, ioModeIDBitPattern: 25,
            width: 2560, height: 1440, pixelWidth: 5120, pixelHeight: 2880, refreshRate: 60.0,
            asleep: false, vendorID: 0x10AC, modelID: 0xD0B3
        )
        let driftedMode1 = PhysicalScreenMode(
            displayID: 1, ioModeID: 77, ioModeIDBitPattern: 77,
            width: 1728, height: 1117, pixelWidth: 1728, pixelHeight: 1117, refreshRate: 60.0,
            asleep: false, vendorID: 0x0610, modelID: 0xA034
        )
        let driftedMode2 = PhysicalScreenMode(
            displayID: 2, ioModeID: 88, ioModeIDBitPattern: 88,
            width: 2560, height: 1440, pixelWidth: 2560, pixelHeight: 1440, refreshRate: 60.0,
            asleep: false, vendorID: 0x10AC, modelID: 0xD0B3
        )
        var modesA: [CGDirectDisplayID: PhysicalScreenMode] = [1: baselineMode1, 2: baselineMode2]
        var virtualDestroyedAtA: ContinuousClock.Instant?
        var permanentRestoreTimeouts: [(CGDirectDisplayID, Duration)] = []
        var display1SlowOnShutdown = true

        let isVirtual9001Online: @MainActor () -> Bool = {
            guard displaySystemA.entries[9_001] != nil else { return false }
            if let destroyedAt = virtualDestroyedAtA {
                return destroyedAt.duration(to: fakeNowA) < .milliseconds(600)
            }
            return true
        }

        let providerA = MockVirtualDisplayProviderImpl(isSupported: true) { _, _, _, _ in
            displaySystemA.entries[9_001] = .init(
                bounds: CGRect(x: 4288, y: 0, width: 540, height: 1080),
                pixels: (1080, 2160),
                vendorID: 0x434C,
                modelID: 0x00F0,
                active: true,
                online: true,
                shareable: true
            )
            // Companion displays drift on virtual mount and remain clamped while virtual is online.
            modesA[1] = driftedMode1
            modesA[2] = driftedMode2
            let handle = MockVirtualDisplayHandle(displayID: 9_001)
            handle.onDestroy = {
                virtualDestroyedAtA = fakeNowA
            }
            return handle
        }

        let makeProtectorEnvA: () -> PhysicalDisplayEnvironment = {
            PhysicalDisplayEnvironment(
                onlineDisplayIDs: {
                    var ids: [CGDirectDisplayID] = [1, 2]
                    if isVirtual9001Online() {
                        ids.append(9_001)
                    }
                    return ids
                },
                vendorID: { id in id == 9_001 ? 0x434C : (modesA[id]?.vendorID ?? 0) },
                modelID: { id in id == 9_001 ? 0x00F0 : (modesA[id]?.modelID ?? 0) },
                isAsleep: { _ in false },
                currentMode: { id in modesA[id] },
                now: { fakeNowA },
                sleep: { d in
                    fakeNowA += d
                    if !isVirtual9001Online() {
                        displaySystemA.entries.removeValue(forKey: 9_001)
                    }
                },
                runRestoreSubprocess: { cmd, timeout in
                    if cmd.scope == .session {
                        // Clamped while virtual display is online.
                        return .exited(0)
                    }
                    permanentRestoreTimeouts.append((cmd.displayID, timeout))
                    if cmd.displayID == 1 && display1SlowOnShutdown {
                        let needed: Duration = .milliseconds(2000)
                        if needed > timeout {
                            fakeNowA += timeout
                            return .timedOut
                        }
                    }
                    let step = min(timeout, .milliseconds(100))
                    fakeNowA += step
                    if cmd.displayID == 1 {
                        modesA[1] = baselineMode1
                    } else if cmd.displayID == 2 {
                        modesA[2] = baselineMode2
                    }
                    return .exited(0)
                },
                observeScreensDidWake: false,
                offlinePollTimeoutNormal: .seconds(3),
                offlinePollTimeoutShutdown: .milliseconds(800),
                offlinePollInterval: .milliseconds(50),
                topologySettleNormal: .milliseconds(800),
                topologySettleShutdown: .milliseconds(150),
                wakeSettleDelay: .zero
            )
        }

        let protectorA = PhysicalDisplayModeProtector(stateDir: stateDirA, environment: makeProtectorEnvA())
        let coordEnvA = VirtualDisplayEnvironment(
            now: { fakeNowA },
            sleep: { d in
                fakeNowA += d
                if !isVirtual9001Online() {
                    displaySystemA.entries.removeValue(forKey: 9_001)
                }
            },
            isDisplayOnline: { id in id == 9_001 ? isVirtual9001Online() : displaySystemA.isOnline(id) },
            switchMode: { _, _, _ in true },
            waitForModeConvergence: { _, _, _ in true },
            onlinePollTimeout: .milliseconds(100),
            onlinePollInterval: .milliseconds(25),
            onlineSettleDelay: .zero
        )
        let coordinatorA = VirtualDisplayCoordinator(provider: providerA, protector: protectorA, environment: coordEnvA)
        let permissionsA = MockPermissionProviderImpl()
        let inputSinkA = MockInputSinkImpl()
        let captureFactoryA = MockCaptureFactoryImpl()
        let roomFactoryA = MockMediaRoomFactoryImpl()
        let windowCoordinatorA = MockWindowCoordinatorImpl()
        var packetsA: [[String: Any]] = []

        let hostA = DesktopHost(
            stateDir: stateDirA,
            displaySystem: displaySystemA,
            permissionProvider: permissionsA,
            inputSink: inputSinkA,
            captureFactory: captureFactoryA,
            roomFactory: roomFactoryA,
            virtualDisplayCoordinator: coordinatorA,
            windowCoordinator: windowCoordinatorA,
            observeWorkspaceSpaces: false,
            outputEmitter: { packetsA.append($0) }
        )

        await hostA.handle([
            "id": "start-a",
            "operation": "start",
            "displayId": "virtual",
            "url": "ws://127.0.0.1:7880",
            "token": "tok",
            "key": String(repeating: "k", count: 32),
            "connectionId": "conn-a",
            "viewer": "viewer-a",
            "quality": ["width": 1920, "fps": 30]
        ])
        XCTAssertEqual(packetsA.last?["ok"] as? Bool, true)

        final class ContinuationLatch: @unchecked Sendable {
            private let lock = NSLock()
            private var cont: CheckedContinuation<Void, Never>?
            private var cancelled = false

            func arm(_ c: CheckedContinuation<Void, Never>) {
                let resumeNow: Bool = lock.withLock {
                    if cancelled { return true }
                    cont = c
                    return false
                }
                if resumeNow { c.resume() }
            }

            func resumeIfNeeded() {
                let saved: CheckedContinuation<Void, Never>? = lock.withLock {
                    cancelled = true
                    let c = cont
                    cont = nil
                    return c
                }
                saved?.resume()
            }
        }
        let disconnectLatch = ContinuationLatch()
        roomFactoryA.lastRoom?.onDisconnect = {
            await withTaskCancellationHandler {
                await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                    disconnectLatch.arm(c)
                }
            } onCancel: {
                disconnectLatch.resumeIfNeeded()
            }
        }

        var shutdownStopTask: Task<Void, Never>?
        var observedUpgrade = false
        windowCoordinatorA.onRestoreBeforeTeardown = {
            // While stop(isShuttingDown: false) is already in-flight, spawn stop(isShuttingDown: true).
            shutdownStopTask = Task { @MainActor in
                await hostA.stop(isShuttingDown: true)
            }
            await Task.yield()
            await Task.yield()
            observedUpgrade = hostA.shutdownRequested
        }

        let stopStartA = fakeNowA
        let rpcStopTask = Task { @MainActor in
            await hostA.stop(isShuttingDown: false)
        }
        await rpcStopTask.value
        await shutdownStopTask?.value
        let elapsedA = stopStartA.duration(to: fakeNowA)

        XCTAssertTrue(observedUpgrade, "In-flight stop(false) must dynamically upgrade when stop(true) arrives")
        XCTAssertLessThanOrEqual(elapsedA, .milliseconds(4350))
        XCTAssertEqual(permanentRestoreTimeouts.map(\.0), [1, 2])
        // Fair-share split: display 1 got ~525ms (not 1,500ms or 2,500ms!), leaving ~525ms for display 2 to succeed!
        XCTAssertLessThan(permanentRestoreTimeouts[0].1, .milliseconds(800))
        XCTAssertEqual(modesA[2], baselineMode2)
        XCTAssertEqual(Set(protectorA.baselineByDisplayID.keys), [1])
        let snapshotPathA = try XCTUnwrap(protectorA.snapshotPath)
        let persistedSnapshotA = DurableJSONStore.loadOrQuarantine(DisplayModesSnapshot.self, from: snapshotPathA)
        XCTAssertEqual(persistedSnapshotA?.displays, [baselineMode1])

        // Next startup crash-recovery restores remaining display 1 .permanently and removes snapshot.
        display1SlowOnShutdown = false
        let restartedProtectorA = PhysicalDisplayModeProtector(stateDir: stateDirA, environment: makeProtectorEnvA())
        await restartedProtectorA.reconcileStartupIfNeeded()
        XCTAssertEqual(modesA[1], baselineMode1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshotPathA))

        // Subcase B: Standalone `stop` RPC (`isShuttingDown: false`) with 2,600ms virtual offline delay
        // stays bounded well under 4,400ms (2,500ms minimumLifetime + 800ms bounded offline poll = 3,300ms).
        let stateDirB = tempRoot.appendingPathComponent("state-b", isDirectory: true).path
        var fakeNowB = ContinuousClock.now
        let displaySystemB = MockDisplaySystemImpl()
        displaySystemB.entries[1] = .init(
            bounds: CGRect(x: 0, y: 0, width: 1920, height: 1080),
            pixels: (3840, 2160),
            vendorID: 0x0610,
            modelID: 0xA034,
            active: true,
            online: true,
            shareable: true
        )
        let baselineB = PhysicalScreenMode(
            displayID: 1, ioModeID: 12, ioModeIDBitPattern: 12,
            width: 1920, height: 1080, pixelWidth: 3840, pixelHeight: 2160, refreshRate: 60.0,
            asleep: false, vendorID: 0x0610, modelID: 0xA034
        )
        var virtualDestroyedAtB: ContinuousClock.Instant?
        let isVirtual9002Online: @MainActor () -> Bool = {
            guard displaySystemB.entries[9_002] != nil else { return false }
            if let destroyedAt = virtualDestroyedAtB {
                return destroyedAt.duration(to: fakeNowB) < .milliseconds(2600)
            }
            return true
        }
        let providerB = MockVirtualDisplayProviderImpl(isSupported: true) { _, _, _, _ in
            displaySystemB.entries[9_002] = .init(
                bounds: CGRect(x: 1920, y: 0, width: 540, height: 1080),
                pixels: (1080, 2160),
                vendorID: 0x434C,
                modelID: 0x00F0,
                active: true,
                online: true,
                shareable: true
            )
            let handle = MockVirtualDisplayHandle(displayID: 9_002)
            handle.onDestroy = { virtualDestroyedAtB = fakeNowB }
            return handle
        }
        let protectorEnvB = PhysicalDisplayEnvironment(
            onlineDisplayIDs: { isVirtual9002Online() ? [1, 9_002] : [1] },
            vendorID: { id in id == 9_002 ? 0x434C : 0x0610 },
            modelID: { id in id == 9_002 ? 0x00F0 : 0xA034 },
            isAsleep: { _ in false },
            currentMode: { id in id == 1 ? baselineB : nil },
            now: { fakeNowB },
            sleep: { d in fakeNowB += d },
            runRestoreSubprocess: { _, _ in .exited(0) },
            observeScreensDidWake: false,
            offlinePollTimeoutNormal: .seconds(3),
            offlinePollTimeoutShutdown: .milliseconds(800),
            offlinePollInterval: .milliseconds(50),
            topologySettleNormal: .milliseconds(800),
            topologySettleShutdown: .milliseconds(150),
            wakeSettleDelay: .zero
        )
        let protectorB = PhysicalDisplayModeProtector(stateDir: stateDirB, environment: protectorEnvB)
        let coordEnvB = VirtualDisplayEnvironment(
            now: { fakeNowB },
            sleep: { d in fakeNowB += d },
            isDisplayOnline: { id in id == 9_002 ? isVirtual9002Online() : true },
            switchMode: { _, _, _ in true },
            waitForModeConvergence: { _, _, _ in true },
            onlinePollTimeout: .milliseconds(100),
            onlinePollInterval: .milliseconds(25),
            onlineSettleDelay: .zero
        )
        let coordinatorB = VirtualDisplayCoordinator(provider: providerB, protector: protectorB, environment: coordEnvB)
        var packetsB: [[String: Any]] = []
        let hostB = DesktopHost(
            stateDir: stateDirB,
            displaySystem: displaySystemB,
            permissionProvider: MockPermissionProviderImpl(),
            inputSink: MockInputSinkImpl(),
            captureFactory: MockCaptureFactoryImpl(),
            roomFactory: MockMediaRoomFactoryImpl(),
            virtualDisplayCoordinator: coordinatorB,
            windowCoordinator: nil,
            observeWorkspaceSpaces: false,
            outputEmitter: { packetsB.append($0) }
        )

        await hostB.handle([
            "id": "start-b",
            "operation": "start",
            "displayId": "virtual",
            "url": "ws://127.0.0.1:7880",
            "token": "tok",
            "key": String(repeating: "k", count: 32),
            "connectionId": "conn-b",
            "viewer": "viewer-b",
            "quality": ["width": 1920, "fps": 30]
        ])
        let stopStartB = fakeNowB
        await hostB.handle(["id": "stop-rpc", "operation": "stop"])
        let elapsedB = stopStartB.duration(to: fakeNowB)
        XCTAssertEqual(packetsB.last?["ok"] as? Bool, true)
        XCTAssertEqual(elapsedB, .milliseconds(3300))
        XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(protectorB.snapshotPath)))
    }

    @MainActor
    func testSCStreamStopDuringWindowRestoreAndCaptureSafeUpshiftSeam() async throws {
        let rig = buildTestRig(virtualSupported: true, initialPhysicalDisplays: [1])

        await rig.host.handle([
            "id": "start-v",
            "operation": "start",
            "displayId": "virtual",
            "url": "ws://127.0.0.1:7880",
            "token": "tok",
            "key": String(repeating: "k", count: 32),
            "connectionId": "conn-v",
            "viewer": "viewer-v",
            "quality": ["width": 1920, "fps": 30]
        ])
        XCTAssertEqual(rig.emitted().last?["ok"] as? Bool, true)

        // Fire SCStreamDelegate.didStopWithError *while* restoreAllBeforeVirtualTeardown() is suspended!
        rig.windowCoordinator.onRestoreBeforeTeardown = {
            await Task.yield()
            rig.captureFactory.handles.last?.stoppedCallback()
            await Task.yield()
        }

        // 1. "virtual" -> "virtual" live viewport resize.
        let resizeLogStart = rig.eventLog().count
        await rig.host.handle([
            "id": "resize-v",
            "operation": "display",
            "connectionId": "conn-v",
            "geometry": rig.host.geometry,
            "displayId": "virtual",
            "viewport": ["width": 393, "height": 760]
        ])
        await Task.yield()
        XCTAssertEqual(rig.emitted().last?["ok"] as? Bool, true)
        XCTAssertEqual(rig.roomFactory.lastRoom?.isConnected, true)
        XCTAssertFalse(rig.eventLog().contains("emit:desktop-stopped"))
        let resizeEvents = Array(rig.eventLog().dropFirst(resizeLogStart))
        let resizeWinIdx = try XCTUnwrap(resizeEvents.firstIndex(of: "windowRestoreBeforeTeardown"))
        let resizeStopIdx = try XCTUnwrap(resizeEvents.firstIndex(where: { $0.hasPrefix("stopCapture:") }))
        let resizeModeIdx = try XCTUnwrap(resizeEvents.firstIndex(where: { $0.hasPrefix("virtualSetMode:") }))
        XCTAssertLessThan(resizeWinIdx, resizeStopIdx)
        XCTAssertLessThan(resizeStopIdx, resizeModeIdx)

        // 2. "virtual" -> physical "1" switch.
        let physLogStart = rig.eventLog().count
        await rig.host.handle([
            "id": "switch-phys",
            "operation": "display",
            "connectionId": "conn-v",
            "geometry": rig.host.geometry,
            "displayId": "1"
        ])
        await Task.yield()
        XCTAssertEqual(rig.emitted().last?["ok"] as? Bool, true)
        XCTAssertEqual(rig.roomFactory.lastRoom?.isConnected, true)
        XCTAssertFalse(rig.eventLog().contains("emit:desktop-stopped"))
        let physEvents = Array(rig.eventLog().dropFirst(physLogStart))
        let physWinIdx = try XCTUnwrap(physEvents.firstIndex(of: "windowRestoreBeforeTeardown"))
        let physStopIdx = try XCTUnwrap(physEvents.firstIndex(where: { $0.hasPrefix("stopCapture:") }))
        let physDestroyIdx = try XCTUnwrap(physEvents.firstIndex(of: "virtualDestroy:9001"))
        XCTAssertLessThan(physWinIdx, physStopIdx)
        XCTAssertLessThan(physStopIdx, physDestroyIdx)

        // 3. Switch back to "virtual" and exercise M3 capture-safe auto-upshift + refresh seams.
        rig.windowCoordinator.onRestoreBeforeTeardown = nil
        await rig.host.handle([
            "id": "switch-back-v",
            "operation": "display",
            "connectionId": "conn-v",
            "geometry": rig.host.geometry,
            "displayId": "virtual",
            "viewport": ["width": 540, "height": 1080]
        ])
        XCTAssertEqual(rig.emitted().last?["ok"] as? Bool, true)

        let captureBeforeUpshift = try XCTUnwrap(rig.captureFactory.handles.last)
        let upshiftLogStart = rig.eventLog().count
        let mounted = try await rig.host.upshiftVirtualDisplayForWindowFill(minimumWidth: 725)
        captureBeforeUpshift.stoppedCallback()
        await Task.yield()
        let refreshedStatus = try await rig.host.completeWindowMutationViewRefresh()

        XCTAssertEqual(mounted.logicalWidth, 730)
        XCTAssertEqual(mounted.logicalHeight, 1460)
        let upshiftEvents = Array(rig.eventLog().dropFirst(upshiftLogStart))
        let upshiftStopIdx = try XCTUnwrap(upshiftEvents.firstIndex(where: { $0.hasPrefix("stopCapture:") }))
        let upshiftSetModeIdx = try XCTUnwrap(upshiftEvents.firstIndex(of: "virtualSetMode:9001:730x1460"))
        XCTAssertLessThan(upshiftStopIdx, upshiftSetModeIdx)
        XCTAssertFalse(rig.eventLog().contains("emit:desktop-stopped"))
        let refreshedDisp = try XCTUnwrap(refreshedStatus["display"] as? [String: Any])
        XCTAssertEqual(refreshedDisp["logicalWidth"] as? Int, 730)
        XCTAssertEqual(refreshedStatus["geometry"] as? String, rig.host.geometry)
        XCTAssertEqual(refreshedDisp["geometry"] as? String, rig.host.geometry)

        // 4. Explicit `stop` RPC while SCStreamDelegate fires inside restoreAllBeforeVirtualTeardown().
        rig.windowCoordinator.onRestoreBeforeTeardown = {
            await Task.yield()
            rig.captureFactory.handles.last?.stoppedCallback()
            await Task.yield()
        }
        await rig.host.handle(["id": "stop-1", "operation": "stop"])
        await Task.yield()
        XCTAssertEqual(rig.emitted().last?["ok"] as? Bool, true)
        XCTAssertFalse(rig.eventLog().contains("emit:desktop-stopped"))
    }

    @MainActor
    func testHeartbeatRecoversUnconfirmedGeometryDriftAndUnwedgesRequireActive() async throws {
        let rig = buildTestRig(virtualSupported: true, initialPhysicalDisplays: [1])

        await rig.host.handle([
            "id": "start-v",
            "operation": "start",
            "displayId": "virtual",
            "viewport": ["width": 540, "height": 1080],
            "url": "ws://127.0.0.1:7880",
            "token": "tok",
            "key": String(repeating: "k", count: 32),
            "connectionId": "conn-v",
            "viewer": "viewer-v",
            "quality": ["width": 1920, "fps": 30]
        ])
        let startRes = try XCTUnwrap(rig.emitted().last?["result"] as? [String: Any])
        let startGeom = try XCTUnwrap(startRes["geometry"] as? String)

        await rig.host.handle([
            "id": "in-1",
            "operation": "input",
            "connectionId": "conn-v",
            "geometry": startGeom,
            "sequence": 1,
            "action": "pointer",
            "phase": "move",
            "x": 0.5,
            "y": 0.5
        ])
        XCTAssertEqual(rig.emitted().last?["ok"] as? Bool, true)

        // Simulate unconfirmed WindowServer mode/bounds change while viewDirty == false.
        rig.displaySystem.entries[9_001]?.bounds = CGRect(x: 3840, y: 0, width: 730, height: 1460)
        rig.displaySystem.entries[9_001]?.pixels = (1460, 2920)
        XCTAssertFalse(rig.host.viewDirty)

        await rig.host.handle([
            "id": "in-wedged",
            "operation": "input",
            "connectionId": "conn-v",
            "geometry": startGeom,
            "sequence": 2,
            "action": "pointer",
            "phase": "move",
            "x": 0.5,
            "y": 0.5
        ])
        XCTAssertEqual(rig.emitted().last?["ok"] as? Bool, false)
        XCTAssertEqual(rig.emitted().last?["error"] as? String, "desktop-display-changed")

        // Heartbeat must detect displayStamp(id) != geometry, invalidateView(), republish SCStream, and sync geometry!
        let hbLogStart = rig.eventLog().count
        await rig.host.handle([
            "id": "hb-heal",
            "operation": "heartbeat",
            "connectionId": "conn-v"
        ])
        let hbReply = try XCTUnwrap(rig.emitted().last)
        XCTAssertEqual(hbReply["ok"] as? Bool, true)
        let hbRes = try XCTUnwrap(hbReply["result"] as? [String: Any])
        let hbGeom = try XCTUnwrap(hbRes["geometry"] as? String)
        let hbDisp = try XCTUnwrap(hbRes["display"] as? [String: Any])

        let hbEvents = Array(rig.eventLog().dropFirst(hbLogStart))
        XCTAssertTrue(hbEvents.contains("emit:desktop-view-invalidated"))
        XCTAssertEqual(rig.captureFactory.records.last?.width, 960)
        XCTAssertEqual(rig.captureFactory.records.last?.height, 1920)
        XCTAssertEqual(hbRes["viewPending"] as? Bool, false)
        XCTAssertNotEqual(hbGeom, startGeom)
        XCTAssertEqual(hbGeom, rig.host.geometry)
        XCTAssertEqual(hbDisp["geometry"] as? String, hbGeom)

        // Input with healed geometry now succeeds; stale startGeom remains fenced!
        await rig.host.handle([
            "id": "in-2",
            "operation": "input",
            "connectionId": "conn-v",
            "geometry": hbGeom,
            "sequence": 2,
            "action": "pointer",
            "phase": "move",
            "x": 0.5,
            "y": 0.5
        ])
        XCTAssertEqual(rig.emitted().last?["ok"] as? Bool, true)

        await rig.host.handle([
            "id": "in-stale",
            "operation": "input",
            "connectionId": "conn-v",
            "geometry": startGeom,
            "sequence": 3,
            "action": "pointer",
            "phase": "move",
            "x": 0.5,
            "y": 0.5
        ])
        XCTAssertEqual(rig.emitted().last?["ok"] as? Bool, false)
        XCTAssertEqual(rig.emitted().last?["error"] as? String, "desktop-display-changed")

        await rig.host.stop()
    }

    @MainActor
    func testPublishCaptureThrowStopsLeakedStreamAndSwitchDisplayRollsBackPostRetireFailures() async throws {
        // Case 1: room.publishCapture throws during `start` -> nextCapture.stopCapture() called, no leaked stream.
        let rig1 = buildTestRig(virtualSupported: true, initialPhysicalDisplays: [1, 2])
        rig1.roomFactory.initialPublishError = DesktopFailure.code("desktop-capture-unavailable")
        await rig1.host.handle([
            "id": "start-pub-fail",
            "operation": "start",
            "displayId": "1",
            "url": "ws://127.0.0.1:7880",
            "token": "tok",
            "key": String(repeating: "k", count: 32),
            "connectionId": "conn-1",
            "viewer": "viewer-1",
            "quality": ["width": 1920, "fps": 30]
        ])
        XCTAssertEqual(rig1.emitted().last?["ok"] as? Bool, false)
        XCTAssertEqual(rig1.emitted().last?["error"] as? String, "desktop-media-connect-failed")
        XCTAssertEqual(rig1.captureFactory.handles.last?.stopCount, 1)
        XCTAssertNil(rig1.host.capture)
        XCTAssertEqual(rig1.host.captureGeneration, "")

        // Case 2: Pre-retire validation failure in `switchDisplay` leaves active stream & session untouched!
        await rig1.host.handle([
            "id": "start-phys-ok",
            "operation": "start",
            "displayId": "1",
            "url": "ws://127.0.0.1:7880",
            "token": "tok",
            "key": String(repeating: "k", count: 32),
            "connectionId": "conn-2",
            "viewer": "viewer-2",
            "quality": ["width": 1920, "fps": 30]
        ])
        XCTAssertEqual(rig1.emitted().last?["ok"] as? Bool, true)
        let activePhysCapture = try XCTUnwrap(rig1.captureFactory.handles.last)
        let activePhysGeom = rig1.host.geometry

        await rig1.host.handle([
            "id": "switch-bad-vp",
            "operation": "display",
            "connectionId": "conn-2",
            "geometry": activePhysGeom,
            "displayId": "virtual",
            "viewport": ["width": 1080, "height": 540]
        ])
        XCTAssertEqual(rig1.emitted().last?["ok"] as? Bool, false)
        XCTAssertEqual(rig1.emitted().last?["error"] as? String, "invalid-desktop-viewport")
        XCTAssertEqual(activePhysCapture.stopCount, 0)
        XCTAssertEqual(rig1.host.room?.isConnected, true)

        await rig1.host.handle([
            "id": "input-still-active",
            "operation": "input",
            "connectionId": "conn-2",
            "geometry": activePhysGeom,
            "sequence": 1,
            "action": "pointer",
            "phase": "move",
            "x": 0.25,
            "y": 0.25
        ])
        XCTAssertEqual(rig1.emitted().last?["ok"] as? Bool, true)

        // Case 3: Post-retire failure in `switchDisplay` ("1" -> "virtual") stops stream, destroys virtual display & disconnects room, preserving error code.
        rig1.roomFactory.lastRoom?.nextPublishError = DesktopFailure.code("desktop-capture-unavailable")
        await rig1.host.handle([
            "id": "switch-virt-pub-fail",
            "operation": "display",
            "connectionId": "conn-2",
            "geometry": activePhysGeom,
            "displayId": "virtual",
            "viewport": ["width": 540, "height": 1080]
        ])
        XCTAssertEqual(rig1.emitted().last?["ok"] as? Bool, false)
        XCTAssertEqual(rig1.emitted().last?["error"] as? String, "desktop-capture-unavailable")
        XCTAssertEqual(rig1.captureFactory.handles.last?.stopCount, 1)
        XCTAssertNil(rig1.host.virtualDisplayCoordinator.activeVirtualDisplayID)
        XCTAssertNil(rig1.host.capture)
        XCTAssertNil(rig1.host.room)

        // Case 4: Post-retire failure in `switchDisplay` ("virtual" -> "2") destroys virtual display & disconnects room cleanly.
        let rig2 = buildTestRig(virtualSupported: true, initialPhysicalDisplays: [1, 2])
        await rig2.host.handle([
            "id": "start-virt-ok",
            "operation": "start",
            "displayId": "virtual",
            "url": "ws://127.0.0.1:7880",
            "token": "tok",
            "key": String(repeating: "k", count: 32),
            "connectionId": "conn-4",
            "viewer": "viewer-4",
            "quality": ["width": 1920, "fps": 30]
        ])
        XCTAssertEqual(rig2.emitted().last?["ok"] as? Bool, true)
        rig2.captureFactory.setNextStartError(DesktopFailure.code("desktop-capture-unavailable"))
        await rig2.host.handle([
            "id": "switch-phys-cap-fail",
            "operation": "display",
            "connectionId": "conn-4",
            "geometry": rig2.host.geometry,
            "displayId": "2"
        ])
        XCTAssertEqual(rig2.emitted().last?["ok"] as? Bool, false)
        XCTAssertEqual(rig2.emitted().last?["error"] as? String, "desktop-capture-unavailable")
        XCTAssertNil(rig2.host.virtualDisplayCoordinator.activeVirtualDisplayID)
        XCTAssertNil(rig2.host.capture)
        XCTAssertNil(rig2.host.room)
    }
}
