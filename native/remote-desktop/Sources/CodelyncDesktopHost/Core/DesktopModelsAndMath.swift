import CoreFoundation
import CoreGraphics
import Foundation
import CGVirtualDisplayRuntime

public enum DesktopFailure: Error, Equatable, Sendable {
    case code(String)
}

enum DesktopJSON {
    static func strictInt(_ raw: Any?) -> Int? {
        guard let number = raw as? NSNumber else { return nil }
        if CFGetTypeID(number) == CFBooleanGetTypeID() { return nil }
        let d = number.doubleValue
        guard d.isFinite, d.rounded(.towardZero) == d, abs(d) <= 9_007_199_254_740_991.0 else {
            return nil
        }
        let i = number.int64Value
        guard Double(i) == d, let exact = Int(exactly: i) else { return nil }
        return exact
    }

    static func strictDouble(_ raw: Any?) -> Double? {
        guard let number = raw as? NSNumber else { return nil }
        if CFGetTypeID(number) == CFBooleanGetTypeID() { return nil }
        let d = number.doubleValue
        return d.isFinite ? d : nil
    }
}

struct Quality: Equatable, Sendable {
    let width: Int
    let fps: Int

    init(_ value: [String: Any]) throws {
        guard let width = DesktopJSON.strictInt(value["width"]), [1280, 1920, 2560].contains(width),
              let fps = DesktopJSON.strictInt(value["fps"]), [15, 30, 60].contains(fps) else {
            throw DesktopFailure.code("invalid-desktop-quality")
        }
        self.width = width
        self.fps = fps
    }

    init(width: Int, fps: Int) throws {
        guard [1280, 1920, 2560].contains(width), [15, 30, 60].contains(fps) else {
            throw DesktopFailure.code("invalid-desktop-quality")
        }
        self.width = width
        self.fps = fps
    }

    var json: [String: Any] { ["width": width, "fps": fps] }
    var bitrate: Int { min(12_000_000, max(1_000_000, width * fps * 100)) }
}

struct DesktopViewport: Equatable, Sendable {
    static let defaultPortrait = DesktopViewport(width: 540, height: 1080)

    let width: Int
    let height: Int

    var clampedRatio: Double {
        min(2.5, max(1.0, Double(height) / Double(width)))
    }

    static func resolve(from payload: [String: Any], isVirtual: Bool) throws -> DesktopViewport? {
        guard let raw = payload["viewport"] else {
            return isVirtual ? .defaultPortrait : nil
        }
        guard let dict = raw as? [String: Any],
              dict.count == 2,
              let width = DesktopJSON.strictInt(dict["width"]),
              let height = DesktopJSON.strictInt(dict["height"]),
              (100...10_000).contains(width),
              (100...10_000).contains(height),
              height >= width else {
            throw DesktopFailure.code("invalid-desktop-viewport")
        }
        return DesktopViewport(width: width, height: height)
    }
}

struct PortraitModeStep: Equatable, Sendable {
    let logicalWidth: Int
    let logicalHeight: Int

    var pixelWidth: Int { logicalWidth * 2 }
    var pixelHeight: Int { logicalHeight * 2 }

    var modeSpec: CLVirtualDisplayModeSpec {
        CLVirtualDisplayModeSpec(
            width: UInt32(logicalWidth),
            height: UInt32(logicalHeight),
            refreshRate: VirtualDisplayHardwareSpec.refreshRate
        )
    }
}

struct PortraitModeLadder: Equatable, Sendable {
    let clampedRatio: Double
    let baseWidth: Int
    let baseHeight: Int
    let steps: [PortraitModeStep]

    init(viewport: DesktopViewport) {
        self.init(rawRatio: Double(viewport.height) / Double(viewport.width))
    }

    init(rawRatio: Double) {
        let safeRatio = rawRatio.isFinite ? min(2.5, max(1.0, rawRatio)) : 2.0
        let selectedBaseWidth = stride(from: 540, through: 1080, by: 10).first { candidate in
            Int((Double(candidate) * safeRatio).rounded()) >= 800
        } ?? 1080
        let builtSteps = stride(from: selectedBaseWidth, through: 1080, by: 10).map { width in
            PortraitModeStep(
                logicalWidth: width,
                logicalHeight: Int((Double(width) * safeRatio).rounded())
            )
        }
        self.clampedRatio = safeRatio
        self.baseWidth = selectedBaseWidth
        self.baseHeight = builtSteps[0].logicalHeight
        self.steps = builtSteps
    }

    var modeSpecs: [CLVirtualDisplayModeSpec] {
        steps.map(\.modeSpec)
    }

    var ladderWidths: [Int] {
        steps.map(\.logicalWidth)
    }

    func stepForUpshift(minimumWidth: Int) -> PortraitModeStep {
        let clamped = min(1080, max(baseWidth, minimumWidth))
        return steps.first { $0.logicalWidth >= clamped } ?? steps[steps.count - 1]
    }
}

enum DesktopCaptureMath {
    static func captureDimensions(nativeWidth: Int, nativeHeight: Int, maxLongEdge: Int) -> (width: Int, height: Int) {
        let safeW = max(2, nativeWidth)
        let safeH = max(2, nativeHeight)
        let evenNativeW = max(2, (safeW / 2) * 2)
        let evenNativeH = max(2, (safeH / 2) * 2)
        let longEdge = max(safeW, safeH)
        guard longEdge > maxLongEdge else {
            return (evenNativeW, evenNativeH)
        }
        if safeW >= safeH {
            let targetW = max(2, (min(safeW, maxLongEdge) / 2) * 2)
            let rawH = Int((Double(safeH) * Double(targetW)) / Double(safeW))
            let targetH = max(2, min(evenNativeH, (rawH / 2) * 2))
            return (targetW, targetH)
        } else {
            let targetH = max(2, (min(safeH, maxLongEdge) / 2) * 2)
            let rawW = Int((Double(safeW) * Double(targetH)) / Double(safeH))
            let targetW = max(2, min(evenNativeW, (rawW / 2) * 2))
            return (targetW, targetH)
        }
    }
}

struct ValidatedScroll: Equatable, Sendable {
    let deltaY: Int32
    let updatedLocation: CGPoint?
}

struct ValidatedPointer: Equatable, Sendable {
    let phase: String
    let button: CGMouseButton
    let location: CGPoint
}

enum DesktopInputMath {
    static func resolveScroll(_ value: [String: Any], displayBounds: CGRect?) throws -> ValidatedScroll {
        guard let delta = DesktopJSON.strictInt(value["deltaY"]),
              (-1200...1200).contains(delta) else {
            throw DesktopFailure.code("invalid-desktop-input")
        }
        let hasX = value["x"] != nil
        let hasY = value["y"] != nil
        guard hasX == hasY else {
            throw DesktopFailure.code("invalid-desktop-input")
        }
        if !hasX {
            return ValidatedScroll(deltaY: Int32(delta), updatedLocation: nil)
        }
        guard let x = DesktopJSON.strictDouble(value["x"]),
              let y = DesktopJSON.strictDouble(value["y"]),
              (0.0...1.0).contains(x),
              (0.0...1.0).contains(y),
              let bounds = displayBounds else {
            throw DesktopFailure.code("invalid-desktop-input")
        }
        let point = CGPoint(
            x: bounds.minX + x * max(0.0, bounds.width - 1.0),
            y: bounds.minY + y * max(0.0, bounds.height - 1.0)
        )
        return ValidatedScroll(deltaY: Int32(delta), updatedLocation: point)
    }

    static func resolvePointer(_ value: [String: Any], displayBounds: CGRect?) throws -> ValidatedPointer {
        guard let bounds = displayBounds,
              let x = DesktopJSON.strictDouble(value["x"]),
              let y = DesktopJSON.strictDouble(value["y"]),
              (0.0...1.0).contains(x),
              (0.0...1.0).contains(y),
              let phase = value["phase"] as? String,
              ["move", "down", "up", "click"].contains(phase) else {
            throw DesktopFailure.code("invalid-desktop-input")
        }
        let button: CGMouseButton = value["button"] as? String == "right" ? .right : .left
        let location = CGPoint(
            x: bounds.minX + x * max(0.0, bounds.width - 1.0),
            y: bounds.minY + y * max(0.0, bounds.height - 1.0)
        )
        return ValidatedPointer(phase: phase, button: button, location: location)
    }
}

struct DesktopLineFramer {
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
