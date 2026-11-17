// swift-tools-version:6.1
import PackageDescription

let package = Package(
    name: "CodelyncDesktopHost",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "CodelyncDesktopHost", targets: ["CodelyncDesktopHost"])],
    dependencies: [.package(url: "https://github.com/livekit/client-sdk-swift.git", exact: "2.19.0")],
    targets: [.executableTarget(name: "CodelyncDesktopHost", dependencies: [.product(name: "LiveKit", package: "client-sdk-swift")])]
)
