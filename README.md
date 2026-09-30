# Agent Bridge

**简体中文** | [English](README.en.md)

Agent Bridge 将手机或 iPad 连接到您自己电脑上运行的 Codex。您可以在移动设备上向已有聊天发送消息、查看最新回复，并处理 Codex 提出的问题或审批请求。

这是一个个人实验项目。当前仓库为私有仓库，项目没有开源许可证。

## 项目内容

| 组件 | 目录 | 说明 |
| --- | --- | --- |
| Windows 桌面控制端 | `desktop/` | 原生 C# / WPF 窗口，打包本地 Node.js 服务。 |
| 本地桥接服务 | 项目根目录、`lib/`、`hook.mjs` | Node.js 服务，无 npm 运行时依赖。 |
| Android 应用 | `android/` | 原生 Android APK 源码和构建脚本。 |
| iPad 网页应用 | `public/` | 可从 Safari 添加到主屏幕的网页应用（PWA）。 |
| macOS 桌面应用 | `desktop-mac/` | SwiftUI 源码和 Mac 构建脚本；构建和设备接入仍属实验状态。 |
| 产品介绍网站 | `website/` | 静态介绍和帮助页面，包含当前打包版本的下载文件。 |

## 工作方式

```text
电脑上的 Codex
        │ 本地桌面连接
Agent Bridge 服务（127.0.0.1:4571）
        │ Tailscale Serve 提供 HTTPS
Android 应用 / iPad 网页应用
```

服务运行在电脑上，并只监听本机回环地址。Tailscale 在电脑和移动设备之间提供私有网络连接。Agent Bridge 不提供云端中继服务，也不把聊天存到云端。已配对的设备可以发送消息并回复支持的问题或审批请求，请只配对您信任的设备。

目前，Codex 桌面端通过本地桌面 IPC 接口接入；该接口兼容性可能随 Codex 更新而变化，它不是稳定的公开 Codex API。使用前请查看当前平台说明，并针对目标 Codex 版本自行验证。本项目与 OpenAI、Tailscale 均无关联。

## 快速开始

1. 在电脑和移动设备上安装并登录 Tailscale，确保两台设备位于同一个 tailnet。
2. 在电脑上安装并打开 Codex，再打开要控制的聊天。
3. 安装并启动对应平台的 Agent Bridge 电脑端服务。Windows 应用和 Mac 源码构建版提供桌面控制窗口；Android 和 iPad 连接到这台电脑上的服务。
4. 配置 Tailscale Serve，将 HTTPS 流量转发到 `http://127.0.0.1:4571`。详见[连接与 Tailscale 常见问题](docs/FAQ.md#tailscale-and-connection)。
5. 在电脑控制窗口生成配对码，在 Android 或 iPad 上填写电脑的 HTTPS 地址和配对码。
6. 在移动设备上选择聊天。您可以发送消息、查看回复，或打开“待办”查看并回答请求。

各平台的详细步骤：

- [Windows 桌面端](desktop/README.md)
- [Android](android/README.md)
- [macOS](desktop-mac/README.md)
- [常见问题与故障排查](docs/FAQ.md)
- [产品介绍网站](website/README.md)

## 构建与测试

各平台的要求有所不同。本地服务需要 Node.js 20.11 或更新版本。Android 和 Mac 应用需要各自的平台构建工具；Mac 应用必须在 macOS 上构建。

```sh
npm test
```

各平台的构建和验证命令见对应说明。自动化测试使用隔离的本地数据；测试通过不代表通知一定送达，也不代表所有 Codex 版本都兼容。

## 安全与隐私

- 保持服务只监听本机回环地址，并使用私有 VPN 网络连接。不要将 `4571` 端口直接暴露到公网，也不要为它配置 Tailscale Funnel。
- 已配对设备可以控制所选 Codex 聊天中的支持操作。设备丢失或不再可信时，请重新配对。
- 配对状态、推送凭据、日志和运行数据保存在 `data/` 中，并已从 Git 排除。签名密钥和下载的构建工具也会被排除。
- 修改 hook 前请先阅读并确认其行为：`hook.mjs`、`hooks.template.json` 和 `tools/install.mjs`。
- 不要提交配对码、私钥、证书、个人 Tailscale 地址、本机日志或聊天内容。

安全问题请查看 [SECURITY.md](SECURITY.md)。仓库没有 `LICENSE` 文件，因此当前并未授予他人复制、分发或复用代码的许可。

## 项目状态

Windows、Android 和 iPad 已在现有设备环境中使用过。macOS 应用及其 Codex 接入仍属实验状态，需要在目标 Mac 和 Codex 版本上验证。通知是否送达取决于网络和移动操作系统的后台规则，不能保证始终送达。
