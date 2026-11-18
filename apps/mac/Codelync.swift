import AppKit
import UniformTypeIdentifiers
import SwiftUI
import CoreImage.CIFilterBuiltins

// BEGIN CODELYNC DASHBOARD VALUES
enum DashboardPanel: String, CaseIterable { case statistics, pairing }

struct DashboardSelection: Equatable {
    private(set) var panel: DashboardPanel = .pairing
    private var userSelected = false
    private var pairedDefaultApplied = false

    mutating func select(_ value: DashboardPanel) { panel = value; userSelected = true }
    mutating func receivePairedDevices(_ hasPairedDevices: Bool) {
        guard hasPairedDevices, !pairedDefaultApplied else { return }
        pairedDefaultApplied = true
        if !userSelected { panel = .statistics }
    }
}

struct DashboardMetrics: Decodable, Equatable {
    let receivedBytes: Double?
    let sentBytes: Double?
    let totalReceivedBytes: Double?
    let totalSentBytes: Double?
    let receiveBytesPerSecond: Double?
    let sendBytesPerSecond: Double?
    let httpRequests: Double?
    let rpcRequests: Double?
    let connectedDevices: Double?
    let uptimeMs: Double?

    private enum CodingKeys: String, CodingKey {
        case version, receivedBytes, sentBytes, totalReceivedBytes, totalSentBytes
        case receiveBytesPerSecond, sendBytesPerSecond, httpRequests, rpcRequests, connectedDevices, uptimeMs
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        if values.contains(.version), (try? values.decode(Int.self, forKey: .version)) != 1 {
            throw DecodingError.dataCorruptedError(forKey: .version, in: values, debugDescription: "Unsupported metrics version")
        }
        func measured(_ key: CodingKeys, integer: Bool = true) -> Double? {
            guard let number = try? values.decode(Double.self, forKey: key), number.isFinite, number >= 0,
                  !integer || number.rounded(.down) == number else { return nil }
            return number
        }
        receivedBytes = measured(.receivedBytes); sentBytes = measured(.sentBytes)
        totalReceivedBytes = measured(.totalReceivedBytes); totalSentBytes = measured(.totalSentBytes)
        receiveBytesPerSecond = measured(.receiveBytesPerSecond, integer: false)
        sendBytesPerSecond = measured(.sendBytesPerSecond, integer: false)
        httpRequests = measured(.httpRequests); rpcRequests = measured(.rpcRequests)
        connectedDevices = measured(.connectedDevices); uptimeMs = measured(.uptimeMs)
    }
    var hasMeasurements: Bool {
        [receivedBytes, sentBytes, totalReceivedBytes, totalSentBytes, receiveBytesPerSecond,
         sendBytesPerSecond, httpRequests, rpcRequests, connectedDevices, uptimeMs].contains { $0 != nil }
    }
}

enum DashboardFormat {
    static let unmeasured = "—"
    static func bytes(_ value: Double?, perSecond: Bool = false, locale: Locale = .current) -> String {
        guard let value, value.isFinite, value >= 0 else { return unmeasured }
        let units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"]
        var amount = value, unit = 0
        while amount >= 1024, unit < units.count - 1 { amount /= 1024; unit += 1 }
        let formatter = NumberFormatter(); formatter.locale = locale; formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = unit == 0 && !perSecond ? 0 : 1
        guard let number = formatter.string(from: NSNumber(value: amount)) else { return unmeasured }
        return "\(number) \(units[unit])" + (perSecond ? NSLocalizedString("/s", comment: "Bytes per second unit") : "")
    }
    static func count(_ value: Double?, locale: Locale = .current) -> String {
        guard let value, value.isFinite, value >= 0, value.rounded(.down) == value else { return unmeasured }
        let formatter = NumberFormatter(); formatter.locale = locale; formatter.numberStyle = .decimal; formatter.maximumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value)) ?? unmeasured
    }
    static func uptime(_ milliseconds: Double?) -> String {
        guard let milliseconds, milliseconds.isFinite, milliseconds >= 0 else { return unmeasured }
        let formatter = DateComponentsFormatter(); formatter.allowedUnits = [.hour, .minute, .second]
        formatter.unitsStyle = .abbreviated; formatter.zeroFormattingBehavior = .pad
        return formatter.string(from: milliseconds / 1000) ?? unmeasured
    }
}
// END CODELYNC DASHBOARD VALUES

// BEGIN CODELYNC CONNECTION VALUES
struct ConnectionConfiguration: Decodable, Equatable {
    let enabledChannels: [String]
    let relayConfigured: Bool
    let serverUrl: String
    let hasToken: Bool
    static let unknown = ConnectionConfiguration(enabledChannels: [], relayConfigured: false, serverUrl: "", hasToken: false)
    var availableKinds: [String] { ["local", "cloudflare"] + (relayConfigured ? ["relay"] : []) }
    var enabledKinds: Set<String> { Set(enabledChannels).intersection(Set(availableKinds)) }
}

struct ConnectionChannel: Identifiable, Decodable, Equatable {
    let id: String
    let kind: String
    let url: String
    let label: String?
    let state: String
    var displayLabel: String { label ?? (kind == "local" ? "Local network" : kind == "cloudflare" ? "Cloudflare" : "Relay") }
}

enum ConnectionStatus {
    static func label(kind: String, configuration: ConnectionConfiguration, channels: [ConnectionChannel], starting: Bool = false) -> String {
        guard configuration.enabledKinds.contains(kind) else { return "Off" }
        let states = channels.filter { $0.kind == kind }.map { $0.state }
        if states.contains("ready") { return "Ready" }
        if states.contains("starting") { return "Starting…" }
        if states.contains("reconnecting") { return "Reconnecting…" }
        if states.contains("unverified") { return "Not verified yet" }
        if states.isEmpty && starting { return "Starting…" }
        return "Unavailable"
    }
}
// END CODELYNC CONNECTION VALUES

// BEGIN CODELYNC SOURCE SUBSCRIPTION VALUES
struct DesktopSourceConfiguration: Decodable, Equatable {
    let version: Int
    let enabledApps: [String]
    let known: Bool
    let revision: Int
    static let apps = ["codex", "antigravity", "claude-desktop"]
    static let unknown = DesktopSourceConfiguration(version: 1, enabledApps: [], known: false, revision: 0)
    var valid: Bool { version == 1 && revision >= 0 && enabledApps.count <= Self.apps.count && Set(enabledApps).count == enabledApps.count && enabledApps.allSatisfy(Self.apps.contains) && (known || enabledApps.isEmpty) }
    var enabled: Set<String> { known ? Set(enabledApps) : [] }
    static func label(_ app: String) -> String { app == "codex" ? "Codex" : app == "antigravity" ? "Antigravity Desktop" : "Claude Desktop (Gateway)" }
}
// END CODELYNC SOURCE SUBSCRIPTION VALUES

// BEGIN CODELYNC SERVICE VALUES
enum ServicePhase: String { case starting, running, pausing, paused, failed
    var canStart: Bool { self == .paused || self == .failed }
    var canPause: Bool { self == .starting || self == .running }
    var running: Bool { self == .starting || self == .running }
    func terminated() -> ServicePhase { self == .pausing ? .paused : .failed }
}
// END CODELYNC SERVICE VALUES

// BEGIN CODELYNC NDJSON FRAMER
struct NDJSONLineSplitter {
    let maxLineBytes: Int
    private var buffer = Data()
    private var discardingOversizedLine = false

    init(maxLineBytes: Int = 65536) {
        self.maxLineBytes = maxLineBytes
    }

    mutating func reset() {
        buffer.removeAll(keepingCapacity: false)
        discardingOversizedLine = false
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
                let sliceLength = bytes.distance(from: cursor, to: end)
                if buffer.count + sliceLength > maxLineBytes {
                    buffer.removeAll(keepingCapacity: true)
                } else if buffer.isEmpty {
                    lines.append(Data(bytes[cursor..<end]))
                } else {
                    buffer.append(bytes[cursor..<end])
                    lines.append(buffer)
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
}
// END CODELYNC NDJSON FRAMER

@MainActor
final class DashboardMetricsStore: ObservableObject {
    @Published private(set) var value: DashboardMetrics?
    func receive(_ raw: Any) {
        guard let bytes = try? JSONSerialization.data(withJSONObject: raw), let next = try? JSONDecoder().decode(DashboardMetrics.self, from: bytes) else { value = nil; return }
        value = next
    }
    func reset() { value = nil }
}

struct DesktopConfiguration: Decodable {
    let enabled: Bool
    let mode: String
    let url: String
    let apiKey: String
    let hasSecret: Bool
    let connected: Bool
    static let disabled = DesktopConfiguration(enabled: false, mode: "local", url: "", apiKey: "", hasSecret: false, connected: false)
}

@MainActor
final class ServiceController: ObservableObject {
    private enum LaunchMode { case normal, settings }
    struct Device: Identifiable, Codable, Equatable { var id: String; var name: String; var createdAt: Double; var lastSeen: Double; var revoked: Bool; var connected: Bool; var notifications: Bool? }
    @Published var status = "Starting Codelync…"
    @Published var pairingURL = ""
    @Published var origin = ""
    @Published private(set) var phase: ServicePhase = .paused
    @Published private(set) var settingsReady = false
    @Published private(set) var quitting = false
    var running: Bool { phase.running }
    var settingsAvailable: Bool { process != nil && phase != .pausing && (launchMode == .normal ? running : settingsReady) && !quitting }
    var hasOwnedProcess: Bool { process != nil }
    @Published var devices: [Device] = []
    @Published var notificationsAvailable = false
    @Published var notificationsBusy = false
    @Published var notificationsError = ""
    @Published var notificationTestAccepted = false
    @Published var pushKeyID = ""
    @Published var pushTeamID = ""
    @Published var pushEnvironment = "development"
    @Published var pushKeyPath = ""
    private var notificationsRequestID = ""
    @Published var copied = false
    @Published var operationError = ""
    // BEGIN CODELYNC SOURCE SUBSCRIPTION STATE
    @Published private(set) var sourceConfiguration = DesktopSourceConfiguration.unknown
    @Published private(set) var sourcesBusy = false
    @Published private(set) var sourcesError = ""
    private var sourcesRequestID = ""
    private var sourcesDesired: [String]?
    private var sourceRevisionInProcess = -1
    // END CODELYNC SOURCE SUBSCRIPTION STATE
    @Published private(set) var connectionConfiguration = ConnectionConfiguration.unknown
    @Published private(set) var connectionChannels: [ConnectionChannel] = []
    @Published private(set) var connectionConfigurationKnown = false
    @Published private(set) var channelsBusy = false
    @Published private(set) var channelsError = ""
    @Published var relayServer = ""
    @Published var relayKey = ""
    @Published var accessBusy = false
    var accessHasSavedKey: Bool { connectionConfiguration.hasToken }
    @Published var accessError = ""
    @Published private(set) var desktopConfiguration = DesktopConfiguration.disabled
    @Published private(set) var desktopKnown = false
    @Published var desktopMode = "local"
    @Published var desktopServer = ""
    @Published var desktopAPIKey = ""
    @Published var desktopAPISecret = ""
    @Published var desktopBusy = false
    @Published var desktopError = ""
    private var desktopRequestID = ""
    private var desktopPendingCommand = ""
    private var desktopDraftInitialized = false
    private var accessRequestID = ""
    private var relayDraftInitialized = false
    private var channelsRequestID = ""
    @Published private(set) var selection = DashboardSelection()
    @Published private var cachedPairingImage: NSImage?
    let metrics = DashboardMetricsStore()
    private var imageURL = ""
    private lazy var imageContext = CIContext()
    private var process: Process?
    private var launchMode: LaunchMode = .normal
    private var nextLaunchMode: LaunchMode?
    private var quitCompletions: [() -> Void] = []
    private var input: Pipe?
    private var lineFramer = NDJSONLineSplitter()

    func start() {
        guard !quitting else { return }
        if process != nil {
            guard launchMode == .settings, phase == .paused else { return }
            nextLaunchMode = .normal
            terminateOwnedProcess()
            return
        }
        launch(.normal)
    }
    func retrySettings() {
        guard !quitting, process == nil else { return }
        launch(.settings)
    }
    private func launch(_ mode: LaunchMode) {
        guard process == nil else { return }
        guard let resources = Bundle.main.resourceURL else { return }
        let runtime = resources.appendingPathComponent("runtime")
        let isolatedQA = Bundle.main.bundleIdentifier?.hasSuffix(".qa") == true
        let defaultState = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(isolatedQA ? "Codelync QA" : "Codelync")
        let configuredState = ProcessInfo.processInfo.environment["CODELYNC_STATE_DIR"]
        let state = configuredState.map { URL(fileURLWithPath: $0, isDirectory: true) } ?? defaultState
        let task = Process(), output = Pipe(), errors = Pipe(), stdin = Pipe()
        task.executableURL = runtime.appendingPathComponent("node")
        task.arguments = [runtime.appendingPathComponent("src/codelync/mac-app-service.mjs").path, "--state=\(state.path)"]
        if mode == .settings { task.arguments?.append("--settings-only=1") }
        task.currentDirectoryURL = runtime
        task.standardOutput = output; task.standardError = errors; task.standardInput = stdin
        var environment = ProcessInfo.processInfo.environment
        if isolatedQA {
            environment["CODELYNC_STATE_DIR"] = state.path
            environment["CODELYNC_BACKEND_PORT"] = environment["CODELYNC_BACKEND_PORT"] ?? "57770"
            environment["CODELYNC_LEASE_DIR"] = environment["CODELYNC_LEASE_DIR"] ?? state.appendingPathComponent("leases").path
        }
        task.environment = environment.merging(["PATH": runtime.path + ":/usr/bin:/bin:/usr/sbin:/sbin"]) { _, new in new }
        output.fileHandleForReading.readabilityHandler = { [weak self, weak task] handle in
            let bytes = handle.availableData
            guard !bytes.isEmpty else { return }
            DispatchQueue.main.async {
                // 旧服务的迟到 stdout 不得覆盖新 Process 的通道状态或二维码。
                guard let self, let task, self.process === task else { return }
                self.receive(bytes)
            }
        }
        errors.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        task.terminationHandler = { [weak self] terminated in
            DispatchQueue.main.async {
                guard let self, self.process === terminated else { return }
                let next = self.nextLaunchMode; self.nextLaunchMode = nil
                self.phase = self.phase.terminated()
                self.process = nil; self.input = nil; self.pairingURL = ""; self.origin = ""
                self.settingsReady = false
                self.status = self.phase == .paused ? "Paused" : "Connection unavailable"
                self.metrics.reset()
                self.resetConnectionObservation(preserveConfiguration: true)
                if self.quitting {
                    let completions = self.quitCompletions; self.quitCompletions = []
                    completions.forEach { $0() }
                } else if let next { self.launch(next) }
            }
        }
        launchMode = mode; settingsReady = false; sourceRevisionInProcess = -1
        process = task; input = stdin; phase = mode == .normal ? .starting : .paused
        lineFramer.reset(); status = mode == .normal ? "Starting Codelync…" : "Paused"
        metrics.reset(); resetConnectionObservation(preserveConfiguration: true); resetTransientErrors()
        do { try task.run() } catch { process = nil; input = nil; phase = .failed; status = "Connection unavailable" }
    }
    private func receive(_ bytes: Data) {
        // 暂停等待完整子进程清理期间，迟到消息不能把用户主动暂停重新显示为连接就绪。
        guard phase != .pausing else { return }
        for line in lineFramer.append(bytes) {
            guard let item = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let type = item["type"] as? String else { continue }
            if type == "settings-ready", launchMode == .settings {
                settingsReady = true; phase = .paused; status = "Paused"
            } else if type == "ready", launchMode == .normal, let value = item["pairingUrl"] as? String {
                phase = .running
                pairingURL = value; origin = item["origin"] as? String ?? ""
                status = devices.contains { !$0.revoked && $0.connected } ? "Phone connected" : "Ready to connect"
            } else if type == "source-subscriptions", let raw = item["configuration"],
                      let bytes = try? JSONSerialization.data(withJSONObject: raw),
                      let configuration = try? JSONDecoder().decode(DesktopSourceConfiguration.self, from: bytes) {
                if configuration.valid && configuration.revision >= sourceRevisionInProcess {
                    sourceRevisionInProcess = configuration.revision
                    sourceConfiguration = configuration
                    if !configuration.known { sourcesError = "Could not load desktop source choices. Try again." }
                }
            } else if type == "source-subscriptions-result", let requestID = item["requestId"] as? String, requestID == sourcesRequestID {
                sourcesBusy = false
                if item["ok"] as? Bool == true { sourcesError = ""; sourcesDesired = nil }
                else if !sourceConfiguration.known { sourcesError = "Could not load desktop source choices. Try again." }
                else { sourcesError = item["code"] as? String == "source-subscriptions-save-failed" ? "Could not save desktop source choices. Try again." : "Source choices are saved. Switching is not complete; retry." }
            } else if type == "access-configuration", let raw = item["configuration"],
                      let bytes = try? JSONSerialization.data(withJSONObject: raw),
                      let configuration = try? JSONDecoder().decode(ConnectionConfiguration.self, from: bytes) {
                let previousServer = connectionConfiguration.serverUrl
                connectionConfiguration = configuration; connectionConfigurationKnown = true
                if !relayDraftInitialized {
                    relayDraftInitialized = true
                    if !accessBusy, relayServer.isEmpty { relayServer = configuration.serverUrl }
                } else if !accessBusy, relayServer == previousServer {
                    // 通道勾选回执不能覆盖用户正在编辑（包括主动清空）的另一个 Relay 地址草稿。
                    relayServer = configuration.serverUrl
                }
            } else if type == "access-channels", let raw = item["channels"],
                      let bytes = try? JSONSerialization.data(withJSONObject: raw),
                      let channels = try? JSONDecoder().decode([ConnectionChannel].self, from: bytes) {
                let safeChannels = channels.filter { ["local", "cloudflare", "relay"].contains($0.kind) }
                if connectionChannels != safeChannels { connectionChannels = safeChannels }
                if item["overallState"] as? String == "unavailable", pairingURL.isEmpty { status = "Connection unavailable" }
            } else if type == "access-result", let requestID = item["requestId"] as? String {
                if requestID == channelsRequestID {
                    channelsBusy = false
                    channelsError = item["ok"] as? Bool == true ? "" : "Could not update connection channels. Try again."
                } else if requestID == accessRequestID {
                    accessBusy = false
                    if item["ok"] as? Bool == true { relayKey = ""; accessError = ""; relayServer = connectionConfiguration.serverUrl }
                    else { accessError = "Could not validate the Relay connection. Check address, access key and network." }
                }
            } else if type == "desktop-status", let raw = item["status"],
                      let bytes = try? JSONSerialization.data(withJSONObject: raw),
                      let configuration = try? JSONDecoder().decode(DesktopConfiguration.self, from: bytes) {
                let previousDesktop = desktopConfiguration
                desktopConfiguration = configuration; desktopKnown = true
                if !desktopDraftInitialized {
                    desktopDraftInitialized = true
                    if !desktopBusy, desktopMode == "local", desktopServer.isEmpty, desktopAPIKey.isEmpty, desktopAPISecret.isEmpty {
                        desktopMode = configuration.mode; desktopServer = configuration.url; desktopAPIKey = configuration.apiKey
                    }
                } else if !desktopBusy, desktopMode == previousDesktop.mode, desktopServer == previousDesktop.url,
                          desktopAPIKey == previousDesktop.apiKey, desktopAPISecret.isEmpty {
                    desktopMode = configuration.mode; desktopServer = configuration.url; desktopAPIKey = configuration.apiKey
                }
                if item["error"] != nil { desktopError = "Could not load remote desktop settings." }
            } else if type == "desktop-result", item["requestId"] as? String == desktopRequestID {
                let pendingKind = desktopPendingCommand; desktopPendingCommand = ""
                desktopBusy = false
                if item["ok"] as? Bool == true {
                    desktopError = ""
                    if pendingKind == "relay" {
                        desktopAPISecret = ""
                        desktopMode = desktopConfiguration.mode; desktopServer = desktopConfiguration.url; desktopAPIKey = desktopConfiguration.apiKey
                    }
                } else { desktopError = "Could not update remote desktop. Check permissions and server settings." }
            } else if type == "metrics" {
                // 每秒小样本只通知指标视图，不能使设备输入框和隐藏二维码重新计算。
                if let raw = item["metrics"] { metrics.receive(raw) } else { metrics.reset() }
            } else if type == "devices", let data = item["devices"], let bytes = try? JSONSerialization.data(withJSONObject: data), let rows = try? JSONDecoder().decode([Device].self, from: bytes) {
                if rows != devices { devices = rows }
                var next = selection; next.receivePairedDevices(rows.contains { !$0.revoked })
                if next != selection { selection = next }
                if !origin.isEmpty { status = rows.contains(where: { !$0.revoked && $0.connected }) ? "Phone connected" : "Ready to connect" }
                operationError = ""
            } else if type == "diagnostic", item["code"] as? String == "device-operation-failed" {
                operationError = "Could not update device. Try again."
            } else if type == "notifications" {
                notificationsAvailable = item["available"] as? Bool ?? false
                if !notificationsBusy {
                    pushKeyID = item["keyId"] as? String ?? ""
                    pushTeamID = item["teamId"] as? String ?? ""
                    pushEnvironment = item["environment"] as? String ?? "development"
                }
                notificationTestAccepted = item["lastTestAccepted"] as? Bool ?? false
            } else if type == "notifications-result", item["requestId"] as? String == notificationsRequestID {
                notificationsBusy = false
                if item["ok"] as? Bool == true { notificationsError = ""; pushKeyPath = "" }
                else {
                    let code = item["code"] as? String ?? ""
                    notificationsError = code == "push-device-not-registered" ? "Open Codelync on this phone and allow notifications." : code == "push-environment-mismatch" ? "The phone and Mac use different push environments." : "Could not configure or send notifications. Check the Apple key and phone registration."
                }
            } else if type == "error" {
                pairingURL = ""; status = "Connection unavailable"; metrics.reset(); resetConnectionObservation()
            } else if type == "starting" { status = item["phase"] as? String == "public-connection" ? "Connecting from anywhere…" : "Starting Codelync…" }
        }
    }
    private func resetTransientErrors() {
        operationError = ""; sourcesError = ""; channelsError = ""; accessError = ""
        desktopError = ""; notificationsError = ""; notificationTestAccepted = false
    }
    private func resetConnectionObservation(preserveConfiguration: Bool = false) {
        connectionChannels = []; channelsBusy = false; accessBusy = false
        devices = devices.map { var device = $0; device.connected = false; return device }
        channelsRequestID = ""; accessRequestID = ""
        sourcesBusy = false; sourcesError = ""; sourcesRequestID = ""; sourcesDesired = nil
        desktopBusy = false; desktopRequestID = ""; desktopPendingCommand = ""
        if !preserveConfiguration { connectionConfigurationKnown = false; sourceConfiguration = .unknown; desktopKnown = false }
    }
    func selectPanel(_ panel: DashboardPanel) { selection.select(panel) }
    var publicStatus: String {
        if quitting { return "Quitting…" }
        if phase == .pausing { return "Pausing…" }
        if phase == .paused { return "Paused" }
        if phase == .failed { return "Connection unavailable" }
        if phase == .starting { return status }
        if connectionConfigurationKnown && connectionConfiguration.enabledKinds.isEmpty { return "All connections are off" }
        if devices.contains(where: { !$0.revoked && $0.connected }) { return "Phone connected" }
        if connectionChannels.contains(where: { $0.state == "ready" && connectionConfiguration.enabledKinds.contains($0.kind) }) { return "Ready to connect" }
        if !connectionChannels.contains(where: { $0.state == "ready" }) {
            if connectionChannels.contains(where: { $0.state == "reconnecting" }) { return "Reconnecting…" }
            if connectionChannels.contains(where: { $0.state == "unverified" }) { return "Waiting for connection verification…" }
            if !connectionChannels.isEmpty && connectionChannels.allSatisfy({ $0.state == "unavailable" }) { return "Connection unavailable" }
        }
        return status
    }
    func refresh() {
        guard running else { return }
        try? input?.fileHandleForWriting.write(contentsOf: Data("{\"type\":\"refresh-invite\"}\n".utf8))
    }
    func choosePushKey() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false; panel.allowedContentTypes = [UTType(filenameExtension: "p8") ?? .data]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        pushKeyPath = url.path
        let name = url.deletingPathExtension().lastPathComponent
        if name.hasPrefix("AuthKey_") { pushKeyID = String(name.dropFirst(8)) }
    }
    func configureNotifications() {
        let keyID = pushKeyID.trimmingCharacters(in: .whitespacesAndNewlines)
        let teamID = pushTeamID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !keyID.isEmpty, !teamID.isEmpty else { return }
        notificationCommand(["type": "configure-notifications", "configuration": ["keyId": keyID, "teamId": teamID, "environment": pushEnvironment, "keyPath": pushKeyPath]])
    }
    func testNotifications(_ id: String) { notificationCommand(["type": "test-notifications", "id": id]) }
    private func notificationCommand(_ command: [String: Any]) {
        guard !notificationsBusy, running, let input else { return }
        notificationsRequestID = UUID().uuidString
        var value = command; value["requestId"] = notificationsRequestID
        guard var bytes = try? JSONSerialization.data(withJSONObject: value) else { return }; bytes.append(10)
        notificationsBusy = true; notificationsError = ""; notificationTestAccepted = false
        do { try input.fileHandleForWriting.write(contentsOf: bytes) }
        catch { notificationsBusy = false; notificationsError = "Could not configure or send notifications. Check the Apple key and phone registration." }
    }
    func deviceAction(_ type: String, id: String, name: String? = nil) {
        guard running, let input else { return }
        var value = ["type": type, "id": id]
        if let name {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            value["name"] = trimmed
        }
        guard var bytes = try? JSONSerialization.data(withJSONObject: value) else { return }; bytes.append(10)
        try? input.fileHandleForWriting.write(contentsOf: bytes)
    }
    func stop() {
        guard phase.canPause, launchMode == .normal, !quitting else { return }
        nextLaunchMode = .settings
        terminateOwnedProcess()
    }
    private func terminateOwnedProcess() {
        guard let process else { return }
        // 复用服务的 graceful shutdown；Start 只有在 terminationHandler 确认所有 owned writer 退出后才开放。
        phase = .pausing; settingsReady = false; pairingURL = ""; status = quitting ? "Quitting…" : "Pausing…"
        resetTransientErrors()
        if process.isRunning { process.terminate() }
    }
    func prepareForQuit(_ completion: @escaping () -> Void) {
        quitting = true; nextLaunchMode = nil
        guard process != nil else { completion(); return }
        quitCompletions.append(completion)
        if phase != .pausing { terminateOwnedProcess() }
    }
    func setChannel(_ kind: String, enabled: Bool) {
        guard settingsAvailable, !channelsBusy, connectionConfigurationKnown, connectionConfiguration.availableKinds.contains(kind), let input else { return }
        var selected = connectionConfiguration.enabledKinds
        if enabled { selected.insert(kind) } else { selected.remove(kind) }
        channelsRequestID = UUID().uuidString
        let value: [String: Any] = ["type": "set-enabled-channels", "requestId": channelsRequestID, "channels": ["local", "cloudflare", "relay"].filter { selected.contains($0) }]
        guard var bytes = try? JSONSerialization.data(withJSONObject: value) else { return }; bytes.append(10)
        channelsBusy = true; channelsError = ""
        do { try input.fileHandleForWriting.write(contentsOf: bytes) }
        catch { channelsBusy = false; channelsError = "Could not update connection channels. Try again." }
    }
    // BEGIN CODELYNC SOURCE SUBSCRIPTION COMMANDS
    func setSource(_ app: String, enabled: Bool) {
        guard sourceConfiguration.known, DesktopSourceConfiguration.apps.contains(app) else { return }
        var selected = sourceConfiguration.enabled
        if enabled { selected.insert(app) } else { selected.remove(app) }
        setSources(DesktopSourceConfiguration.apps.filter { selected.contains($0) })
    }
    func restoreSourceDefaults() { setSources(DesktopSourceConfiguration.apps) }
    func retrySources() {
        if let desired = sourcesDesired { setSources(desired) }
        else { sendSourceCommand("reload-source-subscriptions", apps: nil) }
    }
    private func setSources(_ apps: [String]) {
        guard !sourcesBusy, settingsAvailable, apps.allSatisfy(DesktopSourceConfiguration.apps.contains) else { return }
        sourcesDesired = apps; sendSourceCommand("set-source-subscriptions", apps: apps)
    }
    private func sendSourceCommand(_ type: String, apps: [String]?) {
        guard !sourcesBusy, settingsAvailable, let input else { return }
        sourcesRequestID = UUID().uuidString
        var value: [String: Any] = ["type": type, "requestId": sourcesRequestID]
        if let apps { value["apps"] = apps }
        guard var data = try? JSONSerialization.data(withJSONObject: value) else { return }
        data.append(10); sourcesBusy = true; sourcesError = ""
        do { try input.fileHandleForWriting.write(contentsOf: data) }
        catch { sourcesBusy = false; sourcesError = "Could not save desktop source choices. Try again." }
    }
    // END CODELYNC SOURCE SUBSCRIPTION COMMANDS
    func configureRelay() {
        guard settingsAvailable, !accessBusy, let input else { return }
        accessRequestID = UUID().uuidString
        var value = ["type": "configure-relay", "requestId": accessRequestID, "serverUrl": relayServer]
        if !relayKey.isEmpty { value["token"] = relayKey }
        guard var bytes = try? JSONSerialization.data(withJSONObject: value) else { return }; bytes.append(10)
        accessBusy = true; accessError = ""
        do { try input.fileHandleForWriting.write(contentsOf: bytes) }
        catch { accessBusy = false; accessError = "Could not validate the Relay connection. Check address, access key and network." }
    }
    func configureDesktop(enabled: Bool? = nil) {
        var configuration: [String: Any]
        if let enabled { configuration = ["enabled": enabled] }
        else {
            let trimmedServer = desktopServer.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedKey = desktopAPIKey.trimmingCharacters(in: .whitespacesAndNewlines)
            if desktopMode == "external", (trimmedServer.isEmpty || trimmedKey.isEmpty) { return }
            configuration = ["enabled": desktopConfiguration.enabled, "mode": desktopMode,
                "url": trimmedServer, "apiKey": trimmedKey]
            if !desktopAPISecret.isEmpty { configuration["apiSecret"] = desktopAPISecret }
        }
        desktopCommand(["type": "configure-desktop", "configuration": configuration], kind: enabled == nil ? "relay" : "toggle")
    }
    func requestDesktopPermission(_ permission: String) {
        desktopCommand(["type": "desktop-permission", "permission": permission])
    }
    private func desktopCommand(_ command: [String: Any], kind: String = "") {
        guard !desktopBusy, desktopKnown, settingsAvailable, let input else { return }
        if command["type"] as? String == "desktop-permission", !running { return }
        desktopRequestID = UUID().uuidString
        desktopPendingCommand = kind
        var value = command; value["requestId"] = desktopRequestID
        guard var bytes = try? JSONSerialization.data(withJSONObject: value) else { desktopPendingCommand = ""; return }; bytes.append(10)
        desktopBusy = true; desktopError = ""
        do { try input.fileHandleForWriting.write(contentsOf: bytes) }
        catch { desktopBusy = false; desktopPendingCommand = ""; desktopError = "Could not update remote desktop. Check permissions and server settings." }
    }
    func copyLink() {
        NSPasteboard.general.clearContents(); copied = NSPasteboard.general.setString(pairingURL, forType: .string)
        Task { try? await Task.sleep(nanoseconds: 2_000_000_000); copied = false }
    }
    var image: NSImage? { imageURL == pairingURL ? cachedPairingImage : nil }
    func preparePairingImage() {
        guard imageURL != pairingURL else { return }
        imageURL = pairingURL; cachedPairingImage = nil
        guard !pairingURL.isEmpty else { return }
        let filter = CIFilter.qrCodeGenerator(); filter.message = Data(pairingURL.utf8); filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = imageContext.createCGImage(output, from: output.extent) else { return }
        cachedPairingImage = NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    }

    #if DEBUG
    static func preview(paired: Bool) -> ServiceController {
        let service = ServiceController()
        service.phase = .running; service.status = paired ? "Connection ready" : "Ready to scan"
        service.pairingURL = "codelync://preview/not-a-pairing-invitation"
        if paired {
            let now = Date().timeIntervalSince1970 * 1000
            service.devices = [Device(id: "preview-phone", name: "Preview phone", createdAt: now, lastSeen: now, revoked: false, connected: true)]
            service.selection.receivePairedDevices(true)
            service.metrics.receive(["version": 1, "receivedBytes": 1048576, "sentBytes": 65536,
                                     "totalReceivedBytes": 12582912, "totalSentBytes": 4194304,
                                     "receiveBytesPerSecond": 2048, "sendBytesPerSecond": 512,
                                     "httpRequests": 42, "rpcRequests": 7, "connectedDevices": 1, "uptimeMs": 90000])
        }
        return service
    }
    #endif
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let service = ServiceController()
    private var mainWindow: NSWindow?
    private var terminationRequested = false
    func applicationDidFinishLaunching(_ notification: Notification) {
        _ = NSApp.setActivationPolicy(.regular)
        service.start(); NSApp.activate(ignoringOtherApps: true)
    }
    func rememberMainWindow(_ window: NSWindow) { mainWindow = window; window.isReleasedWhenClosed = false }
    func showMainWindow() { mainWindow?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard mainWindow != nil else { return true }
        showMainWindow(); return false
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminationRequested else { return .terminateLater }
        terminationRequested = true
        guard service.hasOwnedProcess else { return .terminateNow }
        service.prepareForQuit { sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

private struct MainWindowCapture: NSViewRepresentable {
    let remember: (NSWindow) -> Void
    func makeNSView(context: Context) -> NSView { NSView() }
    func updateNSView(_ view: NSView, context: Context) {
        DispatchQueue.main.async { if let window = view.window { remember(window) } }
    }
}

private struct CodelyncWindowCommands: Commands {
    let delegate: AppDelegate
    var body: some Commands {
        CommandGroup(after: .windowArrangement) {
            Button("Show Codelync") { delegate.showMainWindow() }.keyboardShortcut("0", modifiers: .command)
        }
    }
}

struct ContentView: View {
    @ObservedObject var service: ServiceController
    @Environment(\.openSettings) private var openSettings
    var body: some View {
        ScrollView { VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 12) {
                Image("brand-icon").resizable().frame(width: 36, height: 36).clipShape(RoundedRectangle(cornerRadius: 8))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Codelync").font(.system(size: 25, weight: .semibold))
                    Text("Codex, Antigravity and Claude Desktop on your phone").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text(LocalizedStringKey(service.publicStatus)).font(.caption).foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing).fixedSize(horizontal: false, vertical: true).frame(maxWidth: 160)
                    .accessibilityIdentifier("codelync-public-status")
                    .accessibilityLabel("\(NSLocalizedString("Connection status", comment: "Service status accessibility prefix")): \(NSLocalizedString(service.publicStatus, comment: "Service status value"))")
            }
            HStack(spacing: 12) {
                Button("Start", systemImage: "play.fill") { service.start() }
                    .disabled(!service.phase.canStart || service.quitting).accessibilityIdentifier("codelync-service-start")
                Button("Pause", systemImage: "pause.fill") { service.stop() }
                    .disabled(!service.phase.canPause).accessibilityIdentifier("codelync-service-pause")
                if service.phase == .pausing { ProgressView().controlSize(.small) }
                Spacer()
                Button("Settings", systemImage: "gearshape") { openSettings() }
                    .accessibilityIdentifier("codelync-open-settings")
                Button("Quit", systemImage: "power") { NSApp.terminate(nil) }
                    .disabled(service.quitting).accessibilityIdentifier("codelync-app-quit")
            }
            Label("Native sessions from Codex, Antigravity Desktop and Claude Desktop (Gateway). Available actions follow the desktop's current state.", systemImage: "info.circle")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Picker("View", selection: Binding(get: { service.selection.panel }, set: { service.selectPanel($0) })) {
                Text("Statistics").tag(DashboardPanel.statistics)
                Text("Pairing").tag(DashboardPanel.pairing)
            }.pickerStyle(.segmented).labelsHidden()
            if service.selection.panel == .statistics {
                StatisticsView(metrics: service.metrics, running: service.running)
            } else {
                PairingView(service: service)
            }
            Divider()
            DevicesView(service: service)
        }.padding(24).frame(maxWidth: 700) }.frame(minWidth: 520, minHeight: 480)
    }
}

private struct CodelyncSettingsView: View {
    @ObservedObject var service: ServiceController
    var body: some View {
        VStack(spacing: 0) {
            if !service.settingsAvailable && service.phase != .pausing && service.phase != .starting {
                HStack {
                    Text("Settings unavailable").foregroundStyle(.secondary)
                    Button("Retry") { service.retrySettings() }.accessibilityIdentifier("codelync-settings-retry")
                }.padding(.top, 12)
            }
            TabView {
                ScrollView { PublicAccessView(service: service, showHeading: false).padding(20) }
                    .tabItem { Label("Connections", systemImage: "network") }
                ScrollView { DesktopSourcesView(service: service, showHeading: false).padding(20) }
                    .tabItem { Label("Sources", systemImage: "desktopcomputer") }
                ScrollView { RemoteDesktopSettingsView(service: service).padding(20) }
                    .tabItem { Label("Remote desktop", systemImage: "rectangle.on.rectangle") }
            }.padding(12)
            if service.phase == .paused && service.settingsAvailable {
                Text("Changes apply when you Start.").font(.caption).foregroundStyle(.secondary).padding(.bottom, 12)
            }
        }.frame(minWidth: 520, minHeight: 400)
    }
}

// BEGIN CODELYNC SOURCE SUBSCRIPTION VIEW
struct DesktopSourcesView: View {
    @ObservedObject var service: ServiceController
    var showHeading = true
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if showHeading { Text("Sources").font(.headline) }
            ForEach(DesktopSourceConfiguration.apps, id: \.self) { app in
                Toggle(isOn: Binding(get: { service.sourceConfiguration.enabled.contains(app) }, set: { service.setSource(app, enabled: $0) })) {
                    Text(LocalizedStringKey(DesktopSourceConfiguration.label(app)))
                }.toggleStyle(.checkbox).accessibilityIdentifier("codelync-source-\(app)")
                    .disabled(service.sourcesBusy || !service.settingsAvailable || !service.sourceConfiguration.known)
            }
            if !service.sourcesError.isEmpty {
                Text(LocalizedStringKey(service.sourcesError)).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 12) {
                    Button("Retry") { service.retrySources() }.accessibilityIdentifier("codelync-source-retry")
                    if !service.sourceConfiguration.known {
                        Button("Restore defaults") { service.restoreSourceDefaults() }.accessibilityIdentifier("codelync-source-restore-defaults")
                    }
                }.disabled(service.sourcesBusy || !service.settingsAvailable)
            }
        }
    }
}
// END CODELYNC SOURCE SUBSCRIPTION VIEW

struct RelayDeploymentGuideLink: View {
    @Environment(\.locale) private var locale
    private var destination: URL {
        let language = locale.language.languageCode?.identifier ?? "en"
        let document = language.hasPrefix("zh") ? "SELF-HOSTING.zh-CN.md" : "SELF-HOSTING.md"
        return URL(string: "https://github.com/mapix/Codelync/blob/main/docs/\(document)")!
    }
    var body: some View {
        Link("Deployment guide", destination: destination).font(.caption)
    }
}

struct PublicAccessView: View {
    @ObservedObject var service: ServiceController
    var showHeading = true
    @State private var relayExpanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if showHeading { Text("Connections").font(.headline) }
            ForEach(service.connectionConfiguration.availableKinds, id: \.self) { kind in
                HStack(alignment: .top, spacing: 14) {
                    Toggle(isOn: Binding(get: { service.connectionConfiguration.enabledKinds.contains(kind) }, set: { service.setChannel(kind, enabled: $0) })) {
                        Text(LocalizedStringKey(kind == "local" ? "Local network" : kind == "cloudflare" ? "Cloudflare" : "Relay"))
                    }.toggleStyle(.checkbox).accessibilityIdentifier("codelync-channel-\(kind)")
                        .disabled(service.channelsBusy || !service.settingsAvailable || !service.connectionConfigurationKnown)
                    Spacer()
                    Text(LocalizedStringKey(service.phase == .paused || service.phase == .pausing ? service.publicStatus : service.connectionConfigurationKnown ? ConnectionStatus.label(kind: kind, configuration: service.connectionConfiguration, channels: service.connectionChannels, starting: service.phase == .starting) : "Starting…"))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Text("The phone chooses an available connection. You can switch connections there anytime.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if service.connectionChannels.contains(where: { $0.state == "unverified" }) {
                Text("An address is waiting for verification. The phone can check it when connecting.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if !service.channelsError.isEmpty { Text(LocalizedStringKey(service.channelsError)).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            DisclosureGroup("Configure Relay", isExpanded: $relayExpanded) {
                VStack(alignment: .leading, spacing: 12) {
                    RelayDeploymentGuideLink().accessibilityIdentifier("codelync-network-relay-guide")
                    TextField("Relay server address", text: $service.relayServer, prompt: Text("https://relay.example.com"))
                        .textFieldStyle(.roundedBorder).disabled(service.accessBusy || !service.settingsAvailable)
                    SecureField("Access key", text: $service.relayKey).textFieldStyle(.roundedBorder).disabled(service.accessBusy || !service.settingsAvailable)
                    if service.accessHasSavedKey, service.relayServer == service.connectionConfiguration.serverUrl { Text("Saved key will be reused for this server.").font(.caption).foregroundStyle(.secondary) }
                    HStack {
                        Button("Validate & save Relay") { service.configureRelay() }.disabled(service.accessBusy || !service.settingsAvailable || service.relayServer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("codelync-configure-relay")
                        if service.accessBusy { ProgressView().controlSize(.small); Text("Validating Relay…").font(.caption) }
                    }
                    if !service.accessError.isEmpty { Text(LocalizedStringKey(service.accessError)).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
                }.padding(.top, 12)
            }
        }
    }
}

struct RemoteDesktopSettingsView: View {
    @ObservedObject var service: ServiceController
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Toggle("Remote desktop", isOn: Binding(get: { service.desktopConfiguration.enabled }, set: { service.configureDesktop(enabled: $0) }))
                .toggleStyle(.checkbox).accessibilityIdentifier("codelync-desktop-enabled")
                .disabled(!service.desktopKnown || !service.settingsAvailable || service.desktopBusy)
            Picker("Media relay", selection: $service.desktopMode) {
                Text("This Mac").tag("local")
                Text("Custom server").tag("external")
            }.pickerStyle(.segmented).disabled(!service.desktopKnown || !service.settingsAvailable || service.desktopBusy)
                .accessibilityIdentifier("codelync-desktop-relay-mode")
            if service.desktopMode == "external" {
                RelayDeploymentGuideLink().accessibilityIdentifier("codelync-media-relay-guide")
                TextField("LiveKit server URL", text: $service.desktopServer, prompt: Text("wss://media.example.com"))
                    .textFieldStyle(.roundedBorder).disabled(service.desktopBusy || !service.settingsAvailable)
                    .accessibilityIdentifier("codelync-desktop-server")
                TextField("API key", text: $service.desktopAPIKey).textFieldStyle(.roundedBorder)
                    .disabled(service.desktopBusy || !service.settingsAvailable)
                SecureField("API secret", text: $service.desktopAPISecret).textFieldStyle(.roundedBorder)
                    .disabled(service.desktopBusy || !service.settingsAvailable)
            }
            HStack {
                Button("Save media relay") { service.configureDesktop() }
                    .disabled(service.desktopBusy || !service.desktopKnown || !service.settingsAvailable || (service.desktopMode == "external" && (service.desktopServer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || service.desktopAPIKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)))
                    .accessibilityIdentifier("codelync-desktop-relay-save")
                if service.desktopBusy { ProgressView().controlSize(.small) }
            }
            if service.desktopConfiguration.enabled {
                HStack {
                    Button("Allow Screen Recording") { service.requestDesktopPermission("screenRecording") }
                        .accessibilityIdentifier("codelync-desktop-screen-permission")
                    Button("Allow Accessibility") { service.requestDesktopPermission("accessibility") }
                        .accessibilityIdentifier("codelync-desktop-input-permission")
                }.disabled(service.desktopBusy || !service.running)
            }
            if !service.desktopError.isEmpty { Text(LocalizedStringKey(service.desktopError)).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
        }
    }
}

struct StatisticsView: View {
    @ObservedObject var metrics: DashboardMetricsStore
    let running: Bool
    var body: some View {
        let value = metrics.value
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 14) {
                Text("Gateway traffic").font(.headline)
                HStack(spacing: 20) {
                    RateValue(label: "Receiving", symbol: "arrow.down", value: running ? value?.receiveBytesPerSecond : nil)
                    Divider()
                    RateValue(label: "Sending", symbol: "arrow.up", value: running ? value?.sendBytesPerSecond : nil)
                }.frame(height: 66)
            }.padding(18).background(Color(nsColor: .controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 12))
            HStack(alignment: .top, spacing: 14) {
                ByteTotals(title: "This connection", received: value?.receivedBytes, sent: value?.sentBytes)
                ByteTotals(title: "All time", received: value?.totalReceivedBytes, sent: value?.totalSentBytes)
            }
            Grid(horizontalSpacing: 18, verticalSpacing: 12) {
                GridRow {
                    SmallMetric(label: "HTTP requests", value: DashboardFormat.count(value?.httpRequests))
                    SmallMetric(label: "RPC calls", value: DashboardFormat.count(value?.rpcRequests))
                    SmallMetric(label: "Connected devices", value: DashboardFormat.count(value?.connectedDevices))
                    SmallMetric(label: "Uptime", value: DashboardFormat.uptime(value?.uptimeMs))
                }
            }.frame(maxWidth: .infinity)
            Text(LocalizedStringKey(value?.hasMeasurements == true ? "Gateway traffic measured by Codelync. — means not measured." : "Waiting for gateway measurements…"))
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct RateValue: View {
    let label: String
    let symbol: String
    let value: Double?
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(LocalizedStringKey(label), systemImage: symbol).font(.caption).foregroundStyle(.secondary)
            Text(DashboardFormat.bytes(value, perSecond: true)).font(.system(size: 27, weight: .medium, design: .monospaced))
                .monospacedDigit().lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct ByteTotals: View {
    let title: String
    let received: Double?
    let sent: Double?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(LocalizedStringKey(title)).font(.subheadline).fontWeight(.semibold)
            LabeledContent("Received", value: DashboardFormat.bytes(received))
            LabeledContent("Sent", value: DashboardFormat.bytes(sent))
        }.font(.callout).monospacedDigit().padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

struct SmallMetric: View {
    let label: String
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(LocalizedStringKey(label)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            Text(value).font(.system(size: 17, weight: .medium, design: .monospaced)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.75)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct PairingView: View {
    @ObservedObject var service: ServiceController
    var body: some View {
        VStack(spacing: 16) {
            if let image = service.image {
                Image(nsImage: image).interpolation(.none).resizable().aspectRatio(contentMode: .fit)
                    .padding(20).background(.white).clipShape(RoundedRectangle(cornerRadius: 16)).frame(width: 300, height: 300)
                    .accessibilityIdentifier("codelync-pairing-qr")
                    .accessibilityLabel(Text("Pairing QR code"))
            } else {
                ProgressView().frame(width: 300, height: 300)
                    .accessibilityLabel(Text(LocalizedStringKey(service.publicStatus)))
            }
            Text("Open Codelync on your phone and scan this code. No registration or VPN needed.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary).frame(maxWidth: 400)
            HStack {
                Button(LocalizedStringKey(service.copied ? "Copied" : "Copy pairing link")) { service.copyLink() }.disabled(service.pairingURL.isEmpty)
                Button("Refresh QR") { service.refresh() }.disabled(service.pairingURL.isEmpty)
            }
            Text("The phone keeps all enabled addresses. If addresses change and reconnection fails, scan the current QR code.")
                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 430)
        }.frame(maxWidth: .infinity)
            .onAppear { service.preparePairingImage() }
            .onChange(of: service.pairingURL) { _, _ in service.preparePairingImage() }
    }
}

struct DevicesView: View {
    @ObservedObject var service: ServiceController
    @State private var notificationsSetup = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Paired devices").font(.headline)
                Spacer()
                Text(LocalizedStringKey(service.notificationsAvailable ? "Notifications configured" : "Notifications need setup"))
                    .font(.caption).foregroundStyle(.secondary)
                Button("Configure notifications…") { notificationsSetup = true }.disabled(!service.running)
            }
            if !service.notificationsError.isEmpty { Text(LocalizedStringKey(service.notificationsError)).font(.caption).foregroundStyle(.red) }
            if service.notificationTestAccepted { Text("Apple accepted the test. Check your phone.").font(.caption).foregroundStyle(.secondary) }
            if !service.operationError.isEmpty { Text(LocalizedStringKey(service.operationError)).font(.caption).foregroundStyle(.red) }
            if service.devices.isEmpty { Text("No devices yet").foregroundStyle(.secondary).font(.caption) }
            ScrollView { VStack(spacing: 10) {
                ForEach(service.devices) { device in DeviceRow(device: device, service: service) }
            } }.frame(maxHeight: 180)
        }.sheet(isPresented: $notificationsSetup) {
            VStack(alignment: .leading, spacing: 16) {
                Text("Notifications").font(.headline)
                Form {
                    TextField("Apple team ID", text: $service.pushTeamID)
                    TextField("Key ID", text: $service.pushKeyID)
                    Picker("Environment", selection: $service.pushEnvironment) { Text("Development").tag("development"); Text("Production").tag("production") }
                    Button(LocalizedStringKey(service.pushKeyPath.isEmpty ? "Choose Apple push key…" : "Push key selected")) { service.choosePushKey() }
                }
                if !service.notificationsError.isEmpty { Text(LocalizedStringKey(service.notificationsError)).font(.caption).foregroundStyle(.red) }
                HStack {
                    Button("Cancel") { notificationsSetup = false }.keyboardShortcut(.cancelAction)
                    Spacer()
                    Button("Save notifications") { service.configureNotifications() }.keyboardShortcut(.defaultAction)
                        .disabled(service.notificationsBusy || service.pushKeyID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || service.pushTeamID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }.padding(24).frame(width: 420)
                .onChange(of: service.notificationsBusy) { old, busy in if old && !busy && service.notificationsError.isEmpty { notificationsSetup = false } }
        }
    }
}

struct DeviceRow: View {
    let device: ServiceController.Device
    @ObservedObject var service: ServiceController
    @State private var name = ""
    @FocusState private var editing: Bool
    var body: some View {
        HStack {
            Image(systemName: "iphone").foregroundStyle(device.revoked ? Color.secondary : Color.blue)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                TextField(device.name, text: $name)
                    .accessibilityLabel(Text("Device name"))
                    .onSubmit {
                        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty, !device.revoked, service.running {
                            service.deviceAction("rename-device", id: device.id, name: trimmed)
                        } else {
                            name = device.name
                        }
                    }
                    .disabled(device.revoked || !service.running)
                    .focused($editing)
                HStack { Text(LocalizedStringKey(device.revoked ? "Access removed" : device.connected ? "Connected" : "Offline")); Text(Date(timeIntervalSince1970: device.lastSeen / 1000), style: .relative) }.font(.caption).foregroundStyle(.secondary)
                    .accessibilityElement(children: .combine)
                    .accessibilityHint(Text(device.name))
                    .accessibilityIdentifier("codelync-device-status-\(device.id)")
            }
            if !device.revoked {
                Button("Test notification") { service.testNotifications(device.id) }.disabled(service.notificationsBusy || !service.notificationsAvailable || device.notifications != true || !service.running)
                Button("Disconnect") { service.deviceAction("revoke-device", id: device.id) }.disabled(!service.running)
            }
        }.onAppear { name = device.name }.onChange(of: device.name) { _, value in if !editing { name = value } }
    }
}

@main
struct CodelyncApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene {
        Window("Codelync", id: "codelync-main") {
            ContentView(service: delegate.service).background(MainWindowCapture(remember: delegate.rememberMainWindow))
        }.defaultSize(width: 620, height: 640)
            .commands { CodelyncWindowCommands(delegate: delegate) }
        Settings { CodelyncSettingsView(service: delegate.service) }
    }
}

#if DEBUG
@MainActor
struct CodelyncDashboardPreviews: PreviewProvider {
    static var previews: some View {
        Group {
            ContentView(service: ServiceController.preview(paired: true)).previewDisplayName("Paired statistics")
            ContentView(service: ServiceController.preview(paired: false)).previewDisplayName("First pairing")
        }
    }
}
#endif
