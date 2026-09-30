# Agent Bridge macOS 原生版 0.1.0

独立 SwiftUI/AppKit 窗口，内置 Node.js。Android APK 与 iPad 网页继续使用现有版本。
最低构建目标 macOS 13；Apple 芯片优先验收。Intel 可显式构建，但 Codex 实际接入尚未验证。

## 先构建

1. 把 `AgentBridge-macOS-0.1.0-Source.zip` 复制到 Mac，双击解压到普通用户文件夹。保留整个目录结构。
2. 首次在终端执行 `xcode-select --install`，按苹果提示完成命令行工具安装。
3. 双击 `desktop-mac/Build.command`。首次从 Node 官方下载固定版本 v24.19.0，核对固定 SHA256，再编译原生程序、运行控制器自检、包内回归和隔离后台测试。自检包括首次配对和暂停自有进程后停止，不使用真实手机资料。
4. 构建成功后，根目录 `dist/` 出现 `.dmg`、`.app.zip`、`build-report.json`，并打开 DMG 安装盘预览。无需另装 Node。首次制作安装盘布局时，macOS 可能询问是否允许终端控制 Finder；需允许才能写入背景和图标布局。

如果解压工具没有保留可执行权限，进入该目录后执行 `chmod +x desktop-mac/*.command`。如果 macOS 阻止脚本打开，按系统界面审核来源；脚本不移除隔离属性或关闭 Gatekeeper。
网络下载失败或 Swift 报错时，把错误文本发回开发聊天，不要忽略检查继续安装。
重新构建前将 `dist/Agent Bridge.app` 移到别处，保留旧包作对照。

默认是本机 ad-hoc 测试签名，**不是公证发布版**。Developer ID 可通过 `Build.command --identity 'Developer ID Application: …'` 指定；仍需另做公证后才适合公开分发。
Intel 参数：`Build.command --arch x64`。Apple 芯片上运行 Intel 自检需系统具备对应执行环境；构建失败不会标记为支持。

## 安装和使用

1. 打开 DMG，把 **Agent Bridge.app** 拖到 **Applications**，从“应用程序”启动。关闭窗口保留菜单栏连接，菜单栏“退出”才停止本应用启动的服务。
2. 安装并登录 Tailscale，让电脑和手机/iPad 加入同一个网络。窗口显示安装、登录和连接状态；未安装时每次启动最多打开一次官方安装页。
3. 首次为 Agent Bridge 配置 Serve HTTPS。打开终端执行：

   ```bash
   TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale serve status
   ```

   确认没有需要保留的其他根路由，再执行：

   ```bash
   TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=443 http://127.0.0.1:4571
   ```

   按 Tailscale 提示开通 HTTPS/Serve。不使用 Funnel，不暴露公网；不执行 reset 清除已有路由。如安装的是 CLI/Homebrew 版，用实际 `tailscale` 路径替换上面路径。
4. 将 Tailscale 输出的完整 `https://…ts.net` 地址填进窗口并点 **保存地址**。系统建议的 DNS 地址仅供填写，不表示 Serve 已配置。保存时沿用推送密钥，只重启本窗口拥有的后台。
5. Android 填地址与配对码。iPad 用 Safari 打开该地址，配对后“共享 → 添加到主屏幕”，从桌面图标打开并允许通知。
6. 添加第二台设备用 **添加设备**，旧连接保留。**重新配对**会在确认后撤销所有旧设备、订阅和待处理权限。
7. 在移动端选择 Mac 上已有的本机聊天。Mac Codex 要处于运行状态；聊天读取、发消息、提问和审批仍需按下方真实验收确认。

数据、设置和日志保存在 `~/Library/Application Support/AgentBridge/`，权限限定当前用户。更新应用不删除这些资料。
服务只绑定 `127.0.0.1`。同一端口已有其他资料目录或不兼容服务时，会报错，不会杀掉外部程序。
通知受设备权限、后台存活和网络影响；隔离测试通过不代表真实锁屏推送已通过。

## 构建后的检查

打开 Mac 上的 Codex 和一个已有聊天，再双击 **Verify.command**。
报告保存在根目录 `dist/macOS-verify-report.json`，只含系统、架构、计数与检查状态，不含聊天正文、配对码、令牌或私钥。
该脚本只读订阅已有聊天，**不发送消息、不批准真实请求**。将报告与构建报告发回开发聊天。
若 Mac Codex 没有提供聊天列表端点，应用会从当前用户的本机聊天索引列出最近的聊天；选择后仍由 Codex 主通道验证，不能只凭索引向聊天发送内容。此后备目录不含运行状态，因此仅监测已选聊天，其他聊天的后台待办提醒会在窗口状态中标为未验收。显式端点仅用于诊断：`CODEX_APP_TOOLS_PIPE_PATH` 和 `AGENT_BRIDGE_CODEX_IPC`，也必须通过当前用户与目录归属检查。

真实验收仍需手动完成：窗口开关/菜单栏恢复、第二次启动聚焦、重启保留配对、停止和退出清理后台；手机发无副作用测试消息、选项题/文字题、假审批批准/拒绝；Android 和 iPad 各选不同聊天、第三聊天待办、实际完成时间与锁屏推送。尚未实测的项目保留为 pending。

## 可选 hooks（明确安装后才修改用户配置）

桌面聊天桥使用现有 IPC；若还需要 hooks 事件，在将应用装到 `/Applications` 并启动一次后，用终端明确执行：

```bash
"/Applications/Agent Bridge.app/Contents/Resources/runtime/bin/node" "/Applications/Agent Bridge.app/Contents/Resources/app/desktop-mac/setup-hooks.mjs"
```

仅合并 Agent Bridge handlers，先备份 hooks，保留第三方内容与原 notify。命令使用稳定安装路径和独立资料目录。
安装后在 Codex 审核、信任 hooks。安装脚本不替用户设置全局信任，不自动批准。
不要移动安装后的应用路径，否则需重新准备 hooks。

Mac 应用的构建结果可能因签名与公证状态而不同；提交源码不代表 DMG 已适合公开分发。
