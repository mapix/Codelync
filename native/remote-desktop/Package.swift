// swift-tools-version:6.1
import PackageDescription

let package = Package(
    name: "CodelyncDesktopHost",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "CodelyncDesktopHost", targets: ["CodelyncDesktopHost"])
    ],
    dependencies: [
        .package(url: "https://github.com/livekit/client-sdk-swift.git", exact: "2.19.0")
    ],
    targets: [
        .target(
            name: "CGVirtualDisplayRuntime",
            publicHeadersPath: "include",
            linkerSettings: [
                .linkedFramework("Foundation"),
                .linkedFramework("CoreGraphics")
            ]
        ),
        .target(
            name: "CodelyncDesktopHostCore",
            dependencies: [
                "CGVirtualDisplayRuntime",
                .product(name: "LiveKit", package: "client-sdk-swift")
            ],
            path: "Sources/CodelyncDesktopHost/Core"
        ),
        .executableTarget(
            name: "CodelyncDesktopHost",
            dependencies: [
                "CodelyncDesktopHostCore"
            ],
            path: "Sources/CodelyncDesktopHost",
            exclude: ["Core"],
            sources: ["main.swift"]
        ),
        .testTarget(
            name: "CodelyncDesktopHostTests",
            dependencies: [
                "CodelyncDesktopHostCore",
                "CGVirtualDisplayRuntime"
            ]
        )
    ]
)
