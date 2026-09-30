import Foundation
import Combine
import Darwin

struct TailscaleStatus {
    var state: String
    var address: String = ""
    var label: String {
        switch state {
        case "missing": return "未安装"
        case "stopped": return "已停止"
        case "login": return "需要登录"
        case "authorization": return "等待设备授权"
        case "disconnected": return "已断开"
        case "connected": return "已连接"
        default: return "状态待确认"
        }
    }
}
struct ProcessResult { let status: Int32; let output: Data; let timedOut: Bool }
struct BridgeFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

@MainActor
final class BridgeController: ObservableObject {
    @Published var running = false
    @Published var busy = false
    @Published var address = ""
    @Published var pairCode = ""
    @Published var pairing = "服务尚未启动"
    @Published var chatSummary = "在移动端选择电脑上已有的聊天"
    @Published var serviceStatus = "准备启动"
    @Published var tailscale = TailscaleStatus(state: "unavailable")
    @Published var serveStatus = "HTTPS 路由尚未检查"
    @Published var feedback = ""
    @Published var logs = ""
    private var worker: Process?
    private var workerInput: Pipe?
    private var workerOutput: FileHandle?
    private var refreshing = false
    private var detecting = false
    private let resources: URL
    let dataDirectory: URL
    private let session: URLSession
    private let processEnvironment: [String:String]
    private var port = 4571
    private var hookToken = ""
    private var appToken = ""
    var ownsService: Bool { worker?.isRunning == true }
    var ownedProcessIdentifier: Int32? { ownsService ? worker?.processIdentifier : nil }
    var canStopService: Bool { running || ownsService }
    var node: URL { resources.appendingPathComponent("runtime/bin/node") }
    var cli: URL? {
        ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"].map { URL(fileURLWithPath: $0) }.first { FileManager.default.isExecutableFile(atPath: $0.path) }
    }
    init(resources: URL = Bundle.main.resourceURL!, dataDirectory: URL? = nil, processEnvironment: [String:String] = ProcessInfo.processInfo.environment) {
        self.resources = resources
        self.processEnvironment = processEnvironment
        self.dataDirectory = dataDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("AgentBridge", isDirectory: true)
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = 1.5
        config.timeoutIntervalForResource = 2
        session = URLSession(configuration: config)
        if let data = try? Data(contentsOf: self.dataDirectory.appendingPathComponent("desktop-settings.json")), let settings = try? JSONSerialization.jsonObject(with: data) as? [String:Any] { address = settings["address"] as? String ?? "" }
    }
    nonisolated static func validateAddress(_ text: String) throws -> URL {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var parts = URLComponents(string: text), parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/",
              parts.port == nil || (1...65535).contains(parts.port!), !text.contains("\\"), !text.contains(where: { $0.isWhitespace }) else {
            throw BridgeFailure(message: "请填写完整 HTTPS 根地址，例如 https://电脑名.ts.net")
        }
        parts.scheme = "https"; parts.path = ""
        guard let url = parts.url else { throw BridgeFailure(message: "HTTPS 地址无效") }
        return url
    }
    nonisolated static func parseTailscale(_ data: Data) throws -> TailscaleStatus {
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String:Any] else { throw BridgeFailure(message: "Tailscale 状态格式无效") }
        let backend = json["BackendState"] as? String
        let own = json["Self"] as? [String:Any] ?? [:]
        var status = TailscaleStatus(state: "unavailable")
        switch backend {
        case "Stopped": status.state = "stopped"
        case "NeedsLogin": status.state = "login"
        case "NeedsMachineAuth": status.state = "authorization"
        case "Running":
            if let online = own["Online"] as? Bool { status.state = online ? "connected" : "disconnected" }
        default: break
        }
        let dns = (own["DNSName"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "."))
        if status.state == "connected", dns.lowercased().hasSuffix(".ts.net"), let url = try? validateAddress("https://" + dns) { status.address = url.absoluteString }
        return status
    }
    nonisolated static func isCompatibleHealth(_ json: [String:Any]) -> Bool {
        json["ok"] as? Bool == true && json["version"] as? String == "0.4.0" && json["addDevicePairing"] as? Bool == true && json["independentChats"] as? Bool == true
    }
    nonisolated static func runProcess(_ executable: URL, _ arguments: [String], timeout: Double = 2.5, environment: [String:String]? = nil) async throws -> ProcessResult {
        try await Task.detached {
            let fm = FileManager.default
            let directory = fm.temporaryDirectory.appendingPathComponent("AgentBridge-process-" + UUID().uuidString)
            try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            defer { try? fm.removeItem(at: directory) }
            let output = directory.appendingPathComponent("output")
            fm.createFile(atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600])
            let handle = try FileHandle(forWritingTo: output)
            defer { try? handle.close() }
            let process = Process()
            process.executableURL = executable; process.arguments = arguments
            process.environment = environment ?? ProcessInfo.processInfo.environment
            process.standardOutput = handle; process.standardError = FileHandle.nullDevice; process.standardInput = FileHandle.nullDevice
            try process.run()
            let deadline = Date().addingTimeInterval(timeout)
            while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.025) }
            let expired = process.isRunning
            if expired {
                process.terminate()
                let grace = Date().addingTimeInterval(0.5)
                while process.isRunning && Date() < grace { Thread.sleep(forTimeInterval: 0.025) }
                if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
            }
            process.waitUntilExit()
            let reader = try FileHandle(forReadingFrom: output)
            defer { try? reader.close() }
            let data = try reader.read(upToCount: 262144) ?? Data()
            return ProcessResult(status: process.terminationStatus, output: data, timedOut: expired)
        }.value
    }
    private func config() throws {
        try validateDataDirectory()
        let data = try Data(contentsOf: dataDirectory.appendingPathComponent("config.json"))
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String:Any],
              let hook = json["hookToken"] as? String, !hook.isEmpty,
              let app = json["appToken"] as? String, !app.isEmpty, json["host"] as? String == "127.0.0.1",
              let value = json["port"] as? Int, (1...65535).contains(value) else { throw BridgeFailure(message: "本机服务配置无效，未启动") }
        hookToken = hook; appToken = app; port = value
    }
    private func validateDataDirectory() throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: dataDirectory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else { throw BridgeFailure(message: "资料目录不是当前用户的普通目录，停止读取配置") }
    }
    private func request(_ route: String, token: String = "", method: String = "GET", body: [String:Any]? = nil) async throws -> [String:Any] {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)" + route)!)
        req.httpMethod = method
        if !token.isEmpty { req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let body { req.setValue("application/json", forHTTPHeaderField: "Content-Type"); req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await session.data(for: req)
        guard let response = response as? HTTPURLResponse else { throw BridgeFailure(message: "本机服务没有有效响应") }
        let result = (try? JSONSerialization.jsonObject(with: data) as? [String:Any]) ?? [:]
        guard (200...299).contains(response.statusCode) else { throw BridgeFailure(message: result["error"] as? String ?? "本机服务请求失败（\(response.statusCode)）") }
        return result
    }
    private var environment: [String:String] {
        var env = processEnvironment
        env.removeValue(forKey: "AGENT_BRIDGE_PORT")
        env["AGENT_BRIDGE_DATA"] = dataDirectory.path
        env["AGENT_BRIDGE_LOG"] = dataDirectory.appendingPathComponent("service.log").path
        return env
    }
    private func prepare(subject: String? = nil) async throws {
        try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try validateDataDirectory()
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dataDirectory.path)
        var args = [resources.appendingPathComponent("app/desktop-mac/service.mjs").path, "--prepare"]
        if let subject { args += ["--subject", subject] }
        let result = try await Self.runProcess(node, args, timeout: 5, environment: environment)
        guard !result.timedOut && result.status == 0 else { throw BridgeFailure(message: "无法准备本机后台，请查看检查报告") }
        try config()
    }
    func start() async throws {
        guard !running else { return }
        if ownsService { await refresh(); if !running { throw BridgeFailure(message: "后台进程仍在运行但没有响应，请先停止服务再重试") }; return }
        // Check existing data first. Never replace another service's configuration.
        if FileManager.default.fileExists(atPath: dataDirectory.appendingPathComponent("config.json").path) { try config() }
        if let health = try? await request("/api/health") {
            guard Self.isCompatibleHealth(health), !hookToken.isEmpty else { throw BridgeFailure(message: "端口 \(port) 已有不兼容服务，请先处理端口冲突") }
            _ = try await request("/api/local/pairing", token: hookToken)
            running = true; serviceStatus = "正在使用已有服务"; await refresh(); return
        }
        try await prepare(subject: (try? Self.validateAddress(address))?.absoluteString)
        let logURL = dataDirectory.appendingPathComponent("service.log")
        if let size = try? FileManager.default.attributesOfItem(atPath: logURL.path)[.size] as? NSNumber, size.intValue > 4 * 1024 * 1024 { try? FileManager.default.removeItem(at: logURL) }
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        let output = try FileHandle(forWritingTo: logURL); try output.seekToEnd()
        let input = Pipe(), process = Process()
        process.executableURL = node; process.arguments = [resources.appendingPathComponent("app/desktop-mac/service.mjs").path, "--desktop"]
        process.environment = environment; process.standardInput = input; process.standardOutput = output; process.standardError = output
        try process.run()
        worker = process; workerInput = input; workerOutput = output
        do {
            for _ in 0..<35 {
                if !process.isRunning { break }
                if let health = try? await request("/api/health"), Self.isCompatibleHealth(health) {
                    _ = try await request("/api/local/pairing", token: hookToken)
                    running = true; serviceStatus = "服务运行中"; await refresh(); return
                }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            throw BridgeFailure(message: "服务启动失败或端口冲突，未停止外部服务；请展开日志")
        } catch { await stop(); throw error }
    }
    func stop() async {
        if let process = worker, process.isRunning {
            try? workerInput?.fileHandleForWriting.write(contentsOf: Data("shutdown\n".utf8))
            for _ in 0..<35 { if !process.isRunning { break }; try? await Task.sleep(nanoseconds: 100_000_000) }
            if process.isRunning { process.terminate(); try? await Task.sleep(nanoseconds: 300_000_000); if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }; process.waitUntilExit() }
        }
        try? workerInput?.fileHandleForWriting.close(); try? workerOutput?.close()
        worker = nil; workerInput = nil; workerOutput = nil
        running = false; pairCode = ""; pairing = "服务已停止"; serviceStatus = "服务已停止"
    }
    func refresh() async {
        guard !refreshing else { return }; refreshing = true; defer { refreshing = false }
        do {
            try config()
            let health = try await request("/api/health")
            guard Self.isCompatibleHealth(health) else { throw BridgeFailure(message: "端口服务不兼容") }
            let pair = try await request("/api/local/pairing", token: hookToken)
            running = true; pairCode = pair["code"] as? String ?? ""
            let paired = pair["paired"] as? Bool == true
            pairing = paired ? "已配对 · 添加设备保留旧连接" : "请在移动端输入临时配对码"
            serviceStatus = ownsService ? "服务运行中" : "正在使用已有服务"
            if !paired { chatSummary = "请先配对手机或 iPad，再选择聊天"; readLogs(); return }
            let summary = try await request("/api/codex/summary", token: appToken)
            let threads = summary["threads"] as? [[String:Any]] ?? []
            let connected = threads.filter { $0["connected"] as? Bool == true }.count
            let devices = summary["devices"] as? Int ?? 0
            let errors = summary["errors"] as? [[String:Any]] ?? []
            chatSummary = "\(devices) 台设备 · \(connected) 个聊天已连接" + (errors.isEmpty ? "" : "\n" + (errors.first?["error"] as? String ?? "聊天连接待确认"))
            serviceStatus = ownsService ? "服务运行中" : "正在使用已有服务"
        } catch {
            running = false; pairCode = ""; serviceStatus = "服务不可用"; chatSummary = error.localizedDescription
        }
        readLogs()
    }
    func addDevice() async throws { _ = try await request("/api/local/pairing/add-device", token: hookToken, method: "POST"); await refresh() }
    func resetPairing() async throws { _ = try await request("/api/local/pairing/reset", token: hookToken, method: "POST"); await refresh() }
    func testNotification() async throws {
        _ = try await request("/api/admin/test-event", token: appToken, method: "POST", body: ["kind":"decision","title":"Agent Bridge 通知测试","summary":"请选择批准或拒绝，此测试不会执行电脑命令。"])
        feedback = "测试已创建，请检查手机通知与应用待办"
    }
    func saveAddress() async throws {
        let url = try Self.validateAddress(address)
        guard !running || ownsService else { throw BridgeFailure(message: "已有服务由其他程序启动，请先在原程序停止后保存地址") }
        let wasRunning = running
        if worker != nil { await stop() }
        try await prepare(subject: url.absoluteString)
        address = url.absoluteString
        let settings = try JSONSerialization.data(withJSONObject: ["address": address])
        try settings.write(to: dataDirectory.appendingPathComponent("desktop-settings.json"), options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: dataDirectory.appendingPathComponent("desktop-settings.json").path)
        if wasRunning { try await start() }
        feedback = "地址已保存；请确认 Tailscale Serve 指向本机端口 \(port)"
    }
    func detectTailscale() async {
        guard !detecting else { return }; detecting = true; defer { detecting = false }
        guard let cli else {
            tailscale = TailscaleStatus(state: FileManager.default.fileExists(atPath: "/Applications/Tailscale.app") ? "unavailable" : "missing")
            serveStatus = "请先安装、登录并授权 Tailscale"; return
        }
        do {
            var env = ProcessInfo.processInfo.environment; env["TAILSCALE_BE_CLI"] = "1"
            let result = try await Self.runProcess(cli, ["status", "--json"], environment: env)
            guard !result.timedOut && result.status == 0 else { throw BridgeFailure(message: "状态查询超时或失败") }
            tailscale = try Self.parseTailscale(result.output)
            if address.isEmpty { address = tailscale.address }
            let serve = try await Self.runProcess(cli, ["serve", "status", "--json"], environment: env)
            if !serve.timedOut && serve.status == 0, let routes = try? JSONSerialization.jsonObject(with: serve.output) as? [String:Any] {
                serveStatus = routes.isEmpty ? "尚未配置 Serve HTTPS，请按使用说明设置" : "检测到 Serve 配置；请在移动端验证地址"
            } else { serveStatus = "Serve 状态待确认，请查看 Tailscale" }
        } catch { tailscale = TailscaleStatus(state: "unavailable"); serveStatus = "状态查询失败，点击重新检测" }
    }
    func readLogs() {
        guard let handle = try? FileHandle(forReadingFrom: dataDirectory.appendingPathComponent("service.log")) else { logs = "暂无日志"; return }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        try? handle.seek(toOffset: size > 32768 ? size - 32768 : 0)
        let data = (try? handle.read(upToCount: 32768)) ?? Data()
        logs = String(decoding: data, as: UTF8.self)
    }
    func perform(_ action: @escaping () async throws -> Void) {
        guard !busy else { return }; busy = true; feedback = ""
        Task { defer { busy = false }; do { try await action() } catch { feedback = error.localizedDescription } }
    }
}
