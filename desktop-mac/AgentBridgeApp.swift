import SwiftUI
import AppKit
import Darwin

@main
struct AgentBridgeApp: App {
    @NSApplicationDelegateAdaptor(BridgeAppDelegate.self) private var delegate
    var body: some Scene { Settings { EmptyView() } }
}

@MainActor
final class BridgeAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var statusItem: NSStatusItem?
    private var controller: BridgeController?
    private var monitor: Task<Void,Never>?
    private var quitting = false
    private var lockDescriptor: Int32 = -1
    func applicationDidFinishLaunching(_ notification: Notification) {
        let lockDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("AgentBridge")
        do {
            try FileManager.default.createDirectory(at: lockDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let attributes = try FileManager.default.attributesOfItem(atPath: lockDirectory.path)
            guard attributes[.type] as? FileAttributeType == .typeDirectory, (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else { throw BridgeFailure(message: "资料目录归属无效") }
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: lockDirectory.path)
        }
        catch { let alert = NSAlert(); alert.messageText = "无法准备 Agent Bridge 用户目录"; alert.runModal(); NSApp.terminate(nil); return }
        lockDescriptor = Darwin.open(lockDirectory.appendingPathComponent("desktop.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        let locked = lockDescriptor >= 0 && flock(lockDescriptor, LOCK_EX | LOCK_NB) == 0
        let id = Bundle.main.bundleIdentifier ?? "com.agentbridge.desktop"
        if !locked {
            if let other = NSRunningApplication.runningApplications(withBundleIdentifier: id).first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) { other.activate(options: [.activateIgnoringOtherApps]) }
            DistributedNotificationCenter.default().postNotificationName(Notification.Name("AgentBridge.show"), object: nil)
            if lockDescriptor < 0 { let alert = NSAlert(); alert.messageText = "无法锁定 Agent Bridge 用户目录"; alert.runModal() }
            NSApp.terminate(nil); return
        }
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(showWindow), name: Notification.Name("AgentBridge.show"), object: nil)
        let bridge = BridgeController(); controller = bridge
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 740), styleMask: [.titled,.closable,.miniaturizable,.resizable], backing: .buffered, defer: false)
        window.title = "Agent Bridge"; window.minSize = NSSize(width: 550, height: 500)
        window.isReleasedWhenClosed = false; window.delegate = self
        window.contentView = NSHostingView(rootView: BridgeWindow(controller: bridge))
        window.center(); self.window = window
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "link", accessibilityDescription: "Agent Bridge")
        let menu = NSMenu()
        let open = NSMenuItem(title: "打开 Agent Bridge", action: #selector(showWindow), keyEquivalent: ""); open.target = self; menu.addItem(open)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出 Agent Bridge", action: #selector(quitApp), keyEquivalent: "q"); quit.target = self; menu.addItem(quit)
        item.menu = menu; statusItem = item
        let appMenu = NSMenu(); let root = NSMenuItem(); appMenu.addItem(root)
        let actions = NSMenu(); actions.addItem(withTitle: "关于 Agent Bridge", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        actions.addItem(.separator()); let exit = NSMenuItem(title: "退出 Agent Bridge", action: #selector(quitApp), keyEquivalent: "q"); exit.target = self; actions.addItem(exit)
        root.submenu = actions; NSApp.mainMenu = appMenu
        showWindow()
        monitor = Task {
            bridge.perform { try await bridge.start() }
            await bridge.detectTailscale()
            if bridge.tailscale.state == "missing" { NSWorkspace.shared.open(URL(string: "https://tailscale.com/download/mac")!) }
            var ticks = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if Task.isCancelled { break }
                if !bridge.busy { await bridge.refresh() }
                ticks += 1
                if ticks % 5 == 0 { await bridge.detectTailscale() }
            }
        }
    }
    @objc func showWindow() { window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func quitApp() { NSApp.terminate(nil) }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting || controller == nil { return .terminateNow }
        quitting = true; monitor?.cancel()
        Task { await controller?.stop(); NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
}

@MainActor
struct BridgeWindow: View {
    @ObservedObject var controller: BridgeController
    @State private var showReset = false
    @State private var showLogs = false
    private let tint = Color(red: 0.06, green: 0.46, blue: 0.43)
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 14) {
                    Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 56, height: 56)
                    VStack(alignment: .leading, spacing: 4) { Text("Agent Bridge").font(.title2.bold()); Text("让手机接续电脑上的 Codex 聊天").foregroundStyle(.secondary) }
                    Spacer()
                    if controller.busy { ProgressView().controlSize(.small).accessibilityLabel("正在处理") }
                }
                GroupBox {
                    VStack(alignment: .leading, spacing: 12) {
                        status(controller.serviceStatus, active: controller.running)
                        Text(controller.chatSummary).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                        HStack {
                            Button(controller.canStopService ? "停止服务" : "启动服务") { controller.perform { if controller.canStopService { await controller.stop() } else { try await controller.start() } } }.disabled(controller.busy || (controller.running && !controller.ownsService))
                            Button("通知测试") { controller.perform { try await controller.testNotification() } }.disabled(!controller.running || controller.busy)
                            Spacer()
                            Text("关闭窗口后仍在菜单栏运行").font(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                } label: { Label("电脑服务", systemImage: "desktopcomputer") }
                GroupBox {
                    VStack(alignment: .leading, spacing: 12) {
                        status("Tailscale · " + controller.tailscale.label, active: controller.tailscale.state == "connected")
                        Text(controller.serveStatus).font(.callout).foregroundStyle(.secondary)
                        HStack {
                            Button("去安装") { open("https://tailscale.com/download/mac") }
                            Button("打开 Tailscale") {
                                if FileManager.default.fileExists(atPath: "/Applications/Tailscale.app") { NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Tailscale.app")) } else { open("https://tailscale.com/download/mac") }
                            }
                            Button("重新检测") { Task { await controller.detectTailscale() } }
                        }
                        Divider()
                        Text("移动端 HTTPS 地址").font(.callout.weight(.medium))
                        TextField("https://电脑名.ts.net", text: $controller.address).textFieldStyle(.roundedBorder).accessibilityLabel("移动端 HTTPS 地址")
                        HStack {
                            Button("保存地址") { controller.perform { try await controller.saveAddress() } }.disabled(controller.busy)
                            Button("复制地址") { if let url = try? BridgeController.validateAddress(controller.address) { copy(url.absoluteString) } }
                            Button("打开网页") { if let url = try? BridgeController.validateAddress(controller.address) { NSWorkspace.shared.open(url) } }
                        }
                        Text("首次使用请按使用说明设置 Serve。检测到网络连接不代表 HTTPS 已可访问。").font(.caption).foregroundStyle(.secondary)
                    }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                } label: { Label("网络与地址", systemImage: "network") }
                GroupBox {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(controller.pairing).foregroundStyle(.secondary)
                        if !controller.pairCode.isEmpty {
                            HStack {
                                Text(controller.pairCode).font(.system(size: 30, weight: .semibold, design: .monospaced)).textSelection(.enabled)
                                Spacer()
                                Button("复制配对码") { copy(controller.pairCode) }
                            }
                            Text("临时配对码有效期 5 分钟").font(.caption).foregroundStyle(.secondary)
                        }
                        HStack {
                            Button("添加设备") { controller.perform { try await controller.addDevice() } }
                            Button("重新配对…") { showReset = true }
                        }.disabled(!controller.running || controller.busy)
                    }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                } label: { Label("设备配对", systemImage: "iphone.and.arrow.forward") }
                if !controller.feedback.isEmpty { Label(controller.feedback, systemImage: "info.circle").font(.callout).textSelection(.enabled) }
                DisclosureGroup("查看日志", isExpanded: $showLogs) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(controller.logs.isEmpty ? "暂无日志" : controller.logs).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        Button("打开日志目录") { NSWorkspace.shared.open(controller.dataDirectory) }
                    }.padding(.top, 10)
                }
                Text("Agent Bridge 0.1.0 · macOS 原生版").font(.caption).foregroundStyle(.secondary)
            }.padding(24)
        }.background(Color(nsColor: .windowBackgroundColor)).tint(tint)
        .alert("重新配对所有设备？", isPresented: $showReset) {
            Button("取消", role: .cancel) {}
            Button("撤销旧设备并生成配对码", role: .destructive) { controller.perform { try await controller.resetPairing() } }
        } message: { Text("这会撤销所有旧手机与 iPad 的连接权限及通知订阅。添加另一台设备请使用“添加设备”。") }
    }
    private func status(_ text: String, active: Bool) -> some View {
        HStack(spacing: 8) { Circle().fill(active ? tint : Color.orange).frame(width: 8, height: 8).accessibilityHidden(true); Text(text).font(.headline) }
    }
    private func copy(_ value: String) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(value, forType: .string) }
    private func open(_ value: String) { if let url = URL(string: value) { NSWorkspace.shared.open(url) } }
}
