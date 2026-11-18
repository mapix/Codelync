import AppKit
@preconcurrency import ApplicationServices
import CoreGraphics
import Foundation
@preconcurrency import LiveKit
@preconcurrency import ScreenCaptureKit

enum DesktopFailure: Error {
    case code(String)
}

struct Quality: Equatable {
    let width: Int
    let fps: Int
    init(_ value: [String: Any]) throws {
        guard let width = value["width"] as? Int, [1280, 1920, 2560].contains(width),
              let fps = value["fps"] as? Int, [15, 30, 60].contains(fps) else {
            throw DesktopFailure.code("invalid-desktop-quality")
        }
        self.width = width; self.fps = fps
    }
    var json: [String: Any] { ["width": width, "fps": fps] }
    var bitrate: Int { min(12_000_000, max(1_000_000, width * fps * 100)) }
}

final class DesktopVideoOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let capturer: BufferCapturer
    let stopped: @Sendable () -> Void
    private let lock = NSLock()
    private var frames = 0
    init(capturer: BufferCapturer, stopped: @escaping @Sendable () -> Void) { self.capturer = capturer; self.stopped = stopped }
    var frameCount: Int { lock.withLock { frames } }
    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, buffer.isValid, CMSampleBufferGetImageBuffer(buffer) != nil else { return }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let value = attachments.first?[.status] as? Int, value != SCFrameStatus.complete.rawValue { return }
        capturer.capture(buffer)
        lock.withLock { frames += 1 }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { stopped() }
}

final class DesktopCapture: @unchecked Sendable {
    let stream: SCStream
    let output: DesktopVideoOutput
    let track: LocalVideoTrack
    init(stream: SCStream, output: DesktopVideoOutput, track: LocalVideoTrack) { self.stream = stream; self.output = output; self.track = track }
}

@concurrent func desktopCapture(displayId: CGDirectDisplayID, width: Int, height: Int, fps: Int, stopped: @escaping @Sendable () -> Void) async throws -> DesktopCapture {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == displayId }) else { throw DesktopFailure.code("desktop-display-unavailable") }
    let track = await LocalVideoTrack.createBufferTrack(source: .screenShareVideo,
        options: BufferCaptureOptions(dimensions: Dimensions(width: Int32(width), height: Int32(height)), fps: fps))
    guard let capturer = track.capturer as? BufferCapturer else { throw DesktopFailure.code("desktop-capture-unavailable") }
    let output = DesktopVideoOutput(capturer: capturer, stopped: stopped)
    let config = SCStreamConfiguration()
    config.width = width; config.height = height; config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange; config.queueDepth = 3
    config.showsCursor = true; config.scalesToFit = true; config.capturesAudio = false
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let stream = SCStream(filter: filter, configuration: config, delegate: output)
    try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "codelync.desktop.frames"))
    try await stream.startCapture()
    // Publishing needs real capture dimensions, established by the first frame.
    for _ in 0..<100 {
        if output.frameCount > 0 { return DesktopCapture(stream: stream, output: output, track: track) }
        try await Task.sleep(for: .milliseconds(20))
    }
    try? await stream.stopCapture()
    throw DesktopFailure.code("desktop-capture-unavailable")
}

@MainActor final class DesktopHost {
    var room: Room?
    var publication: LocalTrackPublication?
    var capture: DesktopCapture?
    var captureGeneration = ""
    var selectedDisplay: CGDirectDisplayID?
    var geometry = ""
    var connection = ""
    var viewer = ""
    var quality: Quality?
    var pressed: CGMouseButton?
    var location = CGPoint.zero
    var lastInput = 0
    var lastSeen = Date()
    var remoteTargetPID: pid_t?
    var monitor: Task<Void, Never>?
    var viewEpoch = UUID().uuidString
    var viewDirty = false
    var spaceChanges = 0
    var spaceObserver: NSObjectProtocol?

    init() {
        spaceObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.spaceDidChange() }
            }
    }

    func invalidateView() {
        viewEpoch = UUID().uuidString
        guard !connection.isEmpty, let id = selectedDisplay else { return }
        releasePointer(); remoteTargetPID = nil; geometry = displayStamp(id); viewDirty = true
        emit(["type": "desktop-view-invalidated", "connectionId": connection])
    }

    func spaceDidChange() { spaceChanges += 1; invalidateView() }

    func emit(_ value: [String: Any]) {
        guard let bytes = try? JSONSerialization.data(withJSONObject: value) else { return }
        FileHandle.standardOutput.write(bytes + Data([10]))
    }

    func locked() -> Bool {
        guard let state = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
        return state["CGSSessionScreenIsLocked"] as? Bool == true || state["kCGSessionOnConsoleKey"] as? Bool == false
    }

    func permissions() -> [String: Any] {
        ["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(), "locked": locked()]
    }

    func displayStamp(_ id: CGDirectDisplayID) -> String {
        let bounds = CGDisplayBounds(id)
        let size = displayPixels(id)
        return "\(id):\(bounds.origin.x):\(bounds.origin.y):\(bounds.width):\(bounds.height):\(size.width):\(size.height):\(viewEpoch)"
    }

    func displayPixels(_ id: CGDirectDisplayID) -> (width: Int, height: Int) {
        if let mode = CGDisplayCopyDisplayMode(id) { return (mode.pixelWidth, mode.pixelHeight) }
        return (CGDisplayPixelsWide(id), CGDisplayPixelsHigh(id))
    }

    func displayRows() throws -> [[String: Any]] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0, count <= 16 else {
            throw DesktopFailure.code("desktop-display-unavailable")
        }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { throw DesktopFailure.code("desktop-display-unavailable") }
        return ids.prefix(Int(count)).enumerated().map { index, id in
            let size = displayPixels(id)
            return ["id": String(id), "name": id == CGMainDisplayID() ? "Main display" : "Display \(index + 1)",
             "width": size.width, "height": size.height, "geometry": displayStamp(id)]
        }
    }

    func status() -> [String: Any] {
        var result: [String: Any] = ["permissions": permissions(), "capturing": publication != nil,
            "connected": room?.connectionState == .connected, "viewPending": viewDirty, "spaceChanges": spaceChanges,
            "viewerConnected": room?.remoteParticipants.values.contains(where: { $0.identity?.stringValue == viewer }) == true]
        if let id = selectedDisplay { result["geometry"] = displayStamp(id) }
        if let quality { result["quality"] = quality.json }
        if let publication { result["trackSid"] = publication.sid.stringValue }
        return result
    }

    func releasePointer() {
        if let button = pressed {
            let kind: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
            CGEvent(mouseEventSource: nil, mouseType: kind, mouseCursorPosition: location, mouseButton: button)?.post(tap: .cghidEventTap)
        }
        pressed = nil
    }

    func stop() async {
        monitor?.cancel(); monitor = nil
        releasePointer()
        let previous = room; room = nil; publication = nil; selectedDisplay = nil
        let oldCapture = capture; capture = nil; captureGeneration = ""
        try? await oldCapture?.stream.stopCapture()
        connection = ""; viewer = ""; geometry = ""; quality = nil; lastInput = 0
        remoteTargetPID = nil
        viewDirty = false
        await previous?.disconnect()
    }

    func publish(_ next: Quality) async throws {
        releasePointer()
        guard let room, room.connectionState == .connected, let id = selectedDisplay else {
            throw DesktopFailure.code("desktop-display-unavailable")
        }
        let oldCapture = capture; capture = nil; captureGeneration = ""
        try? await oldCapture?.stream.stopCapture()
        if let previous = publication {
            publication = nil
            try await room.localParticipant.unpublish(publication: previous)
        }
        let size = displayPixels(id), nativeWidth = size.width, nativeHeight = size.height
        let width = max(2, min(nativeWidth, next.width) / 2 * 2)
        let height = max(2, Int(Double(nativeHeight) * Double(width) / Double(nativeWidth)) / 2 * 2)
        let generation = UUID().uuidString; captureGeneration = generation
        let nextCapture = try await desktopCapture(displayId: id, width: width, height: height, fps: next.fps) { [weak self] in
            Task { @MainActor in
                guard let self, self.captureGeneration == generation else { return }
                await self.stop(); self.emit(["type": "desktop-stopped"])
            }
        }
        guard self.room === room, captureGeneration == generation else { try? await nextCapture.stream.stopCapture(); throw DesktopFailure.code("desktop-disconnected") }
        capture = nextCapture
        let encoding = VideoEncoding(maxBitrate: next.bitrate, maxFps: next.fps)
        publication = try await room.localParticipant.publish(videoTrack: nextCapture.track,
            options: VideoPublishOptions(screenShareEncoding: encoding, simulcast: false, preferredCodec: .h264))
        quality = next
    }

    func begin(_ value: [String: Any]) async throws -> [String: Any] {
        guard CGPreflightScreenCaptureAccess() else { throw DesktopFailure.code("desktop-screen-permission-required") }
        guard !locked() else { throw DesktopFailure.code("desktop-locked") }
        guard let idString = value["displayId"] as? String, let id = UInt32(idString), CGDisplayIsActive(id) != 0,
              let url = value["url"] as? String, let token = value["token"] as? String,
              let secret = value["key"] as? String, secret.count >= 32,
              let connection = value["connectionId"] as? String,
              let viewer = value["viewer"] as? String,
              let rawQuality = value["quality"] as? [String: Any] else { throw DesktopFailure.code("invalid-desktop-start") }
        let next = try Quality(rawQuality)
        await stop()
        let provider = BaseKeyProvider(isSharedKey: true, sharedKey: secret)
        // Legacy media E2EE interoperates with the phone's pinned WebRTC 137 SDK.
        // Desktop input uses the separate authenticated sealed peer transport.
        let room = Room(roomOptions: RoomOptions(e2eeOptions: E2EEOptions(keyProvider: provider)))
        self.room = room; self.connection = connection; self.viewer = viewer; selectedDisplay = id
        geometry = displayStamp(id); lastSeen = Date()
        do {
            try await room.connect(url: url, token: token)
            try await publish(next)
        } catch {
            await stop(); throw DesktopFailure.code("desktop-media-connect-failed")
        }
        monitor = Task { [weak self] in
            var sawViewer = false
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, let self else { return }
                let viewerPresent = self.room?.remoteParticipants.values.contains(where: { $0.identity?.stringValue == self.viewer }) == true
                if viewerPresent { sawViewer = true }
                if self.locked() || !CGPreflightScreenCaptureAccess() || Date().timeIntervalSince(self.lastSeen) > 15 ||
                    self.room?.connectionState != .connected || (sawViewer && !viewerPresent) {
                    await self.stop(); self.emit(["type": "desktop-stopped"]); return
                }
            }
        }
        return status()
    }

    func requireActive(_ value: [String: Any]) throws {
        guard value["connectionId"] as? String == connection, !connection.isEmpty,
              room?.connectionState == .connected, publication != nil else { throw DesktopFailure.code("desktop-disconnected") }
        guard !viewDirty else { throw DesktopFailure.code("desktop-view-changed") }
        guard let id = selectedDisplay, value["geometry"] as? String == geometry, displayStamp(id) == geometry else {
            releasePointer(); throw DesktopFailure.code("desktop-display-changed")
        }
        guard !locked(), CGPreflightScreenCaptureAccess() else { releasePointer(); throw DesktopFailure.code("desktop-locked") }
        lastSeen = Date()
    }

    func heartbeat(_ value: [String: Any]) async throws -> [String: Any] {
        guard value["connectionId"] as? String == connection, !connection.isEmpty,
              room?.connectionState == .connected, selectedDisplay != nil else { throw DesktopFailure.code("desktop-disconnected") }
        guard !locked(), CGPreflightScreenCaptureAccess() else { throw DesktopFailure.code("desktop-locked") }
        lastSeen = Date()
        try await refreshView()
        return status()
    }

    func refreshView() async throws {
        for _ in 0..<3 {
            guard viewDirty, let quality else { return }
            let revision = viewEpoch; viewDirty = false
            if let id = selectedDisplay { geometry = displayStamp(id) }
            try await publish(quality)
            if revision != viewEpoch { viewDirty = true }
        }
    }

    func spaceShortcut(_ kind: String) throws -> (CGKeyCode, CGEventFlags) {
        let identifier = kind == "previous" ? "79" : "81"
        let defaults: (CGKeyCode, CGEventFlags) = (kind == "previous" ? 123 : 124, [.maskControl, .maskSecondaryFn])
        let domain = UserDefaults.standard.persistentDomain(forName: "com.apple.symbolichotkeys")
        guard let bindings = domain?["AppleSymbolicHotKeys"] as? [String: Any],
              let binding = bindings[identifier] as? [String: Any] else { return defaults }
        if binding["enabled"] as? Bool == false { throw DesktopFailure.code("desktop-space-shortcut-disabled") }
        guard let value = binding["value"] as? [String: Any] else { return defaults }
        guard value["type"] as? String == "standard", let parameters = value["parameters"] as? [NSNumber], parameters.count == 3,
              (0...255).contains(parameters[1].intValue), parameters[2].uint64Value <= UInt64(UInt32.max) else {
            throw DesktopFailure.code("desktop-space-shortcut-unavailable")
        }
        return (CGKeyCode(parameters[1].uint16Value), CGEventFlags(rawValue: parameters[2].uint64Value))
    }

    func navigateSpace(_ value: [String: Any]) async throws -> [String: Any] {
        try requireActive(value)
        guard AXIsProcessTrusted() else { throw DesktopFailure.code("desktop-input-permission-required") }
        guard let sequence = value["sequence"] as? Int, sequence > lastInput, sequence <= lastInput + 1024,
              let kind = value["kind"] as? String, ["previous", "next", "overview"].contains(kind),
              let display = selectedDisplay else { throw DesktopFailure.code("invalid-desktop-space") }
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
            let bounds = CGDisplayBounds(display)
            let point = CGPoint(x: bounds.midX, y: bounds.midY)
            CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { throw DesktopFailure.code("desktop-operation-unknown") }
            down.flags = flags; up.flags = flags; down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
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
        var result = status(); result["accepted"] = true; result["sequence"] = sequence
        result["spaceChanged"] = changed; result["kind"] = kind
        return result
    }

    func input(_ value: [String: Any]) throws -> [String: Any] {
        try requireActive(value)
        guard AXIsProcessTrusted() else { throw DesktopFailure.code("desktop-input-permission-required") }
        guard let sequence = value["sequence"] as? Int, sequence > lastInput, sequence <= lastInput + 1024,
              let action = value["action"] as? String else { throw DesktopFailure.code("desktop-input-replayed") }
        lastInput = sequence
        if action == "pointer" {
            guard let id = selectedDisplay, let x = value["x"] as? Double, let y = value["y"] as? Double,
                  x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y),
                  let phase = value["phase"] as? String, ["move", "down", "up", "click"].contains(phase) else {
                throw DesktopFailure.code("invalid-desktop-input")
            }
            let bounds = CGDisplayBounds(id)
            location = CGPoint(x: bounds.minX + x * (bounds.width - 1), y: bounds.minY + y * (bounds.height - 1))
            let button: CGMouseButton = value["button"] as? String == "right" ? .right : .left
            func send(_ kind: CGEventType, _ mouseButton: CGMouseButton) {
                CGEvent(mouseEventSource: nil, mouseType: kind, mouseCursorPosition: location, mouseButton: mouseButton)?.post(tap: .cghidEventTap)
            }
            if phase == "move" { send(pressed == .right ? .rightMouseDragged : pressed == .left ? .leftMouseDragged : .mouseMoved, pressed ?? button) }
            if phase == "down" || phase == "click" {
                if let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] {
                    remoteTargetPID = windows.first(where: { row in
                        guard row[kCGWindowLayer as String] as? Int == 0,
                              let rect = row[kCGWindowBounds as String] as? [String: Any],
                              let bounds = CGRect(dictionaryRepresentation: rect as CFDictionary) else { return false }
                        return bounds.contains(location)
                    })?[kCGWindowOwnerPID as String] as? pid_t
                }
                releasePointer(); pressed = button; send(button == .right ? .rightMouseDown : .leftMouseDown, button)
            }
            if phase == "up" || phase == "click" { releasePointer() }
        } else if action == "scroll" {
            guard let delta = value["deltaY"] as? Int, (-1200...1200).contains(delta) else { throw DesktopFailure.code("invalid-desktop-input") }
            let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(delta), wheel2: 0, wheel3: 0)
            event?.location = location; event?.post(tap: .cghidEventTap)
        } else if action == "text" {
            restoreSimulatorTarget()
            guard let text = value["text"] as? String, !text.isEmpty, text.utf16.count <= 2048 else { throw DesktopFailure.code("invalid-desktop-input") }
            let units = Array(text.utf16)
            for isDown in [true, false] {
                let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: isDown)
                units.withUnsafeBufferPointer { buffer in event?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress) }
                event?.post(tap: .cghidEventTap)
            }
        } else if action == "key" {
            restoreSimulatorTarget()
            let keys: [String: CGKeyCode] = ["enter": 36, "tab": 48, "escape": 53, "backspace": 51,
                "delete": 117, "left": 123, "right": 124, "down": 125, "up": 126,
                "space": 49, "a": 0, "c": 8, "v": 9, "x": 7, "z": 6, "s": 1, "f": 3, "w": 13, "r": 15]
            guard let key = value["key"] as? String, let code = keys[key], let modifiers = value["modifiers"] as? [String], modifiers.count <= 4,
                  modifiers.allSatisfy({ ["command", "shift", "option", "control"].contains($0) }) else { throw DesktopFailure.code("invalid-desktop-input") }
            var flags: CGEventFlags = []
            if modifiers.contains("command") { flags.insert(.maskCommand) }
            if modifiers.contains("shift") { flags.insert(.maskShift) }
            if modifiers.contains("option") { flags.insert(.maskAlternate) }
            if modifiers.contains("control") { flags.insert(.maskControl) }
            for isDown in [true, false] {
                let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: isDown)
                event?.flags = flags; event?.post(tap: .cghidEventTap)
            }
        } else { throw DesktopFailure.code("invalid-desktop-input") }
        return ["accepted": true, "sequence": sequence]
    }

    func restoreSimulatorTarget() {
        // A simulator runs on the controlled Mac: touching its keyboard steals
        // foreground focus from the clicked desktop window. Isolated simulator
        // QA restores that real target before keyboard injection; production
        // phone connections continue to use the Mac's current focus.
        guard ProcessInfo.processInfo.environment["CODELYNC_DESKTOP_SIMULATOR_QA"] == "1",
              NSWorkspace.shared.frontmostApplication?.bundleIdentifier?.hasPrefix("com.apple.dt.") == true,
              let pid = remoteTargetPID, let app = NSRunningApplication(processIdentifier: pid) else { return }
        app.activate(options: [])
    }

    func handle(_ value: [String: Any]) async {
        let id = value["id"] as? String ?? ""
        do {
            let result: [String: Any]
            switch value["operation"] as? String {
            case "status": result = status()
            case "displays": result = ["displays": try displayRows(), "permissions": permissions()]
            case "request-permissions":
                if value["permission"] as? String == "screenRecording" { _ = CGRequestScreenCaptureAccess() }
                else if value["permission"] as? String == "accessibility" {
                    _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
                } else { throw DesktopFailure.code("invalid-desktop-permission") }
                result = ["permissions": permissions()]
            case "start": result = try await begin(value)
            case "quality":
                try requireActive(value)
                guard let raw = value["quality"] as? [String: Any] else { throw DesktopFailure.code("invalid-desktop-quality") }
                try await publish(Quality(raw)); result = status()
            case "display":
                try requireActive(value)
                guard let requested = value["displayId"] as? String, let id = UInt32(requested),
                      let display = try displayRows().first(where: { $0["id"] as? String == requested }),
                      let quality else { throw DesktopFailure.code("desktop-display-unavailable") }
                releasePointer(); selectedDisplay = id; geometry = displayStamp(id); remoteTargetPID = nil
                try await publish(quality)
                var next = status(); next["display"] = display; result = next
            case "heartbeat": result = try await heartbeat(value)
            case "space": result = try await navigateSpace(value)
            case "input": result = try input(value)
            case "stop": await stop(); result = ["stopped": true]
            default: throw DesktopFailure.code("invalid-desktop-operation")
            }
            emit(["id": id, "ok": true, "result": result])
        } catch {
            let code: String
            if case DesktopFailure.code(let reason) = error { code = reason } else { code = "desktop-host-failed" }
            emit(["id": id, "ok": false, "error": code])
        }
    }
}

// BEGIN CODELYNC DESKTOP STDIN FRAMER
struct DesktopStdinFramer {
    let maxLineBytes: Int
    private var buffer = Data()
    private var discardingOversizedLine = false

    init(maxLineBytes: Int = 16_384) {
        self.maxLineBytes = maxLineBytes
    }

    mutating func append(_ bytes: Data) -> [Data] {
        var lines: [Data] = []
        var cursor = bytes.startIndex
        while cursor < bytes.endIndex {
            if discardingOversizedLine {
                guard let end = bytes[cursor...].firstIndex(of: 10) else { return lines }
                discardingOversizedLine = false
                cursor = bytes.index(after: end)
                continue
            }
            if let end = bytes[cursor...].firstIndex(of: 10) {
                var slice = bytes[cursor..<end]
                if slice.last == 13, buffer.isEmpty { slice = slice.dropLast() }
                let sliceLength = bytes.distance(from: slice.startIndex, to: slice.endIndex)
                if buffer.count + sliceLength > maxLineBytes {
                    buffer.removeAll(keepingCapacity: true)
                } else if buffer.isEmpty {
                    lines.append(Data(slice))
                } else {
                    buffer.append(contentsOf: slice)
                    if buffer.last == 13 { buffer.removeLast() }
                    if buffer.count <= maxLineBytes { lines.append(buffer) }
                    buffer.removeAll(keepingCapacity: true)
                }
                cursor = bytes.index(after: end)
            } else {
                let remaining = bytes.distance(from: cursor, to: bytes.endIndex)
                if buffer.count + remaining > maxLineBytes {
                    buffer.removeAll(keepingCapacity: true)
                    discardingOversizedLine = true
                } else {
                    buffer.append(bytes[cursor...])
                }
                break
            }
        }
        return lines
    }

    mutating func flush() -> Data? {
        defer { buffer.removeAll(keepingCapacity: false); discardingOversizedLine = false }
        guard !discardingOversizedLine, !buffer.isEmpty else { return nil }
        if buffer.last == 13 { buffer.removeLast() }
        return buffer.isEmpty || buffer.count > maxLineBytes ? nil : buffer
    }
}
// END CODELYNC DESKTOP STDIN FRAMER

@main struct Main {
    @MainActor static func main() {
        LiveKitSDK.disableLogging()
        let application = NSApplication.shared
        _ = application.setActivationPolicy(.accessory)
        let host = DesktopHost()
        signal(SIGTERM, SIG_IGN)
        let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termination.setEventHandler { Task { @MainActor in await host.stop(); exit(0) } }
        termination.resume()
        // Blocking stdin reads run off the main actor; commands execute serially.
        let stream = AsyncStream<Data> { continuation in
            Thread.detachNewThread {
                var framer = DesktopStdinFramer(maxLineBytes: 16_384)
                let stdinHandle = FileHandle.standardInput
                while true {
                    let chunk = stdinHandle.availableData
                    if chunk.isEmpty { break }
                    for lineBytes in framer.append(chunk) {
                        continuation.yield(lineBytes)
                    }
                }
                if let trailing = framer.flush() {
                    continuation.yield(trailing)
                }
                continuation.finish()
            }
        }
        Task { @MainActor in
            for await bytes in stream {
                guard let request = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { continue }
                await host.handle(request)
            }
            await host.stop()
            application.terminate(nil)
        }
        // NSWorkspace's distributed Spaces notifications need AppKit's event
        // loop, not only the Swift concurrency executor used by stdin RPC.
        application.run()
        termination.cancel()
    }
}
