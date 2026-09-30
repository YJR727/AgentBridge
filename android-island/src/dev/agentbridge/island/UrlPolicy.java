package dev.agentbridge.island;

import java.net.URI;

public final class UrlPolicy {
    private UrlPolicy() {}

    public static String normalize(String input) {
        try {
            URI uri = new URI(input.trim());
            String host = uri.getHost();
            if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null ||
                !host.toLowerCase(java.util.Locale.ROOT).endsWith(".ts.net") ||
                uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null ||
                (uri.getPort() != -1 && uri.getPort() != 443) ||
                !(uri.getPath().isEmpty() || "/".equals(uri.getPath()))) {
                throw new IllegalArgumentException();
            }
            return "https://" + host.toLowerCase(java.util.Locale.ROOT);
        } catch (Exception error) {
            throw new IllegalArgumentException("请输入电脑 Tailscale 的完整 https://…ts.net 地址，不含路径或端口");
        }
    }
}
