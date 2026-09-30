package dev.agentbridge.island;

public final class IslandPolicy {
    private String thread = "";
    private long started = -1;
    public static boolean canTest(int protocol, Boolean feature) { return protocol >= 3 && !Boolean.FALSE.equals(feature); }
    public static String clip(String text, int count) {
        if (text == null || count <= 0) return "";
        return text.substring(0, text.offsetByCodePoints(0, Math.min(count, text.codePointCount(0, text.length()))));
    }
    public static int waitSeconds(long expires, long now) {
        if (expires <= 0) return 300;
        if (expires <= now) return 1;
        return (int)Math.max(1, Math.min(300, (expires - now) / 1000));
    }
    public static int notificationMinutes(boolean waiting, int seconds) {
        return waiting ? 720 : (int)Math.max(1, Math.min(720, (seconds + 59L) / 60));
    }
    public boolean running(String id, String status, long now) {
        if (id == null || id.isEmpty() || !"processing".equals(status)) { thread = ""; started = -1; return false; }
        if (!id.equals(thread)) { thread = id; started = now; }
        return now >= started && now - started < 43200000L;
    }
}
