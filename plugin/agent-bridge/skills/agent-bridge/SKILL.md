---
name: agent-bridge
description: 用于在 Windows 或 macOS 检查 Agent Bridge 本地服务、手机配对和 Web Push 通知，或开启、排查手机桥。真实 Codex 权限与聊天控制需按服务版本和平台单独验收。
---

# Agent Bridge 手机桥

每次面向用户的汇报以“老板”开头。串行工作，不创建 subagent。

插件内 `../../service/`（相对于本技能目录）包含独立 Node 服务。先读其 README.md、PROGRESS.md 和 [平台操作指引](references/platforms.md)。插件安装不会自动启动服务。

1. 先识别**实际运行服务的电脑**系统与 Node 版本；Windows 走 Windows 分支，macOS 走 macOS 分支。可只读运行 `node -p "JSON.stringify({platform:process.platform,arch:process.arch,executable:process.execPath})"`。Node 缺失时按宿主环境确认系统，不能因此默认 Windows，也不能在 Mac 执行 .cmd、PowerShell 或 Windows 路径。
2. 优先复用用户已使用的服务、实际数据目录和端口；不因插件更新迁移数据、重置配对或替换新版服务。没有服务时才使用插件内 service，复制到稳定、获准的用户可写目录。按平台指引选择目录；保留现有 Windows 路径。插件缓存不适合保存运行资料。
3. 只读检查 Node >=20.11.0、回环服务健康和 Tailscale 状态。不打印 data/config.json、令牌、订阅端点或私钥；不修改 Codex 配置或现有 notify。系统权限错误与未安装分别报告，不把读取失败当作未安装。
4. 用户要求启动时，在实际 service 目录运行 `node server.mjs`，或用已确认的 Node 绝对路径。两平台共用这个入口；Windows 还可沿用 start.cmd。沿用现有 AGENT_BRIDGE_DATA；只绑定 127.0.0.1，默认端口 4571。不启动第二个实例，也不自动重配对。新配对码五分钟有效，仅让用户在电脑终端查看。
5. 按平台指引选择 Tailscale CLI，先检查 status 与 serve status，再按 README 配置 Serve HTTPS。macOS 的应用内 CLI 设置 TAILSCALE_BE_CLI=1。只在 tailnet 内提供访问，不开 Funnel、公网或 ngrok，不覆盖其他 Serve 路由。
6. 手机配对、授权通知后，通过 PWA“发测试事件”逐项验收锁屏、按钮、超时、重配对撤权。插件自带服务的按钮只改变假事件状态；单次 replyToken 只能回复指定事件。失败、过期、取消或相反决定不能显示已批准。HTTP 推送接受不代表手机显示或 Codex 执行。
7. 先核对正在复用的服务版本和能力。插件自带 0.1.0 服务关闭文字回写，未接入真实 hooks 或 App Server；既有新版 Windows 服务继续按其实际说明使用。macOS 能启动 Node 服务不等于能控制 Codex 聊天，不套用 Windows 命名管道，不用 --last 猜测任务。真实接入按平台另行验收。
8. 停用、登录自启和卸载按平台指引处理，只管理本插件的服务。默认保留数据；用户明确要求撤销设备时才重新配对。Windows 使用既有计划任务脚本；macOS 需要用户 LaunchAgent，不调用 Windows 脚本。

需要服务自测时使用临时数据目录并执行 `npm test`。不增加模型 API 调用或 npm 运行依赖。分别记录已验证的系统与未验证的平台，不把 Windows 证据当作 Mac 验收。
