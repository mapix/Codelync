# Codelync

[网站与 Mac 下载](https://codelync.novarock.io/) · [源码](https://github.com/mapix/Codelync) · [MIT 许可](LICENSE) · [English](README.md)

Codelync 面向已在 Codex、Antigravity Desktop 或 Claude Desktop 配置
Gateway 模式的用户。在 iPhone 查看已有项目、会话和可用子代理日志，按各桌面应用的
当前状态使用已确认的操作。接入一个应用不代表所有应用的控制完全相同；
Claude Desktop 的完整正式控制仍在验证。Codelync 不另起模型运行器，
不修改或重启原桌面应用。

日常官方订阅使用推荐各厂商的官方 App。手机远程桌面默认隐藏，可在设置的
功能开关中主动启用；Mac 的远控开关和系统权限仍需分别确认。

CLI 家族、其他 harness 和窗口远控均为延期研究，历史记录不因此变成受支持会话。
三桌面实现需构建当前源码。协议和实测边界见
[Antigravity 接入合同](spec/antigravity-remote-control.md)和
[Claude Desktop 接入合同](spec/claude-desktop-native.md)。

源码仓库已在 GitHub 公开。

## Gateway 发行范围

这里的 Gateway 指原桌面模型请求所用的第三方推理网关，与 Codelync 的配对、
Relay 和网络通道不同。

| 桌面 | 当前发行面向 | 原生接入条件 |
| --- | --- | --- |
| Codex | 已配置 Gateway 模式的用户 | 已运行并核验的 Desktop IPC owner 与原会话身份 |
| Antigravity Desktop | 已配置 Gateway 模式的用户 | 已运行并核验的原生 Language Server owner 与原会话身份 |
| Claude Desktop | 当前仅接受已核验的 Gateway 模式；普通官方登录／非 Gateway 模式尚未支持 | 显式安装并核验的原生 owner bridge／runtime manifest，且当前有效 Gateway 配置通过校验 |

各桌面的可用操作仍以原 owner 当前已确认的能力为准；Claude 的正式安装与
完整原生控制验收仍有待完成。

## 当前发行

- Mac 预览版：Apple Silicon、macOS 14+，Developer ID 签名、Apple 公证及
  ticket stapling。版本与 SHA-256 在下载页可核对。
- 当前公开 Mac 下载 0.6.1 包含三桌面接入，各应用仅提供已确认的原生能力。
- iPhone 客户端：目前需从源码构建并使用自己的 Apple 开发签名。
  尚无公开 App Store/TestFlight 发行，不提供带私人设备登记信息的开发 IPA。
- 安装后在手机扫描 Mac 二维码，无需另外注册 Codelync 账号或安装 VPN。
  一个二维码包含全部已启用地址。手机自动选择已验证的可用连接，也可以在
  “连接方式”面板随时手动切换，或恢复“自动”。

配对后 Mac 默认显示统计页，包含实时与累计网关流量、HTTP/RPC 交互、
在线设备和运行时长。手机项目内使用选择框切换会话，可见项目与会话接收
轻量状态；未知或断连状态保留“未确认”，不伪装为空闲。

“接入来源”可独立选择 Codex、Antigravity Desktop 和 Claude Desktop（Gateway），
默认三项全选，选择会保存。关闭来源只停止 Codelync 对该来源的发现、观察和控制，
原应用与会话继续运行。重新启用读取当前来源状态，不重放旧命令。

Mac 的“连接方式”通过复选框独立启用本地网络、Cloudflare 和已配置的 Relay。
默认勾选全部可用入口，后续选择会保存；多个入口可同时运行，单个失败不会
阻断其他入口。“配置 Relay”填写兼容的 HTTPS 服务地址和访问密钥，校验
HTTP/WebSocket 后保存；配置成功后才显示 Relay 复选框。手机无需填写服务器。
公网 Relay 只转发网络流量，不存会话、账号密钥或任务状态。

本地网络的内容和设备授权均保持密封，公网入口使用 HTTPS/WSS。
同一 Mac 的通道切换保留会话缓存与原命令 ID，不自动重发结果未知的操作。
iOS 首次询问本地网络权限时，请允许后再使用 LAN。Mac 重启可能改变本地
地址/端口或 Cloudflare 临时地址；Relay 的认证路径在重连后保持。
手机可通过仍可用的认证连接取得新地址，全部旧入口不可用时再扫描当前二维码。

目录按原桌面会话更新时间从新到旧加载，并按应用、host 和项目隔离；超过 72 小时的 Codex 会话先显示标题、
项目和时间等基本信息，打开后才加载详细数据。Mac 每 5 秒独立准备目录快照并维护
有界原生状态，原目录扫描仍每 20 秒运行。默认后台观察 16 个普通会话与已有消息
观察器，总上限为 128；缺少可靠状态证据的会话保持“未确认”。
进入已预热的会话先显示最近消息缓存，再后台确认原 owner；冷会话沿原有新鲜读取
流程加载。只有明确向上滚动时才加载更早历史。
后台、目录和预加载不会自动补齐全部旧消息。活跃状态仍来自原 owner，
不能由消息时间推断；新消息也不会都套用一个长轮次的开始时间。

认证 HTTP 仍可读时，实时连接可独立恢复，不反复切换入口。同一 Mac 的通道切换
保留消息、展开内容和草稿。目录与状态分别使用增量水位；未知操作只查原编号回执。

阅读较早历史时，新问题提示仍可打开。选择答案后需要明确提交，回复保持
原 question/communication 身份与原生接受回执。

## 自建 Relay 与远程桌面

操作步骤见 [部署指南](docs/SELF-HOSTING.zh-CN.md) 和
[Linux Compose 模板](deploy/self-host/)。Mac 已内置 LiveKit；只自建通信 Relay
不会自动转发它的 WebRTC 视频。模板可分别启动通信 Relay、可选外部 LiveKit，
或两者一起启动，并提供 TURN 配置和真机公网验证步骤。

## 构建与验证

```sh
git clone https://github.com/mapix/Codelync.git
cd Codelync
pnpm install --frozen-lockfile
pnpm typecheck:all
pnpm lint
pnpm build:native
```

开发基线为 Node 24.15.0 / pnpm 10.11.0。Mac 发行可使用兼容的较新 Node 24
LTS 安全补丁。手机构建需要 Xcode、CocoaPods 和自己的开发团队。
命令与签名参数见 [构建说明](docs/BUILD-AND-VERIFY.md)，公证与静态 Kubernetes
部署见 [公开发行流程](docs/PUBLIC-RELEASE.md)。

源码采用标准 workspace：`apps/mac` 为 SwiftUI Mac 界面，`apps/mobile` 为
Expo/React Native 客户端，`src` 为会话桥接，`packages/relay` 为嵌入式中继，
`packages/wire` 为共享协议，`website` 为无第三方统计脚本的静态网站。

## 安全与限制

请先阅读 [安全说明](SECURITY.md)。只为自己信任的手机配对；当前没有独立的
项目或会话 ACL。原桌面应用持续拥有运行时与 admission；未知操作回执不自动
重放。网站只分发静态页面和已验证的公开包，不接收配对、会话或账号数据。

桌面原生接口可能随应用版本变化，尚未支持的接口会明确显示不可用。
性能基准记录的是合成历史下的 Mac CPU 与请求工作量，不代表已测得的
iPhone 帧率、续航或温度，也不保证手机不会发热。

Codelync 是独立开源项目，不隶属于 OpenAI。基于 Happy 的 MIT 组件构建，
保留原许可证和第三方归属，详见 [第三方说明](THIRD-PARTY-NOTICES.md)。

## 来源与许可

Codelync 原名 CodeLight。早期 iPhone 客户端和加密同步服务基于
[Happy](https://github.com/slopus/happy) 的 MIT 许可源码改造，保留原版权和许可。
详见[第三方说明](THIRD-PARTY-NOTICES.md)和[Happy 许可](licenses/Happy-LICENSE)。
当前原生 Desktop 连接、配对通路恢复、Mac App 和原 owner 控制由本项目后续增加；
第三方 Desktop 和模型运行时仍由原应用拥有，不随本项目分发。
