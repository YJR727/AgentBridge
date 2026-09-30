package dev.agentbridge.island;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import java.net.URL;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

final class BridgeApi {
    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("bridge", Context.MODE_PRIVATE);
    }

    static JSONObject call(Context context, String path, JSONObject body) throws Exception {
        SharedPreferences prefs = prefs(context);
        return request(prefs.getString("url", ""), prefs.getString("token", ""), path, body,deviceId(context));
    }

    static synchronized String deviceId(Context context){
        SharedPreferences p=prefs(context);String id=p.getString("deviceId","");
        if(id.isEmpty()){id=java.util.UUID.randomUUID().toString();if(!p.edit().putString("deviceId",id).commit())throw new IllegalStateException("无法保存设备标识");}return id;
    }

    static JSONObject request(String base, String token, String path, JSONObject body) throws Exception {
        return request(base,token,path,body,"");
    }
    static JSONObject request(String base, String token, String path, JSONObject body,String deviceId) throws Exception {
        boolean chatWrite = body != null && path.startsWith("/api/codex/");
        int readTimeout = chatWrite ? 15000 : 5000;
        long deadline = System.nanoTime() + (chatWrite ? 20000000000L : 8000000000L);
        String origin = UrlPolicy.normalize(base);
        HttpsURLConnection connection = (HttpsURLConnection) new URL(origin + path).openConnection();
        connection.setConnectTimeout(3000);
        connection.setReadTimeout(readTimeout);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "application/json");
        if (!token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
        if(!deviceId.isEmpty())connection.setRequestProperty("X-Agent-Bridge-Device",deviceId);
        try {
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            JSONObject result = new JSONObject();
            if (stream != null) {
                try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[4096];
                    int count;
                    for (;;) {
                        long remaining = (deadline - System.nanoTime()) / 1000000L;
                        if (remaining <= 0) throw new java.net.SocketTimeoutException("请求超时");
                        connection.setReadTimeout((int) Math.min(readTimeout, remaining));
                        count = input.read(buffer);
                        if (count == -1) break;
                        if (output.size() + count > 2 * 1024 * 1024) throw new Exception("响应过大，请在电脑查看完整内容");
                        output.write(buffer, 0, count);
                    }
                    try { result = new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8)); }
                    catch (Exception error) { throw new Exception("电脑服务响应格式不正确"); }
                }
            }
            if (status < 200 || status >= 300) throw new ApiException(status, result.optString("error", "电脑服务返回 HTTP " + status));
            return result;
        } finally { connection.disconnect(); }
    }

    static class ApiException extends Exception {
        final int status;
        ApiException(int status, String message) { super(message); this.status = status; }
    }
}
