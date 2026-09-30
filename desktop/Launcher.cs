using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows;
using System.Runtime.Versioning;

[assembly: AssemblyTitle("Agent Bridge")]
[assembly: AssemblyProduct("Agent Bridge")]
[assembly: AssemblyVersion("0.2.5.0")]
[assembly: TargetFramework(".NETFramework,Version=v4.8")]

// One distributable file. Windows supplies the UI runtime; Node and the bridge are embedded.
class Launcher {
    [STAThread]
    static int Main(string[] args) {
        bool diagnostic = Array.IndexOf(args, "--check") >= 0 || Array.IndexOf(args, "--self-test") >= 0;
        string home = Environment.GetEnvironmentVariable("AGENT_BRIDGE_DESKTOP_HOME");
        if (String.IsNullOrEmpty(home)) home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AgentBridge");
        try {
            home = Path.GetFullPath(home);
            Directory.CreateDirectory(home);
            string runtime = Unpack(home);
            string legacy = File.ReadAllText(Path.Combine(runtime, "legacy-root.txt"), Encoding.UTF8).Trim();
            AppContext.SetSwitch("Switch.System.Windows.DoNotScaleForDpiChanges", false);
            AppContext.SetSwitch("Switch.System.Windows.DoNotUsePresentationDpiCapabilityTier2OrGreater", false);
            using (var controller = new BridgeController(home, runtime, legacy)) {
                if (Array.IndexOf(args, "--quit") >= 0) {
                    try {
                        using(var stop = EventWaitHandle.OpenExisting("Local\\AgentBridgeDesktop-" + controller.ProfileHash + "-shutdown")) stop.Set();
                        using(var owner=Mutex.OpenExisting("Local\\AgentBridgeDesktop-"+controller.ProfileHash)) {
                            bool released=false;
                            try{released=owner.WaitOne(10000);}catch(AbandonedMutexException){released=true;}
                            if(!released)return 1;
                            owner.ReleaseMutex();
                        }
                        Thread.Sleep(200);
                    }
                    catch(WaitHandleCannotBeOpenedException) { }
                    return 0;
                }
                if (Array.IndexOf(args, "--self-test") >= 0) {
                    DesktopChecks.Service(controller).GetAwaiter().GetResult();
                    return 0;
                }
                bool primary;
                using (var mutex = new Mutex(true, "Local\\AgentBridgeDesktop-" + controller.ProfileHash, out primary)) {
                    string signalName = "Local\\AgentBridgeDesktop-" + controller.ProfileHash + "-activate";
                    if (!primary) {
                        EventWaitHandle signal=null;
                        for(int attempt=0;attempt<10 && signal==null;attempt++) {
                            try { signal=EventWaitHandle.OpenExisting(signalName); }
                            catch(WaitHandleCannotBeOpenedException){Thread.Sleep(100);}
                        }
                        if(signal==null)throw new InvalidOperationException("旧版窗口仍在运行，请先从托盘退出旧版。");
                        using(signal)signal.Set();
                        return 0;
                    }
                    try {
                        using (var activation = new EventWaitHandle(false, EventResetMode.AutoReset, signalName))
                        using (var stop = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AgentBridgeDesktop-" + controller.ProfileHash + "-shutdown")) {
                            var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
                            var window = new BridgeWindow(controller, activation, stop, Array.IndexOf(args, "--check") >= 0);
                            application.SessionEnding += (s,e) => window.Quit();
                            if (Array.IndexOf(args, "--check") >= 0) window.View.Loaded += async (s, e) => {
                                try { await DesktopChecks.Window(window, controller); }
                                catch (Exception error) { File.WriteAllText(Path.Combine(home, "diagnostic.log"), error.ToString()); application.Shutdown(1); }
                            };
                            else window.View.Loaded += async (s, e) => await window.Start();
                            return application.Run(window.View);
                        }
                    } finally { controller.Stop(); mutex.ReleaseMutex(); }
                }
            }
        } catch (Exception error) {
            if (diagnostic) File.WriteAllText(Path.Combine(home, "diagnostic.log"), error.ToString());
            else MessageBox.Show("手机桥未能启动：" + error.Message, "Agent Bridge", MessageBoxButton.OK, MessageBoxImage.Error);
            return 1;
        }
    }
    internal static string Quote(string value) { return "\"" + value + (value.EndsWith("\\") ? "\\" : "") + "\""; }
    static string Unpack(string home) {
        using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("bridge.zip")) {
            string hash;
            using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(payload)).Replace("-", "").ToLowerInvariant();
            string root = Path.Combine(home, "runtime", hash.Substring(0, 16));
            string ready = Path.Combine(root, ".ready");
            // Serialize only extraction; the controller owns the single-window mutex.
            FileStream gate = null;
            for (int attempt = 0; gate == null; attempt++) {
                try { gate = new FileStream(Path.Combine(home, "extract.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
                catch (IOException) { if (attempt >= 100) throw; Thread.Sleep(100); }
            }
            using (gate) {
                if (File.Exists(ready) && File.ReadAllText(ready) == hash) return root;
                Directory.CreateDirectory(root);
                payload.Position = 0;
                using (var zip = new ZipArchive(payload, ZipArchiveMode.Read)) {
                    foreach (var entry in zip.Entries) {
                        string target = Path.GetFullPath(Path.Combine(root, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                        if (!target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Invalid bundled path");
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        using (var input = entry.Open()) using (var output = File.Create(target)) input.CopyTo(output);
                    }
                }
                File.WriteAllText(ready, hash);
                return root;
            }
        }
    }
}
