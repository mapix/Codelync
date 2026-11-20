import AppKit
import CoreGraphics
import Darwin
import Foundation

public enum RestoreModeScope: String, Codable, Equatable, Sendable {
    case session = "session"
    case permanent = "permanent"

    public var cgConfigureOption: CGConfigureOption {
        switch self {
        case .session: return .forSession
        case .permanent: return .permanently
        }
    }
}

public struct SetModeCommand: Equatable, Sendable {
    public let displayID: CGDirectDisplayID
    public let logicalWidth: Int
    public let logicalHeight: Int

    public init(displayID: CGDirectDisplayID, logicalWidth: Int, logicalHeight: Int) {
        self.displayID = displayID
        self.logicalWidth = logicalWidth
        self.logicalHeight = logicalHeight
    }
}

public struct RestoreModeCommand: Equatable, Sendable {
    public let displayID: CGDirectDisplayID
    public let ioModeIDBitPattern: UInt32
    public let width: Int
    public let height: Int
    public let pixelWidth: Int
    public let pixelHeight: Int
    public let refreshRate: Double
    public let scope: RestoreModeScope

    public init(
        displayID: CGDirectDisplayID,
        ioModeIDBitPattern: UInt32,
        width: Int,
        height: Int,
        pixelWidth: Int,
        pixelHeight: Int,
        refreshRate: Double,
        scope: RestoreModeScope
    ) {
        self.displayID = displayID
        self.ioModeIDBitPattern = ioModeIDBitPattern
        self.width = width
        self.height = height
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.refreshRate = refreshRate
        self.scope = scope
    }

    public var ioModeID: Int32 {
        Int32(bitPattern: ioModeIDBitPattern)
    }
}

public enum DesktopCLIMode: Equatable, Sendable {
    case daemon(stateDir: String?)
    case setMode(SetModeCommand)
    case restoreMode(RestoreModeCommand)
}

public enum DesktopCLIError: Error, Equatable, Sendable {
    case invalidSetModeArguments
    case invalidRestoreModeArguments
    case missingStateDirValue
    case invalidStateDirValue
    case unknownArgument(String)
}

public func parseDesktopCLIArguments(_ args: [String]) -> Result<DesktopCLIMode, DesktopCLIError> {
    guard let first = args.first else {
        return .success(.daemon(stateDir: nil))
    }

    if first == "--set-mode" {
        guard args.count == 4,
              let displayID = UInt32(args[1]), displayID != kCGNullDirectDisplay,
              let logicalWidth = Int(args[2]), (1...16_384).contains(logicalWidth),
              let logicalHeight = Int(args[3]), (1...16_384).contains(logicalHeight) else {
            return .failure(.invalidSetModeArguments)
        }
        return .success(.setMode(SetModeCommand(
            displayID: displayID,
            logicalWidth: logicalWidth,
            logicalHeight: logicalHeight
        )))
    }

    if first == "--restore-mode" {
        guard args.count == 9,
              let displayID = UInt32(args[1]), displayID != kCGNullDirectDisplay,
              let ioModeIDBitPattern = UInt32(args[2]),
              let width = Int(args[3]), (1...32_768).contains(width),
              let height = Int(args[4]), (1...32_768).contains(height),
              let pixelWidth = Int(args[5]), (1...65_536).contains(pixelWidth),
              let pixelHeight = Int(args[6]), (1...65_536).contains(pixelHeight),
              let refreshRate = Double(args[7]), refreshRate.isFinite, (0.0...1000.0).contains(refreshRate),
              let scope = RestoreModeScope(rawValue: args[8]) else {
            return .failure(.invalidRestoreModeArguments)
        }
        return .success(.restoreMode(RestoreModeCommand(
            displayID: displayID,
            ioModeIDBitPattern: ioModeIDBitPattern,
            width: width,
            height: height,
            pixelWidth: pixelWidth,
            pixelHeight: pixelHeight,
            refreshRate: refreshRate,
            scope: scope
        )))
    }

    var stateDir: String?
    var index = 0
    while index < args.count {
        let arg = args[index]
        if arg == "--state-dir" {
            guard index + 1 < args.count else {
                return .failure(.missingStateDirValue)
            }
            let raw = args[index + 1]
            guard !raw.isEmpty, !raw.contains("\0"), !raw.hasPrefix("--") else {
                return .failure(.invalidStateDirValue)
            }
            stateDir = URL(fileURLWithPath: raw, isDirectory: true).standardizedFileURL.path
            index += 2
        } else if arg.hasPrefix("--state-dir=") {
            let raw = String(arg.dropFirst("--state-dir=".count))
            guard !raw.isEmpty, !raw.contains("\0") else {
                return .failure(.invalidStateDirValue)
            }
            stateDir = URL(fileURLWithPath: raw, isDirectory: true).standardizedFileURL.path
            index += 1
        } else {
            return .failure(.unknownArgument(arg))
        }
    }
    return .success(.daemon(stateDir: stateDir))
}

struct DisplayModeCandidate: Equatable, Sendable {
    let ioModeID: Int32
    let width: Int
    let height: Int
    let pixelWidth: Int
    let pixelHeight: Int
    let refreshRate: Double
    let usableForDesktopGUI: Bool
}

func selectVirtualHiDPIModeIndex(
    in candidates: [DisplayModeCandidate],
    logicalWidth: Int,
    logicalHeight: Int
) -> Int? {
    if let exactUsable = candidates.firstIndex(where: {
        $0.width == logicalWidth &&
        $0.height == logicalHeight &&
        $0.pixelWidth == 2 * logicalWidth &&
        $0.pixelHeight == 2 * logicalHeight &&
        $0.usableForDesktopGUI
    }) {
        return exactUsable
    }
    if let exact2x = candidates.firstIndex(where: {
        $0.width == logicalWidth &&
        $0.height == logicalHeight &&
        $0.pixelWidth == 2 * logicalWidth &&
        $0.pixelHeight == 2 * logicalHeight
    }) {
        return exact2x
    }
    return candidates.firstIndex(where: {
        $0.width == logicalWidth &&
        $0.height == logicalHeight &&
        $0.pixelWidth == 2 * logicalWidth
    })
}

func selectPhysicalRestoreModeIndex(
    in candidates: [DisplayModeCandidate],
    command: RestoreModeCommand
) -> Int? {
    let same = candidates.indices.filter { idx in
        let m = candidates[idx]
        return m.width == command.width &&
            m.height == command.height &&
            m.pixelWidth == command.pixelWidth &&
            m.pixelHeight == command.pixelHeight &&
            abs(m.refreshRate - command.refreshRate) < 0.01
    }
    guard !same.isEmpty else { return nil }
    return same.first(where: { candidates[$0].ioModeID == command.ioModeID })
        ?? same.first(where: { candidates[$0].usableForDesktopGUI })
        ?? same.first
}

private func copyAllDisplayModes(for displayID: CGDirectDisplayID) -> [CGDisplayMode] {
    let options = [kCGDisplayShowDuplicateLowResolutionModes: true] as CFDictionary
    return (CGDisplayCopyAllDisplayModes(displayID, options) as? [CGDisplayMode]) ?? []
}

private func applyDisplayModeTransaction(
    displayID: CGDirectDisplayID,
    mode: CGDisplayMode,
    scope: CGConfigureOption
) -> Bool {
    var config: CGDisplayConfigRef?
    guard CGBeginDisplayConfiguration(&config) == .success, let config else {
        return false
    }
    guard CGConfigureDisplayWithDisplayMode(config, displayID, mode, nil) == .success else {
        CGCancelDisplayConfiguration(config)
        return false
    }
    let status = CGCompleteDisplayConfiguration(config, scope)
    if status != .success {
        CGCancelDisplayConfiguration(config)
        return false
    }
    return true
}

public func executeSetModeSubprocess(_ command: SetModeCommand) -> Bool {
    let modes = copyAllDisplayModes(for: command.displayID)
    let candidates = modes.map {
        DisplayModeCandidate(
            ioModeID: $0.ioDisplayModeID,
            width: $0.width,
            height: $0.height,
            pixelWidth: $0.pixelWidth,
            pixelHeight: $0.pixelHeight,
            refreshRate: $0.refreshRate,
            usableForDesktopGUI: $0.isUsableForDesktopGUI()
        )
    }
    guard let idx = selectVirtualHiDPIModeIndex(
        in: candidates,
        logicalWidth: command.logicalWidth,
        logicalHeight: command.logicalHeight
    ) else {
        return false
    }
    return applyDisplayModeTransaction(displayID: command.displayID, mode: modes[idx], scope: .forSession)
}

public func executeRestoreModeSubprocess(_ command: RestoreModeCommand) -> Bool {
    let modes = copyAllDisplayModes(for: command.displayID)
    let candidates = modes.map {
        DisplayModeCandidate(
            ioModeID: $0.ioDisplayModeID,
            width: $0.width,
            height: $0.height,
            pixelWidth: $0.pixelWidth,
            pixelHeight: $0.pixelHeight,
            refreshRate: $0.refreshRate,
            usableForDesktopGUI: $0.isUsableForDesktopGUI()
        )
    }
    guard let idx = selectPhysicalRestoreModeIndex(in: candidates, command: command) else {
        return false
    }
    return applyDisplayModeTransaction(
        displayID: command.displayID,
        mode: modes[idx],
        scope: command.scope.cgConfigureOption
    )
}

enum SubprocessExitResult: Equatable, Sendable {
    case exited(Int32)
    case timedOut
    case launchFailed(String)

    var succeeded: Bool { self == .exited(0) }
}

func resolveSelfExecutableURL() -> URL? {
    if let url = Bundle.main.executableURL {
        return url.resolvingSymlinksInPath()
    }
    guard let arg0 = CommandLine.arguments.first, !arg0.isEmpty else { return nil }
    if arg0.hasPrefix("/") {
        return URL(fileURLWithPath: arg0).resolvingSymlinksInPath()
    }
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    return URL(fileURLWithPath: arg0, relativeTo: cwd).standardizedFileURL.resolvingSymlinksInPath()
}

func runHelperSubprocess(
    executableURL: URL? = resolveSelfExecutableURL(),
    arguments: [String],
    timeout: Duration = .seconds(10),
    sigkillGrace: Duration = .milliseconds(250)
) async -> SubprocessExitResult {
    guard let executableURL else {
        return .launchFailed("executable-url-unavailable")
    }

    final class SubprocessBox: @unchecked Sendable {
        private enum LaunchPhase {
            case notStarted
            case launching
            case running
            case launchFailed
            case exited
        }

        let process: Process
        private let sigkillGrace: Duration
        private let lock = NSLock()
        private var phase: LaunchPhase = .notStarted
        private var continuation: CheckedContinuation<SubprocessExitResult, Never>?
        private var terminalResult: SubprocessExitResult?
        private var killRequested = false
        private var terminationSent = false
        private var killEscalationTask: Task<Void, Never>?

        init(executableURL: URL, arguments: [String], sigkillGrace: Duration) {
            let proc = Process()
            proc.executableURL = executableURL
            proc.arguments = arguments
            proc.standardInput = FileHandle.nullDevice
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = FileHandle.nullDevice
            self.process = proc
            self.sigkillGrace = sigkillGrace
        }

        private func resolveLocked(_ result: SubprocessExitResult) -> CheckedContinuation<SubprocessExitResult, Never>? {
            guard terminalResult == nil else { return nil }
            terminalResult = result
            let saved = continuation
            continuation = nil
            return saved
        }

        func armAndLaunch(
            _ cont: CheckedContinuation<SubprocessExitResult, Never>,
            timeoutTask: Task<Void, Never>?
        ) {
            let earlyResult: SubprocessExitResult? = lock.withLock {
                if let existing = terminalResult {
                    return existing
                }
                continuation = cont
                phase = .launching
                return nil
            }
            if let earlyResult {
                timeoutTask?.cancel()
                cont.resume(returning: earlyResult)
                return
            }

            process.terminationHandler = { [self] proc in
                timeoutTask?.cancel()
                let result: SubprocessExitResult = proc.terminationReason == .exit
                    ? .exited(proc.terminationStatus)
                    : .exited(-1)
                proc.terminationHandler = nil
                self.handleProcessExit(result)
            }

            do {
                try process.run()
            } catch {
                timeoutTask?.cancel()
                process.terminationHandler = nil
                handleLaunchFailure(error.localizedDescription)
                return
            }

            let shouldTerminateAfterLaunch: Bool = lock.withLock {
                guard phase == .launching else { return false }
                phase = .running
                if killRequested && !terminationSent {
                    terminationSent = true
                    return true
                }
                return false
            }
            if shouldTerminateAfterLaunch {
                terminateAndScheduleSigkill()
            }
        }

        private func handleLaunchFailure(_ message: String) {
            let cont: CheckedContinuation<SubprocessExitResult, Never>? = lock.withLock {
                phase = .launchFailed
                return resolveLocked(.launchFailed(message))
            }
            cont?.resume(returning: .launchFailed(message))
        }

        private func handleProcessExit(_ result: SubprocessExitResult) {
            let (cont, escalation): (CheckedContinuation<SubprocessExitResult, Never>?, Task<Void, Never>?) = lock.withLock {
                phase = .exited
                let esc = killEscalationTask
                killEscalationTask = nil
                return (resolveLocked(result), esc)
            }
            escalation?.cancel()
            cont?.resume(returning: result)
        }

        func terminateForTimeout() {
            let (cont, shouldTerminateNow): (CheckedContinuation<SubprocessExitResult, Never>?, Bool) = lock.withLock {
                killRequested = true
                let saved = resolveLocked(.timedOut)
                let canTerminate = (phase == .running && !terminationSent)
                if canTerminate {
                    terminationSent = true
                }
                return (saved, canTerminate)
            }
            if shouldTerminateNow {
                terminateAndScheduleSigkill()
            }
            cont?.resume(returning: .timedOut)
        }

        private func terminateAndScheduleSigkill() {
            process.terminate()
            let grace = sigkillGrace
            let escalation = Task.detached { [self] in
                try? await Task.sleep(for: grace)
                guard !Task.isCancelled else { return }
                self.escalateSigkillIfRunning()
            }
            let cancelImmediately: Bool = lock.withLock {
                if phase == .exited {
                    return true
                }
                killEscalationTask = escalation
                return false
            }
            if cancelImmediately {
                escalation.cancel()
            }
        }

        private func escalateSigkillIfRunning() {
            lock.withLock {
                guard phase == .running, process.isRunning else { return }
                let pid = process.processIdentifier
                if pid > 0 {
                    _ = Darwin.kill(pid, SIGKILL)
                }
            }
        }
    }

    let box = SubprocessBox(
        executableURL: executableURL,
        arguments: arguments,
        sigkillGrace: sigkillGrace
    )
    let timeoutTask: Task<Void, Never>?
    if timeout <= .zero {
        box.terminateForTimeout()
        timeoutTask = nil
    } else {
        timeoutTask = Task.detached {
            do {
                try await Task.sleep(for: timeout)
                box.terminateForTimeout()
            } catch {}
        }
    }
    defer { timeoutTask?.cancel() }

    return await withTaskCancellationHandler {
        await withCheckedContinuation { continuation in
            box.armAndLaunch(continuation, timeoutTask: timeoutTask)
        }
    } onCancel: {
        timeoutTask?.cancel()
        box.terminateForTimeout()
    }
}

@MainActor
func screenForDisplay(_ displayID: CGDirectDisplayID) -> NSScreen? {
    let key = NSDeviceDescriptionKey("NSScreenNumber")
    return NSScreen.screens.first { screen in
        (screen.deviceDescription[key] as? NSNumber)?.uint32Value == displayID
    }
}

func onlineDisplayIDs(maxDisplays: UInt32 = 32) -> [CGDirectDisplayID] {
    var count: UInt32 = 0
    guard CGGetOnlineDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
    let capacity = min(count, maxDisplays)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(capacity))
    var actual: UInt32 = 0
    guard CGGetOnlineDisplayList(capacity, &ids, &actual) == .success else { return [] }
    return Array(ids.prefix(Int(actual)))
}

@MainActor
func waitForVirtualDisplayModeConvergence(
    displayID: CGDirectDisplayID,
    logicalWidth: Int,
    logicalHeight: Int,
    timeout: Duration = .seconds(2),
    pollInterval: Duration = .milliseconds(50)
) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now + timeout
    while true {
        let cgMatches: Bool = {
            guard let mode = CGDisplayCopyDisplayMode(displayID) else { return false }
            return mode.width == logicalWidth &&
                mode.height == logicalHeight &&
                mode.pixelWidth == 2 * logicalWidth
        }()
        let screenMatches: Bool = {
            guard let screen = screenForDisplay(displayID) else { return false }
            return abs(screen.frame.width - CGFloat(logicalWidth)) < 1.0 &&
                abs(screen.frame.height - CGFloat(logicalHeight)) < 1.0
        }()
        if cgMatches && screenMatches { return true }
        if clock.now >= deadline { return cgMatches }
        try? await Task.sleep(for: pollInterval)
    }
}
