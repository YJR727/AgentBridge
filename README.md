<div align="center">
  <img src="website/assets/mark.svg" alt="Agent Bridge 标志" width="76" height="76">
  <h1>Agent Bridge</h1>
  <p><strong>把电脑上的 Codex，带到手机上继续。</strong></p>
  <p>连接你自己的电脑与 Android、iPhone 或 iPad，接续已有聊天、查看回复，并处理问题和审批。</p>
  <p>
    <a href="https://yjr727.github.io/AgentBridge/">产品介绍与下载</a> ·
    <a href="docs/FAQ.md">常见问题</a> ·
    <a href="README.en.md">English</a>
  </p>
</div>

<p align="center">
  <img alt="Node.js 20.11+" src="https://img.shields.io/badge/Node.js-20.11%2B-43853d?logo=node.js&logoColor=white">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-桌面端-0078D4?logo=windows&logoColor=white">
  <img alt="Android" src="https://img.shields.io/badge/Android-移动端-3DDC84?logo=android&logoColor=white">
  <img alt="macOS Apple Silicon" src="https://img.shields.io/badge/macOS-Apple%20Silicon-111111?logo=apple&logoColor=white">
</p>

> 个人实验项目。项目代码按 GNU GPL-3.0-only 授权；第三方组件保留各自许可证。macOS 版本仅支持 Apple 芯片，仍处于预览阶段。

## 工作方式

```text
┌──────────────────────┐       本机回环        ┌──────────────────────┐
│ Codex 桌面应用       │ ◀──────────────────▶ │ Agent Bridge 服务    │
└──────────────────────┘                       │ 127.0.0.1:4571       │
                                               └──────────┬───────────┘
                                                          │
                                                  Tailscale Serve HTTPS
                                                          │
                                               ┌──────────▼───────────┐
                                               │ Android / iPhone /   │
                                               │ iPad                 │
                                               └──────────────────────┘
```

服务运行在你自己的电脑上，只监听本机回环地址。Tailscale 在电脑和移动设备之间提供私有网络连接；Agent Bridge 不运行云端中继，也不把聊天存到云端。只配对你信任的设备。

## 下载

| 平台 | 下载 / 指引 | 当前状态 |
| --- | --- | --- |
| Windows | [安装包](website/downloads/AgentBridge-Setup-0.2.5.exe) · [安装说明](desktop/README.md) | 预览版 · x64 |
| Android | [APK](website/downloads/agent-bridge-0.4.2.apk) · [安装说明](android/README.md) | 预览版 |
| macOS | [Apple 芯片安装盘](website/downloads/AgentBridge-macOS-0.1.0-arm64.dmg) · [安装说明](desktop-mac/README.md) | 预览版 · 仅 M 系列及更新芯片 |
| iPhone / iPad | [网页应用](public/index.html) · [连接说明](docs/FAQ.md#tailscale-and-connection) | Safari 添加到主屏幕 |

安装包未经全面设备验收。Mac DMG 使用本地测试签名且未经 Apple 公证；首次打开时 macOS 可能显示安全提示。Intel Mac 不支持当前 Mac 安装包。

## 快速开始

1. 电脑和移动设备安装并登录 Tailscale，加入同一个 tailnet。
2. 电脑安装并打开 Codex，再打开要接续的聊天。
3. 安装并启动对应平台的 Agent Bridge 电脑端。
4. 按[连接与 Tailscale 常见问题](docs/FAQ.md#tailscale-and-connection)配置 Serve HTTPS，将请求转发到 `http://127.0.0.1:4571`。
5. 在电脑端生成配对码，在 Android 或 iPad 上填写电脑的 HTTPS 地址和配对码。
6. 在移动端选择聊天，开始查看回复、发送消息或处理待办。

各平台安装与验证步骤见[Windows](desktop/README.md)、[Android](android/README.md)、[macOS](desktop-mac/README.md) 指引。

## 项目结构

| 目录 / 文件 | 内容 |
| --- | --- |
| `desktop/` | Windows 桌面控制端与安装程序 |
| `desktop-mac/` | macOS SwiftUI 应用与构建脚本 |
| `android/` | Android 移动应用 |
| `android-island/` | Android 通知与聊天状态组件 |
| `public/` | iPhone / iPad Safari 网页应用 |
| `website/` | 产品介绍、指南和当前下载包 |
| `lib/`、`server.mjs` | 本地桥接服务 |
| `plugin/` | Agent Bridge Codex 插件 |
| `tests/` | Node.js 服务与工具测试 |
| `docs/` | 常见问题与项目文档 |

## 开发

本地服务需要 Node.js 20.11 或更新版本。运行测试：

```sh
npm test
```

Android、Windows 和 macOS 的构建及验证依赖平台工具；macOS 应用必须在 Mac 上构建。测试通过不代表所有 Codex 版本、设备或后台通知行为均已验收。

## 安全与隐私

- 服务仅监听本机回环地址；不要把 `4571` 端口直接暴露到公网，也不要为它启用 Tailscale Funnel。
- 已配对设备可以操作所选 Codex 聊天中的支持功能；只配对可信设备。
- 配对状态、推送凭据、日志和运行数据保存在 `data/`，已从 Git 排除。
- 签名密钥、证书和构建工具不应提交。修改 hook 前先检查 `hook.mjs`、`hooks.template.json` 与 `tools/install.mjs`。
- 本项目通过 Codex 桌面端本地 IPC 接入；该接口不是稳定的公开 API，可能随 Codex 更新而变化。

安全问题请参阅 [SECURITY.md](SECURITY.md)。项目与 OpenAI、Tailscale 均无关联或官方背书。项目代码按 [GNU GPL-3.0-only](LICENSE) 授权；第三方组件按其各自附带的许可证执行。

