import AppKit
import Darwin
import Foundation
import CodelyncDesktopHostCore

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
    @MainActor private static var activeHost: DesktopHost?

    @MainActor static func main() {
        let stateDir: String?
        let termination: any DispatchSourceSignal
        switch parseDesktopCLIArguments(Array(CommandLine.arguments.dropFirst())) {
        case .success(.setMode(let cmd)):
            Darwin.exit(executeSetModeSubprocess(cmd) ? 0 : 1)
        case .success(.restoreMode(let cmd)):
            Darwin.exit(executeRestoreModeSubprocess(cmd) ? 0 : 1)
        case .failure:
            Darwin.exit(1)
        case .success(.daemon(let parsedStateDir)):
            signal(SIGTERM, SIG_IGN)
            let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
            sigtermSource.setEventHandler {
                Task { @MainActor in
                    if let host = Main.activeHost {
                        await host.stop(isShuttingDown: true)
                    }
                    Darwin.exit(0)
                }
            }
            sigtermSource.resume()
            termination = sigtermSource
            stateDir = parsedStateDir
        }

        DesktopHost.disableLiveKitLogging()
        let application = NSApplication.shared
        _ = application.setActivationPolicy(.accessory)
        let host = DesktopHost(stateDir: stateDir)
        Main.activeHost = host
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
            if stateDir != nil {
                await host.reconcileStartupStateIfNeeded()
            }
            for await bytes in stream {
                guard let request = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { continue }
                await host.handle(request)
            }
            await host.stop(isShuttingDown: true)
            application.terminate(nil)
        }
        // NSWorkspace's distributed Spaces notifications need AppKit's event
        // loop, not only the Swift concurrency executor used by stdin RPC.
        application.run()
        termination.cancel()
    }
}
