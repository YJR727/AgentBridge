package dev.agentbridge.phone;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.text.InputType;
import org.json.JSONArray;
import org.json.JSONObject;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private TextView feedback, connection;
    private TextView emptyPending;
    private EditText address, code;
    private LinearLayout events;
    private LinearLayout pairing;
    private Button pair;
    private boolean visible;
    private ChatPanel chat;
    private android.widget.FrameLayout pages;
    private View chatPage, pendingPage, settingsPage;
    private LinearLayout navigation;
    private LinearLayout[] tabs;
    private android.widget.ImageView[] tabIcons;
    private TextView[] tabLabels;
    private android.widget.Switch listening;
    private boolean syncingSwitch, refreshingEvents;
    private long lastEventRefresh;
    private int currentPage, nativeCount, eventCount;
    private JSONArray recentEvents = new JSONArray();
    private final Runnable updateStatus = new Runnable() {
        @Override public void run() {
            if (!visible) return;
            String state = prefs.getString("status", "尚未开启后台连接");
            long last = prefs.getLong("lastSeen", 0);
            connection.setText(state + (last > 0 ? "\n上次连接 " + time(last) : ""));
            syncingSwitch=true;listening.setChecked(prefs.getBoolean("listening",false));syncingSwitch=false;
            if(System.currentTimeMillis()-lastEventRefresh>8000){lastEventRefresh=System.currentTimeMillis();refresh();}
            handler.postDelayed(this, 1000);
        }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);prefs=BridgeApi.prefs(this);
        if(Build.VERSION.SDK_INT>=30)getWindow().setDecorFitsSystemWindows(false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);getWindow().setNavigationBarColor(Color.WHITE);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        LinearLayout root=Ui.column(this);root.setBackgroundColor(Ui.BG);
        pages=new android.widget.FrameLayout(this);root.addView(pages,new LinearLayout.LayoutParams(-1,0,1));
        chat=new ChatPanel(this,()->showPage(1));chat.onPendingChanged(n->{nativeCount=n;updateTabs();});chatPage=chat;pages.addView(chatPage,new android.widget.FrameLayout.LayoutParams(-1,-1));
        LinearLayout todo=Ui.column(this);todo.setPadding(dp(20),dp(12),dp(20),dp(24));pendingPage=Ui.scroll(this,todo);pages.addView(pendingPage,new android.widget.FrameLayout.LayoutParams(-1,-1));
        Ui.text(this,todo,"待办",28,true);TextView help=Ui.text(this,todo,"需要回答的问题与待审批的申请",14,false);help.setTextColor(Ui.MUTED);
        todo.addView(chat.pendingView(),Ui.width());events=Ui.column(this);todo.addView(events,Ui.width());
        emptyPending=Ui.text(this,todo,"当前没有待办，新的问题和申请会显示在这里。",16,false);emptyPending.setTextColor(Ui.MUTED);
        Ui.button(this,todo,"查看近期记录",this::history,false);
        LinearLayout settings=Ui.column(this);settings.setPadding(dp(20),dp(12),dp(20),dp(24));settingsPage=Ui.scroll(this,settings);pages.addView(settingsPage,new android.widget.FrameLayout.LayoutParams(-1,-1));
        Ui.text(this,settings,"设置",28,true);feedback=Ui.text(this,settings,"",14,false);feedback.setTextColor(Ui.MUTED);feedback.setVisibility(View.GONE);
        LinearLayout computer=Ui.card(this,settings);Ui.text(this,computer,"电脑连接",17,true);
        connection=Ui.text(this,computer,"尚未连接",14,false);connection.setTextColor(Ui.TEAL);
        Ui.text(this,computer,"电脑的 Tailscale HTTPS 地址",14,true);address=new EditText(this);address.setTextSize(16);address.setSingleLine(true);address.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI);address.setHint("https://电脑名.tail…ts.net");address.setText(prefs.getString("url",""));computer.addView(address,Ui.width());
        pairing=Ui.column(this);Ui.text(this,pairing,"电脑控制窗显示的配对码",14,true);code=new EditText(this);code.setTextSize(16);code.setSingleLine(true);code.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS|InputType.TYPE_TEXT_VARIATION_PASSWORD);pairing.addView(code,Ui.width());pair=Ui.button(this,pairing,"确认配对",this::pairComputer,true);
        pairing.setVisibility(prefs.getString("token","").isEmpty()?View.VISIBLE:View.GONE);
        Ui.button(this,computer,"重新配对  ›",()->{pairing.setVisibility(pairing.getVisibility()==View.VISIBLE?View.GONE:View.VISIBLE);if(pairing.getVisibility()==View.VISIBLE)code.requestFocus();},false);computer.addView(pairing,Ui.width());
        LinearLayout notifications=Ui.card(this,settings);Ui.text(this,notifications,"通知与后台",17,true);
        listening=new android.widget.Switch(this);listening.setText("后台连接");listening.setTextColor(Ui.INK);listening.setTextSize(16);listening.setMinHeight(dp(52));listening.setButtonTintList(android.content.res.ColorStateList.valueOf(Ui.TEAL));notifications.addView(listening,Ui.width());
        listening.setOnCheckedChangeListener((view,checked)->{if(syncingSwitch)return;if(checked)startListening();else{prefs.edit().putBoolean("listening",false).putString("status","连接已停止").apply();stopService(new Intent(this,BridgeService.class));message("后台连接已停止");}});
        Ui.button(this,notifications,"通知与电池设置  ›",()->new AlertDialog.Builder(this).setTitle("允许后台接收提醒").setMessage("允许手机桥通知，并让手机桥与 Tailscale 在后台运行。后台连接会增加耗电，您可以关闭上方开关停止连接。").setPositiveButton("应用设置",(d,w)->startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,android.net.Uri.parse("package:"+getPackageName())))).setNeutralButton("电池设置",(d,w)->startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))).setNegativeButton("关闭",null).show(),false);
        LinearLayout tools=Ui.card(this,settings);Ui.text(this,tools,"工具",17,true);
        Ui.button(this,tools,"发送测试审批  ›",()->{if(!prefs.getBoolean("listening",false)){message("请先开启后台连接");return;}run(()->{BridgeApi.call(this,"/api/native/poll",null);BridgeApi.call(this,"/api/admin/test-event",new JSONObject().put("kind","decision"));return "测试申请已创建，不会执行电脑命令";},()->{refresh();showPage(1);});},false);
        Ui.button(this,tools,"关于手机桥  ›",()->new AlertDialog.Builder(this).setTitle("Agent Bridge · 0.4.2").setMessage("每台设备独立选择聊天，所有运行聊天的审批和问题汇总到待办。电脑和手机的 Tailscale 需保持在线。").setPositiveButton("关闭",null).show(),false);
        navigation=new LinearLayout(this);navigation.setBackgroundColor(Color.WHITE);navigation.setPadding(dp(12),dp(4),dp(12),dp(4));
        tabs=new LinearLayout[3];tabIcons=new android.widget.ImageView[3];tabLabels=new TextView[3];String[] labels={"聊天","待办","设置"};int[] icons={R.drawable.ic_chat,R.drawable.ic_pending,R.drawable.ic_settings};
        for(int i=0;i<3;i++){
            final int page=i;LinearLayout tab=Ui.column(this);tabs[i]=tab;tab.setGravity(android.view.Gravity.CENTER);tab.setMinimumHeight(dp(60));tab.setPadding(0,dp(4),0,dp(4));tab.setFocusable(true);
            tab.setBackground(new android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(0x180F766E),null,Ui.background(this,Color.WHITE,12)));
            android.widget.ImageView icon=new android.widget.ImageView(this);tabIcons[i]=icon;icon.setImageResource(icons[i]);icon.setPadding(dp(16),dp(3),dp(16),dp(3));icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);tab.addView(icon,new LinearLayout.LayoutParams(dp(56),dp(28)));
            TextView label=new TextView(this);tabLabels[i]=label;label.setText(labels[i]);label.setTextSize(12);label.setGravity(android.view.Gravity.CENTER);label.setSingleLine(true);label.setEllipsize(android.text.TextUtils.TruncateAt.END);label.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);LinearLayout.LayoutParams caption=new LinearLayout.LayoutParams(-1,-2);caption.topMargin=dp(3);tab.addView(label,caption);
            tab.setOnClickListener(v->showPage(page));LinearLayout.LayoutParams slot=new LinearLayout.LayoutParams(0,-2,1);if(i>0)slot.leftMargin=dp(8);navigation.addView(tab,slot);
        }
        root.addView(navigation,Ui.width());Ui.insets(root,keyboard->navigation.setVisibility(keyboard?View.GONE:View.VISIBLE));setContentView(root);showPage(state==null?(prefs.getString("token","").isEmpty()?2:0):state.getInt("page",0));
    }
    private void showPage(int page){currentPage=page;chatPage.setVisibility(page==0?View.VISIBLE:View.GONE);pendingPage.setVisibility(page==1?View.VISIBLE:View.GONE);settingsPage.setVisibility(page==2?View.VISIBLE:View.GONE);updateTabs();}
    private void updateTabs(){if(tabs==null)return;String[] names={"聊天","待办","设置"};int count=nativeCount+eventCount;chat.pendingCount(count);emptyPending.setVisibility(count==0?View.VISIBLE:View.GONE);for(int i=0;i<3;i++){boolean selected=i==currentPage;String label=names[i]+(i==1&&count>0?" · "+count:"");tabs[i].setSelected(selected);tabs[i].setContentDescription(label+(selected?"，当前页面":""));tabLabels[i].setText(label);tabLabels[i].setTextColor(selected?Ui.TEAL:Ui.MUTED);tabLabels[i].setTypeface(android.graphics.Typeface.DEFAULT,selected?android.graphics.Typeface.BOLD:android.graphics.Typeface.NORMAL);tabIcons[i].setColorFilter(selected?Ui.TEAL:Ui.MUTED);Ui.surface(tabIcons[i],selected?Ui.PALE:Color.TRANSPARENT,14);}}
    @Override protected void onSaveInstanceState(Bundle state){state.putInt("page",currentPage);super.onSaveInstanceState(state);}
    @Override public void onBackPressed(){if(currentPage!=0)showPage(0);else super.onBackPressed();}
    private void history(){Ui.Detail d=new Ui.Detail(this,"近期记录");if(recentEvents.length()==0)Ui.text(this,d.body,"还没有记录",16,false);for(int i=0;i<recentEvents.length();i++){JSONObject e=recentEvents.optJSONObject(i);if(e!=null)Ui.button(this,d.body,e.optString("title")+"\n"+eventLabel(e)+" · "+time(e.optLong("createdAt")),()->detail(e.optString("id")),false);}}

    private void pairComputer() {
        final String base;
        try { base = UrlPolicy.normalize(address.getText().toString()); }
        catch (Exception error) { message(error.getMessage()); return; }
        final String entered = code.getText().toString().trim().toUpperCase(Locale.ROOT);
        if (entered.isEmpty()) { message("请输入电脑显示的配对码"); return; }
        pair.setEnabled(false);
        feedback.setText("正在配对…");feedback.setVisibility(View.VISIBLE);
        network.execute(() -> {
            try {
                JSONObject result = BridgeApi.request(base, "", "/api/pair", new JSONObject().put("code", entered));
                String token = result.getString("token");
                stopService(new Intent(this, BridgeService.class));
                String deviceId=BridgeApi.deviceId(this);
                prefs.edit().clear().putString("deviceId",deviceId).putString("url", base).putString("token", token).putString("status", "配对成功，尚未开启后台连接").commit();
                ui(() -> { code.setText(""); pairing.setVisibility(View.GONE);getSystemService(android.view.inputmethod.InputMethodManager.class).hideSoftInputFromWindow(code.getWindowToken(),0);chat.requestRefresh(); message("配对成功，请开启后台连接"); refresh(); });
            } catch (Exception error) { ui(() -> message(error.getMessage())); }
            finally { ui(() -> pair.setEnabled(true)); }
        });
    }

    private void startListening() {
        if (prefs.getString("token", "").isEmpty()) { message("请先配对电脑"); return; }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
            return;
        }
        if (!getSystemService(android.app.NotificationManager.class).areNotificationsEnabled()) {
            message("请先在系统设置中允许手机桥通知"); return;
        }
        prefs.edit().putBoolean("listening", true).putString("status", "正在连接电脑…").apply();
        try { startForegroundService(new Intent(this, BridgeService.class)); message("后台连接已开启，稍后查看连接状态"); }
        catch (Exception error) { prefs.edit().putBoolean("listening", false).apply(); message("系统拒绝后台连接，请在应用设置中检查权限"); }
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == 1 && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) startListening();
        else message("未允许通知，后台提醒尚未开启");
    }

    private void refresh() {
        if(prefs.getString("token","").isEmpty()||refreshingEvents)return;refreshingEvents=true;
        network.execute(()->{try{JSONArray list=BridgeApi.call(this,"/api/events?limit=30",null).getJSONArray("events");ui(()->{
            recentEvents=list;events.removeAllViews();eventCount=0;
            for(int i=0;i<list.length();i++){JSONObject e=list.optJSONObject(i);if(e==null||!e.optBoolean("needsDecision")||!"pending".equals(e.optString("state"))||e.optLong("expiresAt")<=System.currentTimeMillis())continue;
                eventCount++;LinearLayout box=Ui.card(this,events);TextView category=Ui.text(this,box,e.optString("threadTitle",e.optString("sessionId"))+" · 需要审批",13,true);category.setTextColor(Ui.TEAL);TextView heading=Ui.text(this,box,Markdown.plain(e.optString("title")),17,true);heading.setMaxLines(3);heading.setEllipsize(android.text.TextUtils.TruncateAt.END);TextView summary=Ui.text(this,box,Markdown.plain(e.optString("summary")),14,false);summary.setMaxLines(3);summary.setEllipsize(android.text.TextUtils.TruncateAt.END);Ui.button(this,box,"查看申请详情  ›",()->detail(e.optString("id")),false);
            }updateTabs();
        });}catch(Exception error){ui(()->message("刷新失败："+error.getMessage()));}finally{ui(()->refreshingEvents=false);}});
    }

    private void detail(String id) {
        if(!id.matches("[A-Za-z0-9_-]+"))return;showPage(1);
        network.execute(()->{try{JSONObject event=BridgeApi.call(this,"/api/events/"+id,null).getJSONObject("event");ui(()->{
            Ui.Detail d=new Ui.Detail(this,"审批与事件详情");Ui.text(this,d.body,event.optString("title"),21,true);LinearLayout summary=Ui.column(this);d.body.addView(summary,Ui.width());Ui.markdown(this,summary,event.optString("summary"));
            Ui.text(this,d.body,"状态："+eventLabel(event),14,false);
            Button expand=Ui.button(this,d.body,"查看完整内容与参数  ⌄",()->{},false);LinearLayout full=Ui.column(this);d.body.addView(full,Ui.width());String body=event.optString("body");if(body.startsWith("{"))Ui.code(this,full,body);else Ui.markdown(this,full,body);Ui.text(this,full,"目录："+event.optString("cwd","—")+"\n来源："+event.optString("source","—")+"\n任务："+event.optString("sessionId","—")+"\n时间："+time(event.optLong("createdAt")),13,false);full.setVisibility(View.GONE);expand.setOnClickListener(v->{boolean visible=full.getVisibility()!=View.VISIBLE;full.setVisibility(visible?View.VISIBLE:View.GONE);expand.setText(visible?"收起完整内容与参数  ⌃":"查看完整内容与参数  ⌄");});
            boolean active=event.optBoolean("needsDecision")&&"pending".equals(event.optString("state"))&&event.optLong("expiresAt")>System.currentTimeMillis();
            d.feedback.setText(active?"请确认完整内容后决定，只处理这次申请。":"此事件已处理、过期或取消。");
            if(active)for(String choice:new String[]{"deny","approve"}){
                Button action=d.action(this,choice.equals("approve")?"批准":"拒绝",()->{d.submitted=true;d.disable();d.feedback.setText("正在回传…");network.execute(()->{try{JSONObject r=BridgeApi.call(this,"/api/events/"+id+"/decision",new JSONObject().put("choice",choice).put("via","android-app"));if(!r.optBoolean("ok")||!choice.equals(r.getJSONObject("decision").optString("choice")))throw new Exception("服务未接受选择");ui(()->{d.feedback.setText("选择已回传电脑，请查看对应任务结果。");refresh();});}catch(Exception e){ui(()->d.feedback.setText(e.getMessage()));}});},choice.equals("approve"));if(choice.equals("deny"))Ui.styleButton(action,Color.WHITE,Ui.RED);
            }
            if(active){Runnable expiry=()->{if(!d.submitted&&d.dialog.isShowing()){d.disable();d.feedback.setText("此申请已过期，不能继续提交。");}};handler.postDelayed(expiry,Math.max(0,event.optLong("expiresAt")-System.currentTimeMillis()));d.dialog.setOnDismissListener(dialog->handler.removeCallbacks(expiry));}
        });}catch(Exception e){ui(()->message("详情加载失败："+e.getMessage()));}});
    }

    interface Task { String execute() throws Exception; }
    private void run(Task task, Runnable after) {
        feedback.setText("正在处理…");feedback.setVisibility(View.VISIBLE);
        network.execute(() -> {
            try { String result = task.execute(); ui(() -> { message(result); if (after != null) after.run(); }); }
            catch (Exception error) { ui(() -> message("操作失败：" + error.getMessage())); }
        });
    }
    private void ui(Runnable action) {
        runOnUiThread(() -> { if (!isFinishing() && !isDestroyed()) action.run(); });
    }
    private void message(String value) {
        String text = value == null ? "操作失败，请检查网络与电脑服务" : value;
        feedback.setText(text);feedback.setVisibility(View.VISIBLE);
        Toast.makeText(this, text, Toast.LENGTH_LONG).show();
    }
    private static String label(String state) {
        switch (state) { case "pending": return "等待决定"; case "resolved": return "选择已记录"; case "expired": return "已过期"; case "cancelled": return "已取消"; default: return "已记录"; }
    }
    private static String eventLabel(JSONObject event) {
        JSONObject decision = event.optJSONObject("decision");
        if ("resolved".equals(event.optString("state")) && decision != null) {
            return "approve".equals(decision.optString("choice")) ? "已记录：批准" : "deny".equals(decision.optString("choice")) ? "已记录：拒绝" : "选择已记录";
        }
        return label(event.optString("state"));
    }
    private static String time(long value) { return new SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault()).format(new Date(value)); }
    private int dp(int size) { return Math.round(size * getResources().getDisplayMetrics().density); }
    private void openNotification() {
        String thread = getIntent().getStringExtra("codexThreadId");
        if (thread != null) { showPage(1);chat.notification(thread, getIntent().getStringExtra("questionId"),getIntent().getStringExtra("turnId")); getIntent().removeExtra("codexThreadId"); getIntent().removeExtra("questionId");getIntent().removeExtra("turnId"); return; }
        String id = getIntent().getStringExtra("eventId");
        if (id != null && !prefs.getString("token", "").isEmpty()) {
            getIntent().removeExtra("eventId");
            detail(id);
        }
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); if (visible) openNotification(); }
    @Override protected void onResume() { super.onResume(); visible = true; handler.post(updateStatus); chat.resume(); refresh(); openNotification(); }
    @Override protected void onPause() { visible = false; handler.removeCallbacks(updateStatus); chat.pause(); super.onPause(); }
    @Override protected void onDestroy() { handler.removeCallbacksAndMessages(null);chat.close(); network.shutdownNow(); super.onDestroy(); }
}
