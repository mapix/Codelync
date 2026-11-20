import CoreGraphics
import Darwin
import Foundation
import XCTest
@testable import CodelyncDesktopHostCore

final class SubprocessAndSnapshotTests: XCTestCase {
    private func makeTempStateDir() throws -> URL {
        let base = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("cl-host-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    func testCLIArgumentParsingAndSignedIOModeIDRoundTrip() {
        XCTAssertEqual(parseDesktopCLIArguments([]), .success(.daemon(stateDir: nil)))
        XCTAssertEqual(
            parseDesktopCLIArguments(["--state-dir=/var/tmp/cl-state"]),
            .success(.daemon(stateDir: "/var/tmp/cl-state"))
        )
        XCTAssertEqual(
            parseDesktopCLIArguments(["--state-dir", "/var/tmp/cl-state"]),
            .success(.daemon(stateDir: "/var/tmp/cl-state"))
        )

        XCTAssertEqual(parseDesktopCLIArguments(["--state-dir"]), .failure(.missingStateDirValue))
        XCTAssertEqual(parseDesktopCLIArguments(["--state-dir="]), .failure(.invalidStateDirValue))
        XCTAssertEqual(parseDesktopCLIArguments(["--state-dir", "--other"]), .failure(.invalidStateDirValue))
        XCTAssertEqual(parseDesktopCLIArguments(["--bogus"]), .failure(.unknownArgument("--bogus")))

        // --set-mode validation
        XCTAssertEqual(
            parseDesktopCLIArguments(["--set-mode", "72", "540", "1080"]),
            .success(.setMode(SetModeCommand(displayID: 72, logicalWidth: 540, logicalHeight: 1080)))
        )
        XCTAssertEqual(parseDesktopCLIArguments(["--set-mode", "0", "540", "1080"]), .failure(.invalidSetModeArguments))
        XCTAssertEqual(parseDesktopCLIArguments(["--set-mode", "72", "-10", "1080"]), .failure(.invalidSetModeArguments))
        XCTAssertEqual(parseDesktopCLIArguments(["--set-mode", "72", "540"]), .failure(.invalidSetModeArguments))

        // --restore-mode with negative Int32 ioDisplayModeID (-2_147_483_640 -> UInt32 bitPattern 2_147_483_656)
        let negativeModeID: Int32 = -2_147_483_640
        let bitPattern = UInt32(bitPattern: negativeModeID)
        XCTAssertEqual(bitPattern, 2_147_483_656)

        let parsedPermanent = parseDesktopCLIArguments([
            "--restore-mode", "69733382", String(bitPattern),
            "1728", "1117", "3456", "2234", "120.0", "permanent"
        ])
        guard case .success(.restoreMode(let cmdPerm)) = parsedPermanent else {
            return XCTFail("Expected valid permanent RestoreModeCommand, got \(parsedPermanent)")
        }
        XCTAssertEqual(cmdPerm.ioModeID, negativeModeID)
        XCTAssertEqual(cmdPerm.scope, .permanent)

        // refreshRate == 0.0 must be accepted for panels without fixed scan rates.
        let parsedZeroHz = parseDesktopCLIArguments([
            "--restore-mode", "42", "12", "1920", "1080", "3840", "2160", "0.0", "session"
        ])
        guard case .success(.restoreMode(let cmdZero)) = parsedZeroHz else {
            return XCTFail("Expected valid 0.0Hz session RestoreModeCommand")
        }
        XCTAssertEqual(cmdZero.refreshRate, 0.0)
        XCTAssertEqual(cmdZero.scope, .session)

        // Invalid restore arguments fail closed.
        XCTAssertEqual(
            parseDesktopCLIArguments(["--restore-mode", "42", "12", "1920", "1080", "3840", "2160", "-1.0", "session"]),
            .failure(.invalidRestoreModeArguments)
        )
        XCTAssertEqual(
            parseDesktopCLIArguments(["--restore-mode", "42", "12", "1920", "1080", "3840", "2160", "nan", "session"]),
            .failure(.invalidRestoreModeArguments)
        )
        XCTAssertEqual(
            parseDesktopCLIArguments(["--restore-mode", "42", "12", "1920", "1080", "3840", "2160", "60.0", "invalid"]),
            .failure(.invalidRestoreModeArguments)
        )
    }

    func testSubprocessBoxExitCodesAndTimeoutTermination() async {
        let ok = await runHelperSubprocess(
            executableURL: URL(fileURLWithPath: "/usr/bin/true"),
            arguments: [],
            timeout: .seconds(2)
        )
        XCTAssertEqual(ok, .exited(0))
        XCTAssertTrue(ok.succeeded)

        let fail = await runHelperSubprocess(
            executableURL: URL(fileURLWithPath: "/usr/bin/false"),
            arguments: [],
            timeout: .seconds(2)
        )
        XCTAssertEqual(fail, .exited(1))
        XCTAssertFalse(fail.succeeded)

        let timedOut = await runHelperSubprocess(
            executableURL: URL(fileURLWithPath: "/bin/sleep"),
            arguments: ["5"],
            timeout: .milliseconds(120)
        )
        XCTAssertEqual(timedOut, .timedOut)
        XCTAssertFalse(timedOut.succeeded)
    }

    private func waitForRecordedPID(at path: String, timeout: Duration = .seconds(2)) async -> pid_t? {
        let clock = ContinuousClock()
        let deadline = clock.now + timeout
        while clock.now < deadline {
            if let text = try? String(contentsOfFile: path, encoding: .utf8),
               text.hasSuffix("\n"),
               let parsed = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)),
               parsed > 0 {
                return parsed
            }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return nil
    }

    private func waitForProcessReaped(_ pid: pid_t, timeout: Duration = .seconds(2)) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now + timeout
        while clock.now < deadline {
            if Darwin.kill(pid, 0) == -1 && errno == ESRCH {
                return true
            }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return Darwin.kill(pid, 0) == -1 && errno == ESRCH
    }

    func testSubprocessBoxPreCancelledZeroTimeoutMidFlightCancelAndSigkill() async throws {
        let root = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: root) }

        // (a) Pre-cancelled Task: must return .timedOut immediately without SIGABRT or spawning child.
        let sentinelPath = root.appendingPathComponent("never-spawned.marker").path
        let preCancelStart = ContinuousClock.now
        let preCancelledTask = Task<SubprocessExitResult, Never> {
            withUnsafeCurrentTask { $0?.cancel() }
            XCTAssertTrue(Task.isCancelled)
            return await runHelperSubprocess(
                executableURL: URL(fileURLWithPath: "/usr/bin/touch"),
                arguments: [sentinelPath],
                timeout: .seconds(10)
            )
        }
        let preCancelledResult = await preCancelledTask.value
        XCTAssertEqual(preCancelledResult, .timedOut)
        XCTAssertLessThan(ContinuousClock.now - preCancelStart, .seconds(1))
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertFalse(FileManager.default.fileExists(atPath: sentinelPath))

        // (b1) .zero, negative, and 1ns launch-boundary timeouts against /bin/sleep.
        let zeroResult = await runHelperSubprocess(
            executableURL: URL(fileURLWithPath: "/bin/sleep"),
            arguments: ["30"],
            timeout: .zero
        )
        XCTAssertEqual(zeroResult, .timedOut)

        let negativeResult = await runHelperSubprocess(
            executableURL: URL(fileURLWithPath: "/bin/sleep"),
            arguments: ["30"],
            timeout: .milliseconds(-5)
        )
        XCTAssertEqual(negativeResult, .timedOut)

        let nanoRaceResult = await runHelperSubprocess(
            executableURL: URL(fileURLWithPath: "/bin/sleep"),
            arguments: ["30"],
            timeout: .nanoseconds(1)
        )
        XCTAssertEqual(nanoRaceResult, .timedOut)

        // (b2) Ultra-short timeout against running child kills and reaps /bin/sleep cleanly.
        let shortPidPath = root.appendingPathComponent("short-timeout.pid").path
        let shortTimeoutResult = await runHelperSubprocess(
            executableURL: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "printf \"%d\\n\" \"$$\" > \"$1\"; exec /bin/sleep 30", "sh", shortPidPath],
            timeout: .milliseconds(80)
        )
        XCTAssertEqual(shortTimeoutResult, .timedOut)
        if let shortPid = await waitForRecordedPID(at: shortPidPath, timeout: .milliseconds(100)) {
            let reaped = await waitForProcessReaped(shortPid)
            XCTAssertTrue(reaped, "Timed-out child process \(shortPid) was not killed/reaped")
        }

        // (b3) SIGTERM-ignoring single-PID child (blocked on FIFO) is killed via SIGKILL escalation.
        let sigIgnPidPath = root.appendingPathComponent("sigign.pid").path
        let fifoPath = root.appendingPathComponent("block.fifo").path
        XCTAssertEqual(Darwin.mkfifo(fifoPath, 0o600), 0)
        let sigIgnResult = await runHelperSubprocess(
            executableURL: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "trap \"\" TERM; printf \"%d\\n\" \"$$\" > \"$1\"; read _ < \"$2\"", "sh", sigIgnPidPath, fifoPath],
            timeout: .milliseconds(60),
            sigkillGrace: .milliseconds(60)
        )
        XCTAssertEqual(sigIgnResult, .timedOut)
        let sigIgnPid = await waitForRecordedPID(at: sigIgnPidPath, timeout: .milliseconds(250))
        XCTAssertNotNil(sigIgnPid)
        if let sigIgnPid {
            let reaped = await waitForProcessReaped(sigIgnPid)
            XCTAssertTrue(reaped, "SIGTERM-ignoring child \(sigIgnPid) was not killed/reaped by SIGKILL escalation")
        }

        // (c) Mid-flight Task.cancel() while child is confirmed running.
        let cancelPidPath = root.appendingPathComponent("midflight-cancel.pid").path
        let midFlightTask = Task<SubprocessExitResult, Never> {
            await runHelperSubprocess(
                executableURL: URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", "printf \"%d\\n\" \"$$\" > \"$1\"; exec /bin/sleep 30", "sh", cancelPidPath],
                timeout: .seconds(15)
            )
        }
        guard let runningPid = await waitForRecordedPID(at: cancelPidPath) else {
            midFlightTask.cancel()
            return XCTFail("Child did not record PID before deadline")
        }
        let cancelStart = ContinuousClock.now
        midFlightTask.cancel()
        let midFlightResult = await midFlightTask.value
        XCTAssertEqual(midFlightResult, .timedOut)
        XCTAssertLessThan(ContinuousClock.now - cancelStart, .seconds(2))
        let midFlightReaped = await waitForProcessReaped(runningPid)
        XCTAssertTrue(midFlightReaped, "Cancelled mid-flight child \(runningPid) was not killed/reaped")

        // (d) Nil / missing executable returns .launchFailed without crashing or leaking.
        let nilExec = await runHelperSubprocess(executableURL: nil, arguments: [])
        XCTAssertEqual(nilExec, .launchFailed("executable-url-unavailable"))
        let missingExec = await runHelperSubprocess(
            executableURL: root.appendingPathComponent("missing-executable"),
            arguments: []
        )
        if case .launchFailed = missingExec {
            // Expected
        } else {
            XCTFail("Expected .launchFailed for missing executable, got \(missingExec)")
        }
    }

    func testVirtualHiDPIAndPhysicalRestoreModeSelectionPriority() {
        let candidates = [
            DisplayModeCandidate(ioModeID: 1, width: 540, height: 1080, pixelWidth: 540, pixelHeight: 1080, refreshRate: 60.0, usableForDesktopGUI: true),
            DisplayModeCandidate(ioModeID: 2, width: 540, height: 1080, pixelWidth: 1080, pixelHeight: 2160, refreshRate: 60.0, usableForDesktopGUI: false),
            DisplayModeCandidate(ioModeID: 3, width: 540, height: 1080, pixelWidth: 1080, pixelHeight: 2160, refreshRate: 60.0, usableForDesktopGUI: true)
        ]
        XCTAssertEqual(selectVirtualHiDPIModeIndex(in: candidates, logicalWidth: 540, logicalHeight: 1080), 2)
        XCTAssertNil(selectVirtualHiDPIModeIndex(in: [candidates[0]], logicalWidth: 540, logicalHeight: 1080))

        let physCandidates = [
            DisplayModeCandidate(ioModeID: 10, width: 1728, height: 1117, pixelWidth: 3456, pixelHeight: 2234, refreshRate: 59.94, usableForDesktopGUI: false),
            DisplayModeCandidate(ioModeID: 11, width: 1728, height: 1117, pixelWidth: 3456, pixelHeight: 2234, refreshRate: 59.944, usableForDesktopGUI: true),
            DisplayModeCandidate(ioModeID: -99, width: 1728, height: 1117, pixelWidth: 3456, pixelHeight: 2234, refreshRate: 59.941, usableForDesktopGUI: true)
        ]

        // 1) Exact ioModeID match wins.
        let exactCmd = RestoreModeCommand(
            displayID: 1,
            ioModeIDBitPattern: UInt32(bitPattern: -99),
            width: 1728, height: 1117, pixelWidth: 3456, pixelHeight: 2234,
            refreshRate: 59.94,
            scope: .permanent
        )
        XCTAssertEqual(selectPhysicalRestoreModeIndex(in: physCandidates, command: exactCmd), 2)

        // 2) If ioModeID renumbered by WindowServer, usableForDesktopGUI wins.
        let renumberedCmd = RestoreModeCommand(
            displayID: 1,
            ioModeIDBitPattern: 999,
            width: 1728, height: 1117, pixelWidth: 3456, pixelHeight: 2234,
            refreshRate: 59.94,
            scope: .permanent
        )
        XCTAssertEqual(selectPhysicalRestoreModeIndex(in: physCandidates, command: renumberedCmd), 1)

        // 3) Refresh rate mismatch (>= 0.01 Hz) fails closed.
        let wrongHzCmd = RestoreModeCommand(
            displayID: 1,
            ioModeIDBitPattern: 11,
            width: 1728, height: 1117, pixelWidth: 3456, pixelHeight: 2234,
            refreshRate: 120.0,
            scope: .permanent
        )
        XCTAssertNil(selectPhysicalRestoreModeIndex(in: physCandidates, command: wrongHzCmd))
    }

    func testDurableJSONStorePermissionsQuarantineAndSymlinkDefense() throws {
        let root = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: root) }

        let stateSubdir = root.appendingPathComponent("state-dir", isDirectory: true)
        try FileManager.default.createDirectory(
            at: stateSubdir,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: Int16(0o755))]
        )

        let filePath = stateSubdir.appendingPathComponent("display-modes-snapshot.json").path
        let sample = DisplayModesSnapshot(
            version: 1,
            savedAt: "2026-11-18T14:00:00Z",
            displays: [
                PhysicalScreenMode(
                    displayID: 10,
                    ioModeID: -42,
                    ioModeIDBitPattern: UInt32(bitPattern: -42),
                    width: 1920,
                    height: 1080,
                    pixelWidth: 3840,
                    pixelHeight: 2160,
                    refreshRate: 60.0,
                    asleep: false,
                    vendorID: 0x0610,
                    modelID: 0xA034
                )
            ]
        )
        try DurableJSONStore.writeAtomic(sample, to: filePath)

        var dirStat = Darwin.stat()
        XCTAssertEqual(Darwin.lstat(stateSubdir.path, &dirStat), 0)
        XCTAssertEqual(dirStat.st_mode & 0o777, 0o700)

        var fileStat = Darwin.stat()
        XCTAssertEqual(Darwin.lstat(filePath, &fileStat), 0)
        XCTAssertEqual(fileStat.st_mode & 0o777, 0o600)

        let entries = try FileManager.default.contentsOfDirectory(atPath: stateSubdir.path)
        XCTAssertFalse(entries.contains(where: { $0.hasSuffix(".tmp") }))

        let loaded = DurableJSONStore.loadOrQuarantine(DisplayModesSnapshot.self, from: filePath)
        XCTAssertEqual(loaded, sample)

        // Corrupt JSON must be quarantined to .corrupt-<ts> with 0o600 permissions.
        try Data("{broken-json".utf8).write(to: URL(fileURLWithPath: filePath))
        XCTAssertNil(DurableJSONStore.loadOrQuarantine(DisplayModesSnapshot.self, from: filePath))
        let afterQuarantine = try FileManager.default.contentsOfDirectory(atPath: stateSubdir.path)
        let corruptFiles = afterQuarantine.filter { $0.hasPrefix("display-modes-snapshot.json.corrupt-") }
        XCTAssertEqual(corruptFiles.count, 1)
        var qStat = Darwin.stat()
        XCTAssertEqual(Darwin.lstat(stateSubdir.appendingPathComponent(corruptFiles[0]).path, &qStat), 0)
        XCTAssertEqual(qStat.st_mode & 0o777, 0o600)

        // Symlink target must be refused on both writeAtomic and loadOrQuarantine.
        let outsideFile = root.appendingPathComponent("outside.json").path
        try Data("{\"secret\":true}".utf8).write(to: URL(fileURLWithPath: outsideFile))
        try FileManager.default.createSymbolicLink(atPath: filePath, withDestinationPath: outsideFile)
        XCTAssertThrowsError(try DurableJSONStore.writeAtomic(sample, to: filePath))
        XCTAssertNil(DurableJSONStore.loadOrQuarantine(DisplayModesSnapshot.self, from: filePath))

        // > 1 MiB regular file in genuine dirPath must be quarantined to .corrupt-<ms> with 0o600 permissions.
        _ = Darwin.unlink(filePath)
        let oversizedRealDir = root.appendingPathComponent("oversized-state", isDirectory: true)
        try FileManager.default.createDirectory(at: oversizedRealDir, withIntermediateDirectories: true)
        let oversizedRealFile = oversizedRealDir.appendingPathComponent("display-modes-snapshot.json").path
        let oversizedPayload = Data(repeating: UInt8(ascii: "x"), count: 1_048_577)
        try oversizedPayload.write(to: URL(fileURLWithPath: oversizedRealFile))
        _ = Darwin.chmod(oversizedRealFile, mode_t(0o644))
        XCTAssertNil(DurableJSONStore.loadOrQuarantine(DisplayModesSnapshot.self, from: oversizedRealFile))
        let oversizedQuarantined = try FileManager.default.contentsOfDirectory(atPath: oversizedRealDir.path)
            .filter { $0.hasPrefix("display-modes-snapshot.json.corrupt-") }
        XCTAssertEqual(oversizedQuarantined.count, 1)
        var oqStat = Darwin.stat()
        XCTAssertEqual(Darwin.lstat(oversizedRealDir.appendingPathComponent(oversizedQuarantined[0]).path, &oqStat), 0)
        XCTAssertEqual(oqStat.st_mode & 0o777, 0o600)

        // Symlinked dirPath (--state-dir=<symlink>) must NEVER read, rename/quarantine, chmod, unlink, or write into victim target dir.
        let victimDir = root.appendingPathComponent("victim-dir", isDirectory: true)
        try FileManager.default.createDirectory(
            at: victimDir,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: Int16(0o755))]
        )
        _ = Darwin.chmod(victimDir.path, mode_t(0o755))
        let symStateDir = root.appendingPathComponent("sym-state").path
        try FileManager.default.createSymbolicLink(atPath: symStateDir, withDestinationPath: victimDir.path)
        let symSnapshotPath = "\(symStateDir)/display-modes-snapshot.json"
        let victimSnapshotPath = victimDir.appendingPathComponent("display-modes-snapshot.json").path

        // (a.1) Valid JSON in victimDir: loadOrQuarantine returns nil, removeIfExists leaves file intact, writeAtomic throws ELOOP.
        let encodedValid = try JSONEncoder().encode(sample)
        try encodedValid.write(to: URL(fileURLWithPath: victimSnapshotPath))
        _ = Darwin.chmod(victimSnapshotPath, mode_t(0o644))
        XCTAssertNil(DurableJSONStore.loadOrQuarantine(DisplayModesSnapshot.self, from: symSnapshotPath))
        DurableJSONStore.removeIfExists(at: symSnapshotPath)
        XCTAssertThrowsError(try DurableJSONStore.writeAtomic(sample, to: symSnapshotPath)) { error in
            let nsErr = error as NSError
            XCTAssertEqual(nsErr.domain, NSPOSIXErrorDomain)
            XCTAssertEqual(nsErr.code, Int(ELOOP))
        }
        XCTAssertThrowsError(try DurableJSONStore.writeAtomic(sample, to: "\(symStateDir)/nested/display-modes-snapshot.json"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: victimDir.appendingPathComponent("nested").path))
        var victimDirStat = Darwin.stat()
        XCTAssertEqual(Darwin.lstat(victimDir.path, &victimDirStat), 0)
        XCTAssertEqual(victimDirStat.st_mode & 0o777, 0o755)
        var victimFileStat = Darwin.stat()
        XCTAssertEqual(Darwin.lstat(victimSnapshotPath, &victimFileStat), 0)
        XCTAssertEqual(victimFileStat.st_mode & 0o777, 0o644)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: victimSnapshotPath)), encodedValid)

        // (a.2) Corrupt JSON in victimDir: NOT quarantined/renamed, 0o644 preserved.
        try Data("{corrupt-victim-json".utf8).write(to: URL(fileURLWithPath: victimSnapshotPath))
        _ = Darwin.chmod(victimSnapshotPath, mode_t(0o644))
        XCTAssertNil(DurableJSONStore.loadOrQuarantine(DisplayModesSnapshot.self, from: symSnapshotPath))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: victimDir.path), ["display-modes-snapshot.json"])
        XCTAssertEqual(Darwin.lstat(victimSnapshotPath, &victimFileStat), 0)
        XCTAssertEqual(victimFileStat.st_mode & 0o777, 0o644)

        // (a.3) > 1 MiB file in victimDir: NOT quarantined/renamed/unlinked, 0o644 preserved.
        try oversizedPayload.write(to: URL(fileURLWithPath: victimSnapshotPath))
        _ = Darwin.chmod(victimSnapshotPath, mode_t(0o644))
        XCTAssertNil(DurableJSONStore.loadOrQuarantine(DisplayModesSnapshot.self, from: symSnapshotPath))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: victimDir.path), ["display-modes-snapshot.json"])
        XCTAssertEqual(Darwin.lstat(victimSnapshotPath, &victimFileStat), 0)
        XCTAssertEqual(victimFileStat.st_mode & 0o777, 0o644)
    }

    @MainActor
    func testPhysicalDisplayModeProtectorDriftSleepDeferralAndStartupRecovery() async throws {
        let root = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: root) }

        var fakeNow = ContinuousClock.now
        var online: [CGDirectDisplayID] = [10, 20, 5001] // 5001 is Codelync virtual hardware (0x434C/0x00F0)
        var asleepSet: Set<CGDirectDisplayID> = []
        var modes: [CGDirectDisplayID: PhysicalScreenMode] = [
            10: PhysicalScreenMode(
                displayID: 10, ioModeID: -10, ioModeIDBitPattern: UInt32(bitPattern: -10),
                width: 1728, height: 1117, pixelWidth: 3456, pixelHeight: 2234, refreshRate: 120.0,
                asleep: false, vendorID: 0x0610, modelID: 0xA034
            ),
            20: PhysicalScreenMode(
                displayID: 20, ioModeID: 25, ioModeIDBitPattern: 25,
                width: 2560, height: 1440, pixelWidth: 5120, pixelHeight: 2880, refreshRate: 60.0,
                asleep: false, vendorID: 0x10AC, modelID: 0xD0B3
            ),
            5001: PhysicalScreenMode(
                displayID: 5001, ioModeID: 1, ioModeIDBitPattern: 1,
                width: 540, height: 1080, pixelWidth: 1080, pixelHeight: 2160, refreshRate: 60.0,
                asleep: false, vendorID: 0x434C, modelID: 0x00F0
            )
        ]
        var restoreCalls: [RestoreModeCommand] = []

        let makeEnv: () -> PhysicalDisplayEnvironment = {
            PhysicalDisplayEnvironment(
                onlineDisplayIDs: { online },
                vendorID: { id in modes[id]?.vendorID ?? 0 },
                modelID: { id in modes[id]?.modelID ?? 0 },
                isAsleep: { id in asleepSet.contains(id) },
                currentMode: { id in modes[id] },
                now: { fakeNow },
                sleep: { d in fakeNow += d },
                runRestoreSubprocess: { cmd, _ in
                    restoreCalls.append(cmd)
                    if var cur = modes[cmd.displayID] {
                        cur = PhysicalScreenMode(
                            displayID: cur.displayID,
                            ioModeID: cmd.ioModeID,
                            ioModeIDBitPattern: cmd.ioModeIDBitPattern,
                            width: cmd.width,
                            height: cmd.height,
                            pixelWidth: cmd.pixelWidth,
                            pixelHeight: cmd.pixelHeight,
                            refreshRate: cmd.refreshRate,
                            asleep: false,
                            vendorID: cur.vendorID,
                            modelID: cur.modelID
                        )
                        modes[cmd.displayID] = cur
                    }
                    return .exited(0)
                },
                observeScreensDidWake: false,
                offlinePollTimeoutNormal: .milliseconds(100),
                offlinePollTimeoutShutdown: .milliseconds(50),
                offlinePollInterval: .milliseconds(10),
                topologySettleNormal: .zero,
                topologySettleShutdown: .zero,
                wakeSettleDelay: .zero
            )
        }

        let protector = PhysicalDisplayModeProtector(stateDir: root.path, environment: makeEnv())
        protector.capturePreMountSnapshot(excludedVirtualIDs: [])
        // Virtual hardware 5001 must never enter baselineByDisplayID!
        XCTAssertEqual(Set(protector.baselineByDisplayID.keys), [10, 20])
        XCTAssertTrue(FileManager.default.fileExists(atPath: protector.snapshotPath!))

        // Simulate display 20 drifting to 60Hz 1x (2560x1440 px instead of 5120x2880 px) on virtual mount.
        modes[20] = PhysicalScreenMode(
            displayID: 20, ioModeID: 99, ioModeIDBitPattern: 99,
            width: 2560, height: 1440, pixelWidth: 2560, pixelHeight: 1440, refreshRate: 60.0,
            asleep: false, vendorID: 0x10AC, modelID: 0xD0B3
        )
        await protector.restoreDriftedAfterMount(excludedVirtualIDs: [5001])
        XCTAssertEqual(restoreCalls.count, 1)
        XCTAssertEqual(restoreCalls[0].displayID, 20)
        XCTAssertEqual(restoreCalls[0].scope, .session)
        // Snapshot stays on disk while virtual display remains active (crash safety).
        XCTAssertTrue(FileManager.default.fileExists(atPath: protector.snapshotPath!))

        // Simulate teardown while display 10 drifted AND is currently asleep, and virtual 5001 went offline.
        restoreCalls.removeAll()
        online = [10, 20]
        modes[10] = PhysicalScreenMode(
            displayID: 10, ioModeID: 77, ioModeIDBitPattern: 77,
            width: 1440, height: 900, pixelWidth: 2880, pixelHeight: 1800, refreshRate: 60.0,
            asleep: true, vendorID: 0x0610, modelID: 0xA034
        )
        asleepSet = [10]

        await protector.restoreAfterTeardown(retiringVirtualIDs: [5001], isShuttingDown: false)
        // Display 20 was already converged (0 subprocesses!), Display 10 was asleep so deferred!
        XCTAssertTrue(restoreCalls.isEmpty)
        XCTAssertEqual(Set(protector.baselineByDisplayID.keys), [10])
        XCTAssertTrue(FileManager.default.fileExists(atPath: protector.snapshotPath!))

        // Test crash recovery on a fresh protector instance once display 10 wakes up!
        asleepSet.removeAll()
        let restartedProtector = PhysicalDisplayModeProtector(stateDir: root.path, environment: makeEnv())
        await restartedProtector.reconcileStartupIfNeeded()
        XCTAssertEqual(restoreCalls.count, 1)
        XCTAssertEqual(restoreCalls[0].displayID, 10)
        XCTAssertEqual(restoreCalls[0].scope, .permanent)
        XCTAssertEqual(restoreCalls[0].refreshRate, 120.0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: restartedProtector.snapshotPath!))
    }

    @MainActor
    func testRestoreDriftedAfterMountNonConvergencePreservesBaselineForPermanentRestore() async throws {
        let root = try makeTempStateDir()
        defer { try? FileManager.default.removeItem(at: root) }

        var fakeNow = ContinuousClock.now
        var online: [CGDirectDisplayID] = [10, 5001]
        let preMount120Hz = PhysicalScreenMode(
            displayID: 10, ioModeID: -10, ioModeIDBitPattern: UInt32(bitPattern: -10),
            width: 1728, height: 1117, pixelWidth: 3456, pixelHeight: 2234, refreshRate: 120.0,
            asleep: false, vendorID: 0x0610, modelID: 0xA034
        )
        let drifted60Hz1x = PhysicalScreenMode(
            displayID: 10, ioModeID: 88, ioModeIDBitPattern: 88,
            width: 1728, height: 1117, pixelWidth: 1728, pixelHeight: 1117, refreshRate: 60.0,
            asleep: false, vendorID: 0x0610, modelID: 0xA034
        )
        var modes: [CGDirectDisplayID: PhysicalScreenMode] = [
            10: preMount120Hz,
            5001: PhysicalScreenMode(
                displayID: 5001, ioModeID: 1, ioModeIDBitPattern: 1,
                width: 540, height: 1080, pixelWidth: 1080, pixelHeight: 2160, refreshRate: 60.0,
                asleep: false, vendorID: 0x434C, modelID: 0x00F0
            )
        ]
        var restoreCalls: [RestoreModeCommand] = []

        let makeEnv: () -> PhysicalDisplayEnvironment = {
            PhysicalDisplayEnvironment(
                onlineDisplayIDs: { online },
                vendorID: { id in modes[id]?.vendorID ?? 0 },
                modelID: { id in modes[id]?.modelID ?? 0 },
                isAsleep: { _ in false },
                currentMode: { id in modes[id] },
                now: { fakeNow },
                sleep: { d in fakeNow += d },
                runRestoreSubprocess: { cmd, _ in
                    restoreCalls.append(cmd)
                    // Simulate WindowServer accepting .session exit 0 while keeping display 10 clamped at 60Hz 1x
                    // until the virtual display goes offline, then converging on .permanent restore.
                    if cmd.scope == .permanent {
                        modes[cmd.displayID] = preMount120Hz
                    }
                    return .exited(0)
                },
                observeScreensDidWake: false,
                offlinePollTimeoutNormal: .milliseconds(100),
                offlinePollTimeoutShutdown: .milliseconds(50),
                offlinePollInterval: .milliseconds(10),
                topologySettleNormal: .zero,
                topologySettleShutdown: .zero,
                wakeSettleDelay: .zero
            )
        }

        let protector = PhysicalDisplayModeProtector(stateDir: root.path, environment: makeEnv())
        protector.capturePreMountSnapshot(excludedVirtualIDs: [5001])
        XCTAssertEqual(protector.baselineByDisplayID[10], preMount120Hz)

        // Companion physical display drifts on virtual display mount; .session restore exits 0 without converging.
        modes[10] = drifted60Hz1x
        await protector.restoreDriftedAfterMount(excludedVirtualIDs: [5001])
        XCTAssertEqual(restoreCalls.map(\.scope), [.session])
        XCTAssertFalse(protector.postMountConverged)

        // Pre-retire snapshot MUST NOT clobber the pre-mount 120Hz 2x baseline with the unconverged 60Hz 1x mode.
        protector.capturePreRetireSnapshot(excludedVirtualIDs: [5001])
        XCTAssertEqual(protector.baselineByDisplayID[10], preMount120Hz)
        let persistedBeforeTeardown = DurableJSONStore.loadOrQuarantine(
            DisplayModesSnapshot.self,
            from: protector.snapshotPath!
        )
        XCTAssertEqual(persistedBeforeTeardown?.displays, [preMount120Hz])

        // Once virtual display 5001 goes offline, restoreAfterTeardown MUST restore 120Hz 2x .permanently.
        online = [10]
        await protector.restoreAfterTeardown(retiringVirtualIDs: [5001], isShuttingDown: false)
        XCTAssertEqual(restoreCalls.map(\.scope), [.session, .permanent])
        XCTAssertEqual(restoreCalls.last?.refreshRate, 120.0)
        XCTAssertEqual(restoreCalls.last?.pixelWidth, 3456)
        XCTAssertTrue(protector.baselineByDisplayID.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: protector.snapshotPath!))
    }
}
