// Presentation-only demo: this page never connects to or controls a real Codex chat.
const demos={
  chat:{title:'Codex 已完成回复',text:'更新项目首页 · 点击查看完整内容',nav:0,html:'<div class="phone-message">把下载按钮再突出一点。</div><div class="phone-reply"><div class="phone-reply-label"><span class="assistant-symbol">✳</span>最新回复</div><p>首页已更新，下载入口更清晰了。</p><p class="phone-reply-detail">调整了按钮层级，保留各设备的下载与使用入口。</p><div class="phone-reply-meta"><svg class="icon"><use href="#i-check"/></svg>耗时 1 分 24 秒 · 09:41 完成</div></div>'},
  approval:{title:'Codex 正在等待你的决定',text:'更新项目首页 · 查看请求后再批准',nav:1,html:'<div class="phone-reply"><div class="approval-label">待审批 · 更新项目首页</div><p><strong>允许修改首页样式文件吗？</strong></p><div class="approval-command">修改 assets/site.css</div><p class="phone-reply-detail">原因：调整下载按钮的间距与颜色。</p><div class="approval-actions"><button type="button" data-choice="approve">批准</button><button type="button" data-choice="deny">拒绝</button></div><p class="approval-result" hidden></p></div>'},
  done:{title:'你关注的任务已完成',text:'更新项目首页 · 耗时 1 分 24 秒',nav:0,html:'<div class="phone-reply"><div class="phone-reply-label"><svg class="icon" style="width:14px;height:14px"><use href="#i-check"/></svg>本轮已完成</div><p class="demo-complete-title">首页修改完成。</p><ul class="demo-complete-points"><li>保留清晰的下载入口</li><li>适配手机与 iPad 屏幕</li><li>整理了使用步骤</li></ul><div class="phone-reply-meta">耗时 1 分 24 秒 · 09:41 完成</div><p class="demo-complete-note">手机显示最新完整回复。</p></div>'}
};
const demoContent=document.querySelector('#demo-content');
for(const button of document.querySelectorAll('[data-demo]'))button.addEventListener('click',()=>{
  const demo=demos[button.dataset.demo];
  for(const item of document.querySelectorAll('[data-demo]'))item.setAttribute('aria-pressed',String(item===button));
  demoContent.innerHTML=demo.html;
  document.querySelector('#notification-title').textContent=demo.title;
  document.querySelector('#notification-text').textContent=demo.text;
  document.querySelectorAll('.phone-nav>span').forEach((item,index)=>item.classList.toggle('active',index===demo.nav));
});
demoContent.addEventListener('click',event=>{
  const button=event.target.closest('[data-choice]');if(!button)return;
  const result=demoContent.querySelector('.approval-result');result.hidden=false;
  result.textContent=button.dataset.choice==='approve'?'演示：批准已回传电脑。':'演示：请求已拒绝。';
  demoContent.querySelector('.approval-actions').remove();
});
const menu=document.querySelector('.menu-button'),nav=document.querySelector('#site-nav');
function closeMenu(){menu.setAttribute('aria-expanded','false');menu.setAttribute('aria-label','展开导航');nav.classList.remove('is-open');}
menu.addEventListener('click',()=>{const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'收起导航':'展开导航');nav.classList.toggle('is-open',open);});
nav.addEventListener('click',event=>{if(event.target.closest('a'))closeMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu();});
const guides={
  ipad:{title:'把 Agent Bridge 放到 iPad 主屏幕',html:'<ol class="guide-steps"><li><strong>先准备好电脑</strong>打开 Windows 或 Mac 版 Agent Bridge 与 Codex。电脑已配置 Tailscale HTTPS 地址，且 iPad 已加入同一个 Tailscale 私有网络。</li><li><strong>在 Safari 打开电脑的地址</strong>从电脑控制窗口复制 HTTPS 地址，在 iPad 的 Safari 中打开。这个介绍网站不是电脑的控制地址。</li><li><strong>添加到主屏幕</strong>点 Safari 的分享按钮，选择“添加到主屏幕”，名称设为 Agent Bridge。如果出现“作为网页 App 打开”，保持开启。</li><li><strong>配对并开启通知</strong>从主屏幕图标打开，输入电脑配对码，再选择聊天。需要通知时，在设置页允许网页通知。</li></ol><p class="guide-note">网页通知需要 iOS / iPadOS 16.4 或以上。请保持电脑在线和两端 Tailscale 运行；省电和网络状况可能影响提醒到达。</p>'},
  mac:{title:'在 Mac 安装 Agent Bridge',html:'<ol class="guide-steps"><li><strong>确认电脑型号</strong>此预览包针对 Apple 芯片 Mac；Intel 版尚未完成实际接入验收。电脑还需已安装并登录 Codex 桌面应用。</li><li><strong>安装 App</strong>下载 DMG，打开后将 Agent Bridge.app 拖入“应用程序”，再从“应用程序”启动。此包仅用本地测试签名、未经苹果公证；若 macOS 拦截，请在系统设置的“隐私与安全性”中审核后选择打开，不需要关闭系统安全保护。</li><li><strong>连接私有网络</strong>Mac 与手机或 iPad 登录同一 Tailscale 网络。按照 Tailscale 提示为本机 <code>http://127.0.0.1:4571</code> 配置 Serve HTTPS，把生成的 Mac HTTPS 地址填入 Agent Bridge 窗口。</li><li><strong>配对并选择聊天</strong>在电脑窗口添加设备，移动端填入 Mac 的 HTTPS 地址和配对码，选择 Mac 上已有的 Codex 聊天。保持 Codex、Agent Bridge 与 Tailscale 运行。</li></ol><p class="guide-note">此包已在一台 Apple 芯片 Mac 上构建并完成用户测试。Mac 上未选聊天的后台待办提醒仍待单独验收。</p>'},
  setup:{title:'首次连接配置',html:'<ol class="guide-steps"><li><strong>选择电脑版本</strong>Windows 版要求 Windows 10 1809+ x64 和 .NET Framework 4.8；Mac 预览版目前针对 Apple 芯片。两版均内置 Node.js。电脑还需安装并登录 Codex 桌面应用。</li><li><strong>配置 Tailscale 私有网络</strong>电脑与移动设备登录同一私有网络。电脑需开启 Serve HTTPS，将地址转发到本机 Agent Bridge，默认地址为 <code>http://127.0.0.1:4571</code>。手机使用实际运行 Agent Bridge 的那台电脑的 HTTPS 地址。</li><li><strong>审核可选 Codex hooks</strong>桌面聊天连接可直接使用 Codex 本地通道；若需另外接入 hooks，请先审核配置，并在 Codex 中确认信任。首次网络配置仍需手动完成。</li><li><strong>添加移动设备</strong>电脑首次配对，或点“添加设备”生成新码。Android 输入电脑 HTTPS 地址与配对码；iPad 先在 Safari 打开地址，再配对。配对成功后选择已在电脑加载的聊天。</li></ol><p class="guide-note">详细命令见本页<a href="#serve">Serve HTTPS 配置步骤</a>；Tailscale 下载见<a href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">官方网站</a>。如果已有其他 Serve 转发，请先检查配置，避免覆盖现有服务。</p>'}
};
const dialog=document.querySelector('#guide-dialog');
let previousFocus;
for(const button of document.querySelectorAll('[data-guide]'))button.addEventListener('click',()=>{const guide=guides[button.dataset.guide];document.querySelector('#guide-title').textContent=guide.title;document.querySelector('#guide-body').innerHTML=guide.html;previousFocus=button;dialog.showModal();});
function closeGuide(){dialog.close();previousFocus?.focus();}
dialog.querySelector('.dialog-close').addEventListener('click',closeGuide);
dialog.querySelector('.dialog-done').addEventListener('click',closeGuide);
dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const box=dialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)closeGuide();});
