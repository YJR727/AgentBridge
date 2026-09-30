import dev.agentbridge.phone.UrlPolicy;

public class UrlPolicyTest {
    public static void main(String[] args) {
        if (!"https://computer.tail123.ts.net".equals(UrlPolicy.normalize(" https://Computer.tail123.ts.net/ "))) throw new AssertionError("normalization");
        for (String invalid : new String[] { "http://computer.ts.net", "https://evil.example", "https://computer.ts.net@evil.example", "https://computer.ts.net/path", "https://computer.ts.net?token=secret", "https://computer.ts.net#fragment", "https://computer.ts.net:4571", "file:///etc", "" }) {
            try { UrlPolicy.normalize(invalid); throw new AssertionError("accepted invalid URL"); }
            catch (IllegalArgumentException expected) { }
        }
        System.out.println("URL policy: 10 checks passed");
    }
}
