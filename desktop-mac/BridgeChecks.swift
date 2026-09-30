import Foundation
import Darwin

@main
struct BridgeChecks {
    @MainActor static func main() async throws {
        for input in ["https://bridge.example", " https://bridge.example/ "] {
            let url = try BridgeController.validateAddress(input)
            precondition(url.absoluteString == "https://bridge.example")
        }
        for input in ["http://bridge.example", "https://user:secret@bridge.example", "https://bridge.example/path", "https://bridge.example?secret=1", "https://bridge.example#secret", "https://"] {
            do { _ = try BridgeController.validateAddress(input); fatalError("Invalid address accepted") } catch {}
        }
        for (backend, online, expected) in [("Stopped", false, "stopped"), ("NeedsLogin", false, "login"), ("NeedsMachineAuth", false, "authorization"), ("Running", false, "disconnected"), ("Running", true, "connected")] {
            let data = try JSONSerialization.data(withJSONObject: ["BackendState": backend, "Self": ["Online": online, "DNSName": "device.example.ts.net."]])
            let status = try BridgeController.parseTailscale(data)
            precondition(status.state == expected)
        }
        do { _ = try BridgeController.parseTailscale(Data("bad json".utf8)); fatalError("Invalid JSON accepted") } catch {}
        let result = try await BridgeController.runProcess(URL(fileURLWithPath: "/bin/sleep"), ["10"], timeout: 0.15)
        precondition(result.timedOut)
        precondition(!BridgeController.isCompatibleHealth(["ok":true,"version":"0.1.0"]))
        precondition(BridgeController.isCompatibleHealth(["ok":true,"version":"0.4.0","addDevicePairing":true,"independentChats":true]))
        if CommandLine.arguments.count > 1 {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("AgentBridge-native-check-" + UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            let resources = URL(fileURLWithPath: CommandLine.arguments[1])
            let node = resources.appendingPathComponent("runtime/bin/node")
            var env = ProcessInfo.processInfo.environment; env["AGENT_BRIDGE_DATA"] = directory.path
            env["CODEX_HOME"] = directory.appendingPathComponent("isolated-codex").path
            env.removeValue(forKey: "CODEX_THREAD_ID")
            env.removeValue(forKey: "CODEX_APP_TOOLS_PIPE_PATH")
            env.removeValue(forKey: "AGENT_BRIDGE_CODEX_IPC")
            let encoded = try JSONSerialization.data(withJSONObject: [resources.appendingPathComponent("app/lib/config.mjs").absoluteString])
            let module = String(decoding: encoded, as: UTF8.self).dropFirst().dropLast()
            let script = "import net from 'node:net'; import {loadConfig,saveConfig} from \(module); const server=net.createServer(); await new Promise(r=>server.listen(0,'127.0.0.1',r)); const port=server.address().port; await new Promise(r=>server.close(r)); const {config}=loadConfig();config.port=port;saveConfig(config);"
            let setup = try await BridgeController.runProcess(node, ["--input-type=module", "-e", script], timeout: 5, environment: env)
            precondition(setup.status == 0 && !setup.timedOut)
            let bridge = BridgeController(resources: resources, dataDirectory: directory, processEnvironment: env)
            try await bridge.start()
            let ready = bridge.running && !bridge.pairCode.isEmpty
            let pid = bridge.ownedProcessIdentifier!
            Darwin.kill(pid, SIGSTOP)
            await bridge.refresh()
            let stopAvailable = bridge.canStopService
            await bridge.stop()
            precondition(ready, "First launch must remain running and show pairing before a phone is paired")
            precondition(stopAvailable, "A stuck owned process must remain stoppable")
            precondition(Darwin.kill(pid, 0) == -1 && errno == ESRCH, "Owned process must actually exit")
            precondition(!bridge.ownsService)
        }
        print("Native controller checks passed")
    }
}
