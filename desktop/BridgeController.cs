using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// Existing HTTP API and service, with one owner. No desktop scripting runtime.
sealed class BridgeController : IDisposable {
    internal readonly string Home, Runtime, Data, LogPath, ProfileHash;
    internal string Address;
    internal Process Owned;
    internal bool Reused, Stopped;
    readonly string configPath;
    readonly object logLock = new object();
    internal BridgeController(string home, string runtime, string legacy) {
        Home=home; Runtime=runtime; LogPath=Path.Combine(home,"service.log");
        var saved=ReadJson(Path.Combine(home,"settings.json"));
        string overrideData=Environment.GetEnvironmentVariable("AGENT_BRIDGE_DATA");
        string previous=Text(saved,"dataDirectory");
        Data=Path.GetFullPath(!String.IsNullOrEmpty(overrideData) ? overrideData :
            !String.IsNullOrEmpty(previous) && Directory.Exists(previous) ? previous :
            File.Exists(Path.Combine(legacy,"data","config.json")) ? Path.Combine(legacy,"data") : Path.Combine(home,"data"));
        configPath=Path.Combine(Data,"config.json"); Address=Text(saved,"address");
        using(var sha=SHA256.Create()) ProfileHash=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(home.ToLowerInvariant()))).Replace("-","").Substring(0,16);
    }
    internal static Dictionary<string,object> ReadJson(string file) {
        return File.Exists(file) ? Parse(File.ReadAllText(file,Encoding.UTF8)) : new Dictionary<string,object>();
    }
    internal static Dictionary<string,object> Parse(string json) {
        try{return new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(json);}
        catch(ArgumentException){throw new InvalidDataException("返回的 JSON 数据无法读取。");}
    }
    internal static string Text(Dictionary<string,object> item,string key) { object value; return item!=null && item.TryGetValue(key,out value) && value!=null ? Convert.ToString(value) : ""; }
    internal static bool Flag(Dictionary<string,object> item,string key) { return Text(item,key)=="True"; }
    internal static Dictionary<string,object> Section(Dictionary<string,object> item,string key) { object value; return item!=null && item.TryGetValue(key,out value) ? value as Dictionary<string,object> : null; }
    internal static void SaveJson(string file,object value) {
        File.WriteAllText(file+".tmp",new JavaScriptSerializer().Serialize(value),new UTF8Encoding(false));
        if(File.Exists(file)) File.Replace(file+".tmp",file,null); else File.Move(file+".tmp",file);
    }
    internal Dictionary<string,object> Config() {
        var config=ReadJson(configPath);
        if(config.Count>0 && Text(config,"host")!="127.0.0.1")throw new InvalidOperationException("服务必须使用本机地址。");
        return config;
    }
    internal int Port() {
        string value=Environment.GetEnvironmentVariable("AGENT_BRIDGE_PORT");
        if(String.IsNullOrEmpty(value)) value=Text(Config(),"port");
        int port=String.IsNullOrEmpty(value)?4571:Int32.Parse(value);
        if(port<1 || port>65535)throw new InvalidOperationException("端口配置不正确。");
        return port;
    }
    internal Task<Dictionary<string,object>> Request(string method,string path,string token="",object body=null,int timeout=1500) {
        return Task.Run(()=>{
            var request=(HttpWebRequest)WebRequest.Create("http://127.0.0.1:"+Port()+path);
            request.Method=method; request.Proxy=null; request.Timeout=timeout; request.ReadWriteTimeout=timeout;
            if(!String.IsNullOrEmpty(token))request.Headers["Authorization"]="Bearer "+token;
            if(method=="POST") {
                request.ContentType="application/json; charset=utf-8";
                byte[] bytes=Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(body??new Dictionary<string,object>()));
                request.ContentLength=bytes.Length;
                using(var stream=request.GetRequestStream())stream.Write(bytes,0,bytes.Length);
            }
            using(var response=request.GetResponse())using(var reader=new StreamReader(response.GetResponseStream(),Encoding.UTF8))return Parse(reader.ReadToEnd());
        });
    }
    internal async Task<Dictionary<string,object>> Health() {
        try{return await Request("GET","/api/health",timeout:600);}catch(WebException){return null;}
    }
    internal async Task Start() {
        Stopped=false;
        if(Owned!=null && !Owned.HasExited)return;
        if(Owned!=null){Owned.Dispose();Owned=null;}
        var health=await Health();
        if(health!=null) {
            if(!Flag(health,"ok") || Text(health,"version")!="0.4.0" || !Flag(health,"addDevicePairing") || !Flag(health,"independentChats"))throw new InvalidOperationException("旧手机桥服务仍在运行，请先退出旧手机桥窗口，再启动新版。");
            var config=Config();
            if(config.Count==0)throw new InvalidOperationException("已有服务使用其他资料目录，请先退出原窗口。");
            await Request("GET","/api/local/pairing",Text(config,"hookToken"));
            Reused=true;return;
        }
        if(File.Exists(LogPath) && new FileInfo(LogPath).Length>1048576) {
            if(File.Exists(LogPath+".previous"))File.Delete(LogPath+".previous");
            File.Move(LogPath,LogPath+".previous");
        }
        // Set task-specific process variables; do not copy the Windows PATH/Path dictionary.
        Environment.SetEnvironmentVariable("AGENT_BRIDGE_DATA",Data);
        Environment.SetEnvironmentVariable("AGENT_BRIDGE_LOG",LogPath);
        Owned=new Process {StartInfo=new ProcessStartInfo {
            FileName=Path.Combine(Runtime,"node.exe"), Arguments=Launcher.Quote(Path.Combine(Runtime,"app","desktop","worker.mjs"))+" --desktop",
            WorkingDirectory=Path.Combine(Runtime,"app"), UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,
            RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true
        }};
        Owned.OutputDataReceived+=(s,e)=>{if(e.Data!=null)Log(e.Data);};
        Owned.ErrorDataReceived+=(s,e)=>{if(e.Data!=null)Log(e.Data);};
        if(!Owned.Start())throw new InvalidOperationException("无法启动服务。");
        Owned.BeginOutputReadLine();Owned.BeginErrorReadLine();Reused=false;
    }
    void Log(string line) { lock(logLock){try{File.AppendAllText(LogPath,line+Environment.NewLine,Encoding.UTF8);}catch(IOException){}} }
    internal void Stop() {
        Stopped=true;
        if(Owned==null)return;
        try {
            if(!Owned.HasExited) {
                try{Owned.StandardInput.WriteLine("shutdown");Owned.StandardInput.Flush();}catch(IOException){}
                if(!Owned.WaitForExit(3500)){Owned.Kill();Owned.WaitForExit(1000);}
            }
        }finally{Owned.Dispose();Owned=null;}
    }
    internal bool CanStop {get{return Owned!=null && !Owned.HasExited;}}
    internal void SaveSettings() {SaveJson(Path.Combine(Home,"settings.json"),new {dataDirectory=Data,address=Address});}
    internal static string ValidAddress(string value) {
        Uri uri;
        if(!Uri.TryCreate(value.Trim(),UriKind.Absolute,out uri)||uri.Scheme!="https"||uri.UserInfo!=""||uri.Query!=""||uri.Fragment!=""||uri.AbsolutePath!="/")throw new InvalidOperationException("请输入完整 HTTPS 地址，不含路径或查询参数。");
        return uri.GetLeftPart(UriPartial.Authority);
    }
    internal const string TailscaleInstallPage="https://tailscale.com/download/windows";
    internal static string TailscaleBinary(string name) {
        foreach(var directory in new[]{Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)}) {
            string file=Path.Combine(directory,"Tailscale",name);if(File.Exists(file))return file;
        }
        return "";
    }
    internal static Dictionary<string,object> ParseTailscale(string json) {
        var result=new Dictionary<string,object>{{"state","unavailable"},{"address",""}};
        try {
            var status=Parse(json);string backend=Text(status,"BackendState");var self=Section(status,"Self");
            if(backend=="Stopped")result["state"]="stopped";
            else if(backend=="NeedsLogin")result["state"]="login";
            else if(backend=="NeedsMachineAuth")result["state"]="authorization";
            else if(backend=="Running"&&Text(self,"Online")=="False")result["state"]="disconnected";
            else if(backend=="Running"&&Flag(self,"Online")) {
                result["state"]="connected";
                string name=Text(self,"DNSName").TrimEnd('.');
                if(name.EndsWith(".ts.net",StringComparison.OrdinalIgnoreCase)) {
                    try{result["address"]=ValidAddress("https://"+name);}catch(InvalidOperationException){}
                }
            }
        }catch(InvalidDataException){}
        return result;
    }
    internal async Task<Dictionary<string,object>> DetectTailscale(string binary=null) {
        if(binary==null)binary=TailscaleBinary("tailscale.exe");
        if(!File.Exists(binary))return new Dictionary<string,object>{{"state",binary==""&&TailscaleBinary("tailscale-ipn.exe")!=""?"unavailable":"missing"},{"address",""}};
        return await Task.Run(()=>{
            try {
                using(var process=new Process {StartInfo=new ProcessStartInfo {FileName=binary,Arguments="status --json",UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8}}) {
                    process.Start();var output=process.StandardOutput.ReadToEndAsync();process.StandardError.ReadToEndAsync();
                    if(!process.WaitForExit(2500)){process.Kill();process.WaitForExit(1000);}
                    else if(process.ExitCode==0)return ParseTailscale(output.Result);
                }
            }catch(System.ComponentModel.Win32Exception){}catch(IOException){}catch(InvalidOperationException){}
            return new Dictionary<string,object>{{"state","unavailable"},{"address",""}};
        });
    }
    public void Dispose(){Stop();}
}
