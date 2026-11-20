import AppKit
import CoreGraphics
import Darwin
import Foundation

enum DurableJSONStore {
    private static func splitParentAndFileName(_ filePath: String) -> (dirPath: String, fileName: String)? {
        guard !filePath.isEmpty, !filePath.contains("\0"), !filePath.hasSuffix("/") else {
            return nil
        }
        let dirPath: String
        let fileName: String
        if let slashIndex = filePath.lastIndex(of: "/") {
            fileName = String(filePath[filePath.index(after: slashIndex)...])
            var rawDir = String(filePath[..<slashIndex])
            while rawDir.count > 1 && rawDir.hasSuffix("/") {
                rawDir.removeLast()
            }
            dirPath = rawDir.isEmpty ? "/" : rawDir
        } else {
            dirPath = "."
            fileName = filePath
        }
        guard !fileName.isEmpty, fileName != ".", fileName != ".." else {
            return nil
        }
        return (dirPath, fileName)
    }

    private static func openOrCreateSecureDirectoryFD(at dirPath: String) throws -> Int32 {
        var preStat = Darwin.stat()
        if Darwin.lstat(dirPath, &preStat) == 0 {
            let kind = preStat.st_mode & S_IFMT
            if kind == S_IFLNK {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(ELOOP))
            }
            guard kind == S_IFDIR else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENOTDIR))
            }
            let dirFD = Darwin.open(dirPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard dirFD >= 0 else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            var fdStat = Darwin.stat()
            guard Darwin.fstat(dirFD, &fdStat) == 0, (fdStat.st_mode & S_IFMT) == S_IFDIR else {
                _ = Darwin.close(dirFD)
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENOTDIR))
            }
            if (fdStat.st_mode & S_ISVTX) == 0 && fdStat.st_uid == Darwin.geteuid() && dirPath != "/" {
                if Darwin.fchmod(dirFD, mode_t(0o700)) != 0 {
                    let err = errno
                    _ = Darwin.close(dirFD)
                    throw NSError(domain: NSPOSIXErrorDomain, code: Int(err))
                }
            }
            return dirFD
        }

        guard errno == ENOENT else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }

        var missingComponents: [String] = []
        var anchorPath = dirPath
        while true {
            var curStat = Darwin.stat()
            if Darwin.lstat(anchorPath, &curStat) == 0 {
                let kind = curStat.st_mode & S_IFMT
                if kind == S_IFLNK {
                    if anchorPath == "/tmp" || anchorPath == "/var" || anchorPath == "/etc" {
                        anchorPath = "/private" + anchorPath
                        break
                    }
                    throw NSError(domain: NSPOSIXErrorDomain, code: Int(ELOOP))
                }
                guard kind == S_IFDIR else {
                    throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENOTDIR))
                }
                break
            }
            guard errno == ENOENT else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            guard let (parent, name) = splitParentAndFileName(anchorPath), parent != anchorPath else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENOENT))
            }
            missingComponents.append(name)
            anchorPath = parent
        }

        var currentFD = Darwin.open(anchorPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard currentFD >= 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }

        for component in missingComponents.reversed() {
            if Darwin.mkdirat(currentFD, component, mode_t(0o700)) != 0 && errno != EEXIST {
                let err = errno
                _ = Darwin.close(currentFD)
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(err))
            }
            let nextFD = Darwin.openat(currentFD, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            let openErr = errno
            _ = Darwin.close(currentFD)
            guard nextFD >= 0 else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(openErr))
            }
            if Darwin.fchmod(nextFD, mode_t(0o700)) != 0 {
                let chmodErr = errno
                _ = Darwin.close(nextFD)
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(chmodErr))
            }
            currentFD = nextFD
        }

        return currentFD
    }

    static func writeAtomic<T: Encodable>(_ value: T, to filePath: String) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)

        guard let (dirPath, fileName) = splitParentAndFileName(filePath) else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(EINVAL))
        }

        let dirFD = try openOrCreateSecureDirectoryFD(at: dirPath)
        defer { _ = Darwin.close(dirFD) }

        // Refuse overwriting a symlink, directory, or special file at the target entry inside dirFD.
        var targetStat = Darwin.stat()
        if Darwin.fstatat(dirFD, fileName, &targetStat, AT_SYMLINK_NOFOLLOW) == 0 {
            let kind = targetStat.st_mode & S_IFMT
            if kind == S_IFLNK {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(ELOOP))
            }
            if kind != S_IFREG {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(kind == S_IFDIR ? EISDIR : EINVAL))
            }
        } else if errno != ENOENT {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }

        let tempName = "\(fileName).\(UUID().uuidString).tmp"
        let fd = Darwin.openat(
            dirFD,
            tempName,
            O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
            mode_t(0o600)
        )
        guard fd >= 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        var closed = false
        do {
            if Darwin.fchmod(fd, mode_t(0o600)) != 0 {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            try data.withUnsafeBytes { rawBuffer in
                guard let base = rawBuffer.baseAddress else { return }
                var offset = 0
                while offset < rawBuffer.count {
                    let written = Darwin.write(fd, base.advanced(by: offset), rawBuffer.count - offset)
                    if written < 0 {
                        if errno == EINTR { continue }
                        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
                    }
                    offset += written
                }
            }
            if Darwin.fsync(fd) != 0 {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            if Darwin.close(fd) != 0 {
                closed = true
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            closed = true
            if Darwin.renameat(dirFD, tempName, dirFD, fileName) != 0 {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            _ = Darwin.fsync(dirFD)
        } catch {
            if !closed { _ = Darwin.close(fd) }
            _ = Darwin.unlinkat(dirFD, tempName, 0)
            throw error
        }
    }

    static func loadOrQuarantine<T: Decodable>(
        _ type: T.Type,
        from filePath: String,
        validate: (T) -> Bool = { _ in true }
    ) -> T? {
        guard let (dirPath, fileName) = splitParentAndFileName(filePath) else {
            return nil
        }
        let dirFD = Darwin.open(dirPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard dirFD >= 0 else {
            return nil
        }
        defer { _ = Darwin.close(dirFD) }

        var st = Darwin.stat()
        guard Darwin.fstatat(dirFD, fileName, &st, AT_SYMLINK_NOFOLLOW) == 0 else {
            return nil
        }
        guard (st.st_mode & S_IFMT) == S_IFREG else {
            return nil
        }

        let fd = Darwin.openat(dirFD, fileName, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 { return nil }

        var openStat = Darwin.stat()
        guard Darwin.fstat(fd, &openStat) == 0, (openStat.st_mode & S_IFMT) == S_IFREG else {
            _ = Darwin.close(fd)
            return nil
        }

        var data = Data()
        var readError = openStat.st_size > 1_048_576
        if !readError {
            var buffer = [UInt8](repeating: 0, count: 16_384)
            while true {
                let count = Darwin.read(fd, &buffer, buffer.count)
                if count > 0 {
                    data.append(buffer, count: count)
                    if data.count > 1_048_576 {
                        readError = true
                        break
                    }
                } else if count == 0 {
                    break
                } else if errno != EINTR {
                    readError = true
                    break
                }
            }
        }

        if !readError, let decoded = try? JSONDecoder().decode(type, from: data), validate(decoded) {
            _ = Darwin.close(fd)
            return decoded
        }

        _ = Darwin.fchmod(fd, mode_t(0o600))
        _ = Darwin.close(fd)

        let stamp = Int64(Date().timeIntervalSince1970 * 1000)
        var quarantineName = "\(fileName).corrupt-\(stamp)"
        var qStat = Darwin.stat()
        if Darwin.fstatat(dirFD, quarantineName, &qStat, AT_SYMLINK_NOFOLLOW) == 0 {
            quarantineName = "\(fileName).corrupt-\(stamp)-\(UUID().uuidString.prefix(8))"
        }
        if Darwin.renameat(dirFD, fileName, dirFD, quarantineName) == 0 {
            _ = Darwin.fchmodat(dirFD, quarantineName, mode_t(0o600), AT_SYMLINK_NOFOLLOW)
        } else {
            _ = Darwin.unlinkat(dirFD, fileName, 0)
        }
        _ = Darwin.fsync(dirFD)
        return nil
    }

    static func removeIfExists(at filePath: String) {
        guard let (dirPath, fileName) = splitParentAndFileName(filePath) else {
            return
        }
        let dirFD = Darwin.open(dirPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard dirFD >= 0 else {
            return
        }
        defer { _ = Darwin.close(dirFD) }
        if Darwin.unlinkat(dirFD, fileName, 0) == 0 {
            _ = Darwin.fsync(dirFD)
        }
    }
}

struct PhysicalScreenMode: Codable, Equatable, Sendable {
    let displayID: CGDirectDisplayID
    let ioModeID: Int32
    let ioModeIDBitPattern: UInt32
    let width: Int
    let height: Int
    let pixelWidth: Int
    let pixelHeight: Int
    let refreshRate: Double
    let asleep: Bool
    let vendorID: UInt32
    let modelID: UInt32

    func isSameResolutionAndRefresh(as other: PhysicalScreenMode) -> Bool {
        width == other.width &&
        height == other.height &&
        pixelWidth == other.pixelWidth &&
        pixelHeight == other.pixelHeight &&
        abs(refreshRate - other.refreshRate) < 0.01
    }

    func matchesHardwareIdentity(vendorID currentVendor: UInt32, modelID currentModel: UInt32) -> Bool {
        vendorID == currentVendor && modelID == currentModel
    }

    func restoreCommand(scope: RestoreModeScope) -> RestoreModeCommand {
        RestoreModeCommand(
            displayID: displayID,
            ioModeIDBitPattern: ioModeIDBitPattern,
            width: width,
            height: height,
            pixelWidth: pixelWidth,
            pixelHeight: pixelHeight,
            refreshRate: refreshRate,
            scope: scope
        )
    }

    func restoreCLIArguments(scope: RestoreModeScope) -> [String] {
        [
            "--restore-mode",
            String(displayID),
            String(ioModeIDBitPattern),
            String(width),
            String(height),
            String(pixelWidth),
            String(pixelHeight),
            String(refreshRate),
            scope.rawValue
        ]
    }
}

struct DisplayModesSnapshot: Codable, Equatable, Sendable {
    let version: Int
    let savedAt: String
    let displays: [PhysicalScreenMode]
}

@MainActor
struct PhysicalDisplayEnvironment {
    var onlineDisplayIDs: @MainActor () -> [CGDirectDisplayID]
    var vendorID: @MainActor (CGDirectDisplayID) -> UInt32
    var modelID: @MainActor (CGDirectDisplayID) -> UInt32
    var isAsleep: @MainActor (CGDirectDisplayID) -> Bool
    var currentMode: @MainActor (CGDirectDisplayID) -> PhysicalScreenMode?
    var now: @MainActor () -> ContinuousClock.Instant
    var sleep: @MainActor (Duration) async -> Void
    var runRestoreSubprocess: @MainActor (RestoreModeCommand, Duration) async -> SubprocessExitResult
    var observeScreensDidWake: Bool
    var offlinePollTimeoutNormal: Duration
    var offlinePollTimeoutShutdown: Duration
    var offlinePollInterval: Duration
    var topologySettleNormal: Duration
    var topologySettleShutdown: Duration
    var wakeSettleDelay: Duration

    static let live = PhysicalDisplayEnvironment(
        onlineDisplayIDs: { CodelyncDesktopHostCore.onlineDisplayIDs(maxDisplays: 32) },
        vendorID: { id in CGDisplayVendorNumber(id) },
        modelID: { id in CGDisplayModelNumber(id) },
        isAsleep: { id in CGDisplayIsAsleep(id) != 0 },
        currentMode: { id in
            guard let mode = CGDisplayCopyDisplayMode(id) else { return nil }
            let ioID = mode.ioDisplayModeID
            return PhysicalScreenMode(
                displayID: id,
                ioModeID: ioID,
                ioModeIDBitPattern: UInt32(bitPattern: ioID),
                width: mode.width,
                height: mode.height,
                pixelWidth: mode.pixelWidth,
                pixelHeight: mode.pixelHeight,
                refreshRate: mode.refreshRate,
                asleep: CGDisplayIsAsleep(id) != 0,
                vendorID: CGDisplayVendorNumber(id),
                modelID: CGDisplayModelNumber(id)
            )
        },
        now: { ContinuousClock.now },
        sleep: { duration in try? await Task.sleep(for: duration) },
        runRestoreSubprocess: { command, timeout in
            let args = [
                "--restore-mode",
                String(command.displayID),
                String(command.ioModeIDBitPattern),
                String(command.width),
                String(command.height),
                String(command.pixelWidth),
                String(command.pixelHeight),
                String(command.refreshRate),
                command.scope.rawValue
            ]
            return await runHelperSubprocess(arguments: args, timeout: timeout)
        },
        observeScreensDidWake: true,
        offlinePollTimeoutNormal: .seconds(3),
        offlinePollTimeoutShutdown: .milliseconds(800),
        offlinePollInterval: .milliseconds(50),
        topologySettleNormal: .milliseconds(800),
        topologySettleShutdown: .milliseconds(150),
        wakeSettleDelay: .milliseconds(800)
    )
}

final class NotificationObserverBox: @unchecked Sendable {
    private let center: NotificationCenter
    private let token: NSObjectProtocol

    init(center: NotificationCenter, token: NSObjectProtocol) {
        self.center = center
        self.token = token
    }

    deinit {
        center.removeObserver(token)
    }
}

@MainActor
final class PhysicalDisplayModeProtector {
    static let snapshotFilename = "display-modes-snapshot.json"

    let stateDir: String?
    private let env: PhysicalDisplayEnvironment
    private(set) var baselineByDisplayID: [CGDirectDisplayID: PhysicalScreenMode] = [:]
    private(set) var postMountConverged = false
    private(set) var retiringVirtualDisplayIDs: Set<CGDirectDisplayID> = []
    var activeVirtualDisplayIDProvider: (@MainActor () -> CGDirectDisplayID?)?
    private var wakeObserver: NotificationObserverBox?

    var snapshotPath: String? {
        guard let stateDir else { return nil }
        return URL(fileURLWithPath: stateDir, isDirectory: true)
            .appendingPathComponent(Self.snapshotFilename)
            .path
    }

    var hasPendingRestores: Bool {
        !baselineByDisplayID.isEmpty || !retiringVirtualDisplayIDs.isEmpty
    }

    init(stateDir: String?, environment: PhysicalDisplayEnvironment = .live) {
        self.stateDir = stateDir
        self.env = environment
        if environment.observeScreensDidWake {
            let center = NSWorkspace.shared.notificationCenter
            let token = center.addObserver(
                forName: NSWorkspace.screensDidWakeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    await self?.handleScreensDidWake()
                }
            }
            wakeObserver = NotificationObserverBox(center: center, token: token)
        }
    }

    func isCodelyncVirtualDisplayHardware(_ id: CGDirectDisplayID) -> Bool {
        env.vendorID(id) == VirtualDisplayHardwareSpec.vendorID &&
        env.modelID(id) == VirtualDisplayHardwareSpec.productID
    }

    func otherOnlinePhysicalDisplayIDs(excludedVirtualIDs: Set<CGDirectDisplayID>) -> [CGDirectDisplayID] {
        let activeVirtualID = activeVirtualDisplayIDProvider?()
        return env.onlineDisplayIDs().filter { id in
            if id == activeVirtualID { return false }
            if excludedVirtualIDs.contains(id) { return false }
            if retiringVirtualDisplayIDs.contains(id) { return false }
            if isCodelyncVirtualDisplayHardware(id) { return false }
            return true
        }
    }

    func capturePreMountSnapshot(excludedVirtualIDs: Set<CGDirectDisplayID>) {
        let physicalIDs = otherOnlinePhysicalDisplayIDs(excludedVirtualIDs: excludedVirtualIDs)
        for id in physicalIDs {
            guard let mode = env.currentMode(id) else { continue }
            if let existing = baselineByDisplayID[id] {
                if existing.asleep && !mode.asleep {
                    baselineByDisplayID[id] = mode
                }
            } else {
                baselineByDisplayID[id] = mode
            }
        }
        postMountConverged = false
        persistSnapshotIfConfigured()
    }

    func restoreDriftedAfterMount(excludedVirtualIDs: Set<CGDirectDisplayID>) async {
        let onlinePhysical = Set(otherOnlinePhysicalDisplayIDs(excludedVirtualIDs: excludedVirtualIDs))
        var allConverged = true
        for id in Array(baselineByDisplayID.keys).sorted() {
            guard let saved = baselineByDisplayID[id] else { continue }
            guard onlinePhysical.contains(id) else { continue }
            if env.isAsleep(id) || saved.asleep {
                allConverged = false
                continue
            }
            guard let now = env.currentMode(id) else {
                allConverged = false
                continue
            }
            if !now.isSameResolutionAndRefresh(as: saved) {
                let result = await env.runRestoreSubprocess(saved.restoreCommand(scope: .session), .seconds(10))
                if result.succeeded,
                   let after = env.currentMode(id),
                   !env.isAsleep(id),
                   !after.asleep,
                   after.isSameResolutionAndRefresh(as: saved) {
                    continue
                }
                allConverged = false
            }
        }
        postMountConverged = allConverged
    }

    func capturePreRetireSnapshot(excludedVirtualIDs: Set<CGDirectDisplayID>) {
        let physicalIDs = otherOnlinePhysicalDisplayIDs(excludedVirtualIDs: excludedVirtualIDs)
        var changed = false
        for id in physicalIDs {
            guard let now = env.currentMode(id) else { continue }
            if let existing = baselineByDisplayID[id] {
                if existing.asleep && !now.asleep {
                    baselineByDisplayID[id] = now
                    changed = true
                } else if postMountConverged && !now.asleep && !existing.isSameResolutionAndRefresh(as: now) {
                    baselineByDisplayID[id] = now
                    changed = true
                }
            } else {
                baselineByDisplayID[id] = now
                changed = true
            }
        }
        if changed || !baselineByDisplayID.isEmpty {
            persistSnapshotIfConfigured()
        }
    }

    func restoreAfterTeardown(
        retiringVirtualIDs: Set<CGDirectDisplayID>,
        isShuttingDown: Bool,
        deadline: ContinuousClock.Instant? = nil
    ) async {
        await restoreAfterTeardown(
            retiringVirtualIDs: retiringVirtualIDs,
            isShuttingDownProvider: { isShuttingDown },
            deadlineProvider: { deadline }
        )
    }

    func restoreAfterTeardown(
        retiringVirtualIDs: Set<CGDirectDisplayID>,
        isShuttingDownProvider: @MainActor () -> Bool,
        deadlineProvider: @MainActor () -> ContinuousClock.Instant? = { nil }
    ) async {
        let combinedRetiring = retiringVirtualDisplayIDs.union(retiringVirtualIDs)
        if !combinedRetiring.isEmpty {
            let pollStart = env.now()
            while true {
                let online = Set(env.onlineDisplayIDs())
                let remaining = combinedRetiring.intersection(online)
                if remaining.isEmpty {
                    retiringVirtualDisplayIDs.removeAll()
                    break
                }
                let activeDeadline = deadlineProvider()
                let useBoundedPoll = isShuttingDownProvider() || activeDeadline != nil
                let pollCap = useBoundedPoll ? env.offlinePollTimeoutShutdown : env.offlinePollTimeoutNormal
                var pollDeadline = pollStart + pollCap
                if let activeDeadline, activeDeadline < pollDeadline {
                    pollDeadline = activeDeadline
                }
                let now = env.now()
                if now >= pollDeadline {
                    retiringVirtualDisplayIDs = remaining
                    persistSnapshotIfConfigured()
                    return
                }
                let step = min(env.offlinePollInterval, now.duration(to: pollDeadline))
                await env.sleep(step > .zero ? step : env.offlinePollInterval)
            }
        }

        if baselineByDisplayID.isEmpty {
            if let snapshotPath {
                DurableJSONStore.removeIfExists(at: snapshotPath)
            }
            return
        }

        let settleDeadline = deadlineProvider()
        let useBoundedSettle = isShuttingDownProvider() || settleDeadline != nil
        var settle = useBoundedSettle ? env.topologySettleShutdown : env.topologySettleNormal
        if let settleDeadline {
            let remaining = max(.zero, env.now().duration(to: settleDeadline))
            if remaining < settle {
                settle = remaining
            }
        }
        if settle > .zero {
            await env.sleep(settle)
        }

        let onlineIDs = Set(env.onlineDisplayIDs())
        var driftedDisplayIDs: [CGDirectDisplayID] = []

        for id in Array(baselineByDisplayID.keys).sorted() {
            guard let saved = baselineByDisplayID[id] else { continue }
            guard onlineIDs.contains(id) else {
                // Unplugged display: settle record.
                baselineByDisplayID.removeValue(forKey: id)
                continue
            }
            if isCodelyncVirtualDisplayHardware(id) {
                baselineByDisplayID.removeValue(forKey: id)
                continue
            }
            if !saved.matchesHardwareIdentity(vendorID: env.vendorID(id), modelID: env.modelID(id)) {
                baselineByDisplayID.removeValue(forKey: id)
                continue
            }
            if env.isAsleep(id) {
                // Defer restoration until displays wake.
                continue
            }
            guard let now = env.currentMode(id) else {
                continue
            }
            if saved.asleep {
                // Display was asleep at pre-mount snapshot and woke with no drifted awake baseline; settle.
                baselineByDisplayID.removeValue(forKey: id)
                continue
            }
            if now.isSameResolutionAndRefresh(as: saved) {
                baselineByDisplayID.removeValue(forKey: id)
                continue
            }
            driftedDisplayIDs.append(id)
        }

        for (index, id) in driftedDisplayIDs.enumerated() {
            guard let saved = baselineByDisplayID[id] else { continue }
            let baseCap: Duration = isShuttingDownProvider() ? .milliseconds(1500) : .seconds(10)
            let subprocessTimeout: Duration
            if let activeDeadline = deadlineProvider() {
                let remaining = env.now().duration(to: activeDeadline)
                if remaining <= .zero {
                    break
                }
                let remainingDisplays = driftedDisplayIDs.count - index
                let fairShare = remainingDisplays > 1 ? (remaining / remainingDisplays) : remaining
                subprocessTimeout = min(baseCap, fairShare)
                if subprocessTimeout <= .zero {
                    break
                }
            } else {
                subprocessTimeout = baseCap
            }
            let result = await env.runRestoreSubprocess(saved.restoreCommand(scope: .permanent), subprocessTimeout)
            if result.succeeded,
               let after = env.currentMode(id),
               !env.isAsleep(id),
               !after.asleep,
               after.isSameResolutionAndRefresh(as: saved) {
                baselineByDisplayID.removeValue(forKey: id)
            }
        }

        if baselineByDisplayID.isEmpty {
            if let snapshotPath {
                DurableJSONStore.removeIfExists(at: snapshotPath)
            }
        } else {
            persistSnapshotIfConfigured()
        }
    }

    func handleScreensDidWake() async {
        guard activeVirtualDisplayIDProvider?() == nil, hasPendingRestores else { return }
        if env.wakeSettleDelay > .zero {
            await env.sleep(env.wakeSettleDelay)
        }
        guard activeVirtualDisplayIDProvider?() == nil, hasPendingRestores else { return }
        await restoreAfterTeardown(retiringVirtualIDs: retiringVirtualDisplayIDs, isShuttingDown: false)
    }

    func reconcileStartupIfNeeded() async {
        guard let snapshotPath else { return }
        guard let snapshot = DurableJSONStore.loadOrQuarantine(
            DisplayModesSnapshot.self,
            from: snapshotPath,
            validate: { $0.version == 1 }
        ) else {
            return
        }

        let staleVirtualIDs = Set(env.onlineDisplayIDs().filter { isCodelyncVirtualDisplayHardware($0) })
        for entry in snapshot.displays {
            if entry.vendorID == VirtualDisplayHardwareSpec.vendorID &&
                entry.modelID == VirtualDisplayHardwareSpec.productID {
                continue
            }
            baselineByDisplayID[entry.displayID] = entry
        }
        await restoreAfterTeardown(retiringVirtualIDs: staleVirtualIDs, isShuttingDown: false)
    }

    private func persistSnapshotIfConfigured() {
        guard let snapshotPath else { return }
        if baselineByDisplayID.isEmpty && retiringVirtualDisplayIDs.isEmpty {
            DurableJSONStore.removeIfExists(at: snapshotPath)
            return
        }
        let ordered = baselineByDisplayID.keys.sorted().compactMap { baselineByDisplayID[$0] }
        let formatter = ISO8601DateFormatter()
        let snapshot = DisplayModesSnapshot(
            version: 1,
            savedAt: formatter.string(from: Date()),
            displays: ordered
        )
        try? DurableJSONStore.writeAtomic(snapshot, to: snapshotPath)
    }
}
