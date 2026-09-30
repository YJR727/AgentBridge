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

网站可在本机直接预览。仓库保持私有时，GitHub Pages 不能作为公开下载站使用；需要公开介绍页时，再单独评估并建立公开站点仓库。

推荐使用单独的公开网站仓库：

1. 创建仓库，将本目录中的网页和 `assets/` 放到仓库根目录。
2. 将三个安装文件作为 GitHub Release 附件上传。Mac 包若公开分发，应先完成适合公开下载的签名、公证与新设备安装验收。
3. 在 `index.html` 中，把三个下载链接从 `downloads/...` 改为 Release 给出的实际下载 URL。可搜索 `data-download="windows"`、`data-download="macos"` 和 `data-download="android"` 找到对应入口。无需修改 JavaScript。
4. 在仓库 Settings → Pages 中选择 Deploy from a branch、`main` 和 `/ (root)`，保存。
5. 发布后用 GitHub 给出的 `https://用户名.github.io/仓库名/` 地址查看，并验证三个下载入口。

网站没有根路径资源引用，因此可以发布到项目子路径。不要把真实电脑 HTTPS 地址、配对码或令牌填进这个公开介绍站。

也可以通过 Git 客户端把 `downloads/` 一起提交并直接提供文件下载，此时不必修改链接。网页与安装包的公开发布仍应等软件的仓库整理和新设备安装验收完成。

## 更新

以后更新版本，只需替换安装包、修改下载 URL 和可见版本号。Mac Intel 版尚未验收，不能使用当前 Apple 芯片 DMG 标记为通用 Mac 包。

不需要付费服务器或自购域名。使用 GitHub Pages 默认地址即可，之后可另绑定自有域名。
