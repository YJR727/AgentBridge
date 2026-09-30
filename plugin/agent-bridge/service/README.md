# Agent Bridge 手机桥

阶段一交付：Codex 插件 + 独立 Node 服务，复用旧 HTTP、PWA 和图标，运行时零 npm 依赖。插件操作指引兼容 Windows 与 macOS，按宿主系统选择路径和命令；安装不会自动启动服务。此更新不改变 Node 服务逻辑。当前按钮只处理假事件，文字回写关闭。真实权限 hooks、任务完成/失败捕获和 App Server 接入留到后续阶段；旧文件保留在开发工作区，不装入本次发布包。

## 运行与数据

解压后插件根目录为 agent-bridge，独立服务在 service 子目录。先识别实际运行服务的电脑系统，参考 [平台操作指引](../skills/agent-bridge/references/platforms.md)。优先复用用户已使用的服务与资料；新安装才将整个 service 复制到获准的稳定目录，例如 Windows 的 %LOCALAPPDATA%/AgentBridge/service，或 macOS 的 ~/Library/Application Support/AgentBridge/service。目录包含空格时正确引用，不在插件缓存内保存运行资料。不要运行两个服务实例，也不要用此早期服务替换新版 Windows 服务。

需要 Node >=20.11.0；用 node --version 和 node 的 process.platform/process.execPath 核对版本、宿主系统和可执行文件路径。两平台都从实际 service 目录运行 node server.mjs。Windows PowerShell 示例（替换为实际目录）：

```powershell
Set-Location -LiteralPath 'C:\实际目录\agent-bridge\service'
node server.mjs
```

macOS Terminal 示例（替换为实际目录）：

```sh
cd "/实际目录/agent-bridge/service"
node server.mjs
```

Windows 仍可双击 start.cmd 启动；macOS 使用上面的 Node 入口。沿用原 AGENT_BRIDGE_DATA 和端口，数据默认位于 service/data。Ctrl+C 停止服务，待处理假事件取消。首次启动自动生成 data\config.json、VAPID 密钥与手机/上报凭证；配对码仅在电脑终端显示，五分钟有效。不要把 data、完整配置、订阅端点或配对码发到聊天中。配对成功关闭入口。

重新配对先 Ctrl+C 停止服务，再运行 `node server.mjs --reset-pairing`。命令撤销旧手机凭证、清空旧订阅、取消待处理请求后启动服务。端口被占用时拒绝重配对。手机需重新配对和开启通知。

## Tailscale HTTPS 与手机验收

按实际电脑检查 Tailscale 安装、登录与 Serve 路由；读取失败时说明原因，不当作未安装。电脑和手机须加入同一 tailnet；MagicDNS、HTTPS 证书与 tailnet 访问规则须允许该电脑。先用本机 serve --help 确认语法，再按平台指引配置。

Windows 在能访问 Tailscale 的电脑终端执行；先确认路径存在并查看是否已有 Serve 路由：

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' status
& 'C:\Program Files\Tailscale\tailscale.exe' serve status
& 'C:\Program Files\Tailscale\tailscale.exe' serve --bg http://127.0.0.1:4571
```

macOS 优先使用 command -v tailscale 查到的 CLI；若没有，再确认应用内 CLI 路径存在后使用：

```sh
TAILSCALE_BE_CLI=1 "/Applications/Tailscale.app/Contents/MacOS/Tailscale" status
TAILSCALE_BE_CLI=1 "/Applications/Tailscale.app/Contents/MacOS/Tailscale" serve status
TAILSCALE_BE_CLI=1 "/Applications/Tailscale.app/Contents/MacOS/Tailscale" serve --bg http://127.0.0.1:4571
```

TAILSCALE_BE_CLI=1 避免脚本调用时打开图形窗口，见 [官方 CLI 文档](https://tailscale.com/docs/reference/tailscale-cli?tab=macos)。配置 Serve 需要用户要求；先检查路由，使用实际服务端口。

已有路由时先检查冲突，不盲目覆盖。按输出启用 HTTPS 所需配置并取得真实 https 地址，不猜域名。只使用 Serve，不使用 Funnel。文档：https://tailscale.com/docs/reference/tailscale-cli/serve 。

集中手机清单：

1. Android 开启 Tailscale，用 Chrome 打开真实 HTTPS 地址；输入电脑终端配对码。
2. 开启网页通知；可添加到主屏幕。添加不是锁屏送达的保证；确认 Android/Chrome 的通知权限和电池策略。
3. PWA 点“发测试事件”，锁屏查看通知；分别点批准与拒绝，确认对应假事件变为 resolved，页面显示服务已记录选择。
4. 什么都不点等默认 90 秒；事件变为 expired，随后按钮回复被拒绝。关闭通知/网络后仍须有限期失效。
5. 重复点击不改变首个选择；电脑发出两个不同假事件，两条通知不能互相覆盖。
6. 查看推送日志：HTTP 成功只代表推送服务接受；手机真实显示须单独记录。
7. 停止/重启服务，旧 pending 变为 cancelled；按上述命令重新配对，旧手机不能再查看详情或回复，旧订阅清除。

手机与电脑间回传/查看详情需要 Tailscale 在线。电脑休眠、断网或停机不承诺实时处理。未配对、无订阅、全部推送失败会尽快结束假事件等待；不会自动批准。

## 配置、测试与故障排查

配置源为 data\config.json，config.template.json 仅供参考。把 vapid.subject 改为自己的联系邮箱。默认只推需要决定与失败，完成静默；notify.success 可设 push/batch。摘要最多 140 字；notify.contentMode=none 时标题仅“有新事件”，不携带工作目录或任务正文。

每个请求用 source/sessionId/turnId/kind/requestId 组合去重，稳定 requestId 缺失时保守保留。不同请求分别推送。pending 只能转为 resolved/expired/cancelled；选择与一次性令牌消费在事件文件同一队列执行。相同选择重试仅返回已有结果，相反选择冲突。重启取消遗留 pending。最多保留 300 条事件，去重也限于保留事件；不宣称跨进程或无限期历史幂等。

```powershell
npm test
```

开发工作区全部套件当前 79 项通过，其中阶段一发布包只含 crypto/server/reliability 共 48 项。旧 hooks 测试仍验证历史错误契约，不作为真实桌面验收证据。新测试已匹配 RFC 8291 独立加密向量，并验证配对、鉴权、重投、超时、并发与 SW 401/403/409/500/网络失败。测试使用隔离数据与假推送，不能替代手机实测。

排查顺序：电脑服务健康 `http://127.0.0.1:4571/api/health` → Tailscale/HTTPS → 配对 → 浏览器通知授权与有效订阅 → 推送日志 HTTP 状态 → 锁屏显示 → 按钮回传。401/403 检查配对或事件令牌，409 检查已处理/过期/取消，404/410 推送订阅自动删除，500/网络失败不会显示已批准。

## 登录自启、停用、卸载

两平台手动服务均用 Ctrl+C 停用。Windows 可选计划任务脚本只管理“Agent Bridge”任务；本次未安装或执行。它在用户登录时启动，不是无人登录的系统服务：

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Action install
powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Action status
powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Action stop
powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Action uninstall
```

上述脚本仅适用于 Windows，macOS 不执行 PowerShell 或 .cmd。Mac 默认手动启动；用户要求登录自启时按平台指引配置用户 LaunchAgent，使用实际 Node/service/data 绝对路径并在 Mac 实机验收。插件更新不会自动添加登录自启。

Windows 安装可能需要管理员权限，脚本会请求系统提权；实际计划任务启动未验收。停止服务即可停用桥接；卸载该计划任务后在 Codex 移除插件，按需保留/移走 data。若该 HTTPS 路由仅用于本项目，可执行 `tailscale serve --https=443 off`，不要用 reset 删除其他 Serve 配置。真实 Codex 配置与 notify 未改动，无需恢复；配置备份位置：本次无。

本次 0.1.1 更新只增加插件的平台分支和操作说明，service/package.json 与既有 Windows 服务、start.cmd、计划任务脚本不变。Windows 验证结果不能代替 Mac 实机验收；在 Mac 成功启动此 Node 服务也不表示已能控制 Codex 聊天。

官方接口支持 PermissionRequest 允许/拒绝/不作决定，但当前桌面触发路径尚未验证。插件不携带自动执行 hooks，不声称已能回答等待中的 Codex 任务。下一步先记录真实手机验收结果，经用户确认后进入阶段二。
