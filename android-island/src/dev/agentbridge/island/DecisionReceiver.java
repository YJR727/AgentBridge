package dev.agentbridge.island;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import org.json.JSONObject;

public class DecisionReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra("eventId");
        String choice = intent.getStringExtra("choice");
        String token = intent.getStringExtra("replyToken");
        if (id == null || !id.matches("[A-Za-z0-9_-]+") || !("approve".equals(choice) || "deny".equals(choice)) || token == null) return;
        PendingResult pending = goAsync();
        new Thread(() -> {
            String title = "回传失败";
            String message = "请打开手机桥查看事件状态";
            try {
                JSONObject body = new JSONObject().put("choice", choice).put("replyToken", token).put("via", "android-notification");
                JSONObject result = BridgeApi.request(BridgeApi.prefs(context).getString("url", ""), "", "/api/events/" + id + "/decision", body);
                if (!result.optBoolean("ok") || !choice.equals(result.optJSONObject("decision").optString("choice"))) throw new Exception("服务未接受这次选择");
                title = "选择已记录";
                message = result.optBoolean("duplicate") ? "相同选择已记录，无需重复提交" : "选择已回传电脑；执行结果请查看对应任务";
                context.getSystemService(NotificationManager.class).cancel(id, 2);
            } catch (BridgeApi.ApiException error) {
                message = error.status == 409 ? "请求已处理、过期或取消，请查看电脑状态" : error.status == 401 ? "事件令牌无效，请打开手机桥刷新" : "电脑未接受回复，请打开手机桥检查";
            } catch (Exception error) {
                message = "无法回传，请确认 Tailscale 在线后查看事件状态";
            } finally {
                try {
                    BridgeService.channels(context);
                    context.getSystemService(NotificationManager.class).notify(id, 3, new Notification.Builder(context, BridgeService.EVENTS_CHANNEL)
                        .setSmallIcon(R.drawable.ic_stat_bridge).setContentTitle(title).setContentText(message)
                        .setStyle(new Notification.BigTextStyle().bigText(message)).setContentIntent(BridgeService.openApp(context, id))
                        .setVisibility(Notification.VISIBILITY_PRIVATE).setAutoCancel(true).build());
                } catch (RuntimeException error) {
                    BridgeApi.prefs(context).edit().putString("status", "通知被系统限制，请打开应用检查事件状态").apply();
                } finally { pending.finish(); }
            }
        }, "bridge-decision").start();
    }
}
