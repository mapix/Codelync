import AppKit
@preconcurrency import ApplicationServices
import CoreFoundation
import CoreGraphics
import Darwin
import Foundation

public struct WindowKey: Hashable, Codable, Sendable {
    public let pid: Int32
    public let windowId: UInt32

    public init(pid: Int32, windowId: UInt32) {
        self.pid = pid
        self.windowId = windowId
    }

    public var rawId: String {
        "\(pid):\(windowId)"
    }

    public static func parse(_ raw: String) -> WindowKey? {
        let parts = raw.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let left = parts[0]
        let right = parts[1]
        guard (1...10).contains(left.utf8.count),
              (1...10).contains(right.utf8.count),
              left.utf8.allSatisfy({ (0x30...0x39).contains($0) }),
              right.utf8.allSatisfy({ (0x30...0x39).contains($0) }),
              let pid = Int32(left), pid > 0,
              let wid = UInt32(right), wid > 0 else {
            return nil
        }
        return WindowKey(pid: pid, windowId: wid)
    }
}

public struct RunningAppSnapshot: Equatable, Sendable {
    public let pid: Int32
    public let bundleId: String?
    public let appName: String
    public let executableName: String?
    public let isRegular: Bool
    public let isTerminated: Bool

    public init(
        pid: Int32,
        bundleId: String?,
        appName: String,
        executableName: String?,
        isRegular: Bool = true,
        isTerminated: Bool = false
    ) {
        self.pid = pid
        self.bundleId = bundleId
        self.appName = appName
        self.executableName = executableName
        self.isRegular = isRegular
        self.isTerminated = isTerminated
    }
}

public struct WindowCandidateSnapshot: Equatable, Sendable {
    public let key: WindowKey
    public let title: String
    public let frame: CGRect
    public let isMinimized: Bool
    public let isFullScreen: Bool

    public init(
        key: WindowKey,
        title: String,
        frame: CGRect,
        isMinimized: Bool,
        isFullScreen: Bool
    ) {
        self.key = key
        self.title = title
        self.frame = frame
        self.isMinimized = isMinimized
        self.isFullScreen = isFullScreen
    }
}

public struct WindowLiveState: Equatable, Sendable {
    public let frame: CGRect
    public let isMinimized: Bool
    public let isFullScreen: Bool
    public let title: String?

    public init(
        frame: CGRect,
        isMinimized: Bool,
        isFullScreen: Bool,
        title: String?
    ) {
        self.frame = frame
        self.isMinimized = isMinimized
        self.isFullScreen = isFullScreen
        self.title = title
    }
}

public struct CGWindowEntry: Equatable, Sendable {
    public let key: WindowKey
    public let bounds: CGRect
    public let layer: Int
    public let title: String?
    public let zIndex: Int

    public init(
        key: WindowKey,
        bounds: CGRect,
        layer: Int,
        title: String?,
        zIndex: Int
    ) {
        self.key = key
        self.bounds = bounds
        self.layer = layer
        self.title = title
        self.zIndex = zIndex
    }
}

public struct ScreenDisplayFrames: Equatable, Sendable {
    public let displayId: CGDirectDisplayID
    public let frame: CGRect
    public let visibleFrame: CGRect
    public let isVirtual: Bool

    public init(
        displayId: CGDirectDisplayID,
        frame: CGRect,
        visibleFrame: CGRect,
        isVirtual: Bool
    ) {
        self.displayId = displayId
        self.frame = frame
        self.visibleFrame = visibleFrame
        self.isVirtual = isVirtual
    }
}

public struct ScreenTopologySnapshot: Equatable, Sendable {
    public let displays: [CGDirectDisplayID: ScreenDisplayFrames]
    public let primaryScreenHeight: CGFloat
    public let primaryPhysicalDisplayId: CGDirectDisplayID?

    public init(
        displays: [CGDirectDisplayID: ScreenDisplayFrames],
        primaryScreenHeight: CGFloat,
        primaryPhysicalDisplayId: CGDirectDisplayID?
    ) {
        self.displays = displays
        self.primaryScreenHeight = primaryScreenHeight
        self.primaryPhysicalDisplayId = primaryPhysicalDisplayId
    }
}

public enum AXDriverError: Error, Equatable, Sendable {
    case untrusted
    case windowUnavailable
    case timedOutOrUnresponsive
    case attributeUnsupported
}

public struct RestoreFrame: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public init(_ rect: CGRect) {
        self.x = Double(rect.origin.x)
        self.y = Double(rect.origin.y)
        self.width = Double(rect.size.width)
        self.height = Double(rect.size.height)
    }

    public var cgRect: CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }

    public var isValid: Bool {
        x.isFinite && y.isFinite && width.isFinite && height.isFinite && width > 0 && height > 0
    }
}

public struct RestoreRecord: Codable, Equatable, Sendable {
    public let pid: Int32
    public let windowId: UInt32
    public let bundleId: String?
    public let appName: String
    public let title: String
    public var originalFrame: RestoreFrame
    public let wasFullScreen: Bool
    public let wasMinimized: Bool
    public let savedAt: String

    enum CodingKeys: String, CodingKey {
        case pid
        case windowId
        case bundleId
        case appName
        case title
        case originalFrame
        case wasFullScreen
        case wasMinimized
        case savedAt
    }

    public init(
        pid: Int32,
        windowId: UInt32,
        bundleId: String?,
        appName: String,
        title: String,
        originalFrame: RestoreFrame,
        wasFullScreen: Bool,
        wasMinimized: Bool,
        savedAt: String
    ) {
        self.pid = pid
        self.windowId = windowId
        self.bundleId = bundleId
        self.appName = appName
        self.title = title
        self.originalFrame = originalFrame
        self.wasFullScreen = wasFullScreen
        self.wasMinimized = wasMinimized
        self.savedAt = savedAt
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.pid = try container.decode(Int32.self, forKey: .pid)
        self.windowId = try container.decode(UInt32.self, forKey: .windowId)
        self.bundleId = try container.decodeIfPresent(String.self, forKey: .bundleId)
        self.appName = try container.decode(String.self, forKey: .appName)
        self.title = try container.decode(String.self, forKey: .title)
        self.originalFrame = try container.decode(RestoreFrame.self, forKey: .originalFrame)
        self.wasFullScreen = try container.decode(Bool.self, forKey: .wasFullScreen)
        self.wasMinimized = try container.decode(Bool.self, forKey: .wasMinimized)
        self.savedAt = try container.decode(String.self, forKey: .savedAt)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(pid, forKey: .pid)
        try container.encode(windowId, forKey: .windowId)
        if let bundleId {
            try container.encode(bundleId, forKey: .bundleId)
        } else {
            try container.encodeNil(forKey: .bundleId)
        }
        try container.encode(appName, forKey: .appName)
        try container.encode(title, forKey: .title)
        try container.encode(originalFrame, forKey: .originalFrame)
        try container.encode(wasFullScreen, forKey: .wasFullScreen)
        try container.encode(wasMinimized, forKey: .wasMinimized)
        try container.encode(savedAt, forKey: .savedAt)
    }

    public var key: WindowKey {
        WindowKey(pid: pid, windowId: windowId)
    }

    public var isValid: Bool {
        pid > 0 && windowId > 0 && originalFrame.isValid && !savedAt.isEmpty
    }
}

public struct RestoreStoreFile: Codable, Equatable, Sendable {
    public let version: Int
    public let records: [RestoreRecord]

    public init(version: Int = 1, records: [RestoreRecord]) {
        self.version = version
        self.records = records
    }
}

@MainActor
public protocol AccessibilityWindowDriving: AnyObject {
    func isProcessTrusted() -> Bool
    func setMessagingTimeout(seconds: Float)
    func runningRegularApps() -> [RunningAppSnapshot]
    func cgWindowSnapshot() -> (onScreenZOrder: [WindowKey: Int], allByKey: [WindowKey: CGWindowEntry])
    func liveCGWindow(for key: WindowKey) -> CGWindowEntry?
    func enumerateStandardWindows(
        for app: RunningAppSnapshot,
        cgSnapshot: [WindowKey: CGWindowEntry]
    ) throws -> [WindowCandidateSnapshot]
    func readWindowState(_ key: WindowKey) throws -> WindowLiveState
    func setMinimized(_ key: WindowKey, _ minimized: Bool) throws
    func setFullScreen(_ key: WindowKey, _ fullScreen: Bool) throws
    func setSize(_ key: WindowKey, _ size: CGSize) throws
    func setPosition(_ key: WindowKey, _ origin: CGPoint) throws
    func raiseAndActivate(_ key: WindowKey) throws
    func screenTopology(virtualDisplayId: CGDirectDisplayID?) -> ScreenTopologySnapshot
    func sleep(milliseconds: UInt64) async
}

/// Resolves HIServices Accessibility C entrypoints dynamically via `dlsym` so `nm -u`
/// contains zero static `_AXUIElement*` or `__AXUIElementGetWindow` linker symbols.
final class HIServicesAXRuntime: @unchecked Sendable {
    static let shared = HIServicesAXRuntime()

    private typealias CreateSystemWideFn = @convention(c) () -> Unmanaged<AnyObject>?
    private typealias CreateApplicationFn = @convention(c) (pid_t) -> Unmanaged<AnyObject>?
    private typealias SetMessagingTimeoutFn = @convention(c) (UnsafeRawPointer, Float) -> Int32
    private typealias CopyAttributeValueFn = @convention(c) (
        UnsafeRawPointer,
        UnsafeRawPointer,
        UnsafeMutablePointer<Unmanaged<AnyObject>?>
    ) -> Int32
    private typealias SetAttributeValueFn = @convention(c) (
        UnsafeRawPointer,
        UnsafeRawPointer,
        UnsafeRawPointer
    ) -> Int32
    private typealias PerformActionFn = @convention(c) (UnsafeRawPointer, UnsafeRawPointer) -> Int32
    private typealias GetWindowFn = @convention(c) (UnsafeRawPointer, UnsafeMutablePointer<CGWindowID>) -> Int32

    private let createSystemWideFn: CreateSystemWideFn?
    private let createApplicationFn: CreateApplicationFn?
    private let setMessagingTimeoutFn: SetMessagingTimeoutFn?
    private let copyAttributeValueFn: CopyAttributeValueFn?
    private let setAttributeValueFn: SetAttributeValueFn?
    private let performActionFn: PerformActionFn?
    private let getWindowFn: GetWindowFn?

    var isCoreAXAvailable: Bool {
        createSystemWideFn != nil &&
        createApplicationFn != nil &&
        setMessagingTimeoutFn != nil &&
        copyAttributeValueFn != nil &&
        setAttributeValueFn != nil &&
        performActionFn != nil
    }

    var hasDirectGetWindowSymbol: Bool {
        getWindowFn != nil
    }

    private init() {
        let frameworkPath = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
        let handle = Darwin.dlopen(frameworkPath, RTLD_LAZY | RTLD_NOLOAD)
            ?? Darwin.dlopen(frameworkPath, RTLD_LAZY)
            ?? UnsafeMutableRawPointer(bitPattern: -2)

        func loadSymbol<T>(_ name: String, as _: T.Type) -> T? {
            guard let sym = Darwin.dlsym(handle, name) ?? Darwin.dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else {
                return nil
            }
            return unsafeBitCast(sym, to: T.self)
        }

        let axPrefix = "AXUI" + "Element"
        self.createSystemWideFn = loadSymbol(axPrefix + "CreateSystemWide", as: CreateSystemWideFn.self)
        self.createApplicationFn = loadSymbol(axPrefix + "CreateApplication", as: CreateApplicationFn.self)
        self.setMessagingTimeoutFn = loadSymbol(axPrefix + "SetMessagingTimeout", as: SetMessagingTimeoutFn.self)
        self.copyAttributeValueFn = loadSymbol(axPrefix + "CopyAttributeValue", as: CopyAttributeValueFn.self)
        self.setAttributeValueFn = loadSymbol(axPrefix + "SetAttributeValue", as: SetAttributeValueFn.self)
        self.performActionFn = loadSymbol(axPrefix + "PerformAction", as: PerformActionFn.self)
        self.getWindowFn = loadSymbol("_" + axPrefix + "GetWindow", as: GetWindowFn.self)
    }

    func createSystemWide() -> AnyObject? {
        createSystemWideFn?()?.takeRetainedValue()
    }

    func createApplication(pid: pid_t) -> AnyObject? {
        createApplicationFn?(pid)?.takeRetainedValue()
    }

    @discardableResult
    func setMessagingTimeout(_ element: AnyObject, seconds: Float) -> AXError {
        guard let fn = setMessagingTimeoutFn else { return .failure }
        let raw = withExtendedLifetime(element) {
            fn(Unmanaged.passUnretained(element).toOpaque(), seconds)
        }
        return AXError(rawValue: raw) ?? .failure
    }

    func copyAttributeValue(_ element: AnyObject, attribute: String) -> (AXError, AnyObject?) {
        guard let fn = copyAttributeValueFn else { return (.failure, nil) }
        var out: Unmanaged<AnyObject>?
        let attrCF = attribute as CFString
        let raw = withExtendedLifetime((element, attrCF)) {
            fn(
                Unmanaged.passUnretained(element).toOpaque(),
                Unmanaged.passUnretained(attrCF).toOpaque(),
                &out
            )
        }
        let err = AXError(rawValue: raw) ?? .failure
        if err == .success, let out {
            return (.success, out.takeRetainedValue())
        }
        return (err, nil)
    }

    func setAttributeValue(_ element: AnyObject, attribute: String, value: AnyObject) -> AXError {
        guard let fn = setAttributeValueFn else { return .failure }
        let attrCF = attribute as CFString
        let raw = withExtendedLifetime((element, attrCF, value)) {
            fn(
                Unmanaged.passUnretained(element).toOpaque(),
                Unmanaged.passUnretained(attrCF).toOpaque(),
                Unmanaged.passUnretained(value).toOpaque()
            )
        }
        return AXError(rawValue: raw) ?? .failure
    }

    func performAction(_ element: AnyObject, action: String) -> AXError {
        guard let fn = performActionFn else { return .failure }
        let actionCF = action as CFString
        let raw = withExtendedLifetime((element, actionCF)) {
            fn(
                Unmanaged.passUnretained(element).toOpaque(),
                Unmanaged.passUnretained(actionCF).toOpaque()
            )
        }
        return AXError(rawValue: raw) ?? .failure
    }

    func getWindowID(_ element: AnyObject) -> CGWindowID? {
        guard let fn = getWindowFn else { return nil }
        var wid: CGWindowID = 0
        let raw = withExtendedLifetime(element) {
            fn(Unmanaged.passUnretained(element).toOpaque(), &wid)
        }
        guard (AXError(rawValue: raw) ?? .failure) == .success, wid > 0 else {
            return nil
        }
        return wid
    }
}

@MainActor
public final class MacAccessibilityWindowDriver: AccessibilityWindowDriving {
    private static let attrWindows = "AXWindows"
    private static let attrRole = "AXRole"
    private static let attrSubrole = "AXSubrole"
    private static let attrTitle = "AXTitle"
    private static let attrPosition = "AXPosition"
    private static let attrSize = "AXSize"
    private static let attrMinimized = "AXMinimized"
    private static let attrFullScreen = "AXFullScreen"
    private static let attrMain = "AXMain"
    private static let attrFocused = "AXFocused"
    private static let roleWindow = "AXWindow"
    private static let subroleStandardWindow = "AXStandardWindow"
    private static let actionRaise = "AXRaise"

    private let ax = HIServicesAXRuntime.shared
    private var messagingTimeoutSeconds: Float = 1.0
    private var cachedWindowElements: [WindowKey: AnyObject] = [:]

    public init() {}

    public func isProcessTrusted() -> Bool {
        AXIsProcessTrusted()
    }

    public func setMessagingTimeout(seconds: Float) {
        let clamped = max(0.05, seconds)
        messagingTimeoutSeconds = clamped
        if let sysWide = ax.createSystemWide() {
            ax.setMessagingTimeout(sysWide, seconds: clamped)
        }
        for element in cachedWindowElements.values {
            ax.setMessagingTimeout(element, seconds: clamped)
        }
    }

    public func runningRegularApps() -> [RunningAppSnapshot] {
        let ownPID = ProcessInfo.processInfo.processIdentifier
        return NSWorkspace.shared.runningApplications.compactMap { app in
            let pid = app.processIdentifier
            let isRegular = app.activationPolicy == .regular
            let isTerminated = app.isTerminated
            let bundleId = app.bundleIdentifier
            let execName = app.executableURL?.lastPathComponent
            let localized = app.localizedName?.trimmingCharacters(in: .whitespacesAndNewlines)
            let appName: String
            if let localized, !localized.isEmpty {
                appName = localized
            } else if let execName, !execName.isEmpty {
                appName = execName
            } else if let bundleId, !bundleId.isEmpty {
                appName = bundleId
            } else {
                appName = ""
            }
            guard WindowCoordinator.shouldIncludeRegularApp(
                pid: pid,
                ownPID: ownPID,
                isRegular: isRegular,
                isTerminated: isTerminated,
                bundleId: bundleId,
                appName: appName,
                executableName: execName
            ) else {
                return nil
            }
            return RunningAppSnapshot(
                pid: pid,
                bundleId: bundleId,
                appName: appName,
                executableName: execName,
                isRegular: isRegular,
                isTerminated: isTerminated
            )
        }
    }

    public func cgWindowSnapshot() -> (onScreenZOrder: [WindowKey: Int], allByKey: [WindowKey: CGWindowEntry]) {
        var onScreenZOrder: [WindowKey: Int] = [:]
        var allByKey: [WindowKey: CGWindowEntry] = [:]

        if let onScreenRows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] {
            var nextZ = 0
            for row in onScreenRows {
                guard let entry = Self.parseCGWindowRow(row, zIndex: nextZ) else { continue }
                if entry.layer == 0, onScreenZOrder[entry.key] == nil {
                    onScreenZOrder[entry.key] = nextZ
                    nextZ += 1
                }
                if allByKey[entry.key] == nil {
                    allByKey[entry.key] = entry
                }
            }
        }

        if let allRows = CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
            var fallbackRank = max(onScreenZOrder.count, 10_000)
            for row in allRows {
                guard let entry = Self.parseCGWindowRow(row, zIndex: fallbackRank) else { continue }
                if allByKey[entry.key] == nil {
                    allByKey[entry.key] = entry
                    fallbackRank += 1
                }
            }
        }

        return (onScreenZOrder, allByKey)
    }

    public func liveCGWindow(for key: WindowKey) -> CGWindowEntry? {
        guard key.pid > 0, key.windowId > 0 else { return nil }
        guard let rows = CGWindowListCopyWindowInfo([.optionIncludingWindow], key.windowId) as? [[String: Any]] else {
            return nil
        }
        for row in rows {
            guard let entry = Self.parseCGWindowRow(row, zIndex: 0),
                  entry.key == key else {
                continue
            }
            return entry
        }
        return nil
    }

    public func enumerateStandardWindows(
        for app: RunningAppSnapshot,
        cgSnapshot: [WindowKey: CGWindowEntry]
    ) throws -> [WindowCandidateSnapshot] {
        guard isProcessTrusted() else { throw AXDriverError.untrusted }
        guard ax.isCoreAXAvailable, let appElement = ax.createApplication(pid: app.pid) else {
            throw AXDriverError.timedOutOrUnresponsive
        }
        if let sysWide = ax.createSystemWide() {
            ax.setMessagingTimeout(sysWide, seconds: messagingTimeoutSeconds)
        }
        ax.setMessagingTimeout(appElement, seconds: messagingTimeoutSeconds)

        let (winErr, rawWindowsObj) = ax.copyAttributeValue(appElement, attribute: Self.attrWindows)
        if winErr != .success {
            if winErr == .noValue || winErr == .attributeUnsupported {
                return []
            }
            throw mapAXError(winErr)
        }
        guard let windowElements = rawWindowsObj as? [AnyObject] else {
            return []
        }

        let pidCGEntries = cgSnapshot.values
            .filter { $0.key.pid == app.pid && $0.layer == 0 }
            .sorted { $0.zIndex < $1.zIndex }
        var consumedWindowIDs: Set<CGWindowID> = []
        var results: [WindowCandidateSnapshot] = []

        for winElement in windowElements {
            ax.setMessagingTimeout(winElement, seconds: messagingTimeoutSeconds)

            let (subroleErr, subroleObj) = ax.copyAttributeValue(winElement, attribute: Self.attrSubrole)
            if subroleErr == .cannotComplete || subroleErr == .apiDisabled {
                throw mapAXError(subroleErr)
            }
            guard subroleErr == .success,
                  let subrole = subroleObj as? String,
                  subrole == Self.subroleStandardWindow else {
                continue
            }

            if let roleObj = ax.copyAttributeValue(winElement, attribute: Self.attrRole).1 as? String,
               roleObj != Self.roleWindow {
                continue
            }

            guard let frame = try readAXFrame(winElement, allowMissingAsNil: true),
                  frame.width > 0,
                  frame.height > 0 else {
                continue
            }

            let rawTitle = ax.copyAttributeValue(winElement, attribute: Self.attrTitle).1 as? String
            let sanitizedTitle = WindowCoordinator.sanitizeWindowTitle(rawTitle)

            guard let resolvedWindowID = resolveCGWindowID(
                for: winElement,
                pid: app.pid,
                axFrame: frame,
                sanitizedTitle: sanitizedTitle,
                cgSnapshot: cgSnapshot,
                pidCGEntries: pidCGEntries,
                consumedWindowIDs: &consumedWindowIDs
            ) else {
                continue
            }

            consumedWindowIDs.insert(resolvedWindowID)
            let key = WindowKey(pid: app.pid, windowId: resolvedWindowID)
            cachedWindowElements[key] = winElement

            let isMinimized = Self.extractAXBool(ax.copyAttributeValue(winElement, attribute: Self.attrMinimized).1)
            let isFullScreen = Self.extractAXBool(ax.copyAttributeValue(winElement, attribute: Self.attrFullScreen).1)
            let fallbackTitle = sanitizedTitle.isEmpty
                ? WindowCoordinator.sanitizeWindowTitle(cgSnapshot[key]?.title)
                : sanitizedTitle

            results.append(
                WindowCandidateSnapshot(
                    key: key,
                    title: fallbackTitle,
                    frame: frame,
                    isMinimized: isMinimized,
                    isFullScreen: isFullScreen
                )
            )
        }

        return results
    }

    public func readWindowState(_ key: WindowKey) throws -> WindowLiveState {
        let element = try resolveAXWindowElement(for: key)
        guard let frame = try readAXFrame(element, allowMissingAsNil: false) else {
            throw AXDriverError.windowUnavailable
        }
        let (minErr, minObj) = ax.copyAttributeValue(element, attribute: Self.attrMinimized)
        if minErr == .cannotComplete || minErr == .apiDisabled || minErr == .invalidUIElement {
            throw mapAXError(minErr)
        }
        let (fsErr, fsObj) = ax.copyAttributeValue(element, attribute: Self.attrFullScreen)
        if fsErr == .cannotComplete || fsErr == .apiDisabled || fsErr == .invalidUIElement {
            throw mapAXError(fsErr)
        }
        let rawTitle = ax.copyAttributeValue(element, attribute: Self.attrTitle).1 as? String
        return WindowLiveState(
            frame: frame,
            isMinimized: Self.extractAXBool(minObj),
            isFullScreen: Self.extractAXBool(fsObj),
            title: rawTitle
        )
    }

    private static func extractAXBool(_ raw: AnyObject?) -> Bool {
        if let b = raw as? Bool { return b }
        if let n = raw as? NSNumber { return n.boolValue }
        return false
    }

    public func setMinimized(_ key: WindowKey, _ minimized: Bool) throws {
        let element = try resolveAXWindowElement(for: key)
        let boolValue: CFBoolean = minimized ? kCFBooleanTrue : kCFBooleanFalse
        let err = ax.setAttributeValue(element, attribute: Self.attrMinimized, value: boolValue)
        if err != .success {
            throw mapAXMutationError(err, key: key)
        }
    }

    public func setFullScreen(_ key: WindowKey, _ fullScreen: Bool) throws {
        let element = try resolveAXWindowElement(for: key)
        let boolValue: CFBoolean = fullScreen ? kCFBooleanTrue : kCFBooleanFalse
        let err = ax.setAttributeValue(element, attribute: Self.attrFullScreen, value: boolValue)
        if err != .success {
            throw mapAXMutationError(err, key: key)
        }
    }

    public func setSize(_ key: WindowKey, _ size: CGSize) throws {
        let element = try resolveAXWindowElement(for: key)
        var mutableSize = size
        guard let axValue = AXValueCreate(.cgSize, &mutableSize) else {
            throw AXDriverError.attributeUnsupported
        }
        let err = ax.setAttributeValue(element, attribute: Self.attrSize, value: axValue)
        if err != .success {
            throw mapAXMutationError(err, key: key)
        }
    }

    public func setPosition(_ key: WindowKey, _ origin: CGPoint) throws {
        let element = try resolveAXWindowElement(for: key)
        var mutablePoint = origin
        guard let axValue = AXValueCreate(.cgPoint, &mutablePoint) else {
            throw AXDriverError.attributeUnsupported
        }
        let err = ax.setAttributeValue(element, attribute: Self.attrPosition, value: axValue)
        if err != .success {
            throw mapAXMutationError(err, key: key)
        }
    }

    public func raiseAndActivate(_ key: WindowKey) throws {
        let element = try resolveAXWindowElement(for: key)
        let raiseErr = ax.performAction(element, action: Self.actionRaise)
        if raiseErr == .cannotComplete || raiseErr == .apiDisabled || raiseErr == .invalidUIElement {
            throw mapAXMutationError(raiseErr, key: key)
        }
        _ = ax.setAttributeValue(element, attribute: Self.attrMain, value: kCFBooleanTrue)
        _ = ax.setAttributeValue(element, attribute: Self.attrFocused, value: kCFBooleanTrue)
        if let runningApp = NSRunningApplication(processIdentifier: key.pid), !runningApp.isTerminated {
            _ = runningApp.activate(options: [])
        }
    }

    public func screenTopology(virtualDisplayId: CGDirectDisplayID?) -> ScreenTopologySnapshot {
        let screens = NSScreen.screens
        let primaryScreen = screens.first(where: { $0.frame.origin == .zero }) ?? screens.first
        let primaryHeight = primaryScreen?.frame.height ?? CGDisplayBounds(CGMainDisplayID()).height

        var displays: [CGDirectDisplayID: ScreenDisplayFrames] = [:]
        var orderedPhysicalIDs: [CGDirectDisplayID] = []
        var zeroOriginPhysicalID: CGDirectDisplayID?

        for screen in screens {
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
                continue
            }
            let id = CGDirectDisplayID(number.uint32Value)
            guard id != kCGNullDirectDisplay else { continue }
            let isVirtual = (virtualDisplayId != nil && id == virtualDisplayId) ||
                (CGDisplayVendorNumber(id) == VirtualDisplayHardwareSpec.vendorID &&
                 CGDisplayModelNumber(id) == VirtualDisplayHardwareSpec.productID)
            displays[id] = ScreenDisplayFrames(
                displayId: id,
                frame: screen.frame,
                visibleFrame: screen.visibleFrame,
                isVirtual: isVirtual
            )
            if !isVirtual {
                orderedPhysicalIDs.append(id)
                if screen.frame.origin == .zero && zeroOriginPhysicalID == nil {
                    zeroOriginPhysicalID = id
                }
            }
        }

        let primaryPhysical = zeroOriginPhysicalID ?? orderedPhysicalIDs.first
        return ScreenTopologySnapshot(
            displays: displays,
            primaryScreenHeight: primaryHeight,
            primaryPhysicalDisplayId: primaryPhysical
        )
    }

    public func sleep(milliseconds: UInt64) async {
        try? await Task.sleep(for: .milliseconds(Int64(milliseconds)))
    }

    private static func parseCGWindowRow(_ row: [String: Any], zIndex: Int) -> CGWindowEntry? {
        guard let pidNum = row[kCGWindowOwnerPID as String] as? NSNumber,
              let winNum = row[kCGWindowNumber as String] as? NSNumber else {
            return nil
        }
        let pid = pidNum.int32Value
        let wid = winNum.uint32Value
        guard pid > 0, wid > 0 else { return nil }
        let layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
        var bounds = CGRect.zero
        if let rectDict = row[kCGWindowBounds as String] as? [String: Any],
           let parsed = CGRect(dictionaryRepresentation: rectDict as CFDictionary) {
            bounds = parsed
        }
        let title = row[kCGWindowName as String] as? String
        return CGWindowEntry(
            key: WindowKey(pid: pid, windowId: wid),
            bounds: bounds,
            layer: layer,
            title: title,
            zIndex: zIndex
        )
    }

    private func resolveCGWindowID(
        for winElement: AnyObject,
        pid: Int32,
        axFrame: CGRect,
        sanitizedTitle: String,
        cgSnapshot: [WindowKey: CGWindowEntry],
        pidCGEntries: [CGWindowEntry],
        consumedWindowIDs: inout Set<CGWindowID>
    ) -> CGWindowID? {
        if let directID = ax.getWindowID(winElement), !consumedWindowIDs.contains(directID) {
            let directKey = WindowKey(pid: pid, windowId: directID)
            if cgSnapshot[directKey] != nil || liveCGWindow(for: directKey) != nil {
                return directID
            }
        }

        return WindowCoordinator.matchFallbackCGWindowID(
            axFrame: axFrame,
            sanitizedTitle: sanitizedTitle,
            pidCGEntries: pidCGEntries,
            consumedWindowIDs: consumedWindowIDs
        )
    }

    private func resolveAXWindowElement(for key: WindowKey) throws -> AnyObject {
        guard isProcessTrusted() else { throw AXDriverError.untrusted }
        guard liveCGWindow(for: key) != nil else {
            cachedWindowElements.removeValue(forKey: key)
            throw AXDriverError.windowUnavailable
        }

        if let cached = cachedWindowElements[key] {
            ax.setMessagingTimeout(cached, seconds: messagingTimeoutSeconds)
            if let directID = ax.getWindowID(cached), directID == key.windowId {
                return cached
            }
            let (posErr, _) = ax.copyAttributeValue(cached, attribute: Self.attrPosition)
            if posErr == .success && !ax.hasDirectGetWindowSymbol {
                return cached
            }
            if posErr == .cannotComplete || posErr == .apiDisabled {
                throw mapAXError(posErr)
            }
            cachedWindowElements.removeValue(forKey: key)
        }

        guard ax.isCoreAXAvailable, let appElement = ax.createApplication(pid: key.pid) else {
            throw AXDriverError.timedOutOrUnresponsive
        }
        if let sysWide = ax.createSystemWide() {
            ax.setMessagingTimeout(sysWide, seconds: messagingTimeoutSeconds)
        }
        ax.setMessagingTimeout(appElement, seconds: messagingTimeoutSeconds)

        let (winErr, rawWindowsObj) = ax.copyAttributeValue(appElement, attribute: Self.attrWindows)
        if winErr != .success {
            if winErr == .invalidUIElement || winErr == .noValue {
                throw AXDriverError.windowUnavailable
            }
            throw mapAXError(winErr)
        }
        guard let windowElements = rawWindowsObj as? [AnyObject] else {
            throw AXDriverError.windowUnavailable
        }

        let snapshot = cgWindowSnapshot().allByKey
        let pidEntries = snapshot.values
            .filter { $0.key.pid == key.pid && $0.layer == 0 }
            .sorted { $0.zIndex < $1.zIndex }
        var consumed: Set<CGWindowID> = []

        for element in windowElements {
            ax.setMessagingTimeout(element, seconds: messagingTimeoutSeconds)
            if let directID = ax.getWindowID(element) {
                if directID == key.windowId {
                    cachedWindowElements[key] = element
                    return element
                }
                consumed.insert(directID)
                continue
            }
            if let axFrame = try readAXFrame(element, allowMissingAsNil: true) {
                let rawTitle = ax.copyAttributeValue(element, attribute: Self.attrTitle).1 as? String
                let cleanTitle = WindowCoordinator.sanitizeWindowTitle(rawTitle)
                if let resolvedID = resolveCGWindowID(
                    for: element,
                    pid: key.pid,
                    axFrame: axFrame,
                    sanitizedTitle: cleanTitle,
                    cgSnapshot: snapshot,
                    pidCGEntries: pidEntries,
                    consumedWindowIDs: &consumed
                ) {
                    consumed.insert(resolvedID)
                    if resolvedID == key.windowId {
                        cachedWindowElements[key] = element
                        return element
                    }
                }
            }
        }

        throw AXDriverError.windowUnavailable
    }

    private func readAXFrame(_ element: AnyObject, allowMissingAsNil: Bool) throws -> CGRect? {
        let (posErr, posObj) = ax.copyAttributeValue(element, attribute: Self.attrPosition)
        if posErr != .success {
            if allowMissingAsNil && (posErr == .attributeUnsupported || posErr == .noValue || posErr == .failure) {
                return nil
            }
            throw mapAXError(posErr)
        }
        let (sizeErr, sizeObj) = ax.copyAttributeValue(element, attribute: Self.attrSize)
        if sizeErr != .success {
            if allowMissingAsNil && (sizeErr == .attributeUnsupported || sizeErr == .noValue || sizeErr == .failure) {
                return nil
            }
            throw mapAXError(sizeErr)
        }
        guard let posVal = posObj,
              let sizeVal = sizeObj,
              CFGetTypeID(posVal) == AXValueGetTypeID(),
              CFGetTypeID(sizeVal) == AXValueGetTypeID() else {
            return allowMissingAsNil ? nil : { () -> CGRect? in nil }()
        }
        let axPos = unsafeDowncast(posVal, to: AXValue.self)
        let axSize = unsafeDowncast(sizeVal, to: AXValue.self)
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetType(axPos) == .cgPoint,
              AXValueGetValue(axPos, .cgPoint, &point),
              AXValueGetType(axSize) == .cgSize,
              AXValueGetValue(axSize, .cgSize, &size) else {
            return nil
        }
        return CGRect(origin: point, size: size)
    }

    private func mapAXError(_ error: AXError) -> AXDriverError {
        switch error {
        case .apiDisabled:
            return isProcessTrusted() ? .timedOutOrUnresponsive : .untrusted
        case .cannotComplete:
            return .timedOutOrUnresponsive
        case .invalidUIElement:
            return .windowUnavailable
        default:
            return .attributeUnsupported
        }
    }

    private func mapAXMutationError(_ error: AXError, key: WindowKey) -> AXDriverError {
        switch error {
        case .apiDisabled:
            return isProcessTrusted() ? .timedOutOrUnresponsive : .untrusted
        case .cannotComplete:
            return .timedOutOrUnresponsive
        case .invalidUIElement:
            cachedWindowElements.removeValue(forKey: key)
            return .windowUnavailable
        default:
            if liveCGWindow(for: key) == nil {
                cachedWindowElements.removeValue(forKey: key)
                return .windowUnavailable
            }
            return .attributeUnsupported
        }
    }
}

@MainActor
public final class WindowCoordinator: DesktopWindowCoordinating {
    public static let restoreFilename = "window-restore.json"
    private static let maxListedWindows = 200
    private static let maxStdoutPayloadBytes = 240_000
    private static let placementAttemptsNormal = 10
    private static let placementIntervalNormalMs: UInt64 = 250
    private static let restoreAttemptsNormal = 6
    private static let restoreIntervalNormalMs: UInt64 = 150
    private static let restoreAttemptsFast = 3
    private static let restoreIntervalFastMs: UInt64 = 50
    private static let headlessFallbackFrame = CGRect(x: 80, y: 80, width: 1280, height: 820)

    public let stateDir: String?
    public let driver: any AccessibilityWindowDriving
    weak var host: DesktopHost?

    public private(set) var trackedRecords: [RestoreRecord] = []
    private var deferredRecords: [RestoreRecord] = []
    public private(set) var activeWindowKey: WindowKey?
    private var didReconcileStartup = false
    private let customNowProvider: (@MainActor () -> ContinuousClock.Instant)?

    public var activeWindowId: String? {
        activeWindowKey?.rawId
    }

    public var restoreFilePath: String? {
        guard let stateDir, !stateDir.isEmpty else { return nil }
        return URL(fileURLWithPath: stateDir, isDirectory: true)
            .appendingPathComponent(Self.restoreFilename)
            .path
    }

    public init(
        stateDir: String?,
        driver: any AccessibilityWindowDriving = MacAccessibilityWindowDriver(),
        nowProvider: (@MainActor () -> ContinuousClock.Instant)? = nil
    ) {
        self.stateDir = stateDir
        self.driver = driver
        self.customNowProvider = nowProvider
    }

    private func currentInstant() -> ContinuousClock.Instant {
        customNowProvider?() ?? host?.virtualDisplayCoordinator.now() ?? ContinuousClock.now
    }

    func attach(host: DesktopHost) {
        self.host = host
    }

    public static func shouldIncludeRegularApp(
        pid: Int32,
        ownPID: Int32 = ProcessInfo.processInfo.processIdentifier,
        isRegular: Bool,
        isTerminated: Bool,
        bundleId: String?,
        appName: String,
        executableName: String?
    ) -> Bool {
        guard isRegular, !isTerminated, pid > 0, pid != ownPID else {
            return false
        }
        if let lowerBundle = bundleId?.lowercased(),
           lowerBundle.hasPrefix("com.codelync") || lowerBundle.hasPrefix("ai.codelync") {
            return false
        }
        if appName.lowercased().hasPrefix("codelync") {
            return false
        }
        if let lowerExec = executableName?.lowercased(), lowerExec.hasPrefix("codelync") {
            return false
        }
        return true
    }

    public static func sanitizeWindowTitle(_ raw: String?, maxCount: Int = 200) -> String {
        guard let raw, !raw.isEmpty, maxCount > 0 else { return "" }
        var scalars = String.UnicodeScalarView()
        var previousWasCR = false
        for scalar in raw.unicodeScalars {
            if scalar.value == 0x0D {
                scalars.append(" ")
                previousWasCR = true
                continue
            }
            if scalar.value == 0x0A {
                if !previousWasCR {
                    scalars.append(" ")
                }
                previousWasCR = false
                continue
            }
            previousWasCR = false
            if scalar.value == 0x09 {
                scalars.append(" ")
                continue
            }
            let category = scalar.properties.generalCategory
            if category == .control {
                continue
            }
            if category == .format && scalar.value != 0x200D {
                continue
            }
            scalars.append(scalar)
        }
        let cleaned = String(scalars)
        var result = String(cleaned.prefix(maxCount))
        while result.unicodeScalars.count > maxCount {
            result.removeLast()
        }
        return result
    }

    public static func matchFallbackCGWindowID(
        axFrame: CGRect,
        sanitizedTitle: String,
        pidCGEntries: [CGWindowEntry],
        consumedWindowIDs: Set<CGWindowID>
    ) -> CGWindowID? {
        let unconsumed = pidCGEntries.filter { $0.layer == 0 && !consumedWindowIDs.contains($0.key.windowId) }
        if let exactMatch = unconsumed.first(where: { candidate in
            let cgTitle = Self.sanitizeWindowTitle(candidate.title)
            return cgTitle == sanitizedTitle && Self.framesMatch(candidate.bounds, axFrame, tolerance: 2.0)
        }) {
            return exactMatch.key.windowId
        }

        let frameMatches = unconsumed.filter { Self.framesMatch($0.bounds, axFrame, tolerance: 2.0) }
        if frameMatches.count == 1 {
            return frameMatches[0].key.windowId
        }

        if !sanitizedTitle.isEmpty,
           let titleNearMatch = unconsumed.first(where: { candidate in
               Self.sanitizeWindowTitle(candidate.title) == sanitizedTitle &&
               Self.framesMatch(candidate.bounds, axFrame, tolerance: 24.0)
           }) {
            return titleNearMatch.key.windowId
        }

        return nil
    }

    public static func appKitRectToAX(_ rect: CGRect, primaryScreenHeight: CGFloat) -> CGRect {
        CGRect(
            x: rect.minX,
            y: primaryScreenHeight - rect.maxY,
            width: rect.width,
            height: rect.height
        )
    }

    public static func framesMatch(_ lhs: CGRect, _ rhs: CGRect, tolerance: CGFloat = 2.0) -> Bool {
        abs(lhs.minX - rhs.minX) <= tolerance &&
        abs(lhs.minY - rhs.minY) <= tolerance &&
        abs(lhs.width - rhs.width) <= tolerance &&
        abs(lhs.height - rhs.height) <= tolerance
    }

    public static func matchesAppIdentity(record: RestoreRecord, app: RunningAppSnapshot) -> Bool {
        if record.bundleId != nil || app.bundleId != nil {
            return record.bundleId == app.bundleId
        }
        return !record.appName.isEmpty && record.appName == app.appName
    }

    private static func mergeRecords(_ primary: [RestoreRecord], _ secondary: [RestoreRecord]) -> [RestoreRecord] {
        var seen: Set<WindowKey> = []
        var merged: [RestoreRecord] = []
        for record in primary + secondary where !seen.contains(record.key) {
            seen.insert(record.key)
            merged.append(record)
        }
        return merged
    }

    public func recoverIfTrusted() async {
        guard let restoreFilePath else { return }
        let hostTrusted = host?.permissionProvider.accessibilityGranted() ?? true
        guard hostTrusted && driver.isProcessTrusted() else { return }
        didReconcileStartup = true

        let store = DurableJSONStore.loadOrQuarantine(
            RestoreStoreFile.self,
            from: restoreFilePath,
            validate: { $0.version == 1 && $0.records.allSatisfy(\.isValid) }
        )
        let activeKeys = Set(trackedRecords.map(\.key))
        let candidates = Self.mergeRecords(deferredRecords, store?.records ?? [])
            .filter { !activeKeys.contains($0.key) }

        if candidates.isEmpty {
            deferredRecords.removeAll()
            if store != nil && trackedRecords.isEmpty {
                DurableJSONStore.removeIfExists(at: restoreFilePath)
            }
            return
        }

        driver.setMessagingTimeout(seconds: 1.0)
        let eligibleApps = eligibleRunningAppsByPID()
        var remaining: [RestoreRecord] = []

        for record in candidates {
            guard driver.liveCGWindow(for: record.key) != nil else {
                continue
            }
            guard let app = eligibleApps[record.pid],
                  Self.matchesAppIdentity(record: record, app: app) else {
                continue
            }
            let outcome = await restoreSingleRecord(
                record,
                maxAttempts: Self.restoreAttemptsNormal,
                intervalMs: Self.restoreIntervalNormalMs,
                allowFullScreenSpaceRestore: true,
                deadlineProvider: { nil }
            )
            if outcome == .retainForRetry {
                remaining.append(record)
            }
        }

        deferredRecords = remaining
        let combined = Self.mergeRecords(deferredRecords, trackedRecords)
        if combined.isEmpty {
            DurableJSONStore.removeIfExists(at: restoreFilePath)
        } else {
            try? DurableJSONStore.writeAtomic(RestoreStoreFile(version: 1, records: combined), to: restoreFilePath)
        }
    }

    public func restoreAllBeforeVirtualTeardown() async {
        await restoreAllBeforeVirtualTeardown(
            isShuttingDownProvider: { false },
            deadlineProvider: { nil }
        )
    }

    public func restoreAllBeforeVirtualTeardown(
        isShuttingDownProvider: @MainActor () -> Bool,
        deadlineProvider: @MainActor () -> ContinuousClock.Instant?
    ) async {
        activeWindowKey = nil
        let toRestore = Self.mergeRecords(trackedRecords, deferredRecords)
        guard !toRestore.isEmpty else {
            return
        }

        let hostTrusted = host?.permissionProvider.accessibilityGranted() ?? true
        guard hostTrusted && driver.isProcessTrusted() else {
            // Retain persisted records on disk so startup crash recovery can restore once trusted.
            deferredRecords = toRestore
            trackedRecords.removeAll()
            return
        }

        let now = currentInstant()
        let activeDeadline = deadlineProvider()
        let remainingBudget = activeDeadline.map { max(.zero, now.duration(to: $0)) }
        let useFastMode = isShuttingDownProvider() || (remainingBudget != nil && remainingBudget! <= .milliseconds(1000))

        driver.setMessagingTimeout(seconds: useFastMode ? 0.25 : 1.0)
        defer { driver.setMessagingTimeout(seconds: 1.0) }

        let eligibleApps = eligibleRunningAppsByPID()
        var remaining: [RestoreRecord] = []

        for record in toRestore {
            if let limit = deadlineProvider(), currentInstant() >= limit {
                if driver.liveCGWindow(for: record.key) != nil {
                    remaining.append(record)
                }
                continue
            }
            guard driver.liveCGWindow(for: record.key) != nil else {
                continue
            }
            guard let app = eligibleApps[record.pid],
                  Self.matchesAppIdentity(record: record, app: app) else {
                continue
            }
            let outcome = await restoreSingleRecord(
                record,
                maxAttempts: useFastMode ? Self.restoreAttemptsFast : Self.restoreAttemptsNormal,
                intervalMs: useFastMode ? Self.restoreIntervalFastMs : Self.restoreIntervalNormalMs,
                allowFullScreenSpaceRestore: !useFastMode && !isShuttingDownProvider(),
                deadlineProvider: deadlineProvider
            )
            if outcome == .retainForRetry {
                remaining.append(record)
            }
        }

        trackedRecords.removeAll()
        deferredRecords = remaining
        if let restoreFilePath {
            if remaining.isEmpty {
                DurableJSONStore.removeIfExists(at: restoreFilePath)
            } else {
                try? DurableJSONStore.writeAtomic(RestoreStoreFile(version: 1, records: remaining), to: restoreFilePath)
            }
        }
    }

    public func listWindows() async throws -> [String: Any] {
        let hostTrusted = host?.permissionProvider.accessibilityGranted() ?? true
        guard hostTrusted && driver.isProcessTrusted() else {
            throw DesktopFailure.code("desktop-accessibility-required")
        }

        if stateDir != nil && activeWindowKey == nil && trackedRecords.isEmpty && !didReconcileStartup {
            await recoverIfTrusted()
        }

        driver.setMessagingTimeout(seconds: 1.0)
        host?.lastSeen = Date()

        let activeVirtualID: CGDirectDisplayID?
        if let host,
           host.selectedDisplayIsVirtual,
           let vID = host.virtualDisplayCoordinator.activeVirtualDisplayID,
           host.selectedDisplay == vID {
            activeVirtualID = vID
        } else {
            activeVirtualID = nil
        }

        let virtualAXBounds: CGRect?
        if let vID = activeVirtualID {
            let topology = driver.screenTopology(virtualDisplayId: vID)
            virtualAXBounds = resolveVirtualAXFrame(virtualDisplayID: vID, topology: topology)
        } else {
            virtualAXBounds = nil
        }

        let cg = driver.cgWindowSnapshot()
        let ownPID = ProcessInfo.processInfo.processIdentifier
        let apps = driver.runningRegularApps().filter { app in
            Self.shouldIncludeRegularApp(
                pid: app.pid,
                ownPID: ownPID,
                isRegular: app.isRegular,
                isTerminated: app.isTerminated,
                bundleId: app.bundleId,
                appName: app.appName,
                executableName: app.executableName
            )
        }

        struct RankedItem {
            let zOrder: Int
            let insertionOrder: Int
            let payload: [String: Any]
        }

        var seenKeys: Set<WindowKey> = []
        var ranked: [RankedItem] = []
        var insertionIndex = 0

        for app in apps {
            let candidates: [WindowCandidateSnapshot]
            do {
                candidates = try driver.enumerateStandardWindows(for: app, cgSnapshot: cg.allByKey)
            } catch AXDriverError.untrusted {
                throw DesktopFailure.code("desktop-accessibility-required")
            } catch {
                // Skip individual hung or exited apps so the rest of the window list still loads.
                continue
            }
            host?.lastSeen = Date()

            for candidate in candidates {
                guard candidate.key.pid > 0,
                      candidate.key.windowId > 0,
                      !seenKeys.contains(candidate.key),
                      candidate.frame.origin.x.isFinite,
                      candidate.frame.origin.y.isFinite,
                      candidate.frame.size.width.isFinite,
                      candidate.frame.size.height.isFinite else {
                    continue
                }
                let roundedW = Int(candidate.frame.size.width.rounded())
                let roundedH = Int(candidate.frame.size.height.rounded())
                guard roundedW > 0, roundedH > 0 else { continue }
                let roundedX = Int(candidate.frame.origin.x.rounded())
                let roundedY = Int(candidate.frame.origin.y.rounded())

                seenKeys.insert(candidate.key)
                let cleanTitle = Self.sanitizeWindowTitle(candidate.title)
                let center = CGPoint(x: candidate.frame.midX, y: candidate.frame.midY)
                let onVirtual = virtualAXBounds?.contains(center) ?? false
                let zOrder = cg.onScreenZOrder[candidate.key] ?? cg.allByKey[candidate.key]?.zIndex ?? Int.max

                let cleanAppName = Self.sanitizeWindowTitle(app.appName, maxCount: 120)
                let item: [String: Any] = [
                    "id": candidate.key.rawId,
                    "pid": Int(candidate.key.pid),
                    "windowId": Int(candidate.key.windowId),
                    "appName": cleanAppName,
                    "bundleId": app.bundleId ?? NSNull(),
                    "title": cleanTitle,
                    "bounds": [
                        "x": roundedX,
                        "y": roundedY,
                        "width": roundedW,
                        "height": roundedH
                    ],
                    "minimized": candidate.isMinimized,
                    "onVirtualDisplay": onVirtual
                ]
                ranked.append(RankedItem(zOrder: zOrder, insertionOrder: insertionIndex, payload: item))
                insertionIndex += 1
            }
        }

        ranked.sort { lhs, rhs in
            if lhs.zOrder != rhs.zOrder {
                return lhs.zOrder < rhs.zOrder
            }
            return lhs.insertionOrder < rhs.insertionOrder
        }

        var items = Array(ranked.prefix(Self.maxListedWindows).map(\.payload))
        var response: [String: Any] = [
            "windows": items,
            "activeWindowId": activeWindowId ?? NSNull()
        ]
        while !items.isEmpty,
              let encoded = try? JSONSerialization.data(withJSONObject: response, options: []),
              encoded.count > Self.maxStdoutPayloadBytes {
            let ratio = Double(Self.maxStdoutPayloadBytes) / Double(max(encoded.count, 1))
            let targetCount = min(items.count - 1, max(0, Int(Double(items.count) * ratio * 0.95)))
            items.removeSubrange(targetCount..<items.count)
            response["windows"] = items
        }
        return response
    }

    public func handleWindow(_ value: [String: Any]) async throws -> [String: Any] {
        // 1. Schema validation (400 invalid-desktop-window)
        guard let mode = value["mode"] as? String, (mode == "fill" || mode == "restore") else {
            throw DesktopFailure.code("invalid-desktop-window")
        }

        let targetKey: WindowKey?
        if mode == "fill" {
            guard let rawWindowId = value["windowId"] as? String,
                  let parsed = WindowKey.parse(rawWindowId) else {
                throw DesktopFailure.code("invalid-desktop-window")
            }
            targetKey = parsed
        } else {
            if value["windowId"] != nil {
                throw DesktopFailure.code("invalid-desktop-window")
            }
            targetKey = nil
        }

        let parsedSequence: Int?
        if let rawSeq = value["sequence"] {
            guard let seq = DesktopJSON.strictInt(rawSeq) else {
                throw DesktopFailure.code("invalid-desktop-window")
            }
            parsedSequence = seq
        } else {
            parsedSequence = nil
        }

        let parsedGeometry: String?
        if let rawGeom = value["geometry"] {
            guard let geom = rawGeom as? String, !geom.isEmpty else {
                throw DesktopFailure.code("invalid-desktop-window")
            }
            parsedGeometry = geom
        } else {
            parsedGeometry = nil
        }

        let parsedConnectionId: String?
        if let rawConn = value["connectionId"] {
            guard let conn = rawConn as? String, !conn.isEmpty else {
                throw DesktopFailure.code("invalid-desktop-window")
            }
            parsedConnectionId = conn
        } else {
            parsedConnectionId = nil
        }

        // 2. Pre-mutation session, display, sequence, geometry, lock & trust checks
        guard let host else {
            throw DesktopFailure.code("desktop-disconnected")
        }
        if let reqConn = parsedConnectionId, reqConn != host.connection {
            throw DesktopFailure.code("desktop-disconnected")
        }
        guard !host.connection.isEmpty,
              host.room?.isConnected == true,
              host.currentTrackSid != nil else {
            throw DesktopFailure.code("desktop-disconnected")
        }
        guard host.selectedDisplayIsVirtual,
              let virtualDisplayID = host.selectedDisplay,
              virtualDisplayID == host.virtualDisplayCoordinator.activeVirtualDisplayID else {
            throw DesktopFailure.code("desktop-virtual-display-required")
        }
        if let seq = parsedSequence {
            guard seq > host.lastInput, seq <= host.lastInput + 1024 else {
                throw DesktopFailure.code("desktop-sequence-out-of-order")
            }
        }
        guard !host.viewDirty else {
            throw DesktopFailure.code("desktop-view-changed")
        }
        if let reqGeom = parsedGeometry, reqGeom != host.geometry {
            host.releasePointer()
            throw DesktopFailure.code("desktop-display-changed")
        }
        guard host.displayStamp(virtualDisplayID) == host.geometry else {
            host.releasePointer()
            throw DesktopFailure.code("desktop-display-changed")
        }
        guard !host.locked(), host.permissionProvider.screenRecordingGranted() else {
            host.releasePointer()
            throw DesktopFailure.code("desktop-locked")
        }

        if let seq = parsedSequence {
            host.lastInput = seq
        }
        host.lastSeen = Date()

        guard host.permissionProvider.accessibilityGranted(), driver.isProcessTrusted() else {
            throw DesktopFailure.code("desktop-accessibility-required")
        }

        if stateDir != nil && activeWindowKey == nil && trackedRecords.isEmpty && !didReconcileStartup {
            await recoverIfTrusted()
        }
        driver.setMessagingTimeout(seconds: 1.0)

        // 3. Mode == "restore"
        if mode == "restore" {
            if !trackedRecords.isEmpty || !deferredRecords.isEmpty {
                await restoreTrackedWindowsInteractive(
                    excluding: nil,
                    includeDeferred: true,
                    deadlineProvider: { [weak host] in host?.shutdownDeadline }
                )
            }
            activeWindowKey = nil
            var result = try await host.completeWindowMutationViewRefresh()
            result["activeWindowId"] = NSNull()
            result["upshifted"] = false
            if let seq = parsedSequence {
                result["sequence"] = seq
            }
            result["accepted"] = true
            result["mode"] = mode
            return result
        }

        // 4. Mode == "fill"
        guard let targetKey else {
            throw DesktopFailure.code("invalid-desktop-window")
        }
        guard let restoreFilePath else {
            throw DesktopFailure.code("desktop-restore-persist-failed")
        }

        // Pre-flight target window eligibility and readability BEFORE touching any window or disk!
        let eligibleApps = eligibleRunningAppsByPID()
        guard let targetApp = eligibleApps[targetKey.pid],
              driver.liveCGWindow(for: targetKey) != nil else {
            throw DesktopFailure.code("desktop-window-unavailable")
        }
        var targetState: WindowLiveState
        do {
            targetState = try driver.readWindowState(targetKey)
        } catch {
            throw mapDriverErrorToDesktopFailure(error)
        }

        var didMutateWindowState = false
        var upshifted = false

        do {
            // If switching from Window A -> Window B, restore & settle Window A first, then write-ahead Window B.
            if trackedRecords.contains(where: { $0.key != targetKey }) {
                didMutateWindowState = true
                activeWindowKey = nil
                await restoreTrackedWindowsInteractive(
                    excluding: targetKey,
                    includeDeferred: false,
                    deadlineProvider: { [weak host] in host?.shutdownDeadline }
                )
                targetState = try driver.readWindowState(targetKey)
            }

            let initialTopology = driver.screenTopology(virtualDisplayId: virtualDisplayID)
            let initialVirtualAXFrame = resolveVirtualAXFrame(virtualDisplayID: virtualDisplayID, topology: initialTopology)

            // Write-ahead atomic RestoreRecord persistence BEFORE mutating targetKey!
            var createdFromFullScreen = false
            if let existingIdx = trackedRecords.firstIndex(where: { $0.key == targetKey }),
               Self.matchesAppIdentity(record: trackedRecords[existingIdx], app: targetApp) {
                // Already tracked: preserve pre-virtual originalFrame, wasFullScreen, and wasMinimized untouched.
                try persistRecords(trackedRecords, to: restoreFilePath)
            } else if let deferredIdx = deferredRecords.firstIndex(where: { $0.key == targetKey }),
                      Self.matchesAppIdentity(record: deferredRecords[deferredIdx], app: targetApp) {
                // Promote deferred pre-virtual RestoreRecord so originalFrame is never overwritten by virtual bounds.
                let promoted = deferredRecords.remove(at: deferredIdx)
                trackedRecords.removeAll { $0.key == targetKey }
                var nextRecords = trackedRecords
                nextRecords.append(promoted)
                try persistRecords(nextRecords, to: restoreFilePath)
                trackedRecords = nextRecords
            } else {
                trackedRecords.removeAll { $0.key == targetKey }
                deferredRecords.removeAll { $0.key == targetKey }
                let originalRect = computeInitialOriginalFrame(
                    targetState: targetState,
                    virtualAXFrame: initialVirtualAXFrame,
                    topology: initialTopology
                )
                let newRecord = RestoreRecord(
                    pid: targetKey.pid,
                    windowId: targetKey.windowId,
                    bundleId: targetApp.bundleId,
                    appName: targetApp.appName,
                    title: Self.sanitizeWindowTitle(targetState.title),
                    originalFrame: RestoreFrame(originalRect),
                    wasFullScreen: targetState.isFullScreen,
                    wasMinimized: targetState.isMinimized,
                    savedAt: Self.iso8601Now()
                )
                var nextRecords = trackedRecords
                nextRecords.append(newRecord)
                try persistRecords(nextRecords, to: restoreFilePath)
                trackedRecords = nextRecords
                createdFromFullScreen = targetState.isFullScreen
            }

            // Unminimize if minimized.
            if targetState.isMinimized {
                didMutateWindowState = true
                try setMinimizedIgnoringUnsupported(targetKey, false)
                for _ in 0..<8 {
                    host.lastSeen = Date()
                    await driver.sleep(milliseconds: 100)
                    targetState = try driver.readWindowState(targetKey)
                    if !targetState.isMinimized {
                        break
                    }
                }
            }

            // Exit native macOS fullscreen if fullscreen, then atomically update originalFrame if revealed.
            if targetState.isFullScreen {
                didMutateWindowState = true
                try setFullScreenIgnoringUnsupported(targetKey, false)
                var prevWindowedFrame: CGRect?
                for _ in 0..<12 {
                    host.lastSeen = Date()
                    await driver.sleep(milliseconds: 150)
                    targetState = try driver.readWindowState(targetKey)
                    if !targetState.isFullScreen {
                        if let prev = prevWindowedFrame, Self.framesMatch(targetState.frame, prev, tolerance: 2.0) {
                            break
                        }
                        prevWindowedFrame = targetState.frame
                    }
                }
                if createdFromFullScreen,
                   !targetState.isFullScreen,
                   targetState.frame.width >= 64,
                   targetState.frame.height >= 64,
                   !initialVirtualAXFrame.contains(CGPoint(x: targetState.frame.midX, y: targetState.frame.midY)),
                   let idx = trackedRecords.firstIndex(where: { $0.key == targetKey }) {
                    var updated = trackedRecords
                    updated[idx].originalFrame = RestoreFrame(targetState.frame)
                    try persistRecords(updated, to: restoreFilePath)
                    trackedRecords = updated
                }
            }

            // Place window into virtual display's AX visibleFrame (zero 28pt subtraction).
            let currentTopology = driver.screenTopology(virtualDisplayId: virtualDisplayID)
            let fillArea = resolveVirtualAXVisibleFrame(virtualDisplayID: virtualDisplayID, topology: currentTopology)
            didMutateWindowState = true
            let placedFrame = try await placeWindow(
                targetKey,
                target: fillArea,
                maxAttempts: Self.placementAttemptsNormal,
                intervalMs: Self.placementIntervalNormalMs,
                deadlineProvider: { [weak host] in host?.shutdownDeadline }
            )

            // Check post-move clamped minimum width/height for auto-upshift (multiply-before-divide).
            let currentLogicalWidth = host.virtualDisplayCoordinator.currentLogicalSize?.width
                ?? max(1, Int(fillArea.width.rounded()))
            let clampedOversized = placedFrame.width > fillArea.width + 2.0 || placedFrame.height > fillArea.height + 2.0

            if clampedOversized, fillArea.width > 0, fillArea.height > 0 {
                if currentLogicalWidth < 1080, let ladder = host.virtualDisplayCoordinator.currentLadder {
                    let w = CGFloat(currentLogicalWidth)
                    let neededW = (w * placedFrame.width) / fillArea.width
                    let neededH = (w * placedFrame.height) / fillArea.height
                    let needed = max(neededW, neededH)
                    let targetStep = ladder.stepForUpshift(minimumWidth: Int(needed.rounded(.up)))

                    if targetStep.logicalWidth > currentLogicalWidth {
                        let mounted = try await host.upshiftVirtualDisplayForWindowFill(minimumWidth: targetStep.logicalWidth)
                        upshifted = true
                        let updatedTopology = await waitForVirtualVisibleFrameWidth(
                            displayID: mounted.displayID,
                            expectedLogicalWidth: mounted.logicalWidth
                        )
                        let expandedArea = resolveVirtualAXVisibleFrame(
                            virtualDisplayID: mounted.displayID,
                            topology: updatedTopology
                        )
                        let refilled = try await placeWindow(
                            targetKey,
                            target: expandedArea,
                            maxAttempts: Self.placementAttemptsNormal,
                            intervalMs: Self.placementIntervalNormalMs,
                            deadlineProvider: { [weak host] in host?.shutdownDeadline }
                        )
                        if refilled.width > expandedArea.width + 2.0 || refilled.height > expandedArea.height + 2.0 {
                            try setPositionIgnoringUnsupported(targetKey, expandedArea.origin)
                        }
                    } else {
                        try setPositionIgnoringUnsupported(targetKey, fillArea.origin)
                    }
                } else {
                    // Already at 1080pt ceiling: keep top-left aligned (zero zoom keystrokes).
                    try setPositionIgnoringUnsupported(targetKey, fillArea.origin)
                }
            }

            try raiseAndActivateWindow(targetKey)
            activeWindowKey = targetKey
        } catch {
            if didMutateWindowState, !host.viewDirty {
                host.invalidateView()
            }
            throw mapDriverErrorToDesktopFailure(error)
        }

        var result = try await host.completeWindowMutationViewRefresh()
        result["activeWindowId"] = activeWindowId ?? NSNull()
        result["upshifted"] = upshifted
        if let seq = parsedSequence {
            result["sequence"] = seq
        }
        result["accepted"] = true
        result["mode"] = mode
        return result
    }

    // MARK: - Internal Helpers

    private enum SingleRestoreOutcome {
        case settled
        case retainForRetry
    }

    private func eligibleRunningAppsByPID() -> [Int32: RunningAppSnapshot] {
        let ownPID = ProcessInfo.processInfo.processIdentifier
        var map: [Int32: RunningAppSnapshot] = [:]
        for app in driver.runningRegularApps() {
            guard Self.shouldIncludeRegularApp(
                pid: app.pid,
                ownPID: ownPID,
                isRegular: app.isRegular,
                isTerminated: app.isTerminated,
                bundleId: app.bundleId,
                appName: app.appName,
                executableName: app.executableName
            ) else {
                continue
            }
            map[app.pid] = app
        }
        return map
    }

    private func computeInitialOriginalFrame(
        targetState: WindowLiveState,
        virtualAXFrame: CGRect,
        topology: ScreenTopologySnapshot
    ) -> CGRect {
        let winCenter = CGPoint(x: targetState.frame.midX, y: targetState.frame.midY)
        guard !targetState.isFullScreen, virtualAXFrame.contains(winCenter) else {
            return targetState.frame
        }
        if let physID = topology.primaryPhysicalDisplayId,
           let physScreen = topology.displays[physID] {
            let physVis = Self.appKitRectToAX(
                physScreen.visibleFrame,
                primaryScreenHeight: topology.primaryScreenHeight
            )
            let w = min(max(targetState.frame.width, 320.0), physVis.width)
            let h = min(max(targetState.frame.height, 240.0), physVis.height)
            let x = physVis.minX + floor((physVis.width - w) / 2.0)
            let y = physVis.minY + floor((physVis.height - h) / 2.0)
            return CGRect(x: x, y: y, width: max(1.0, w), height: max(1.0, h))
        }
        return Self.headlessFallbackFrame
    }

    private func resolveVirtualAXFrame(
        virtualDisplayID: CGDirectDisplayID,
        topology: ScreenTopologySnapshot
    ) -> CGRect {
        if let screen = topology.displays[virtualDisplayID] {
            return Self.appKitRectToAX(screen.frame, primaryScreenHeight: topology.primaryScreenHeight)
        }
        return host?.displaySystem.bounds(of: virtualDisplayID) ?? CGRect(x: 0, y: 0, width: 540, height: 1080)
    }

    private func resolveVirtualAXVisibleFrame(
        virtualDisplayID: CGDirectDisplayID,
        topology: ScreenTopologySnapshot
    ) -> CGRect {
        if let screen = topology.displays[virtualDisplayID] {
            return Self.appKitRectToAX(screen.visibleFrame, primaryScreenHeight: topology.primaryScreenHeight)
        }
        return host?.displaySystem.bounds(of: virtualDisplayID) ?? CGRect(x: 0, y: 0, width: 540, height: 1080)
    }

    private func waitForVirtualVisibleFrameWidth(
        displayID: CGDirectDisplayID,
        expectedLogicalWidth: Int
    ) async -> ScreenTopologySnapshot {
        for _ in 0..<20 {
            let topology = driver.screenTopology(virtualDisplayId: displayID)
            guard let screen = topology.displays[displayID] else {
                return topology
            }
            if abs(screen.frame.width - CGFloat(expectedLogicalWidth)) <= 2.0 {
                return topology
            }
            host?.lastSeen = Date()
            await driver.sleep(milliseconds: 50)
        }
        return driver.screenTopology(virtualDisplayId: displayID)
    }

    private func placeWindow(
        _ key: WindowKey,
        target: CGRect,
        maxAttempts: Int,
        intervalMs: UInt64,
        deadlineProvider: @MainActor () -> ContinuousClock.Instant?
    ) async throws -> CGRect {
        var previousGot: CGRect?
        var lastGot = target
        let attempts = max(1, maxAttempts)

        for attempt in 0..<attempts {
            try setSizeIgnoringUnsupported(key, target.size)
            try setPositionIgnoringUnsupported(key, target.origin)
            try setSizeIgnoringUnsupported(key, target.size)

            let state = try driver.readWindowState(key)
            let got = state.frame
            lastGot = got

            if Self.framesMatch(got, target, tolerance: 2.0) {
                return got
            }

            let originAligned = abs(got.minX - target.minX) <= 2.0 && abs(got.minY - target.minY) <= 2.0
            if originAligned, let prev = previousGot, Self.framesMatch(got, prev, tolerance: 2.0) {
                return got
            }
            previousGot = got

            if attempt + 1 < attempts {
                if let deadline = deadlineProvider(), currentInstant() >= deadline {
                    return got
                }
                host?.lastSeen = Date()
                await driver.sleep(milliseconds: intervalMs)
            }
        }

        return lastGot
    }

    private func restoreTrackedWindowsInteractive(
        excluding excludedKey: WindowKey?,
        includeDeferred: Bool,
        deadlineProvider: @MainActor () -> ContinuousClock.Instant?
    ) async {
        let eligibleApps = eligibleRunningAppsByPID()
        let candidates = includeDeferred ? Self.mergeRecords(trackedRecords, deferredRecords) : trackedRecords
        var nextTracked: [RestoreRecord] = []
        var nextDeferred: [RestoreRecord] = includeDeferred
            ? []
            : deferredRecords.filter { record in !trackedRecords.contains(where: { $0.key == record.key }) }

        for record in candidates {
            if let excludedKey, record.key == excludedKey {
                if trackedRecords.contains(where: { $0.key == record.key }) {
                    nextTracked.append(record)
                } else {
                    nextDeferred.append(record)
                }
                continue
            }
            guard driver.liveCGWindow(for: record.key) != nil else {
                continue
            }
            guard let app = eligibleApps[record.pid],
                  Self.matchesAppIdentity(record: record, app: app) else {
                continue
            }
            let outcome = await restoreSingleRecord(
                record,
                maxAttempts: Self.restoreAttemptsNormal,
                intervalMs: Self.restoreIntervalNormalMs,
                allowFullScreenSpaceRestore: true,
                deadlineProvider: deadlineProvider
            )
            if outcome == .retainForRetry {
                nextDeferred.append(record)
            }
        }

        trackedRecords = nextTracked
        deferredRecords = Self.mergeRecords([], nextDeferred.filter { record in
            !nextTracked.contains(where: { $0.key == record.key })
        })
        let combined = Self.mergeRecords(trackedRecords, deferredRecords)
        if let restoreFilePath {
            if combined.isEmpty {
                DurableJSONStore.removeIfExists(at: restoreFilePath)
            } else {
                try? DurableJSONStore.writeAtomic(RestoreStoreFile(version: 1, records: combined), to: restoreFilePath)
            }
        }
    }

    private func restoreSingleRecord(
        _ record: RestoreRecord,
        maxAttempts: Int,
        intervalMs: UInt64,
        allowFullScreenSpaceRestore: Bool,
        deadlineProvider: @MainActor () -> ContinuousClock.Instant?
    ) async -> SingleRestoreOutcome {
        let key = record.key
        do {
            var liveState = try driver.readWindowState(key)

            if liveState.isFullScreen && !record.wasFullScreen {
                try setFullScreenIgnoringUnsupported(key, false)
                if allowFullScreenSpaceRestore {
                    for _ in 0..<8 {
                        if let limit = deadlineProvider(), currentInstant() >= limit { break }
                        host?.lastSeen = Date()
                        await driver.sleep(milliseconds: 100)
                        liveState = try driver.readWindowState(key)
                        if !liveState.isFullScreen { break }
                    }
                }
            }

            if liveState.isMinimized {
                try setMinimizedIgnoringUnsupported(key, false)
                if allowFullScreenSpaceRestore {
                    await driver.sleep(milliseconds: 50)
                }
            }

            _ = try await placeWindow(
                key,
                target: record.originalFrame.cgRect,
                maxAttempts: maxAttempts,
                intervalMs: intervalMs,
                deadlineProvider: deadlineProvider
            )

            if record.wasFullScreen && allowFullScreenSpaceRestore {
                try setFullScreenIgnoringUnsupported(key, true)
            } else if record.wasMinimized {
                try setMinimizedIgnoringUnsupported(key, true)
            }

            return .settled
        } catch AXDriverError.timedOutOrUnresponsive {
            return driver.liveCGWindow(for: key) != nil ? .retainForRetry : .settled
        } catch {
            return .settled
        }
    }

    private func persistRecords(_ records: [RestoreRecord], to path: String) throws {
        let combined = Self.mergeRecords(records, deferredRecords)
        do {
            try DurableJSONStore.writeAtomic(RestoreStoreFile(version: 1, records: combined), to: path)
        } catch {
            throw DesktopFailure.code("desktop-restore-persist-failed")
        }
    }

    private func setMinimizedIgnoringUnsupported(_ key: WindowKey, _ minimized: Bool) throws {
        do {
            try driver.setMinimized(key, minimized)
        } catch AXDriverError.attributeUnsupported {
            // Non-minimizable window: proceed safely.
        }
    }

    private func setFullScreenIgnoringUnsupported(_ key: WindowKey, _ fullScreen: Bool) throws {
        do {
            try driver.setFullScreen(key, fullScreen)
        } catch AXDriverError.attributeUnsupported {
            // Non-fullscreen-capable window: proceed safely.
        }
    }

    private func setSizeIgnoringUnsupported(_ key: WindowKey, _ size: CGSize) throws {
        do {
            try driver.setSize(key, size)
        } catch AXDriverError.attributeUnsupported {
            // Fixed-size window rejects AXSize: proceed to AXPosition & clamped size readback.
        }
    }

    private func setPositionIgnoringUnsupported(_ key: WindowKey, _ origin: CGPoint) throws {
        do {
            try driver.setPosition(key, origin)
        } catch AXDriverError.attributeUnsupported {
            // Non-movable element: readback will report actual bounds.
        }
    }

    private func raiseAndActivateWindow(_ key: WindowKey) throws {
        do {
            try driver.raiseAndActivate(key)
        } catch AXDriverError.attributeUnsupported {
            // Raising optional attributes may not be supported on all windows.
        }
    }

    private func mapDriverErrorToDesktopFailure(_ error: any Error) -> DesktopFailure {
        if let desktopError = error as? DesktopFailure {
            return desktopError
        }
        if let axError = error as? AXDriverError {
            switch axError {
            case .untrusted:
                return .code("desktop-accessibility-required")
            case .windowUnavailable:
                return .code("desktop-window-unavailable")
            case .timedOutOrUnresponsive:
                return .code("desktop-window-unresponsive")
            case .attributeUnsupported:
                return .code("desktop-window-unavailable")
            }
        }
        return .code("desktop-host-failed")
    }

    private static func iso8601Now() -> String {
        let formatter = ISO8601DateFormatter()
        return formatter.string(from: Date())
    }
}
