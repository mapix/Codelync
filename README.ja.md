# Codelync

[English](README.md) · [中文](README.zh-CN.md) · [ウェブサイト](https://codelync.novarock.io/)

Codelync は、Codex、Antigravity Desktop、Claude Desktop に Gateway を設定済みの方のための独立した iPhone コンパニオンです。Mac 版を起動し、QR コードをスキャンすると、既存のプロジェクト、セッション、利用可能なサブエージェントのログを確認できます。セッションとモデルへの要求は元のデスクトップアプリが管理し、操作は確認済みの能力に応じます。

通常のサブスクリプション利用には各社の公式アプリをおすすめします。Codelync は OpenAI、Anthropic、Google の公式製品ではありません。

## インストールと接続

Mac 版は Apple Silicon、macOS 14 以降に対応します。公開パッケージは Developer ID で署名され、Apple の公証を受けます。ウェブサイトに現在のダウンロードと TestFlight Beta の状況を表示します。個人デバイス向けの IPA やプロビジョニングプロファイルは公開配布しません。

1. 元のデスクトップアプリで Gateway を設定します。
2. Codelync の Mac 版を Applications に移動して開きます。
3. iPhone アプリで Mac の現在の QR コードをスキャンします。専用アカウントや VPN は不要です。

アプリとウェブサイトは英語、中国語、日本語に対応し、初期設定ではシステムの言語に従います。iPhone の設定やウェブサイトで言語を選ぶと、その選択を優先します。GitHub の主要な README、開発資料、リリース説明は英語です。

リモートデスクトップは iPhone で初期設定ではオフです。必要な場合は設定で有効化し、Mac 側でも有効化して画面収録とアクセシビリティを許可してください。

## 開発と安全性

[英語の README](README.md)、[ビルドと検証](docs/BUILD-AND-VERIFY.md)、[セキュリティ](SECURITY.md)、[貢献ガイド](CONTRIBUTING.md)を参照してください。ツールチェーンは Node 24.15.0 と pnpm 10.11.0 です。

MIT ライセンスで公開しています。初期のモバイル実装に由来する Happy コンポーネントとライセンスは [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) に記載しています。
