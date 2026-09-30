import dev.agentbridge.phone.ChatStatus;
import java.util.TimeZone;
public class ChatStatusTest {
 public static void main(String[] args){
  ChatStatus s=new ChatStatus();long a=s.begin("A");s.confirm("A",a,1000,true);
  if(!s.isConnected(10999)||s.isConnected(11000))throw new AssertionError("10 second expiry");
  s.begin("B");s.confirm("A",a,11001,true);if(s.isConnected(11001))throw new AssertionError("late old reply");
  if(!ChatStatus.formatTime(-1,1000,1000,TimeZone.getTimeZone("UTC")).equals("时间不可用"))throw new AssertionError("invalid metadata");
  String time=ChatStatus.formatTime(138000,86460000,90000000,TimeZone.getTimeZone("UTC"));
  if(!time.contains("2 分 18 秒")||!time.contains("今日 00:01"))throw new AssertionError(time);
  if(ChatStatus.formatTime(1000,1000,86400000,TimeZone.getTimeZone("UTC")).contains("今日"))throw new AssertionError("cross day");
  System.out.println("ChatStatus checks passed");
 }
}
