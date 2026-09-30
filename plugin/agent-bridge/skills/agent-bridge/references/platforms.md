# Windows 与 macOS 操作指引

先识别运行服务的宿主系统。手机的系统不会决定电脑端的分支。下面的目录是新安装建议；已有服务继续使用原目录、数据和端口。

## 服务与 Node

| 项目 | Windows | macOS |
| --- | --- | --- |
| 系统标识 | Node process.platform 为 win32 | Node process.platform 为 darwin |
| 新服务建议目录 | %LOCALAPPDATA%\AgentBridge\service | ~/Library/Application Support/AgentBridge/service |
| 手动入口 | node server.mjs；保留 start.cmd | 在 Terminal 运行 node server.mjs |
| Node 定位 | Get-Command node；已记录的 Node 路径 | command -v node；已记录的 Node 路径 |
| 登录自启 | 既有 tools/install-autostart.ps1 | 用户 LaunchAgent，按需配置 |

两平台需要 Node >=20.11.0。确认 `node --version` 和 `process.execPath`；后者可用于 GUI 启动环境或登录自启，避免依赖终端的 PATH。不要假定 Mac 一定安装了 Homebrew、Rosetta 或 Node，也不自动安装工具链。

从稳定 service 目录运行服务。默认资料在该目录的 data；已有 AGENT_BRIDGE_DATA 时沿用它。更新插件不改变这个默认行为。空间包含空格的路径必须正确引用，shell 示例中的占位路径要替换成实际路径。所有配对码只在电脑终端显示。

Windows PowerShell 示例：

~~~powershell
Set-Location -LiteralPath 'C:\实际目录\agent-bridge\service'
node server.mjs
~~~

macOS Terminal 示例：

~~~sh
cd "/实际目录/agent-bridge/service"
node server.mjs
~~~

没有服务时才将插件内 service 完整复制到获准的稳定目录。已存在新版 Windows 服务时继续复用，不能用插件自带早期服务覆盖它。重复启动、资料目录不明或端口占用时先核对原服务，不停止其他进程。

## Tailscale

Windows：优先查 Get-Command tailscale，然后查当前机器的 Program Files/Tailscale/tailscale.exe。路径存在后才调用；现有 C:\Program Files\Tailscale\tailscale.exe 用法保留。

~~~powershell
& 'C:\Program Files\Tailscale\tailscale.exe' status
& 'C:\Program Files\Tailscale\tailscale.exe' serve status
~~~

macOS：先查 `command -v tailscale`；有可执行文件时使用其实际路径。若没有，再查 /Applications/Tailscale.app/Contents/MacOS/Tailscale。即使 Terminal 有 tailscale alias，GUI 或服务进程也未必能用它。直接运行应用内 CLI 时设置 TAILSCALE_BE_CLI=1：

~~~sh
TAILSCALE_BE_CLI=1 "/Applications/Tailscale.app/Contents/MacOS/Tailscale" status
TAILSCALE_BE_CLI=1 "/Applications/Tailscale.app/Contents/MacOS/Tailscale" serve status
~~~

有 tailscale CLI 时同样可用 `TAILSCALE_BE_CLI=1 tailscale status`。以本机 `serve --help` 确认语法，在用户要求配置 HTTPS 后运行 `serve --bg http://127.0.0.1:4571`；端口已改时使用实际端口。已有路由先查冲突，不用 reset 清除其他路由。只使用 Serve；从实际输出取得 HTTPS 地址。

读不到状态时说明原因，保留“待确认”；用户自行登录、授权系统扩展或安装 Tailscale。不要把手机 VPN 状态与电脑检测结果混为一谈。

官方依据：[Tailscale CLI](https://tailscale.com/docs/reference/tailscale-cli?tab=macos)、[Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)。

## 登录自启、停用与卸载

手动启动两平台均在对应 Terminal 按 Ctrl+C 停止服务。插件安装和更新不会自动注册登录自启。

Windows：用户要求自启时使用 service/tools/install-autostart.ps1 的 install/status/start/stop/uninstall。先确认是这份 service 的任务，保留既有任务和数据处理方式。这个脚本仅适用于 Windows。

macOS：用户要求自启时，先检查已有同用途服务；只为当前用户配置 ~/Library/LaunchAgents 下的 LaunchAgent。plist 的 ProgramArguments 使用确认后的 Node 绝对路径和 server.mjs 绝对路径，WorkingDirectory 使用实际 service 目录，EnvironmentVariables 沿用实际 AGENT_BRIDGE_DATA，日志写入用户可写目录。用 plutil 检查 plist，用 launchctl 的 gui/<uid> 域加载和卸载。路径不能含字面量 ~、$HOME 或依赖交互终端 PATH。已有同名 plist 先备份，不覆盖无关任务；不要注册系统 LaunchDaemon，不默认启用不断重启的 KeepAlive。Mac 自启须在 Mac 上验证后才报告成功。

卸载只移除本插件对应的任务和插件；配对资料默认保留。Tailscale HTTPS 路由确认只供本服务使用后才停用，不执行全局 reset。

## 能力与验收

插件内 service/package.json 仍是早期 0.1.0 服务：手机配对、PWA 与假事件通知。macOS 的插件指引不包含 WPF 窗口或真实 Codex 聊天控制移植。复用新版服务时读它自己的说明并按实际能力处理。

检查服务健康、配对和手机锁屏通知时记录宿主系统。Windows 原有验证可继续使用；Mac 的 Node 服务、Tailscale HTTPS、手机回传和自启需要 Mac 实机分别确认。
