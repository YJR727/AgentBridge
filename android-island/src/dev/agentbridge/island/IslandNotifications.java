package dev.agentbridge.island;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.LinearLayout;
import android.widget.Switch;
import android.widget.TextView;
import org.json.JSONObject;

final class IslandNotifications {
    static final String RUNNING_TAG = "island-running";
    static final String TEST_TAG = "island-local-test";
    static final int RUNNING_ID = 4, TEST_ID = 5;
    static boolean enabled(Context c) { return BridgeApi.prefs(c).getBoolean("island", true); }
    static int protocol(Context c) {
        try { return Settings.System.getInt(c.getContentResolver(), "notification_focus_protocol", 0); }
        catch (Exception e) { return 0; }
    }
    static Boolean feature() {
        try {
            Object value = Class.forName("android.os.SystemProperties").getDeclaredMethod("getBoolean", String.class, boolean.class).invoke(null, "persist.sys.feature.island", false);
            return value instanceof Boolean ? (Boolean)value : null;
        } catch (Exception e) { return null; }
    }
    static Notification decorate(Context c, Notification notification, String title, String content, String compact, int seconds, boolean updating) {
        try {
            if (!enabled(c) || !IslandPolicy.canTest(protocol(c), feature())) return notification;
            JSONObject pic = new JSONObject().put("type", 1).put("pic", "miui.focus.pic_bridge");
            JSONObject text = new JSONObject().put("title", IslandPolicy.clip(compact, 4)).put("showHighlightColor", false);
            JSONObject left = new JSONObject().put("type", 1).put("picInfo", pic).put("textInfo", text);
            JSONObject island = new JSONObject().put("islandProperty", 1).put("islandTimeout", seconds)
                .put("bigIslandArea", new JSONObject().put("imageTextInfoLeft", left).put("picInfo", pic))
                .put("smallIslandArea", new JSONObject().put("picInfo", pic));
            JSONObject params = new JSONObject().put("protocol", 1).put("business", "agent_bridge_task")
                .put("filterWhenNoPermission", false).put("islandFirstFloat", !updating).put("enableFloat", false)
                .put("updatable", updating).put("reopen", "reopen").put("timeout", IslandPolicy.notificationMinutes("待审批".equals(compact) || "待回答".equals(compact), seconds))
                .put("ticker", IslandPolicy.clip(title, 40)).put("aodTitle", IslandPolicy.clip(title, 40))
                .put("param_island", island)
                .put("baseInfo", new JSONObject().put("type", 1).put("title", IslandPolicy.clip(title, 40)).put("content", IslandPolicy.clip(content, 100)))
                .put("picInfo", new JSONObject().put("type", 1).put("pic", "miui.focus.pic_bridge"));
            Bundle pics = new Bundle(); pics.putParcelable("miui.focus.pic_bridge", Icon.createWithResource(c, R.drawable.ic_launcher));
            notification.extras.putBundle("miui.focus.pics", pics);
            notification.extras.putString("miui.focus.param", new JSONObject().put("param_v2", params).toString());
        } catch (Exception e) {
            BridgeApi.prefs(c).edit().putString("islandError", "超级岛参数不可用，保留普通通知").apply();
        }
        return notification;
    }
    static void cancelRunning(Context c) { c.getSystemService(NotificationManager.class).cancel(RUNNING_TAG, RUNNING_ID); }
    static void running(Context c, JSONObject codex, boolean bridgeEnabled, IslandPolicy policy) {
        String id = codex == null ? "" : codex.optString("threadId");
        String state = codex == null ? "" : codex.optString("status");
        if (!bridgeEnabled || !enabled(c) || !IslandPolicy.canTest(protocol(c), feature()) || !policy.running(id, state, android.os.SystemClock.elapsedRealtime())) {
            cancelRunning(c); return;
        }
        String title = codex.optString("title", "Codex") + " · 正在处理";
        Notification n = new Notification.Builder(c, BridgeService.CONNECTION_CHANNEL).setSmallIcon(R.drawable.ic_stat_bridge)
            .setContentTitle(title).setContentText("点击查看当前聊天；完成或断开后结束")
            .setContentIntent(BridgeService.openApp(c)).setVisibility(Notification.VISIBILITY_PRIVATE)
            .setOngoing(true).setOnlyAlertOnce(true).setTimeoutAfter(15000).build();
        c.getSystemService(NotificationManager.class).notify(RUNNING_TAG, RUNNING_ID, decorate(c, n, title, "任务执行中，点击查看聊天", "处理中", 15, true));
    }
    static String diagnose(Context c) {
        int version = protocol(c); Boolean support = feature(); String permission = "无法确认";
        try {
            Bundle args = new Bundle(); args.putString("package", c.getPackageName());
            Bundle result = c.getContentResolver().call(Uri.parse("content://miui.statusbar.notification.public"), "canShowFocus", null, args);
            if (result != null && result.containsKey("canShowFocus")) permission = result.getBoolean("canShowFocus") ? "允许" : "未允许";
        } catch (Exception e) { /* Query unavailable: retain unknown, never claim permission. */ }
        return "系统协议：" + (version == 0 ? "无法确认" : String.valueOf(version))
            + "\n岛能力：" + (support == null ? "无法确认" : support ? "支持" : "未检测到支持")
            + "\n焦点通知权限：" + permission
            + "\n本包未配置小米平台 App ID，仅供兼容测试。提交通知不代表已获上岛权限。"
            + (BridgeApi.prefs(c).getString("islandError", "").isEmpty() ? "" : "\n" + BridgeApi.prefs(c).getString("islandError", ""));
    }
    static void addSettings(Activity activity, LinearLayout settings) {
        LinearLayout card = Ui.card(activity, settings); Ui.text(activity, card, "超级岛 · 独立测试版", 17, true);
        Ui.text(activity, card, "此应用与旧版分别配对。在电脑点“添加设备”领取新码，不要点“重新配对”。", 14, false);
        Switch toggle = new Switch(activity); toggle.setText("尝试超级岛显示"); toggle.setTextSize(16); toggle.setMinHeight(Ui.dp(activity, 52));
        toggle.setChecked(enabled(activity)); card.addView(toggle, Ui.width());
        toggle.setOnCheckedChangeListener((v, checked) -> { BridgeApi.prefs(activity).edit().putBoolean("island", checked).apply(); if (!checked) cancelRunning(activity); });
        TextView status = Ui.text(activity, card, "正在检测系统与权限…", 14, false);
        Runnable inspect = () -> new Thread(() -> { String result = diagnose(activity); activity.runOnUiThread(() -> { if (!activity.isFinishing()) status.setText(result); }); }, "island-diagnosis").start();
        Ui.button(activity, card, "重新检测", inspect, false);
        Ui.button(activity, card, "发送本地展示测试", () -> new AlertDialog.Builder(activity).setTitle("只测试显示，不发电脑指令")
            .setItems(new String[]{"处理中（15 秒）", "待审批（60 秒）", "已完成（60 秒）"}, (dialog, which) -> {
                try {
                    BridgeService.channels(activity); NotificationManager manager = activity.getSystemService(NotificationManager.class);
                    if (!manager.areNotificationsEnabled()) { status.setText("请先在系统设置中允许测试版通知"); return; }
                    String compact = new String[]{"处理中", "待审批", "已完成"}[which];
                    int seconds = which == 0 ? 15 : 60;
                    Notification n = new Notification.Builder(activity, BridgeService.EVENTS_CHANNEL).setSmallIcon(R.drawable.ic_stat_bridge)
                        .setContentTitle("Agent Bridge · " + compact).setContentText("本地显示测试，点击打开应用，不执行电脑操作")
                        .setContentIntent(BridgeService.openApp(activity)).setVisibility(Notification.VISIBILITY_PRIVATE).setAutoCancel(true).setTimeoutAfter(seconds * 1000L).build();
                    manager.notify(TEST_TAG, TEST_ID, decorate(activity, n, "Agent Bridge · " + compact, "本地展示测试，不执行电脑操作", compact, seconds, false));
                    status.setText("测试通知已提交；请观察是否上岛。仅显示普通通知说明系统未采用岛模板。\n" + "本包未配置小米平台 App ID，不代表正式授权。");
                } catch (Exception e) { status.setText("系统拒绝测试通知，请检查通知权限"); }
            }).setNegativeButton("取消", null).show(), false);
        Ui.button(activity, card, "清除测试通知", () -> activity.getSystemService(NotificationManager.class).cancel(TEST_TAG, TEST_ID), false);
        inspect.run();
    }
}
