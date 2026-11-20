import AppKit
@preconcurrency import ApplicationServices
import CoreGraphics
import CoreMedia
import Foundation
@preconcurrency import LiveKit
@preconcurrency import ScreenCaptureKit

@MainActor
protocol DesktopWindowCoordinating: AnyObject {
    var activeWindowId: String? { get }
    func attach(host: DesktopHost)
    func recoverIfTrusted() async
    func restoreAllBeforeVirtualTeardown() async
    func restoreAllBeforeVirtualTeardown(
        isShuttingDownProvider: @MainActor () -> Bool,
        deadlineProvider: @MainActor () -> ContinuousClock.Instant?
    ) async
    func listWindows() async throws -> [String: Any]
    func handleWindow(_ value: [String: Any]) async throws -> [String: Any]
}

extension DesktopWindowCoordinating {
    var activeWindowId: String? { nil }
    func attach(host: DesktopHost) {}

    func restoreAllBeforeVirtualTeardown(
        isShuttingDownProvider: @MainActor () -> Bool,
        deadlineProvider: @MainActor () -> ContinuousClock.Instant?
    ) async {
        await restoreAllBeforeVirtualTeardown()
    }

    func listWindows() async throws -> [String: Any] {
        throw DesktopFailure.code("invalid-desktop-operation")
    }

    func handleWindow(_ value: [String: Any]) async throws -> [String: Any] {
        throw DesktopFailure.code("invalid-desktop-operation")
    }
}

@MainActor
protocol DesktopDisplaySystem: AnyObject {
    var headlessFallbackPollTimeout: Duration { get }
    var headlessFallbackPollInterval: Duration { get }
    func activeDisplayIDs() -> [CGDirectDisplayID]?
    func isOnline(_ id: CGDirectDisplayID) -> Bool
    func mainDisplayID() -> CGDirectDisplayID
    func bounds(of id: CGDirectDisplayID) -> CGRect
    func pixels(of id: CGDirectDisplayID) -> (width: Int, height: Int)
    func vendorID(of id: CGDirectDisplayID) -> UInt32
    func modelID(of id: CGDirectDisplayID) -> UInt32
    func isShareableDisplayAvailable(_ id: CGDirectDisplayID) async -> Bool
    func sleep(_ duration: Duration) async
}

@MainActor
final class LiveDesktopDisplaySystem: DesktopDisplaySystem {
    let headlessFallbackPollTimeout: Duration = .seconds(3)
    let headlessFallbackPollInterval: Duration = .milliseconds(50)

    func activeDisplayIDs() -> [CGDirectDisplayID]? {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count <= 32 else {
            return nil
        }
        if count == 0 {
            return []
        }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        var actual: UInt32 = 0
        guard CGGetActiveDisplayList(count, &ids, &actual) == .success else {
            return nil
        }
        return Array(ids.prefix(Int(actual)))
    }

    func isOnline(_ id: CGDirectDisplayID) -> Bool {
        onlineDisplayIDs(maxDisplays: 32).contains(id)
    }

    func mainDisplayID() -> CGDirectDisplayID {
        CGMainDisplayID()
    }

    func bounds(of id: CGDirectDisplayID) -> CGRect {
        CGDisplayBounds(id)
    }

    func pixels(of id: CGDirectDisplayID) -> (width: Int, height: Int) {
        if let mode = CGDisplayCopyDisplayMode(id) {
            return (mode.pixelWidth, mode.pixelHeight)
        }
        return (CGDisplayPixelsWide(id), CGDisplayPixelsHigh(id))
    }

    func vendorID(of id: CGDirectDisplayID) -> UInt32 {
        CGDisplayVendorNumber(id)
    }

    func modelID(of id: CGDirectDisplayID) -> UInt32 {
        CGDisplayModelNumber(id)
    }

    func isShareableDisplayAvailable(_ id: CGDirectDisplayID) async -> Bool {
        guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) else {
            return false
        }
        return content.displays.contains(where: { $0.displayID == id })
    }

    func sleep(_ duration: Duration) async {
        try? await Task.sleep(for: duration)
    }
}

@MainActor
protocol DesktopPermissionProviding: AnyObject {
    func screenRecordingGranted() -> Bool
    func accessibilityGranted() -> Bool
    func isSessionLocked() -> Bool
    func requestScreenRecording()
    func requestAccessibility()
}

@MainActor
final class LiveDesktopPermissionProvider: DesktopPermissionProviding {
    func screenRecordingGranted() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    func accessibilityGranted() -> Bool {
        AXIsProcessTrusted()
    }

    func isSessionLocked() -> Bool {
        guard let state = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
        return state["CGSSessionScreenIsLocked"] as? Bool == true ||
            state["kCGSessionOnConsoleKey"] as? Bool == false
    }

    func requestScreenRecording() {
        _ = CGRequestScreenCaptureAccess()
    }

    func requestAccessibility() {
        let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([promptKey: true] as CFDictionary)
    }
}

@MainActor
protocol DesktopInputEventSink: AnyObject {
    func postMouse(type: CGEventType, location: CGPoint, button: CGMouseButton)
    func postScroll(deltaY: Int32, location: CGPoint)
    func postUnicodeText(_ utf16Units: [UniChar])
    func postKey(code: CGKeyCode, flags: CGEventFlags)
    func topWindowOwnerPID(at location: CGPoint) -> pid_t?
}

@MainActor
final class LiveDesktopInputEventSink: DesktopInputEventSink {
    func postMouse(type: CGEventType, location: CGPoint, button: CGMouseButton) {
        CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: location, mouseButton: button)?
            .post(tap: .cghidEventTap)
    }

    func postScroll(deltaY: Int32, location: CGPoint) {
        let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 1,
            wheel1: deltaY,
            wheel2: 0,
            wheel3: 0
        )
        event?.location = location
        event?.post(tap: .cghidEventTap)
    }

    func postUnicodeText(_ utf16Units: [UniChar]) {
        for isDown in [true, false] {
            let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: isDown)
            utf16Units.withUnsafeBufferPointer { buffer in
                event?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            }
            event?.post(tap: .cghidEventTap)
        }
    }

    func postKey(code: CGKeyCode, flags: CGEventFlags) {
        for isDown in [true, false] {
            let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: isDown)
            event?.flags = flags
            event?.post(tap: .cghidEventTap)
        }
    }

    func topWindowOwnerPID(at location: CGPoint) -> pid_t? {
        guard let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        return windows.first(where: { row in
            guard row[kCGWindowLayer as String] as? Int == 0,
                  let rect = row[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: rect as CFDictionary) else { return false }
            return bounds.contains(location)
        })?[kCGWindowOwnerPID as String] as? pid_t
    }
}

protocol DesktopCaptureHandle: AnyObject, Sendable {
    func stopCapture() async
}

protocol DesktopCaptureFactory: AnyObject, Sendable {
    func startCapture(
        displayId: CGDirectDisplayID,
        width: Int,
        height: Int,
        fps: Int,
        stopped: @escaping @Sendable () -> Void
    ) async throws -> any DesktopCaptureHandle
}

@MainActor
protocol DesktopMediaRoom: AnyObject {
    var isConnected: Bool { get }
    func hasRemoteParticipant(identity: String) -> Bool
    func connect(url: String, token: String) async throws
    func publishCapture(_ capture: any DesktopCaptureHandle, bitrate: Int, fps: Int) async throws -> String
    func unpublishCurrent() async throws
    func disconnect() async
}

@MainActor
protocol DesktopMediaRoomFactory: AnyObject {
    func createRoom(sharedKey: String) -> any DesktopMediaRoom
}

final class DesktopVideoOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let capturer: BufferCapturer
    let stopped: @Sendable () -> Void
    private let lock = NSLock()
    private var frames = 0

    init(capturer: BufferCapturer, stopped: @escaping @Sendable () -> Void) {
        self.capturer = capturer
        self.stopped = stopped
    }

    var frameCount: Int { lock.withLock { frames } }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, buffer.isValid, CMSampleBufferGetImageBuffer(buffer) != nil else { return }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let value = attachments.first?[.status] as? Int, value != SCFrameStatus.complete.rawValue { return }
        capturer.capture(buffer)
        lock.withLock { frames += 1 }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        stopped()
    }
}

final class DesktopCapture: DesktopCaptureHandle, @unchecked Sendable {
    let stream: SCStream
    let output: DesktopVideoOutput
    let track: LocalVideoTrack

    init(stream: SCStream, output: DesktopVideoOutput, track: LocalVideoTrack) {
        self.stream = stream
        self.output = output
        self.track = track
    }

    func stopCapture() async {
        try? await stream.stopCapture()
    }
}

@concurrent func desktopCapture(
    displayId: CGDirectDisplayID,
    width: Int,
    height: Int,
    fps: Int,
    stopped: @escaping @Sendable () -> Void
) async throws -> DesktopCapture {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
        throw DesktopFailure.code("desktop-display-unavailable")
    }
    let track = await LocalVideoTrack.createBufferTrack(
        source: .screenShareVideo,
        options: BufferCaptureOptions(
            dimensions: Dimensions(width: Int32(width), height: Int32(height)),
            fps: fps
        )
    )
    guard let capturer = track.capturer as? BufferCapturer else {
        throw DesktopFailure.code("desktop-capture-unavailable")
    }
    let output = DesktopVideoOutput(capturer: capturer, stopped: stopped)
    let config = SCStreamConfiguration()
    config.width = width
    config.height = height
    config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    config.queueDepth = 3
    config.showsCursor = true
    config.scalesToFit = true
    config.capturesAudio = false
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let stream = SCStream(filter: filter, configuration: config, delegate: output)
    try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "codelync.desktop.frames"))
    try await stream.startCapture()
    // Publishing needs real capture dimensions, established by the first frame.
    for _ in 0..<100 {
        if output.frameCount > 0 {
            return DesktopCapture(stream: stream, output: output, track: track)
        }
        try await Task.sleep(for: .milliseconds(20))
    }
    try? await stream.stopCapture()
    throw DesktopFailure.code("desktop-capture-unavailable")
}

final class LiveDesktopCaptureFactory: DesktopCaptureFactory, @unchecked Sendable {
    func startCapture(
        displayId: CGDirectDisplayID,
        width: Int,
        height: Int,
        fps: Int,
        stopped: @escaping @Sendable () -> Void
    ) async throws -> any DesktopCaptureHandle {
        try await desktopCapture(displayId: displayId, width: width, height: height, fps: fps, stopped: stopped)
    }
}

@MainActor
final class LiveDesktopMediaRoom: DesktopMediaRoom {
    private let room: Room
    private var publication: LocalTrackPublication?

    init(sharedKey: String) {
        let provider = BaseKeyProvider(isSharedKey: true, sharedKey: sharedKey)
        // Legacy media E2EE interoperates with the phone's pinned WebRTC 137 SDK.
        // Desktop input uses the separate authenticated sealed peer transport.
        self.room = Room(roomOptions: RoomOptions(e2eeOptions: E2EEOptions(keyProvider: provider)))
    }

    var isConnected: Bool {
        room.connectionState == .connected
    }

    func hasRemoteParticipant(identity: String) -> Bool {
        room.remoteParticipants.values.contains(where: { $0.identity?.stringValue == identity })
    }

    func connect(url: String, token: String) async throws {
        try await room.connect(url: url, token: token)
    }

    func publishCapture(_ capture: any DesktopCaptureHandle, bitrate: Int, fps: Int) async throws -> String {
        guard let liveCapture = capture as? DesktopCapture else {
            throw DesktopFailure.code("desktop-capture-unavailable")
        }
        let encoding = VideoEncoding(maxBitrate: bitrate, maxFps: fps)
        let pub = try await room.localParticipant.publish(
            videoTrack: liveCapture.track,
            options: VideoPublishOptions(screenShareEncoding: encoding, simulcast: false, preferredCodec: .h264)
        )
        self.publication = pub
        return pub.sid.stringValue
    }

    func unpublishCurrent() async throws {
        guard let previous = publication else { return }
        publication = nil
        if room.connectionState == .connected {
            try await room.localParticipant.unpublish(publication: previous)
        }
    }

    func disconnect() async {
        publication = nil
        await room.disconnect()
    }
}

@MainActor
final class LiveDesktopMediaRoomFactory: DesktopMediaRoomFactory {
    func createRoom(sharedKey: String) -> any DesktopMediaRoom {
        LiveDesktopMediaRoom(sharedKey: sharedKey)
    }
}

@MainActor
private final class RoomDisconnectState {
    private(set) var completed = false
    private var finished = false
    private var continuation: CheckedContinuation<Void, Never>?

    func markCompleted() {
        completed = true
        resolveWaiter()
    }

    func resolveWaiter() {
        guard !finished else { return }
        finished = true
        let saved = continuation
        continuation = nil
        saved?.resume()
    }

    func waitUntilResolved() async {
        if completed || finished {
            finished = true
            return
        }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            if completed || finished {
                finished = true
                cont.resume()
            } else {
                continuation = cont
            }
        }
    }
}

private final class EarlyStopBox: @unchecked Sendable {
    private let lock = NSLock()
    private var armed = false
    private var stoppedBeforeArm = false

    func recordStopShouldPropagate() -> Bool {
        lock.withLock {
            if armed {
                return true
            }
            stoppedBeforeArm = true
            return false
        }
    }

    func markArmedIfAlive() -> Bool {
        lock.withLock {
            if stoppedBeforeArm {
                return false
            }
            armed = true
            return true
        }
    }
}

@MainActor
public final class DesktopHost {
    public static func disableLiveKitLogging() {
        LiveKitSDK.disableLogging()
    }

    public let stateDir: String?
    let displaySystem: any DesktopDisplaySystem
    let permissionProvider: any DesktopPermissionProviding
    let inputSink: any DesktopInputEventSink
    let captureFactory: any DesktopCaptureFactory
    let roomFactory: any DesktopMediaRoomFactory
    let virtualDisplayCoordinator: VirtualDisplayCoordinator
    var windowCoordinator: (any DesktopWindowCoordinating)?
    var outputEmitter: ([String: Any]) -> Void

    var room: (any DesktopMediaRoom)?
    var currentTrackSid: String?
    var capture: (any DesktopCaptureHandle)?
    var captureGeneration = ""
    var pendingCaptureAttempt = ""
    var selectedDisplay: CGDirectDisplayID?
    var selectedDisplayIsVirtual = false
    var selectedDisplayName = ""
    var geometry = ""
    var connection = ""
    var viewer = ""
    var quality: Quality?
    var pressed: CGMouseButton?
    var location = CGPoint.zero
    var lastInput = 0
    var lastSeen = Date()
    var inFlightOperations = 0
    var remoteTargetPID: pid_t?
    var monitor: Task<Void, Never>?
    var viewEpoch = UUID().uuidString
    var viewDirty = false
    var spaceChanges = 0
    var spaceObserver: NotificationObserverBox?
    static let stopTotalBudget: Duration = .milliseconds(4300)
    static let stopWindowRestoreBudget: Duration = .milliseconds(750)
    static let switchDisplayWindowRestoreBudget: Duration = .milliseconds(2500)
    private var activeStopTask: Task<Void, Never>?
    private(set) var shutdownRequested = false
    private(set) var shutdownDeadline: ContinuousClock.Instant?
    private var startupReconciled = false

    public convenience init(stateDir: String? = nil) {
        let protector = PhysicalDisplayModeProtector(stateDir: stateDir, environment: .live)
        let coordinator = VirtualDisplayCoordinator(
            provider: LiveCGVirtualDisplayProvider(),
            protector: protector,
            environment: .live
        )
        let windowCoord = WindowCoordinator(stateDir: stateDir, driver: MacAccessibilityWindowDriver())
        self.init(
            stateDir: stateDir,
            displaySystem: LiveDesktopDisplaySystem(),
            permissionProvider: LiveDesktopPermissionProvider(),
            inputSink: LiveDesktopInputEventSink(),
            captureFactory: LiveDesktopCaptureFactory(),
            roomFactory: LiveDesktopMediaRoomFactory(),
            virtualDisplayCoordinator: coordinator,
            windowCoordinator: windowCoord,
            observeWorkspaceSpaces: true,
            outputEmitter: { value in
                guard let bytes = try? JSONSerialization.data(withJSONObject: value) else { return }
                FileHandle.standardOutput.write(bytes + Data([10]))
            }
        )
    }

    init(
        stateDir: String? = nil,
        displaySystem: any DesktopDisplaySystem,
        permissionProvider: any DesktopPermissionProviding,
        inputSink: any DesktopInputEventSink,
        captureFactory: any DesktopCaptureFactory,
        roomFactory: any DesktopMediaRoomFactory,
        virtualDisplayCoordinator: VirtualDisplayCoordinator,
        windowCoordinator: (any DesktopWindowCoordinating)? = nil,
        observeWorkspaceSpaces: Bool = false,
        outputEmitter: @escaping ([String: Any]) -> Void = { _ in }
    ) {
        self.stateDir = stateDir
        self.displaySystem = displaySystem
        self.permissionProvider = permissionProvider
        self.inputSink = inputSink
        self.captureFactory = captureFactory
        self.roomFactory = roomFactory
        self.virtualDisplayCoordinator = virtualDisplayCoordinator
        self.windowCoordinator = windowCoordinator
        self.outputEmitter = outputEmitter
        windowCoordinator?.attach(host: self)

        virtualDisplayCoordinator.onUnexpectedTermination = { [weak self] terminatedID in
            guard let self, self.selectedDisplayIsVirtual, self.selectedDisplay == terminatedID else { return }
            Task { @MainActor in
                await self.stop()
                self.emit(["type": "desktop-stopped"])
            }
        }

        if observeWorkspaceSpaces {
            let center = NSWorkspace.shared.notificationCenter
            let token = center.addObserver(
                forName: NSWorkspace.activeSpaceDidChangeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.spaceDidChange() }
            }
            spaceObserver = NotificationObserverBox(center: center, token: token)
        }
    }

    public func reconcileStartupStateIfNeeded() async {
        guard stateDir != nil else { return }
        if !startupReconciled {
            startupReconciled = true
            await virtualDisplayCoordinator.protector.reconcileStartupIfNeeded()
        }
        if permissionProvider.accessibilityGranted() {
            await windowCoordinator?.recoverIfTrusted()
        }
    }

    func invalidateView() {
        viewEpoch = UUID().uuidString
        guard !connection.isEmpty, let id = selectedDisplay else { return }
        releasePointer()
        remoteTargetPID = nil
        geometry = displayStamp(id)
        viewDirty = true
        emit(["type": "desktop-view-invalidated", "connectionId": connection])
    }

    func spaceDidChange() {
        spaceChanges += 1
        invalidateView()
    }

    func emit(_ value: [String: Any]) {
        outputEmitter(value)
    }

    func locked() -> Bool {
        permissionProvider.isSessionLocked()
    }

    func permissions() -> [String: Any] {
        [
            "screenRecording": permissionProvider.screenRecordingGranted(),
            "accessibility": permissionProvider.accessibilityGranted(),
            "locked": locked()
        ]
    }

    func isOwnedVirtualDisplay(_ id: CGDirectDisplayID) -> Bool {
        virtualDisplayCoordinator.isOwnedVirtualDisplay(
            id,
            vendorID: displaySystem.vendorID(of: id),
            modelID: displaySystem.modelID(of: id)
        )
    }

    func activePhysicalDisplayIDs() throws -> [CGDirectDisplayID] {
        guard let ids = displaySystem.activeDisplayIDs() else {
            throw DesktopFailure.code("desktop-display-unavailable")
        }
        return ids.filter { !isOwnedVirtualDisplay($0) }
    }

    func physicalDisplayLabel(for id: CGDirectDisplayID, in physicalIDs: [CGDirectDisplayID]) -> String {
        let mainID = displaySystem.mainDisplayID()
        if id == mainID && !isOwnedVirtualDisplay(mainID) {
            return "Main display"
        }
        if let idx = physicalIDs.firstIndex(of: id) {
            if idx == 0 && isOwnedVirtualDisplay(mainID) {
                return "Main display"
            }
            return "Display \(idx + 1)"
        }
        return "Display"
    }

    func displayStamp(_ id: CGDirectDisplayID) -> String {
        let bounds = displaySystem.bounds(of: id)
        let size = displaySystem.pixels(of: id)
        return "\(id):\(bounds.origin.x):\(bounds.origin.y):\(bounds.width):\(bounds.height):\(size.width):\(size.height):\(viewEpoch)"
    }

    func displayPixels(_ id: CGDirectDisplayID) -> (width: Int, height: Int) {
        displaySystem.pixels(of: id)
    }

    func virtualInventoryRow() -> [String: Any] {
        if let virtualCGID = virtualDisplayCoordinator.activeVirtualDisplayID,
           displaySystem.isOnline(virtualCGID) {
            let bounds = displaySystem.bounds(of: virtualCGID)
            let size = displaySystem.pixels(of: virtualCGID)
            let logicalW = max(1, Int(bounds.width.rounded()))
            let logicalH = max(1, Int(bounds.height.rounded()))
            return [
                "id": "virtual",
                "name": VirtualDisplayHardwareSpec.displayName,
                "kind": "virtual",
                "width": size.width,
                "height": size.height,
                "logicalWidth": logicalW,
                "logicalHeight": logicalH,
                "geometry": displayStamp(virtualCGID)
            ]
        }
        return [
            "id": "virtual",
            "name": VirtualDisplayHardwareSpec.displayName,
            "kind": "virtual",
            "width": 1080,
            "height": 2160,
            "logicalWidth": 540,
            "logicalHeight": 1080,
            "geometry": "virtual:0.0:0.0:540.0:1080.0:1080:2160:\(viewEpoch)"
        ]
    }

    func displayRows() throws -> [[String: Any]] {
        let physicalIDs = try activePhysicalDisplayIDs()
        var rows: [[String: Any]] = physicalIDs.map { id in
            let bounds = displaySystem.bounds(of: id)
            let size = displaySystem.pixels(of: id)
            let logicalW = max(1, Int(bounds.width.rounded()))
            let logicalH = max(1, Int(bounds.height.rounded()))
            return [
                "id": String(id),
                "name": physicalDisplayLabel(for: id, in: physicalIDs),
                "kind": "physical",
                "width": size.width,
                "height": size.height,
                "logicalWidth": logicalW,
                "logicalHeight": logicalH,
                "geometry": displayStamp(id)
            ]
        }
        if virtualDisplayCoordinator.isSupported {
            rows.append(virtualInventoryRow())
        }
        if rows.isEmpty {
            throw DesktopFailure.code("desktop-display-unavailable")
        }
        return rows
    }

    func activeDisplayRow(id: CGDirectDisplayID, stamp: String) -> [String: Any] {
        let bounds = displaySystem.bounds(of: id)
        let size = displaySystem.pixels(of: id)
        let logicalW = max(1, Int(bounds.width.rounded()))
        let logicalH = max(1, Int(bounds.height.rounded()))
        if selectedDisplayIsVirtual {
            return [
                "id": "virtual",
                "name": VirtualDisplayHardwareSpec.displayName,
                "kind": "virtual",
                "width": size.width,
                "height": size.height,
                "logicalWidth": logicalW,
                "logicalHeight": logicalH,
                "geometry": stamp
            ]
        }
        let fallbackLabel: String
        if !selectedDisplayName.isEmpty {
            fallbackLabel = selectedDisplayName
        } else {
            let physicalIDs = (try? activePhysicalDisplayIDs()) ?? []
            fallbackLabel = physicalDisplayLabel(for: id, in: physicalIDs)
        }
        return [
            "id": String(id),
            "name": fallbackLabel,
            "kind": "physical",
            "width": size.width,
            "height": size.height,
            "logicalWidth": logicalW,
            "logicalHeight": logicalH,
            "geometry": stamp
        ]
    }

    func status() -> [String: Any] {
        var result: [String: Any] = [
            "permissions": permissions(),
            "capturing": currentTrackSid != nil,
            "connected": room?.isConnected == true,
            "viewPending": viewDirty,
            "spaceChanges": spaceChanges,
            "viewerConnected": room?.hasRemoteParticipant(identity: viewer) == true
        ]
        if let id = selectedDisplay {
            let stamp = displayStamp(id)
            result["geometry"] = stamp
            result["display"] = activeDisplayRow(id: id, stamp: stamp)
            if selectedDisplayIsVirtual {
                if let activeWindowId = windowCoordinator?.activeWindowId {
                    result["activeWindowId"] = activeWindowId
                } else if windowCoordinator is WindowCoordinator {
                    result["activeWindowId"] = NSNull()
                }
            }
        }
        if let quality {
            result["quality"] = quality.json
        }
        if let currentTrackSid {
            result["trackSid"] = currentTrackSid
        }
        return result
    }

    func releasePointer() {
        if let button = pressed {
            let kind: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
            inputSink.postMouse(type: kind, location: location, button: button)
        }
        pressed = nil
    }

    func disarmActiveCaptureGeneration() {
        releasePointer()
        pendingCaptureAttempt = ""
        captureGeneration = ""
    }

    func retireActiveCapture(unpublishFromRoom: Bool) async {
        disarmActiveCaptureGeneration()
        let oldCapture = capture
        capture = nil
        await oldCapture?.stopCapture()
        if unpublishFromRoom {
            currentTrackSid = nil
            if let room, room.isConnected {
                try? await room.unpublishCurrent()
            }
        } else {
            currentTrackSid = nil
        }
    }

    public func stop(isShuttingDown: Bool = false) async {
        if isShuttingDown {
            shutdownRequested = true
            if shutdownDeadline == nil {
                shutdownDeadline = virtualDisplayCoordinator.now() + Self.stopTotalBudget
            }
        }
        if let inFlight = activeStopTask {
            await inFlight.value
            return
        }
        let initialDeadline = shutdownDeadline ?? (virtualDisplayCoordinator.now() + Self.stopTotalBudget)
        let task = Task { @MainActor in
            await self.performStop(initialDeadline: initialDeadline)
        }
        activeStopTask = task
        await task.value
        activeStopTask = nil
        shutdownRequested = false
        shutdownDeadline = nil
    }

    private func performStop(initialDeadline: ContinuousClock.Instant) async {
        let effectiveDeadline: @MainActor () -> ContinuousClock.Instant = { [weak self] in
            if let shutdownDeadline = self?.shutdownDeadline, shutdownDeadline < initialDeadline {
                return shutdownDeadline
            }
            return initialDeadline
        }

        monitor?.cancel()
        monitor = nil
        disarmActiveCaptureGeneration()

        await windowCoordinator?.restoreAllBeforeVirtualTeardown(
            isShuttingDownProvider: { [weak self] in self?.shutdownRequested == true },
            deadlineProvider: { [weak self] in
                guard let self else { return initialDeadline }
                let stopLimit = effectiveDeadline()
                let capped = self.virtualDisplayCoordinator.now() + Self.stopWindowRestoreBudget
                return capped < stopLimit ? capped : stopLimit
            }
        )

        let previousRoom = room
        room = nil
        selectedDisplay = nil
        selectedDisplayIsVirtual = false
        selectedDisplayName = ""

        await retireActiveCapture(unpublishFromRoom: false)

        connection = ""
        viewer = ""
        geometry = ""
        quality = nil
        lastInput = 0
        remoteTargetPID = nil
        viewDirty = false

        let disconnectState = RoomDisconnectState()
        let disconnectTask: Task<Void, Never>?
        if let previousRoom {
            disconnectTask = Task { @MainActor in
                await previousRoom.disconnect()
                disconnectState.markCompleted()
            }
        } else {
            disconnectState.markCompleted()
            disconnectTask = nil
        }

        await virtualDisplayCoordinator.teardownAndRestorePhysicalDisplays(
            isShuttingDownProvider: { [weak self] in self?.shutdownRequested == true },
            deadlineProvider: { effectiveDeadline() }
        )

        if !disconnectState.completed {
            await Task.yield()
        }
        if !disconnectState.completed, let disconnectTask {
            let remaining = virtualDisplayCoordinator.now().duration(to: effectiveDeadline())
            if remaining > .zero {
                let coordinator = virtualDisplayCoordinator
                let timeoutWatcher = Task { @MainActor in
                    await Task.yield()
                    guard !Task.isCancelled, !disconnectState.completed else { return }
                    await coordinator.sleep(remaining)
                    disconnectState.resolveWaiter()
                }
                await disconnectState.waitUntilResolved()
                timeoutWatcher.cancel()
            }
            if !disconnectState.completed {
                disconnectTask.cancel()
            }
        }
    }

    func publish(_ next: Quality) async throws {
        releasePointer()
        guard let room, room.isConnected, let id = selectedDisplay else {
            throw DesktopFailure.code("desktop-display-unavailable")
        }
        await retireActiveCapture(unpublishFromRoom: true)

        let size = displayPixels(id)
        let (width, height) = DesktopCaptureMath.captureDimensions(
            nativeWidth: size.width,
            nativeHeight: size.height,
            maxLongEdge: next.width
        )
        let generation = UUID().uuidString
        pendingCaptureAttempt = generation
        let earlyStopBox = EarlyStopBox()
        let nextCapture: any DesktopCaptureHandle
        do {
            nextCapture = try await captureFactory.startCapture(
                displayId: id,
                width: width,
                height: height,
                fps: next.fps
            ) { [weak self] in
                guard earlyStopBox.recordStopShouldPropagate() else { return }
                Task { @MainActor in
                    guard let self, self.captureGeneration == generation else { return }
                    await self.stop()
                    self.emit(["type": "desktop-stopped"])
                }
            }
        } catch {
            if pendingCaptureAttempt == generation {
                pendingCaptureAttempt = ""
            }
            throw error
        }
        guard self.room === room, pendingCaptureAttempt == generation else {
            await nextCapture.stopCapture()
            throw DesktopFailure.code("desktop-disconnected")
        }
        pendingCaptureAttempt = ""
        guard earlyStopBox.markArmedIfAlive() else {
            await nextCapture.stopCapture()
            throw DesktopFailure.code("desktop-capture-unavailable")
        }
        capture = nextCapture
        captureGeneration = generation
        let sid: String
        do {
            sid = try await room.publishCapture(nextCapture, bitrate: next.bitrate, fps: next.fps)
        } catch {
            if captureGeneration == generation {
                capture = nil
                captureGeneration = ""
            }
            await nextCapture.stopCapture()
            throw error
        }
        guard self.room === room, captureGeneration == generation else {
            await nextCapture.stopCapture()
            throw DesktopFailure.code("desktop-disconnected")
        }
        currentTrackSid = sid
        quality = next
    }

    func begin(_ value: [String: Any]) async throws -> [String: Any] {
        if stateDir != nil && permissionProvider.accessibilityGranted() {
            await windowCoordinator?.recoverIfTrusted()
        }
        guard permissionProvider.screenRecordingGranted() else {
            throw DesktopFailure.code("desktop-screen-permission-required")
        }
        guard !locked() else {
            throw DesktopFailure.code("desktop-locked")
        }
        guard let idString = value["displayId"] as? String, !idString.isEmpty,
              let url = value["url"] as? String, !url.isEmpty,
              let token = value["token"] as? String, !token.isEmpty,
              let secret = value["key"] as? String, secret.count >= 32,
              let connection = value["connectionId"] as? String, !connection.isEmpty,
              let viewer = value["viewer"] as? String, !viewer.isEmpty,
              let rawQuality = value["quality"] as? [String: Any] else {
            throw DesktopFailure.code("invalid-desktop-start")
        }

        let isVirtual = (idString == "virtual")
        let requestedPhysicalID: CGDirectDisplayID?
        if isVirtual {
            requestedPhysicalID = nil
        } else if let parsedID = UInt32(idString), parsedID != kCGNullDirectDisplay {
            requestedPhysicalID = parsedID
        } else {
            throw DesktopFailure.code("invalid-desktop-start")
        }

        let next = try Quality(rawQuality)
        let viewport = try DesktopViewport.resolve(from: value, isVirtual: isVirtual)

        if isVirtual && !virtualDisplayCoordinator.isSupported {
            throw DesktopFailure.code("desktop-virtual-display-unavailable")
        }

        await stop()

        let targetID: CGDirectDisplayID
        let targetName: String
        if isVirtual {
            let mounted = try await virtualDisplayCoordinator.mountOrUpdate(viewport: viewport ?? .defaultPortrait)
            targetID = mounted.displayID
            targetName = VirtualDisplayHardwareSpec.displayName
        } else if let physicalID = requestedPhysicalID {
            let physicalIDs = try activePhysicalDisplayIDs()
            guard physicalIDs.contains(physicalID) else {
                throw DesktopFailure.code("desktop-display-unavailable")
            }
            targetID = physicalID
            targetName = physicalDisplayLabel(for: physicalID, in: physicalIDs)
        } else {
            throw DesktopFailure.code("invalid-desktop-start")
        }

        let mediaRoom = roomFactory.createRoom(sharedKey: secret)
        self.room = mediaRoom
        self.connection = connection
        self.viewer = viewer
        self.selectedDisplay = targetID
        self.selectedDisplayIsVirtual = isVirtual
        self.selectedDisplayName = targetName
        let publishEpoch = UUID().uuidString
        self.viewEpoch = publishEpoch
        self.viewDirty = false
        self.geometry = displayStamp(targetID)
        self.lastSeen = Date()

        do {
            try await mediaRoom.connect(url: url, token: token)
            try await publish(next)
            if viewEpoch != publishEpoch {
                viewDirty = true
                try await refreshView()
            } else {
                geometry = displayStamp(targetID)
            }
        } catch {
            await stop()
            throw DesktopFailure.code("desktop-media-connect-failed")
        }

        lastSeen = Date()
        monitor = Task { [weak self] in
            var sawViewer = false
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, let self else { return }
                let viewerPresent = self.room?.hasRemoteParticipant(identity: self.viewer) == true
                if viewerPresent { sawViewer = true }
                if self.shouldStopForMonitorTick(sawViewer: sawViewer, viewerPresent: viewerPresent) {
                    await self.stop()
                    self.emit(["type": "desktop-stopped"])
                    return
                }
            }
        }
        return status()
    }

    func shouldStopForMonitorTick(
        now: Date = Date(),
        sawViewer: Bool,
        viewerPresent: Bool
    ) -> Bool {
        locked() ||
        !permissionProvider.screenRecordingGranted() ||
        (inFlightOperations == 0 && now.timeIntervalSince(lastSeen) > 15) ||
        room?.isConnected != true ||
        (sawViewer && !viewerPresent)
    }

    func switchDisplay(_ value: [String: Any]) async throws -> [String: Any] {
        try requireActive(value)
        guard let quality else {
            throw DesktopFailure.code("desktop-display-unavailable")
        }
        guard let requested = value["displayId"] as? String, !requested.isEmpty else {
            throw DesktopFailure.code("desktop-display-unavailable")
        }

        if requested == "virtual" {
            let viewport = try DesktopViewport.resolve(from: value, isVirtual: true) ?? .defaultPortrait
            guard virtualDisplayCoordinator.isSupported else {
                throw DesktopFailure.code("desktop-virtual-display-unavailable")
            }

            disarmActiveCaptureGeneration()
            invalidateView()
            if selectedDisplayIsVirtual {
                await windowCoordinator?.restoreAllBeforeVirtualTeardown(
                    isShuttingDownProvider: { [weak self] in self?.shutdownRequested == true },
                    deadlineProvider: { [weak self] in
                        guard let self else { return nil }
                        let capped = self.virtualDisplayCoordinator.now() + Self.switchDisplayWindowRestoreBudget
                        if let shutdownDeadline = self.shutdownDeadline, shutdownDeadline < capped {
                            return shutdownDeadline
                        }
                        return capped
                    }
                )
            }
            await retireActiveCapture(unpublishFromRoom: true)
            remoteTargetPID = nil

            do {
                let mounted = try await virtualDisplayCoordinator.mountOrUpdate(viewport: viewport)
                lastSeen = Date()
                selectedDisplay = mounted.displayID
                selectedDisplayIsVirtual = true
                selectedDisplayName = VirtualDisplayHardwareSpec.displayName
                let publishEpoch = UUID().uuidString
                viewEpoch = publishEpoch
                viewDirty = false
                geometry = displayStamp(mounted.displayID)

                try await publish(quality)
                if viewEpoch != publishEpoch {
                    viewDirty = true
                    try await refreshView()
                } else {
                    geometry = displayStamp(mounted.displayID)
                }
                lastSeen = Date()
                return status()
            } catch {
                await stop()
                throw error
            }
        }

        _ = try DesktopViewport.resolve(from: value, isVirtual: false)
        guard let requestedID = UInt32(requested),
              requestedID != kCGNullDirectDisplay,
              !isOwnedVirtualDisplay(requestedID) else {
            throw DesktopFailure.code("desktop-display-unavailable")
        }

        let preSwitchPhysical = try activePhysicalDisplayIDs()
        let wasVirtual = selectedDisplayIsVirtual
        let wasHeadlessWhileVirtual = wasVirtual && preSwitchPhysical.isEmpty

        if !wasHeadlessWhileVirtual {
            guard preSwitchPhysical.contains(requestedID) else {
                throw DesktopFailure.code("desktop-display-unavailable")
            }
        }

        disarmActiveCaptureGeneration()
        invalidateView()
        if wasVirtual {
            await windowCoordinator?.restoreAllBeforeVirtualTeardown(
                isShuttingDownProvider: { [weak self] in self?.shutdownRequested == true },
                deadlineProvider: { [weak self] in
                    guard let self else { return nil }
                    let capped = self.virtualDisplayCoordinator.now() + Self.switchDisplayWindowRestoreBudget
                    if let shutdownDeadline = self.shutdownDeadline, shutdownDeadline < capped {
                        return shutdownDeadline
                    }
                    return capped
                }
            )
        }
        await retireActiveCapture(unpublishFromRoom: true)
        remoteTargetPID = nil

        do {
            if wasVirtual {
                await virtualDisplayCoordinator.teardownAndRestorePhysicalDisplays(
                    isShuttingDownProvider: { [weak self] in self?.shutdownRequested == true },
                    deadlineProvider: { [weak self] in self?.shutdownDeadline }
                )
                lastSeen = Date()
            }

            let resolvedTargetID = try await resolvePhysicalDisplayAfterSwitch(
                requestedID: requestedID,
                allowHeadlessFallback: wasHeadlessWhileVirtual
            )
            let currentPhysical = (try? activePhysicalDisplayIDs()) ?? [resolvedTargetID]
            selectedDisplay = resolvedTargetID
            selectedDisplayIsVirtual = false
            selectedDisplayName = physicalDisplayLabel(for: resolvedTargetID, in: currentPhysical)

            let publishEpoch = UUID().uuidString
            viewEpoch = publishEpoch
            viewDirty = false
            geometry = displayStamp(resolvedTargetID)

            try await publish(quality)
            if viewEpoch != publishEpoch {
                viewDirty = true
                try await refreshView()
            } else {
                geometry = displayStamp(resolvedTargetID)
            }
            lastSeen = Date()
            return status()
        } catch {
            await stop()
            throw error
        }
    }

    private func resolvePhysicalDisplayAfterSwitch(
        requestedID: CGDirectDisplayID,
        allowHeadlessFallback: Bool
    ) async throws -> CGDirectDisplayID {
        let clock = ContinuousClock()
        let deadline = clock.now + displaySystem.headlessFallbackPollTimeout
        while true {
            let physicalIDs = (try? activePhysicalDisplayIDs()) ?? []
            if physicalIDs.contains(requestedID) {
                if !allowHeadlessFallback {
                    return requestedID
                }
                if await displaySystem.isShareableDisplayAvailable(requestedID) {
                    return requestedID
                }
            } else if allowHeadlessFallback, let fallbackID = physicalIDs.first {
                if await displaySystem.isShareableDisplayAvailable(fallbackID) {
                    return fallbackID
                }
            }
            if clock.now >= deadline {
                selectedDisplay = nil
                selectedDisplayIsVirtual = false
                selectedDisplayName = ""
                throw DesktopFailure.code("desktop-display-unavailable")
            }
            await displaySystem.sleep(displaySystem.headlessFallbackPollInterval)
        }
    }

    @discardableResult
    func upshiftVirtualDisplayForWindowFill(minimumWidth targetWidth: Int) async throws -> MountedVirtualDisplay {
        guard selectedDisplayIsVirtual,
              let activeID = virtualDisplayCoordinator.activeVirtualDisplayID,
              selectedDisplay == activeID else {
            throw DesktopFailure.code("desktop-virtual-display-required")
        }
        guard let currentSize = virtualDisplayCoordinator.currentLogicalSize,
              let ladder = virtualDisplayCoordinator.currentLadder else {
            throw DesktopFailure.code("desktop-virtual-display-unavailable")
        }
        let step = ladder.stepForUpshift(minimumWidth: targetWidth)
        guard step.logicalWidth != currentSize.width || step.logicalHeight != currentSize.height else {
            return MountedVirtualDisplay(
                displayID: activeID,
                logicalWidth: currentSize.width,
                logicalHeight: currentSize.height,
                ladder: ladder
            )
        }

        disarmActiveCaptureGeneration()
        if !viewDirty {
            invalidateView()
        }
        await retireActiveCapture(unpublishFromRoom: true)

        do {
            let mounted = try await virtualDisplayCoordinator.upshiftWidth(to: step.logicalWidth)
            selectedDisplay = mounted.displayID
            geometry = displayStamp(mounted.displayID)
            lastSeen = Date()
            return mounted
        } catch {
            if let quality,
               let room, room.isConnected,
               let id = selectedDisplay,
               displaySystem.isOnline(id) {
                try? await publish(quality)
                if currentTrackSid != nil {
                    geometry = displayStamp(id)
                    viewDirty = false
                } else {
                    await stop()
                }
            } else {
                await stop()
            }
            throw error
        }
    }

    func completeWindowMutationViewRefresh() async throws -> [String: Any] {
        if !viewDirty {
            invalidateView()
        }
        try await refreshView()
        lastSeen = Date()
        return status()
    }

    func requireActive(_ value: [String: Any]) throws {
        guard value["connectionId"] as? String == connection,
              !connection.isEmpty,
              room?.isConnected == true,
              currentTrackSid != nil else {
            throw DesktopFailure.code("desktop-disconnected")
        }
        guard !viewDirty else {
            throw DesktopFailure.code("desktop-view-changed")
        }
        guard let id = selectedDisplay,
              value["geometry"] as? String == geometry,
              displayStamp(id) == geometry else {
            releasePointer()
            throw DesktopFailure.code("desktop-display-changed")
        }
        guard !locked(), permissionProvider.screenRecordingGranted() else {
            releasePointer()
            throw DesktopFailure.code("desktop-locked")
        }
        lastSeen = Date()
    }

    func heartbeat(_ value: [String: Any]) async throws -> [String: Any] {
        guard value["connectionId"] as? String == connection,
              !connection.isEmpty,
              room?.isConnected == true,
              selectedDisplay != nil else {
            throw DesktopFailure.code("desktop-disconnected")
        }
        guard !locked(), permissionProvider.screenRecordingGranted() else {
            throw DesktopFailure.code("desktop-locked")
        }
        lastSeen = Date()
        if let id = selectedDisplay, !viewDirty, (displayStamp(id) != geometry || currentTrackSid == nil) {
            invalidateView()
        }
        try await refreshView()
        return status()
    }

    func refreshView() async throws {
        for _ in 0..<3 {
            guard viewDirty, let quality else { return }
            let revision = viewEpoch
            viewDirty = false
            if let id = selectedDisplay {
                geometry = displayStamp(id)
            }
            do {
                try await publish(quality)
            } catch {
                viewDirty = true
                throw error
            }
            if revision != viewEpoch {
                viewDirty = true
            } else if let id = selectedDisplay {
                geometry = displayStamp(id)
            }
        }
    }

    func spaceShortcut(_ kind: String) throws -> (CGKeyCode, CGEventFlags) {
        let identifier = kind == "previous" ? "79" : "81"
        let defaults: (CGKeyCode, CGEventFlags) = (kind == "previous" ? 123 : 124, [.maskControl, .maskSecondaryFn])
        let domain = UserDefaults.standard.persistentDomain(forName: "com.apple.symbolichotkeys")
        guard let bindings = domain?["AppleSymbolicHotKeys"] as? [String: Any],
              let binding = bindings[identifier] as? [String: Any] else { return defaults }
        if binding["enabled"] as? Bool == false {
            throw DesktopFailure.code("desktop-space-shortcut-disabled")
        }
        guard let value = binding["value"] as? [String: Any] else { return defaults }
        guard value["type"] as? String == "standard",
              let parameters = value["parameters"] as? [NSNumber],
              parameters.count == 3,
              (0...255).contains(parameters[1].intValue),
              parameters[2].uint64Value <= UInt64(UInt32.max) else {
            throw DesktopFailure.code("desktop-space-shortcut-unavailable")
        }
        return (CGKeyCode(parameters[1].uint16Value), CGEventFlags(rawValue: parameters[2].uint64Value))
    }

    func navigateSpace(_ value: [String: Any]) async throws -> [String: Any] {
        try requireActive(value)
        guard permissionProvider.accessibilityGranted() else {
            throw DesktopFailure.code("desktop-input-permission-required")
        }
        guard let sequence = DesktopJSON.strictInt(value["sequence"]),
              sequence > lastInput,
              sequence <= lastInput + 1024,
              let kind = value["kind"] as? String,
              ["previous", "next", "overview"].contains(kind),
              let display = selectedDisplay else {
            throw DesktopFailure.code("invalid-desktop-space")
        }
        lastInput = sequence
        releasePointer()
        let before = spaceChanges
        if kind == "overview" {
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.exposelauncher") else {
                throw DesktopFailure.code("desktop-space-shortcut-unavailable")
            }
            _ = try await NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
            try await Task.sleep(for: .milliseconds(400))
        } else {
            let (code, flags) = try spaceShortcut(kind)
            let bounds = displaySystem.bounds(of: display)
            let point = CGPoint(x: bounds.midX, y: bounds.midY)
            inputSink.postMouse(type: .mouseMoved, location: point, button: .left)
            inputSink.postKey(code: code, flags: flags)
            for _ in 0..<75 {
                if spaceChanges != before { break }
                try await Task.sleep(for: .milliseconds(20))
            }
        }
        let changed = spaceChanges != before
        // Even a boundary/no-confirmation result gets a fresh publication so
        // old pointer readiness cannot cross a posted system operation.
        if !viewDirty { invalidateView() }
        try await refreshView()
        var result = status()
        result["accepted"] = true
        result["sequence"] = sequence
        result["spaceChanged"] = changed
        result["kind"] = kind
        return result
    }

    func input(_ value: [String: Any]) throws -> [String: Any] {
        try requireActive(value)
        guard permissionProvider.accessibilityGranted() else {
            throw DesktopFailure.code("desktop-input-permission-required")
        }
        guard let sequence = DesktopJSON.strictInt(value["sequence"]),
              sequence > lastInput,
              sequence <= lastInput + 1024,
              let action = value["action"] as? String else {
            throw DesktopFailure.code("desktop-input-replayed")
        }
        lastInput = sequence
        if action == "pointer" {
            let bounds = selectedDisplay.map { displaySystem.bounds(of: $0) }
            let resolved = try DesktopInputMath.resolvePointer(value, displayBounds: bounds)
            location = resolved.location
            let button = resolved.button
            let phase = resolved.phase
            if phase == "move" {
                let moveType: CGEventType = pressed == .right
                    ? .rightMouseDragged
                    : pressed == .left ? .leftMouseDragged : .mouseMoved
                inputSink.postMouse(type: moveType, location: location, button: pressed ?? button)
            }
            if phase == "down" || phase == "click" {
                remoteTargetPID = inputSink.topWindowOwnerPID(at: location)
                releasePointer()
                pressed = button
                inputSink.postMouse(
                    type: button == .right ? .rightMouseDown : .leftMouseDown,
                    location: location,
                    button: button
                )
            }
            if phase == "up" || phase == "click" {
                releasePointer()
            }
        } else if action == "scroll" {
            let bounds = selectedDisplay.map { displaySystem.bounds(of: $0) }
            let resolved = try DesktopInputMath.resolveScroll(value, displayBounds: bounds)
            if let nextLocation = resolved.updatedLocation {
                location = nextLocation
            }
            inputSink.postScroll(deltaY: resolved.deltaY, location: location)
        } else if action == "text" {
            restoreSimulatorTarget()
            guard let text = value["text"] as? String, !text.isEmpty, text.utf16.count <= 2048 else {
                throw DesktopFailure.code("invalid-desktop-input")
            }
            let units = Array(text.utf16)
            inputSink.postUnicodeText(units)
        } else if action == "key" {
            restoreSimulatorTarget()
            let keys: [String: CGKeyCode] = [
                "enter": 36, "tab": 48, "escape": 53, "backspace": 51,
                "delete": 117, "left": 123, "right": 124, "down": 125, "up": 126,
                "space": 49, "a": 0, "c": 8, "v": 9, "x": 7, "z": 6, "s": 1, "f": 3, "w": 13, "r": 15
            ]
            guard let key = value["key"] as? String,
                  let code = keys[key],
                  let modifiers = value["modifiers"] as? [String],
                  modifiers.count <= 4,
                  modifiers.allSatisfy({ ["command", "shift", "option", "control"].contains($0) }) else {
                throw DesktopFailure.code("invalid-desktop-input")
            }
            var flags: CGEventFlags = []
            if modifiers.contains("command") { flags.insert(.maskCommand) }
            if modifiers.contains("shift") { flags.insert(.maskShift) }
            if modifiers.contains("option") { flags.insert(.maskAlternate) }
            if modifiers.contains("control") { flags.insert(.maskControl) }
            inputSink.postKey(code: code, flags: flags)
        } else {
            throw DesktopFailure.code("invalid-desktop-input")
        }
        return ["accepted": true, "sequence": sequence]
    }

    func restoreSimulatorTarget() {
        // A simulator runs on the controlled Mac: touching its keyboard steals
        // foreground focus from the clicked desktop window. Isolated simulator
        // QA restores that real target before keyboard injection; production
        // phone connections continue to use the Mac's current focus.
        guard ProcessInfo.processInfo.environment["CODELYNC_DESKTOP_SIMULATOR_QA"] == "1",
              NSWorkspace.shared.frontmostApplication?.bundleIdentifier?.hasPrefix("com.apple.dt.") == true,
              let pid = remoteTargetPID,
              let app = NSRunningApplication(processIdentifier: pid) else { return }
        app.activate(options: [])
    }

    private func withInFlightOperation<T>(_ body: () async throws -> T) async rethrows -> T {
        inFlightOperations += 1
        if selectedDisplay != nil {
            lastSeen = Date()
        }
        defer {
            inFlightOperations = max(0, inFlightOperations - 1)
            if selectedDisplay != nil {
                lastSeen = Date()
            }
        }
        return try await body()
    }

    public func handle(_ value: [String: Any]) async {
        let id = value["id"] as? String ?? ""
        do {
            let result: [String: Any]
            switch value["operation"] as? String {
            case "status":
                result = status()
            case "displays":
                result = [
                    "displays": try displayRows(),
                    "permissions": permissions(),
                    "virtualDisplaySupported": virtualDisplayCoordinator.isSupported
                ]
            case "request-permissions":
                if value["permission"] as? String == "screenRecording" {
                    permissionProvider.requestScreenRecording()
                } else if value["permission"] as? String == "accessibility" {
                    permissionProvider.requestAccessibility()
                } else {
                    throw DesktopFailure.code("invalid-desktop-permission")
                }
                result = ["permissions": permissions()]
            case "start":
                result = try await begin(value)
            case "quality":
                result = try await withInFlightOperation {
                    try requireActive(value)
                    guard let raw = value["quality"] as? [String: Any] else {
                        throw DesktopFailure.code("invalid-desktop-quality")
                    }
                    let nextQuality = try Quality(raw)
                    let publishEpoch = viewEpoch
                    try await publish(nextQuality)
                    if viewEpoch != publishEpoch {
                        viewDirty = true
                        try await refreshView()
                    } else if let selected = selectedDisplay {
                        geometry = displayStamp(selected)
                    }
                    return status()
                }
            case "display":
                result = try await withInFlightOperation {
                    try await switchDisplay(value)
                }
            case "heartbeat":
                result = try await withInFlightOperation {
                    try await heartbeat(value)
                }
            case "space":
                result = try await withInFlightOperation {
                    try await navigateSpace(value)
                }
            case "input":
                result = try input(value)
            case "windows":
                if let windowCoordinator {
                    result = try await withInFlightOperation {
                        try await windowCoordinator.listWindows()
                    }
                } else {
                    throw DesktopFailure.code("invalid-desktop-operation")
                }
            case "window":
                if let windowCoordinator {
                    result = try await withInFlightOperation {
                        try await windowCoordinator.handleWindow(value)
                    }
                } else {
                    throw DesktopFailure.code("invalid-desktop-operation")
                }
            case "stop":
                await stop(isShuttingDown: false)
                result = ["stopped": true]
            default:
                throw DesktopFailure.code("invalid-desktop-operation")
            }
            emit(["id": id, "ok": true, "result": result])
        } catch {
            let code: String
            if case DesktopFailure.code(let reason) = error {
                code = reason
            } else {
                code = "desktop-host-failed"
            }
            emit(["id": id, "ok": false, "error": code])
        }
    }
}
