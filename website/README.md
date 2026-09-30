# Agent Bridge 产品介绍网站

这是一个静态产品站，包含功能演示、连接方式、Windows / Mac 的 Tailscale Serve HTTPS 配置、Windows / macOS / Android 下载、iPad 使用指南，以及安装、配对、聊天和通知的常见问题。

直接双击 `index.html` 即可查看，也可使用任何静态网页服务器预览。页面没有 npm 依赖、外部字体、追踪脚本或真实 Codex 控制接口。首屏中的窗口、聊天、审批和通知均为明确标注的交互演示。Mac DMG 来自用户在 Apple 芯片 Mac 上构建的测试包；仅本地分发，使用本地测试签名、未经苹果公证。

## 文件

- `index.html`：页面内容和下载链接。
- `assets/site.css`：响应式样式。
- `assets/site.js`：交互演示、移动导航和安装指南弹窗。
- `assets/mark.svg`：网站标志与 favicon。
- `downloads/`：Windows 0.2.5 安装包、Android 0.4.2 APK 和 macOS 0.1.0 Apple 芯片 DMG。
- `.nojekyll`：让 GitHub Pages 按普通静态文件发布。

安装包是现有构建产物的完整副本，此次没有重编译软件。Mac DMG 的 SHA256 是 `d36c64669ea7a8701dd2f3767f03a3a39a997723aa7952cd43944d152d4e9368`，已与 Mac 构建报告核对。不同设备、系统版本和后台通知仍需继续验收；页面因此标为预览版。Serve 命令与限制对照了 [Tailscale 官方文档](https://tailscale.com/docs/reference/tailscale-cli/serve)，未使用 Funnel。

## 放到 GitHub Pages

网站可以直接使用 GitHub Pages 托管。此项目仓库保持私有时，个人账户需要 GitHub Pro 或更高方案才能发布 Pages；GitHub Free 个人账户要求仓库公开。即使源仓库是私有的，公开发布的网站和其中的下载文件仍可被任何人访问。

仓库内的 `.github/workflows/publish-website.yml` 只发布 `website/` 目录，不会发布其他应用源码。首次设置时，在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。之后每次更新 `website/` 并推送到 `main`，GitHub Actions 会自动部署。默认网址为 `https://yjr20250822-ctrl.github.io/AgentBridge/`；也可以在 Settings → Pages 查看实际地址。

公开网站会包含 `website/downloads/` 中的 Windows 安装包、Android APK 和 Mac DMG。当前网站和安装包是预览版本；Mac DMG 未经 Apple 公证，新设备可能会显示 Gatekeeper 安全提示。不要把真实电脑 HTTPS 地址、配对码或令牌填进这个公开网站。

如果 GitHub 方案不支持从私有仓库发布 Pages，请保持应用仓库私有，并将本目录单独复制到一个公开的网站仓库。不要为了托管网站而公开整个应用源码仓库。

## 更新

以后更新版本，只需替换安装包、修改下载 URL 和可见版本号。Mac Intel 版尚未验收，不能使用当前 Apple 芯片 DMG 标记为通用 Mac 包。

不需要付费服务器或自购域名。使用 GitHub Pages 默认地址即可，之后可另绑定自有域名。
