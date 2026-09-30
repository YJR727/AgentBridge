package dev.agentbridge.phone;

import java.util.*;
import java.util.regex.*;

/** Small, display-only Markdown subset. The original source remains available for copying. */
public final class Markdown {
    public static final class Mark {
        public final int start, end; public final String kind, target;
        Mark(int start, int end, String kind, String target) { this.start=start;this.end=end;this.kind=kind;this.target=target; }
    }
    public static final class Block {
        public final String kind, text; public final int level; public final List<Mark> marks;
        Block(String kind, String text, int level, List<Mark> marks) { this.kind=kind;this.text=text;this.level=level;this.marks=marks; }
    }
    private static final Pattern HEADING=Pattern.compile("^(#{1,6})\\s+(.+)$");
    private static final Pattern LIST=Pattern.compile("^\\s*[-*+]\\s+(.+)$");
    private static final Pattern INLINE=Pattern.compile("(`+)([^`\\n]+)\\1|\\*\\*([^*\\n]+)\\*\\*|__([^_\\n]+)__|\\[([^]\\n]+)\\]\\((https?://[^\\s)]+)\\)");
    public static List<Block> parse(String source) {
        List<Block> result=new ArrayList<>();StringBuilder paragraph=new StringBuilder(),code=new StringBuilder();String fence=null;int codeLines=0;
        for(String line:source.replace("\r\n","\n").split("\n",-1)) {
            String trimmed=line.trim();
            if(fence!=null) {
                if(trimmed.startsWith(fence)){result.add(new Block("code",code.toString(),0,Collections.emptyList()));code.setLength(0);fence=null;}
                else {if(codeLines++>0)code.append('\n');code.append(line);}continue;
            }
            if(trimmed.startsWith("```")||trimmed.startsWith("~~~")){flush(result,paragraph);fence=trimmed.substring(0,3);codeLines=0;continue;}
            if(trimmed.isEmpty()){flush(result,paragraph);continue;}
            Matcher heading=HEADING.matcher(line),list=LIST.matcher(line);
            if(heading.matches()){flush(result,paragraph);result.add(inline("heading",heading.group(2),heading.group(1).length()));}
            else if(list.matches()){flush(result,paragraph);result.add(inline("list","• "+list.group(1),0));}
            else if(trimmed.startsWith("> ")){flush(result,paragraph);result.add(inline("quote",trimmed.substring(2),0));}
            else {if(paragraph.length()>0)paragraph.append('\n');paragraph.append(line);}
        }
        if(fence!=null)result.add(new Block("code",code.toString(),0,Collections.emptyList()));flush(result,paragraph);return result;
    }
    private static void flush(List<Block> result,StringBuilder paragraph){if(paragraph.length()>0){result.add(inline("paragraph",paragraph.toString(),0));paragraph.setLength(0);}}
    public static String plain(String source){StringBuilder result=new StringBuilder();for(Block b:parse(source)){if(result.length()>0)result.append('\n');result.append(b.text);}return result.toString();}
    private static Block inline(String kind,String source,int level) {
        StringBuilder text=new StringBuilder();List<Mark> marks=new ArrayList<>();Matcher matcher=INLINE.matcher(source);int previous=0;
        while(matcher.find()){
            text.append(source,previous,matcher.start());int start=text.length();String value,style,target=null;
            if(matcher.group(1)!=null){value=matcher.group(2);style="code";}
            else if(matcher.group(3)!=null||matcher.group(4)!=null){value=matcher.group(3)!=null?matcher.group(3):matcher.group(4);style="bold";}
            else {value=matcher.group(5);style="link";target=matcher.group(6);}
            text.append(value);marks.add(new Mark(start,text.length(),style,target));previous=matcher.end();
        }
        text.append(source,previous,source.length());return new Block(kind,text.toString(),level,marks);
    }
}
