package dev.agentbridge.phone;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

public final class ChatStatus {
    private String thread="";
    private long generation=0, confirmedAt=-1;
    private boolean connected=false;
    public long begin(String id){thread=id;connected=false;confirmedAt=-1;return ++generation;}
    public long generation(){return generation;}
    public void confirm(String id,long requestGeneration,long now,boolean ok){
        if(requestGeneration!=generation||(!thread.isEmpty()&&!thread.equals(id)))return;
        thread=id;connected=ok&&!id.isEmpty();confirmedAt=connected?now:-1;
    }
    public boolean isConnected(long now){return connected&&now>=confirmedAt&&now-confirmedAt<10000;}
    public static String formatTime(long duration,long completed,long now,TimeZone zone){
        if(duration<0||completed<0||completed>8640000000000000L)return "时间不可用";
        long seconds=duration/1000;String elapsed=seconds>=3600?seconds/3600+" 小时 "+seconds%3600/60+" 分":seconds>=60?seconds/60+" 分 "+seconds%60+" 秒":seconds+" 秒";
        SimpleDateFormat date=new SimpleDateFormat("yyyy-MM-dd",Locale.CHINA),clock=new SimpleDateFormat("HH:mm",Locale.CHINA);date.setTimeZone(zone);clock.setTimeZone(zone);
        String day=date.format(new Date(completed));return "耗时 "+elapsed+" · "+(day.equals(date.format(new Date(now)))?"今日":day)+" "+clock.format(new Date(completed))+" 完成";
    }
}
