import dev.agentbridge.island.Markdown;
import java.util.List;

public final class MarkdownTest {
    private static int checks;
    private static void check(boolean result, String message) { checks++; if (!result) throw new AssertionError(message); }
    public static void main(String[] args) {
        Markdown.Block bold = Markdown.parse("**批准/拒绝**").get(0);
        check(bold.text.equals("批准/拒绝"), "bold markers should not appear");
        check(bold.marks.size() == 1 && bold.marks.get(0).kind.equals("bold") && bold.marks.get(0).end == 5, "correct bold range");
        List<Markdown.Block> blocks = Markdown.parse("# 标题\n\n- 一条说明\n> 引用\n```sh\necho '**保留**'\na*b\n```\n正文 `a*b` 与 **加粗**");
        check(blocks.get(0).kind.equals("heading"), "heading block");
        check(blocks.get(1).text.equals("• 一条说明"), "list marker");
        check(blocks.get(2).kind.equals("quote"), "quote block");
        check(blocks.get(3).text.equals("echo '**保留**'\na*b"), "code must remain literal");
        check(blocks.get(4).text.equals("正文 a*b 与 加粗"), "inline code remains intact");
        check(blocks.get(4).marks.get(0).kind.equals("code"), "inline code style");
        check(Markdown.parse("a*b 与 **未闭合").get(0).text.equals("a*b 与 **未闭合"), "ordinary punctuation remains");
        Markdown.Block link = Markdown.parse("[官网](https://example.com) [危险](javascript:alert)").get(0);
        check(link.text.equals("官网 [危险](javascript:alert)"), "only safe link formats styled");
        check(link.marks.get(0).target.equals("https://example.com"), "preserve link target");
        check(Markdown.parse("```\nx ** y").get(0).text.equals("x ** y"), "unfinished fence stays literal");
        check(Markdown.parse("```\n\nfirst\n\nlast\n\n```").get(0).text.equals("\nfirst\n\nlast\n"), "code blank lines must remain exact");
        check(Markdown.parse("中文".repeat(30000)).get(0).text.length() == 60000, "long Chinese reply complete");
        check(Markdown.plain("**选择**\n\n- 苹果").equals("选择\n• 苹果"), "card preview uses readable text");
        check(Markdown.plain("```\na*b\n```").equals("a*b"), "card preview preserves code symbols");
        System.out.println("Markdown: " + checks + " checks passed");
    }
}
