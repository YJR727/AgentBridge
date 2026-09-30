package dev.agentbridge.phone;

import android.app.Service;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.IBinder;
import android.os.PowerManager;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.HashSet;
import java.util.Set;

public class BridgeService extends Service {
    static final String CONNECTION_CHANNEL = "connection";
    static final String EVENTS_CHANNEL = "events";
    private volatile boolean running;
    private Thread worker;
    private PowerManager.WakeLock wakeLock;

    static void channels(android.content.Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CONNECTION_CHANNEL, "后台连接状态", NotificationManager.IMPORTANCE_LOW));
        NotificationChannel events = new NotificationChannel(EVENTS_CHANNEL, "审批与事件提醒", NotificationManager.IMPORTANCE_HIGH);
        events.setDescription("电脑审批请求与测试事件；点通知正文查看完整详情");
        events.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(events);
    }

    static PendingIntent openApp(android.content.Context context) {
        return openApp(context, null);
    }

    static PendingIntent openApp(android.content.Context context, String eventId) {
        Intent intent = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (eventId != null) intent.putExtra("eventId", eventId).setData(Uri.parse("agentbridge://event/" + Uri.encode(eventId)));
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification connection(String status) {
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, BridgeService.class).setAction("stop"), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CONNECTION_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_bridge).setContentTitle("手机桥后台连接")
            .setContentText(status).setContentIntent(openApp(this)).setOngoing(true)
            .addAction(new Notification.Action.Builder(null, "停止连接", stop).build()).build();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) {
            BridgeApi.prefs(this).edit().putBoolean("listening", false).putString("status", "连接已停止").apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (running) return START_STICKY;
        SharedPreferences prefs = BridgeApi.prefs(this);
        if (prefs.getString("token", "").isEmpty() || !prefs.getBoolean("listening", false)) { stopSelf(); return START_NOT_STICKY; }
        channels(this);
        startForeground(1, connection("正在连接电脑…"));
        running = true;
        wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AgentBridge:Connection");
        wakeLock.acquire(); // 用户开启时保持连接，停止服务立即释放；无需 Google 推送。
        worker = new Thread(this::listen, "bridge-connection");
        worker.start();
        return START_STICKY;
    }

    private void status(String message) {
        SharedPreferences prefs = BridgeApi.prefs(this);
        if (!message.equals(prefs.getString("status", ""))) {
            prefs.edit().putString("status", message).apply();
            getSystemService(NotificationManager.class).notify(1, connection(message));
        }
    }

    private void listen() {
        SharedPreferences prefs = BridgeApi.prefs(this);
        Set<String> seen = new HashSet<>(prefs.getStringSet("seen", new HashSet<>()));
        Set<String> questionNotifications = new HashSet<>();
        while (running) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (!manager.areNotificationsEnabled() || manager.getNotificationChannel(EVENTS_CHANNEL).getImportance() == NotificationManager.IMPORTANCE_NONE) {
                prefs.edit().putBoolean("listening", false).putString("status", "事件通知被关闭，请在系统设置中允许").apply();
                stopSelf();
                return;
            }
            String credential = prefs.getString("token", "");
            try {
                JSONObject feed = BridgeApi.request(prefs.getString("url", ""), credential, "/api/native/poll", null,BridgeApi.deviceId(this));
                if (!running || !credential.equals(prefs.getString("token", ""))) break;
                prefs.edit().putLong("lastSeen", System.currentTimeMillis()).apply();
                status(feed.optBoolean("enabled", true) ? "已连接，等待电脑事件" : "电脑桥接已停用");
                JSONArray events = feed.getJSONArray("events");
                Set<String> current = new HashSet<>();
                Set<String> currentQuestions = new HashSet<>();
                JSONObject codex = feed.optJSONObject("codex");
                if (feed.optBoolean("enabled", true)) {
                    JSONArray questions = feed.optJSONArray("pending");
                    if (questions != null) for (int i=0;i<questions.length();i++) {
                        JSONObject question = questions.getJSONObject(i);
                        String thread = question.getString("threadId"), qid = question.getString("questionId"),turn=question.optString("turnId");
                        String key = "codex:" + thread + ":" + turn + ":" + qid;
                        currentQuestions.add(key); current.add(key);
                        if (!seen.contains(key)) {
                            Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                                .setData(Uri.parse("agentbridge://question/" + Uri.encode(thread) + "/" + Uri.encode(qid)))
                                .putExtra("codexThreadId", thread).putExtra("questionId", qid).putExtra("turnId",turn);
                            PendingIntent action = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                            manager.notify(key, 3, new Notification.Builder(this, EVENTS_CHANNEL).setSmallIcon(R.drawable.ic_stat_bridge)
                                .setContentTitle(question.optString("threadTitle","Codex")+" · 需要您处理").setContentText(question.optString("title"))
                                .setStyle(new Notification.BigTextStyle().bigText(question.optString("title")))
                                .setContentIntent(action).setVisibility(Notification.VISIBILITY_PRIVATE).setAutoCancel(true).setOnlyAlertOnce(true).build());
                            seen.add(key);
                        }
                    }
                }
                for (String key : questionNotifications) if (!currentQuestions.contains(key)) manager.cancel(key, 3);
                questionNotifications = currentQuestions;
                for (int i = events.length() - 1; i >= 0; i--) {
                    JSONObject event = events.getJSONObject(i);
                    String id = event.getString("id");
                    current.add(id);
                    if (event.optBoolean("needsDecision") && !"pending".equals(event.optString("state"))) {
                        getSystemService(NotificationManager.class).cancel(id, 2);
                    }
                    if (event.optBoolean("notify") && !seen.contains(id)) {
                        showEvent(event);
                        seen.add(id);
                    }
                }
                // ponytail: 只保留服务返回的最近 100 条标识，后端保留上限 300 条。
                seen.retainAll(current);
                prefs.edit().putStringSet("seen", new HashSet<>(seen)).apply();
            } catch (BridgeApi.ApiException error) {
                if (!running || !credential.equals(prefs.getString("token", ""))) return;
                if (error.status == 401 || error.status == 403) {
                    prefs.edit().remove("token").putBoolean("listening", false).putString("status", "配对已失效，请重新配对").apply();
                    stopSelf();
                    return;
                }
                if (running) status("电脑暂不可用，正在重试");
            } catch (Exception error) {
                if (running) status("连接中断，请检查 Tailscale 和网络");
            }
            try { Thread.sleep(5000); }
            catch (InterruptedException error) { return; }
        }
    }

    private void showEvent(JSONObject event) throws Exception {
        String id = event.getString("id");
        Notification.Builder notification = new Notification.Builder(this, EVENTS_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_bridge).setContentTitle(event.optString("title", "有新事件"))
            .setContentText(event.optString("summary"))
            .setStyle(new Notification.BigTextStyle().bigText(event.optString("summary")))
            .setVisibility(Notification.VISIBILITY_PRIVATE).setContentIntent(openApp(this, id))
            .setAutoCancel(true).setOnlyAlertOnce(true);
        String token = event.optString("replyToken", "");
        if (event.optBoolean("needsDecision") && !token.isEmpty() && !"null".equals(token)) {
            for (String choice : new String[] { "approve", "deny" }) {
                Intent intent = new Intent(this, DecisionReceiver.class)
                    .setData(Uri.parse("agentbridge://decision/" + Uri.encode(id) + "/" + choice))
                    .putExtra("eventId", id).putExtra("choice", choice).putExtra("replyToken", token);
                PendingIntent action = PendingIntent.getBroadcast(this, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                notification.addAction(new Notification.Action.Builder(null, "approve".equals(choice) ? "批准" : "拒绝", action).build());
            }
        }
        getSystemService(NotificationManager.class).notify(id, 2, notification.build());
    }

    @Override public void onDestroy() {
        running = false;
        if (worker != null) worker.interrupt();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
