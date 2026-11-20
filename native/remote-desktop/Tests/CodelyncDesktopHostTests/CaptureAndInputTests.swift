import CoreGraphics
import Foundation
import XCTest
@testable import CodelyncDesktopHostCore

final class CaptureAndInputTests: XCTestCase {
    func testLongEdgeCaptureDimensionsAcrossLandscapePortraitSquareSmallAndOddSizes() throws {
        // Landscape 3000x2000
        XCTAssertEqual(
            DesktopCaptureMath.captureDimensions(nativeWidth: 3000, nativeHeight: 2000, maxLongEdge: 2560).width, 2560
        )
        XCTAssertEqual(
            DesktopCaptureMath.captureDimensions(nativeWidth: 3000, nativeHeight: 2000, maxLongEdge: 1920).width, 1920
        )
        XCTAssertEqual(
            DesktopCaptureMath.captureDimensions(nativeWidth: 3000, nativeHeight: 2000, maxLongEdge: 1920).height, 1280
        )
        XCTAssertEqual(
            DesktopCaptureMath.captureDimensions(nativeWidth: 3000, nativeHeight: 2000, maxLongEdge: 1280).width, 1280
        )

        // Portrait 2x Phone Screen (540x1080pt -> 1080x2160px)
        let p2560 = DesktopCaptureMath.captureDimensions(nativeWidth: 1080, nativeHeight: 2160, maxLongEdge: 2560)
        XCTAssertEqual(p2560.width, 1080)
        XCTAssertEqual(p2560.height, 2160) // Never upscales when 2160 <= 2560

        let p1920 = DesktopCaptureMath.captureDimensions(nativeWidth: 1080, nativeHeight: 2160, maxLongEdge: 1920)
        XCTAssertEqual(p1920.width, 960)
        XCTAssertEqual(p1920.height, 1920)

        let p1280 = DesktopCaptureMath.captureDimensions(nativeWidth: 1080, nativeHeight: 2160, maxLongEdge: 1280)
        XCTAssertEqual(p1280.width, 640)
        XCTAssertEqual(p1280.height, 1280)

        // Portrait Tall 2x (540x1170pt -> 1080x2340px)
        let tall2560 = DesktopCaptureMath.captureDimensions(nativeWidth: 1080, nativeHeight: 2340, maxLongEdge: 2560)
        XCTAssertEqual(tall2560.width, 1080)
        XCTAssertEqual(tall2560.height, 2340)
        let tall1920 = DesktopCaptureMath.captureDimensions(nativeWidth: 1080, nativeHeight: 2340, maxLongEdge: 1920)
        XCTAssertEqual(tall1920.width, 886)
        XCTAssertEqual(tall1920.height, 1920)
        let tall1280 = DesktopCaptureMath.captureDimensions(nativeWidth: 1080, nativeHeight: 2340, maxLongEdge: 1280)
        XCTAssertEqual(tall1280.width, 590)
        XCTAssertEqual(tall1280.height, 1280)

        // Max Upshifted Portrait (1080x2700pt -> 2160x5400px)
        let max2560 = DesktopCaptureMath.captureDimensions(nativeWidth: 2160, nativeHeight: 5400, maxLongEdge: 2560)
        XCTAssertEqual(max2560.width, 1024)
        XCTAssertEqual(max2560.height, 2560)
        let max1920 = DesktopCaptureMath.captureDimensions(nativeWidth: 2160, nativeHeight: 5400, maxLongEdge: 1920)
        XCTAssertEqual(max1920.width, 768)
        XCTAssertEqual(max1920.height, 1920)
        let max1280 = DesktopCaptureMath.captureDimensions(nativeWidth: 2160, nativeHeight: 5400, maxLongEdge: 1280)
        XCTAssertEqual(max1280.width, 512)
        XCTAssertEqual(max1280.height, 1280)

        // Square, small, and odd dimensions across all 3 tiers
        let matrix: [(Int, Int)] = [(2000, 2000), (800, 600), (640, 960), (1081, 2161), (1, 1)]
        for (nw, nh) in matrix {
            for tier in [1280, 1920, 2560] {
                let (w, h) = DesktopCaptureMath.captureDimensions(nativeWidth: nw, nativeHeight: nh, maxLongEdge: tier)
                XCTAssertEqual(w % 2, 0)
                XCTAssertEqual(h % 2, 0)
                XCTAssertGreaterThanOrEqual(w, 2)
                XCTAssertGreaterThanOrEqual(h, 2)
                XCTAssertLessThanOrEqual(max(w, h), max(2, tier))
                XCTAssertLessThanOrEqual(w, max(2, (max(2, nw) / 2) * 2))
                XCTAssertLessThanOrEqual(h, max(2, (max(2, nh) / 2) * 2))
            }
        }

        // Quality bitrate & strict JSON checks
        let qLow = try Quality(["width": 1280, "fps": 15])
        XCTAssertEqual(qLow.bitrate, 1_920_000)
        let qHigh = try Quality(["width": 2560, "fps": 60])
        XCTAssertEqual(qHigh.bitrate, 12_000_000)

        let boolQuality = try JSONSerialization.jsonObject(
            with: Data(#"{"width":true,"fps":30}"#.utf8)
        ) as! [String: Any]
        XCTAssertThrowsError(try Quality(boolQuality)) { error in
            XCTAssertEqual(error as? DesktopFailure, .code("invalid-desktop-quality"))
        }
    }

    @MainActor
    func testScrollCoordinateAnchorAndEndToEndPortraitClarityAndInputValidation() async throws {
        let displaySystem = MockDisplaySystemImpl()
        let permissions = MockPermissionProviderImpl()
        let inputSink = MockInputSinkImpl()
        let captureFactory = MockCaptureFactoryImpl()
        let roomFactory = MockMediaRoomFactoryImpl()
        var emitted: [[String: Any]] = []

        let provider = MockVirtualDisplayProviderImpl(isSupported: true) { _, _, _, _ in
            let id: CGDirectDisplayID = 9_001
            displaySystem.entries[id] = .init(
                bounds: CGRect(x: 1920, y: 100, width: 540, height: 1080),
                pixels: (1080, 2160),
                vendorID: 0x434C,
                modelID: 0x00F0,
                active: true,
                online: true,
                shareable: true
            )
            let handle = MockVirtualDisplayHandle(displayID: id)
            handle.onDestroy = { displaySystem.entries.removeValue(forKey: id) }
            return handle
        }
        var fakeNow = ContinuousClock.now
        let protectorEnv = PhysicalDisplayEnvironment(
            onlineDisplayIDs: { Array(displaySystem.entries.keys) },
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
            switchMode: { _, _, _ in true },
            waitForModeConvergence: { _, _, _ in true },
            onlinePollTimeout: .milliseconds(50),
            onlinePollInterval: .milliseconds(10),
            onlineSettleDelay: .zero
        )
        let coordinator = VirtualDisplayCoordinator(provider: provider, protector: protector, environment: coordEnv)

        let host = DesktopHost(
            stateDir: nil,
            displaySystem: displaySystem,
            permissionProvider: permissions,
            inputSink: inputSink,
            captureFactory: captureFactory,
            roomFactory: roomFactory,
            virtualDisplayCoordinator: coordinator,
            windowCoordinator: nil,
            observeWorkspaceSpaces: false,
            outputEmitter: { emitted.append($0) }
        )

        // Start on portrait virtual display (1080x2160 px) at tier 2560 -> capture 1080x2160
        await host.handle([
            "id": "s1",
            "operation": "start",
            "displayId": "virtual",
            "url": "ws://127.0.0.1:7880",
            "token": "tok",
            "key": String(repeating: "k", count: 32),
            "connectionId": "conn-scroll",
            "viewer": "viewer-s",
            "quality": ["width": 2560, "fps": 30]
        ])
        XCTAssertEqual(captureFactory.records.last?.width, 1080)
        XCTAssertEqual(captureFactory.records.last?.height, 2160)

        // Switch quality to 1920 -> capture 960x1920; switch to 1280 -> capture 640x1280
        await host.handle([
            "id": "q1920", "operation": "quality", "connectionId": "conn-scroll",
            "geometry": host.geometry, "quality": ["width": 1920, "fps": 30]
        ])
        XCTAssertEqual(captureFactory.records.last?.width, 960)
        XCTAssertEqual(captureFactory.records.last?.height, 1920)

        await host.handle([
            "id": "q1280", "operation": "quality", "connectionId": "conn-scroll",
            "geometry": host.geometry, "quality": ["width": 1280, "fps": 30]
        ])
        XCTAssertEqual(captureFactory.records.last?.width, 640)
        XCTAssertEqual(captureFactory.records.last?.height, 1280)

        // Set initial pointer location to (2000, 300) via pointer move
        host.location = CGPoint(x: 2000, y: 300)

        // 1. Legacy scroll without (x, y) preserves host.location
        await host.handle([
            "id": "in-1", "operation": "input", "connectionId": "conn-scroll",
            "geometry": host.geometry, "sequence": 1,
            "action": "scroll", "deltaY": -120
        ])
        XCTAssertEqual(emitted.last?["ok"] as? Bool, true)
        XCTAssertEqual(inputSink.scrollEvents.last, .init(deltaY: -120, location: CGPoint(x: 2000, y: 300)))

        // 2. Scroll with normalized (x: 0.25, y: 0.75) on bounds (1920, 100, 540, 1080) updates host.location first!
        await host.handle([
            "id": "in-2", "operation": "input", "connectionId": "conn-scroll",
            "geometry": host.geometry, "sequence": 2,
            "action": "scroll", "deltaY": -240, "x": 0.25, "y": 0.75
        ])
        let expectedPoint = CGPoint(x: 1920.0 + 0.25 * 539.0, y: 100.0 + 0.75 * 1079.0)
        XCTAssertEqual(emitted.last?["ok"] as? Bool, true)
        XCTAssertEqual(host.location.x, expectedPoint.x, accuracy: 1e-6)
        XCTAssertEqual(host.location.y, expectedPoint.y, accuracy: 1e-6)
        XCTAssertEqual(inputSink.scrollEvents.last?.deltaY, -240)
        XCTAssertEqual(inputSink.scrollEvents.last!.location.x, expectedPoint.x, accuracy: 1e-6)
        XCTAssertEqual(inputSink.scrollEvents.last!.location.y, expectedPoint.y, accuracy: 1e-6)

        // 3. Invalid scroll packets must throw invalid-desktop-input WITHOUT mutating host.location!
        let savedLocation = host.location
        let boolScrollJSON = try JSONSerialization.jsonObject(
            with: Data(#"{"action":"scroll","deltaY":-60,"x":true,"y":0.5}"#.utf8)
        ) as! [String: Any]

        let invalidInputs: [[String: Any]] = [
            ["action": "scroll", "deltaY": -60, "x": 0.5],               // x without y
            ["action": "scroll", "deltaY": -60, "y": 0.5],               // y without x
            boolScrollJSON,                                              // CFBoolean x: true
            ["action": "scroll", "deltaY": -60, "x": -0.01, "y": 0.5],   // < 0
            ["action": "scroll", "deltaY": -60, "x": 0.5, "y": 1.01],    // > 1
            ["action": "scroll", "deltaY": -60, "x": Double.nan, "y": 0],
            ["action": "scroll", "deltaY": -60, "x": NSNull(), "y": NSNull()],
            ["action": "scroll", "deltaY": 1500, "x": 0.5, "y": 0.5]     // out-of-range deltaY
        ]

        var seq = 3
        for var bad in invalidInputs {
            bad["id"] = "bad-\(seq)"
            bad["operation"] = "input"
            bad["connectionId"] = "conn-scroll"
            bad["geometry"] = host.geometry
            bad["sequence"] = seq
            seq += 1
            await host.handle(bad)
            XCTAssertEqual(emitted.last?["ok"] as? Bool, false)
            XCTAssertEqual(emitted.last?["error"] as? String, "invalid-desktop-input")
            XCTAssertEqual(host.location, savedLocation)
        }

        await host.stop()
    }

    func testDesktopLineFramerOversizedDiscardCRLFAndFlush() {
        var framer = DesktopLineFramer(maxLineBytes: 16_384)
        let big = Data(repeating: 65, count: 20_000) + Data([10]) + Data(#"{"operation":"status"}"#.utf8) + Data([10])
        let out1 = framer.append(big)
        XCTAssertEqual(out1.count, 1)
        XCTAssertEqual(String(decoding: out1[0], as: UTF8.self), #"{"operation":"status"}"#)

        let chunkA = Data(repeating: 66, count: 12_000)
        let chunkB = Data(repeating: 67, count: 8_000) + Data([13, 10]) + Data(#"{"operation":"stop"}"#.utf8) + Data([13, 10])
        XCTAssertTrue(framer.append(chunkA).isEmpty)
        let out2 = framer.append(chunkB)
        XCTAssertEqual(out2.count, 1)
        XCTAssertEqual(String(decoding: out2[0], as: UTF8.self), #"{"operation":"stop"}"#)

        XCTAssertEqual(framer.append(Data(repeating: 68, count: 16_384) + Data([10])).count, 1)
        XCTAssertTrue(framer.append(Data(#"{"id":"tail"}"#.utf8)).isEmpty)
        let tail = framer.flush()
        XCTAssertNotNil(tail)
        XCTAssertEqual(String(decoding: tail!, as: UTF8.self), #"{"id":"tail"}"#)
    }
}
