using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Forms=System.Windows.Forms;

sealed class BridgeWindow {
    internal readonly Window View;
    readonly BridgeController controller;
    readonly EventWaitHandle activation, shutdown;
    readonly DispatcherTimer timer;
    readonly Forms.NotifyIcon tray;
    bool exiting, busy, refreshing;
    bool tailscaleRefreshing, installPageOpened;
    string tailscaleState="unavailable";
    DateTime nextTailscaleCheck;
    int ticks;
    internal bool ActivationObserved;
    internal BridgeWindow(BridgeController controller,EventWaitHandle activation,EventWaitHandle shutdown,bool check=false) {
        this.controller=controller;this.activation=activation;this.shutdown=shutdown;
        using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("Window.xaml")) View=(Window)XamlReader.Load(stream);
        View.Height=Math.Min(View.Height,Math.Max(View.MinHeight,SystemParameters.WorkArea.Height-60));
        if(check){View.WindowStartupLocation=WindowStartupLocation.Manual;View.Left=-12000;View.Top=-12000;View.ShowInTaskbar=false;}
        View.Icon=BitmapFrame.Create(new Uri(Path.Combine(controller.Runtime,"agent-bridge.ico")));
        var logo=new BitmapImage();logo.BeginInit();logo.UriSource=new Uri(Path.Combine(controller.Runtime,"app","public","icon-512.png"));logo.CacheOption=BitmapCacheOption.OnLoad;logo.EndInit();Control<Image>("Logo").Source=logo;
        Control<TextBox>("Address").Text=controller.Address;
        tray=new Forms.NotifyIcon {Icon=new System.Drawing.Icon(Path.Combine(controller.Runtime,"agent-bridge.ico")),Text="Agent Bridge",Visible=true};
        var menu=new Forms.ContextMenuStrip();menu.Items.Add("打开 Agent Bridge",null,(s,e)=>View.Dispatcher.BeginInvoke(new Action(Restore)));
        menu.Items.Add("退出程序",null,(s,e)=>View.Dispatcher.BeginInvoke(new Action(Quit)));tray.ContextMenuStrip=menu;
        tray.DoubleClick+=(s,e)=>Restore();
        View.Closing+=(s,e)=>{if(!exiting){e.Cancel=true;View.Hide();Notice("Agent Bridge 已收起到系统托盘，手机连接继续运行。");}};
        View.Closed+=(s,e)=>{timer.Stop();tray.Visible=false;tray.ContextMenuStrip.Dispose();tray.Icon.Dispose();tray.Dispose();};
        Button("Copy").Click+=(s,e)=>{try{SaveAddress();Clipboard.SetText(controller.Address);Notice("地址已复制，可粘贴到手机或 iPad。");}catch(Exception error){Notice(error.Message);}};
        Button("Open").Click+=(s,e)=>{try{SaveAddress();Process.Start(controller.Address);Notice("已打开手机桥网页。");}catch(Exception error){Notice(error.Message);}};
        Button("Toggle").Click+=async(s,e)=>await Action(async()=>{if(controller.CanStop){await Task.Run(()=>controller.Stop());Notice("服务已停止。");}else{await controller.Start();Notice("正在启动服务…");}});
        Button("AddDevice").Click+=async(s,e)=>await Action(async()=>{
            var config=controller.Config();ShowPairing(await controller.Request("POST","/api/local/pairing/add-device",BridgeController.Text(config,"hookToken")));
            Notice("新设备配对码已生成，原设备仍可使用。请在另一台设备输入此码。");
        });
        Button("Reset").Click+=async(s,e)=>{
            if(MessageBox.Show(View,"重新配对会撤销所有旧设备权限和待处理审批。添加另一台设备请使用“添加设备”。是否撤销并生成新码？","重新配对",MessageBoxButton.YesNo,MessageBoxImage.Question)!=MessageBoxResult.Yes)return;
            await Action(async()=>{var config=controller.Config();ShowPairing(await controller.Request("POST","/api/local/pairing/reset",BridgeController.Text(config,"hookToken")));Notice("新配对码已生成，请在设备上输入。旧设备权限已撤销。");});
        };
        Button("Test").Click+=async(s,e)=>await Action(async()=>{
            var config=controller.Config();await controller.Request("POST","/api/admin/test-event",BridgeController.Text(config,"appToken"),new {kind="decision",title="Agent Bridge 通知测试",summary="请点击通知并选择批准或拒绝，此测试不会执行命令。"});
            Notice("测试审批已创建，请查看设备通知或待办。");
        });
        Button("LogToggle").Click+=(s,e)=>ToggleLogs();Button("Exit").Click+=(s,e)=>Quit();
        Button("TailscaleRefresh").Click+=async(s,e)=>await RefreshTailscale();
        Button("TailscaleAction").Click+=(s,e)=>{
            try {
                if(tailscaleState=="missing")Process.Start(BridgeController.TailscaleInstallPage);
                else {
                    string app=BridgeController.TailscaleBinary("tailscale-ipn.exe");
                    if(app==""){Notice("未找到 Tailscale 窗口，请从 Windows 开始菜单打开。");return;}
                    Process.Start(new ProcessStartInfo {FileName=app,UseShellExecute=true});
                }
            }catch(Exception error){Notice("无法打开 Tailscale："+error.Message);}
        };
        timer=new DispatcherTimer {Interval=TimeSpan.FromMilliseconds(200)};
        timer.Tick+=async(s,e)=>{if(shutdown.WaitOne(0)){Quit();return;}if(activation.WaitOne(0)){ActivationObserved=true;Restore();}if(++ticks%10==0&&!busy&&!check){await Refresh();if(DateTime.UtcNow>=nextTailscaleCheck)await RefreshTailscale();}};
        timer.Start();
    }
    internal T Control<T>(string name) where T:FrameworkElement {return (T)View.FindName(name);}
    internal Button Button(string name){return Control<Button>(name);}
    internal void Notice(string text){Control<TextBlock>("Feedback").Text=text;}
    void SaveAddress(){controller.Address=BridgeController.ValidAddress(Control<TextBox>("Address").Text);Control<TextBox>("Address").Text=controller.Address;controller.SaveSettings();}
    internal async Task Start() {
        await Action(async()=>{
            await RefreshTailscale(true);
            controller.SaveSettings();await controller.Start();
            Notice(controller.Reused?"已连接现有手机桥服务。退出本窗口不会停止原服务。":"关闭窗口后，Agent Bridge 会在系统托盘继续运行。");
        });
    }
    internal void ShowTailscale(System.Collections.Generic.Dictionary<string,object> status) {
        tailscaleState=BridgeController.Text(status,"state");
        string title="Tailscale：状态待确认",hint="无法读取状态，请打开 Tailscale 检查后重新检测。";
        switch(tailscaleState) {
            case "missing":title="Tailscale：未安装";hint="安装并登录后，点击重新检测。";break;
            case "stopped":title="Tailscale：未开启";hint="打开 Tailscale 并连接，手机和 iPad 才能远程访问。";break;
            case "login":title="Tailscale：尚未登录";hint="打开 Tailscale，登录与手机相同的账号。";break;
            case "authorization":title="Tailscale：等待设备授权";hint="打开 Tailscale，按提示完成设备授权。";break;
            case "disconnected":title="Tailscale：未连接";hint="请在 Tailscale 检查网络并重新连接。";break;
            case "connected":title="Tailscale：电脑端已连接";hint="手机端也需保持 Tailscale 连接。";break;
        }
        Control<TextBlock>("TailscaleState").Text=title;
        Control<TextBlock>("TailscaleState").Foreground=new System.Windows.Media.SolidColorBrush(tailscaleState=="connected"?System.Windows.Media.Color.FromRgb(15,118,110):System.Windows.Media.Color.FromRgb(141,90,0));
        Control<TextBlock>("TailscaleHint").Text=hint;
        Button("TailscaleAction").Content=tailscaleState=="missing"?"去安装":"打开 Tailscale";
    }
    async Task RefreshTailscale(bool openInstallPage=false) {
        if(tailscaleRefreshing||exiting)return;tailscaleRefreshing=true;Button("TailscaleRefresh").IsEnabled=false;
        try {
            var status=await controller.DetectTailscale();if(exiting)return;
            ShowTailscale(status);
            string address=BridgeController.Text(status,"address");
            if(String.IsNullOrWhiteSpace(Control<TextBox>("Address").Text)&&address!=""){
                controller.Address=address;Control<TextBox>("Address").Text=address;controller.SaveSettings();
            }
            if(openInstallPage&&tailscaleState=="missing"&&!installPageOpened){installPageOpened=true;Process.Start(BridgeController.TailscaleInstallPage);}
        }catch(Exception error){Notice("Tailscale 检测未完成："+error.Message);}
        finally{nextTailscaleCheck=DateTime.UtcNow.AddSeconds(10);tailscaleRefreshing=false;Button("TailscaleRefresh").IsEnabled=true;}
    }
    async Task Action(Func<Task> action){
        if(busy)return;busy=true;
        Button("AddDevice").IsEnabled=false;Button("Reset").IsEnabled=false;Button("Test").IsEnabled=false;Button("Toggle").IsEnabled=false;
        try{await action();}catch(Exception error){Notice("操作未完成："+error.Message);File.AppendAllText(Path.Combine(controller.Home,"diagnostic.log"),error.ToString()+Environment.NewLine);}
        finally{busy=false;}
        await Refresh();
    }
    internal async Task Refresh() {
        if(refreshing||exiting)return;refreshing=true;
        try {
            var health=await controller.Health();bool running=health!=null&&BridgeController.Flag(health,"ok");
            Control<TextBlock>("Badge").Text=running?"服务在线":"服务离线";
            Button("Toggle").Content=running?"停止服务":"启动服务";
            Button("Toggle").IsEnabled=!busy&&(!running||controller.CanStop);
            Button("AddDevice").IsEnabled=false;Button("Reset").IsEnabled=false;Button("Test").IsEnabled=false;
            if(running){
                var config=controller.Config();ShowPairing(await controller.Request("GET","/api/local/pairing",BridgeController.Text(config,"hookToken")));
                bool paired=!String.IsNullOrEmpty(BridgeController.Text(config,"pairedAt"));
                Control<TextBlock>("ServiceState").Text=paired?"设备已配对 · 服务运行中":"服务运行中 · 等待设备配对";
                Button("Test").IsEnabled=!busy&&paired;
                try{var summary=await controller.Request("GET","/api/codex/summary",BridgeController.Text(config,"appToken"));Control<TextBlock>("ChatState").Text=ChatSummary(summary);}catch(WebException){Control<TextBlock>("ChatState").Text="Codex 连接待确认，请检查电脑上的 Codex。";}
            }else {
                Control<TextBlock>("ServiceState").Text="服务未运行";Control<TextBlock>("PairCode").Text="—";Control<TextBlock>("PairHint").Text="启动服务后可查看配对状态。";
                if(controller.Reused&&!controller.Stopped){controller.Reused=false;await controller.Start();}
                else if(controller.CanStop)Control<TextBlock>("ServiceState").Text="服务正在启动…";
            }
            if(Control<Border>("LogPanel").Visibility==Visibility.Visible&&File.Exists(controller.LogPath)){
                string log=File.ReadAllText(controller.LogPath);Control<TextBox>("Logs").Text=log.Length>14000?log.Substring(log.Length-14000):log;Control<TextBox>("Logs").ScrollToEnd();
            }
        }catch(Exception error){Notice("连接待确认："+error.Message);Button("AddDevice").IsEnabled=false;Button("Reset").IsEnabled=false;Button("Test").IsEnabled=false;}
        finally{refreshing=false;}
    }
    internal static string ChatSummary(System.Collections.Generic.Dictionary<string,object> summary){
        object value;var titles=new System.Collections.Generic.List<string>();
        if(summary.TryGetValue("threads",out value)&&value is System.Collections.IEnumerable)foreach(object item in (System.Collections.IEnumerable)value){
            var thread=item as System.Collections.Generic.Dictionary<string,object>;string title=BridgeController.Text(thread,"title");if(title.Length>36)title=title.Substring(0,36)+"…";
            titles.Add(title+(BridgeController.Flag(thread,"connected")?"":"（连接待确认）"));
        }
        string result=titles.Count==0?"打开电脑 Codex，在每台设备选择自己的聊天。":BridgeController.Text(summary,"devices")+" 台设备 · "+titles.Count+" 个聊天\n"+String.Join("、",titles.GetRange(0,Math.Min(3,titles.Count)));
        if(summary.TryGetValue("errors",out value)&&value is System.Collections.IEnumerable)foreach(object error in (System.Collections.IEnumerable)value){result+="\n部分聊天待确认："+BridgeController.Text(error as System.Collections.Generic.Dictionary<string,object>,"error");break;}return result;
    }
    internal void ShowPairing(System.Collections.Generic.Dictionary<string,object> pairing){
        Button("Reset").IsEnabled=!busy;
        bool paired=BridgeController.Flag(pairing,"paired");Button("AddDevice").IsEnabled=!busy&&paired;
        if(BridgeController.Text(pairing,"code")!=""){
            Control<TextBlock>("PairCode").Text=BridgeController.Text(pairing,"code");
            long expires=Convert.ToInt64(pairing["expiresAt"]);long remaining=Math.Max(0,(expires-DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())/1000);
            Control<TextBlock>("PairHint").Text=(paired?"原设备保留 · 请在新设备输入此码":"请在设备输入此码")+" · 剩余 "+remaining+" 秒";
        }else if(paired){Control<TextBlock>("PairCode").Text="已配对";Control<TextBlock>("PairHint").Text="手机与 iPad 可同时使用。连接另一台请点击添加设备。";}
        else{Control<TextBlock>("PairCode").Text="已过期";Control<TextBlock>("PairHint").Text="点击重新配对生成新码。";}
    }
    internal void ToggleLogs(){var panel=Control<Border>("LogPanel");panel.Visibility=panel.Visibility==Visibility.Visible?Visibility.Collapsed:Visibility.Visible;Button("LogToggle").Content=panel.Visibility==Visibility.Visible?"收起日志":"查看日志";}
    internal void Restore(){View.Show();View.WindowState=WindowState.Normal;View.Activate();}
    internal void Quit(){if(exiting)return;exiting=true;timer.Stop();View.Close();Application.Current.Shutdown();}
}
