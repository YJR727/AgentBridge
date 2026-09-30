using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;

static class DesktopChecks {
    static void Require(bool condition,string message){if(!condition)throw new InvalidOperationException(message);}
    static async Task Ready(BridgeController controller){
        for(int i=0;i<60;i++){if(await controller.Health()!=null)return;await Task.Delay(100);}
        throw new InvalidOperationException("服务启动超时");
    }
    internal static async Task Service(BridgeController controller){
        Require(!String.IsNullOrEmpty(Environment.GetEnvironmentVariable("AGENT_BRIDGE_DATA"))&&!String.IsNullOrEmpty(Environment.GetEnvironmentVariable("AGENT_BRIDGE_PORT"))&&!String.IsNullOrEmpty(Environment.GetEnvironmentVariable("AGENT_BRIDGE_DESKTOP_HOME")),"自测必须指定隔离资料、端口和控制台目录");
        Require(await controller.Health()==null,"自测端口已占用，不触碰已有服务");
        var checks=new List<string>();
        await controller.Start();await Ready(controller);Require(controller.CanStop,"未启动自有服务");checks.Add("bundled Node starts without PowerShell or a console");
        Require(BridgeController.Flag(await controller.Health(),"independentChats"),"新版多设备服务能力缺失");
        checks.Add("bundled service supports independent chats");
        var config=controller.Config();string hook=BridgeController.Text(config,"hookToken");
        var pairing=await controller.Request("GET","/api/local/pairing",hook);
        Require(BridgeController.Text(pairing,"code")!="","首次配对码缺失");
        var paired=await controller.Request("POST","/api/pair",body:new{code=BridgeController.Text(pairing,"code")});
        string token=BridgeController.Text(paired,"token");Require(token!="","配对失败");
        var summary=await controller.Request("GET","/api/codex/summary",token);
        Require(BridgeController.Text(summary,"devices")=="0"&&summary.ContainsKey("threads"),"多设备概况错误");
        checks.Add("multi-device summary is available without choosing a chat");
        await controller.Start();Require(BridgeController.Text(controller.Config(),"appToken")==token,"重复启动改变配对");checks.Add("second start preserves pairing");
        var added=await controller.Request("POST","/api/local/pairing/add-device",hook);
        Require(BridgeController.Flag(added,"paired")&&BridgeController.Text(added,"code")!="","添加设备码缺失");
        var second=await controller.Request("POST","/api/pair",body:new{code=BridgeController.Text(added,"code")});
        Require(BridgeController.Text(second,"token")==token,"添加设备撤销旧凭证");
        await controller.Request("GET","/api/events",token);
        Require(BridgeController.Text(await controller.Request("GET","/api/local/pairing",hook),"code")=="","添加设备码未关闭");
        checks.Add("adding a second device preserves the first and closes its one-use code");
        // Isolated native client lease lets this approval wait without a real push subscription.
        await controller.Request("GET","/api/native/poll",token);
        var test=await controller.Request("POST","/api/admin/test-event",token,new{kind="decision",title="隔离窗口测试",waitMs=10000});
        string eventId=BridgeController.Text(test,"eventId");Require(eventId!="","测试事件缺失");
        await controller.Request("POST","/api/events/"+eventId+"/decision",token,new{choice="approve",via="desktop-self-test"});
        var decided=BridgeController.Section(await controller.Request("GET","/api/events/"+eventId,token),"event");
        Require(BridgeController.Text(BridgeController.Section(decided,"decision"),"choice")=="approve","审批回传未记录");checks.Add("fake approval uses the real decision API");
        var reset=await controller.Request("POST","/api/local/pairing/reset",hook);Require(BridgeController.Text(reset,"code")!=""&&!BridgeController.Flag(reset,"paired"),"重新配对失败");
        bool revoked=false;try{await controller.Request("GET","/api/events",token);}catch(WebException error){using(var response=error.Response as HttpWebResponse)revoked=response!=null&&response.StatusCode==HttpStatusCode.Unauthorized;}
        Require(revoked,"旧手机权限未撤销");checks.Add("re-pair revokes old phone credentials");
        var owner=controller.Owned;controller.Owned=null;
        string file=Path.Combine(controller.Data,"config.json"),original=File.ReadAllText(file);
        try {
            var wrong=BridgeController.Parse(original);wrong["hookToken"]="wrong-isolated-credential";BridgeController.SaveJson(file,wrong);
            bool rejected=false;try{await controller.Start();}catch(WebException error){using(var response=error.Response as HttpWebResponse)rejected=response!=null&&response.StatusCode==HttpStatusCode.Unauthorized;}
            Require(rejected&&controller.Owned==null&&await controller.Health()!=null,"其他资料目录接管了已有服务");checks.Add("wrong-profile service is rejected");
        }finally{File.WriteAllText(file,original);}
        try{await controller.Start();Require(controller.Reused&&controller.Owned==null,"外部服务未复用");controller.Stop();Require(await controller.Health()!=null,"复用服务被停止");checks.Add("external service is preserved on exit");}finally{controller.Owned=owner;}
        controller.Stop();Require(await controller.Health()==null,"自有服务未退出");checks.Add("owned service stops through its private pipe");
        await controller.Start();await Ready(controller);controller.Owned.StandardInput.Close();Require(controller.Owned.WaitForExit(5000)&&await controller.Health()==null,"断开控制器留下孤儿服务");checks.Add("controller pipe closure leaves no orphan");
        bool valid=false;try{BridgeController.ValidAddress("http://localhost/?token=secret");}catch(InvalidOperationException){valid=true;}Require(valid,"地址未校验");checks.Add("invalid access URL is rejected");
        BridgeController.SaveJson(Path.Combine(controller.Home,"self-test.json"),new{passed=checks.Count,checks});
    }
    internal static async Task Window(BridgeWindow window,BridgeController controller) {
        window.View.Left=-12000;window.View.Top=-12000;
        var parse=typeof(BridgeController).GetMethod("ParseTailscale",BindingFlags.Static|BindingFlags.NonPublic);
        Require(parse!=null,"缺少 Tailscale 状态检测");
        Func<string,Dictionary<string,object>> state=json=>(Dictionary<string,object>)parse.Invoke(null,new object[]{json});
        Require(BridgeController.Text(state("{\"BackendState\":\"Running\",\"Self\":{\"Online\":true,\"DNSName\":\"computer.example.ts.net.\"}}"),"state")=="connected","Tailscale 在线状态错误");
        Require(BridgeController.Text(state("{\"BackendState\":\"Running\",\"Self\":{\"Online\":true,\"DNSName\":\"computer.example.ts.net.\"}}"),"address")=="https://computer.example.ts.net","Tailscale 地址读取失败");
        Require(BridgeController.Text(state("{\"BackendState\":\"Stopped\"}"),"state")=="stopped","已安装未开启不能显示在线");
        Require(BridgeController.Text(state("{\"BackendState\":\"NeedsLogin\"}"),"state")=="login","未登录状态错误");
        Require(BridgeController.Text(state("{\"BackendState\":\"Running\",\"Self\":{\"Online\":false}}"),"state")=="disconnected","未连接不能显示在线");
        Require(BridgeController.Text(state("{\"BackendState\":\"Starting\"}"),"state")=="unavailable","尚未完成连接不能显示在线");
        Require(BridgeController.Text(state("{\"BackendState\":\"NeedsMachineAuth\"}"),"state")=="authorization","设备授权状态错误");
        Require(BridgeController.Text(state("not json"),"state")=="unavailable","检测失败不能误报成未安装");
        var detect=typeof(BridgeController).GetMethod("DetectTailscale",BindingFlags.Instance|BindingFlags.NonPublic);
        Require(detect!=null,"缺少 Tailscale 安装检测");
        var missing=await (Task<Dictionary<string,object>>)detect.Invoke(controller,new object[]{Path.Combine(controller.Home,"not-installed","tailscale.exe")});
        Require(BridgeController.Text(missing,"state")=="missing","未安装状态错误");
        var failed=await controller.DetectTailscale(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"whoami.exe"));
        Require(BridgeController.Text(failed,"state")=="unavailable","CLI 调用失败不能误报未安装");
        Require(window.Control<TextBlock>("TailscaleState")!=null&&window.Button("TailscaleAction")!=null&&window.Button("TailscaleRefresh")!=null,"缺少 Tailscale 状态或恢复按钮");
        window.ShowTailscale(missing);Require((string)window.Button("TailscaleAction").Content=="去安装","未安装没有提供安装入口");
        window.ShowTailscale(state("{\"BackendState\":\"Stopped\"}"));Require(window.Control<TextBlock>("TailscaleState").Text.Contains("未开启"),"未开启没有显示操作提示");
        window.ShowTailscale(state("not json"));Require((string)window.Button("TailscaleAction").Content=="打开 Tailscale","检测失败误导用户重新安装");
        window.ShowTailscale(state("{\"BackendState\":\"Running\",\"Self\":{\"Online\":true}}"));
        Require(window.Control<TextBlock>("TailscaleState").Text.Contains("电脑端已连接"),"在线提示未区分电脑与手机");
        window.ShowPairing(new Dictionary<string,object>{{"paired",true}});
        Require(window.Button("AddDevice").IsEnabled&&window.Control<TextBlock>("PairCode").Text=="已配对","已配对后不能添加设备");
        window.ShowPairing(new Dictionary<string,object>{{"paired",true},{"code","ABCD2345"},{"expiresAt",DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()+300000}});
        Require(window.Control<TextBlock>("PairCode").Text=="ABCD2345"&&window.Control<TextBlock>("PairHint").Text.Contains("原设备保留"),"添加设备码被已有配对状态隐藏");
        window.Control<TextBox>("Address").Text="https://your-computer.example.ts.net";
        window.Control<TextBlock>("ServiceState").Text="设备已配对 · 服务运行中";window.Control<TextBlock>("Badge").Text="服务在线";
        string chatSummary=BridgeWindow.ChatSummary(new Dictionary<string,object>{{"devices",2},{"threads",new object[]{new Dictionary<string,object>{{"title","手机 · Agent Bridge 开发"},{"connected",true}},new Dictionary<string,object>{{"title","iPad · 独立聊天"},{"connected",true}}}},{"errors",new object[0]}});
        Require(chatSummary.Contains("2 台设备")&&chatSummary.Contains("2 个聊天")&&chatSummary.Contains("iPad"),"多设备聊天摘要未显示");
        window.Control<TextBlock>("ChatState").Text=chatSummary;
        window.Button("Test").IsEnabled=true;
        window.ToggleLogs();Require(window.Control<Border>("LogPanel").Visibility==Visibility.Visible,"日志没有展开");window.ToggleLogs();
        Require(window.Control<Border>("LogPanel").Visibility==Visibility.Collapsed,"日志没有收起");
        window.View.UpdateLayout();var scales=new[]{100,125,150,200};
        foreach(int scale in scales){
            var root=(FrameworkElement)window.View.Content;double factor=scale/100.0;
            var bitmap=new RenderTargetBitmap((int)Math.Ceiling(root.ActualWidth*factor),(int)Math.Ceiling(root.ActualHeight*factor),96*factor,96*factor,PixelFormats.Pbgra32);
            bitmap.Render(root);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using(var stream=File.Create(Path.Combine(controller.Home,"desktop-"+scale+".png")))encoder.Save(stream);
        }
        window.View.Close();Require(!window.View.IsVisible,"关闭窗口未隐藏到托盘");
        using(var duplicate=Process.Start(new ProcessStartInfo{FileName=Assembly.GetExecutingAssembly().Location,Arguments="--check",UseShellExecute=false,CreateNoWindow=true})){
            for(int i=0;i<100&&!duplicate.HasExited;i++)await Task.Delay(100);
            Require(duplicate.HasExited&&duplicate.ExitCode==0,"重复启动未退出");
            for(int i=0;i<20&&!window.ActivationObserved;i++)await Task.Delay(100);
            Require(window.ActivationObserved&&window.View.IsVisible,"重复启动未唤回隐藏窗口");
        }
        window.View.Hide();window.Restore();Require(window.View.IsVisible,"托盘无法恢复窗口");
        var live=await controller.DetectTailscale();
        BridgeController.SaveJson(Path.Combine(controller.Home,"window-check.json"),new{ui="WPF",singleInstance=true,trayRestore=true,tailscaleStates=true,liveTailscaleState=BridgeController.Text(live,"state"),scales});
        window.Quit();
    }
}
