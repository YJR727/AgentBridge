package dev.agentbridge.island;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Handler;
import android.text.InputType;
import android.view.View;
import android.widget.*;
import org.json.*;
import java.util.*;
import java.util.concurrent.*;

/** One native view for the selected desktop chat; networking stays off the UI thread. */
final class ChatPanel extends LinearLayout {
    private final Activity activity;
    private final SharedPreferences prefs;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(android.os.Looper.getMainLooper());
    private final TextView title, status, feedback, connectionText, replyTime;
    private final View dot;
    private final ChatStatus connection=new ChatStatus();
    private android.animation.ObjectAnimator pulse;
    private JSONArray pendingItems=new JSONArray();
    private long lastPendingAt=-1;
    private String notificationTurn="",openQuestionTurn="",openApprovalTurn="";
    private final LinearLayout reply;
    private final ScrollView replyScroll;
    private final Button pendingBanner;
    private String replySource = "";
    private java.util.function.IntConsumer pendingChanged = n -> {};
    private final EditText input;
    private final Button send;
    private final Button copyReply;
    private final LinearLayout pending;
    private String threadId = "", signature = "", notificationThread = "", notificationQuestion = "";
    private boolean visible, refreshing, sending, connected;
    private Ui.Detail openQuestionDetail;
    private String openQuestionId="", openQuestionThread="";
    private Ui.Detail openApprovalDetail;
    private String openApprovalId="", openApprovalThread="";
    private final Runnable poll = new Runnable() { public void run() { if (!visible) return; refresh(); handler.postDelayed(this, 4000); } };

    ChatPanel(Activity activity, Runnable showPending) {
        super(activity); this.activity=activity; prefs=BridgeApi.prefs(activity); setOrientation(VERTICAL); setBackgroundColor(Ui.BG);
        LinearLayout header=Ui.column(activity);header.setPadding(dp(20),dp(12),dp(20),dp(8));header.setBackgroundColor(Color.WHITE);addView(header,Ui.width());
        title=Ui.text(activity,header,"选择电脑上的聊天  ⌄",21,true);title.setMinHeight(dp(48));title.setMaxLines(2);title.setEllipsize(android.text.TextUtils.TruncateAt.END);title.setOnClickListener(v->choose());title.setContentDescription("切换电脑聊天");
        status=Ui.text(activity,header,"配对后，先在电脑打开对应聊天。",13,false);status.setTextColor(Ui.MUTED);
        LinearLayout connectionRow=new LinearLayout(activity);connectionRow.setGravity(android.view.Gravity.CENTER_VERTICAL);header.addView(connectionRow,Ui.width());
        dot=new View(activity);LayoutParams dotSize=new LayoutParams(dp(9),dp(9));dotSize.rightMargin=dp(8);connectionRow.addView(dot,dotSize);Ui.surface(dot,Ui.RED,9);
        connectionText=Ui.text(activity,connectionRow,"未连接",13,false);connectionText.setTextColor(Ui.MUTED);
        LinearLayout reading=Ui.column(activity);reading.setPadding(dp(16),dp(8),dp(16),dp(20));
        LinearLayout card=Ui.card(activity,reading);
        LinearLayout replyHeader=new LinearLayout(activity);replyHeader.setGravity(android.view.Gravity.CENTER_VERTICAL);card.addView(replyHeader,Ui.width());
        TextView caption=new TextView(activity);caption.setText("最新完整回复");caption.setTextColor(Ui.MUTED);caption.setTextSize(13);replyHeader.addView(caption,new LayoutParams(0,-2,1));
        LinearLayout copySlot=Ui.column(activity);replyHeader.addView(copySlot,new LayoutParams(-2,-2));copyReply=Ui.button(activity,copySlot,"复制",()->Ui.copy(activity,"Codex 回复",replySource),false);copyReply.setTextSize(13);copyReply.setEnabled(false);
        reply=Ui.column(activity);card.addView(reply,Ui.width());Ui.markdown(activity,reply,"尚无已完成回复，新回复完成后会自动显示。");
        replyTime=Ui.text(activity,card,"",12,false);replyTime.setTextColor(Ui.MUTED);replyTime.setVisibility(GONE);
        pendingBanner=Ui.button(activity,reading,"查看待办",showPending,false);pendingBanner.setVisibility(GONE);
        replyScroll=Ui.scroll(activity,reading);addView(replyScroll,new LayoutParams(-1,0,1));
        LinearLayout composer=Ui.column(activity);composer.setPadding(dp(16),dp(10),dp(16),dp(8));composer.setBackgroundColor(Color.WHITE);addView(composer,Ui.width());
        feedback=Ui.text(activity,composer,"",13,false);feedback.setTextColor(Ui.MUTED);feedback.setVisibility(GONE);
        LinearLayout row=new LinearLayout(activity);row.setGravity(android.view.Gravity.BOTTOM);composer.addView(row,Ui.width());
        input=new EditText(activity);input.setTextSize(16);input.setMinLines(1);input.setMaxLines(5);input.setMinHeight(dp(48));input.setGravity(android.view.Gravity.CENTER_VERTICAL);input.setPadding(dp(14),dp(10),dp(14),dp(10));Ui.surface(input,Ui.BG,14);
        input.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE);input.setHint("给 Codex 发指令…");input.setContentDescription("发给 Codex 的文字指令");
        input.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(16000)});input.setText(prefs.getString("commandDraft",""));row.addView(input,new LayoutParams(0,-2,1));
        LinearLayout sendSlot=Ui.column(activity);LayoutParams sendLayout=new LayoutParams(-2,-2);sendLayout.leftMargin=dp(8);row.addView(sendSlot,sendLayout);
        send=Ui.button(activity,sendSlot,"发送",this::send,true);LayoutParams buttonLayout=(LayoutParams)send.getLayoutParams();buttonLayout.topMargin=0;buttonLayout.bottomMargin=0;buttonLayout.height=dp(48);send.setLayoutParams(buttonLayout);send.setMinWidth(dp(72));send.setMinimumWidth(dp(72));send.setPadding(dp(16),0,dp(16),0);send.setEnabled(false);
        pending=Ui.column(activity);
    }
    LinearLayout pendingView(){return pending;}
    void onPendingChanged(java.util.function.IntConsumer listener){pendingChanged=listener;}
    void pendingCount(int count){pendingBanner.setText("有 "+count+" 项待处理  ›");pendingBanner.setVisibility(count>0?VISIBLE:GONE);}
    void requestRefresh(){refresh();}
    private void feedback(String value){feedback.setText(value);feedback.setVisibility(value.isEmpty()?GONE:VISIBLE);}
    void resume() { visible=true;connection.begin("");showConnection();handler.removeCallbacks(poll);handler.post(poll);handler.post(freshness); }
    void pause() { visible=false;connection.begin("");showConnection();handler.removeCallbacks(freshness);handler.removeCallbacks(poll);prefs.edit().putString("commandDraft",input.getText().toString()).apply(); }
    void close() { pause();network.shutdownNow(); }
    void notification(String thread,String question,String turn) { notificationThread=thread;notificationQuestion=question;notificationTurn=turn==null?"":turn;refresh(); }
    private void ui(Runnable action) { activity.runOnUiThread(()->{if(!activity.isDestroyed()&&!activity.isFinishing())action.run();}); }
    private void choose() {
        if(prefs.getString("token","").isEmpty()){feedback("请先在连接设置中配对");return;}
        status.setText("正在读取电脑聊天…");
        network.execute(()->{try{
            JSONArray threads=BridgeApi.call(activity,"/api/codex/threads",null).getJSONArray("threads");String[] names=new String[threads.length()];
            for(int i=0;i<names.length;i++){JSONObject t=threads.getJSONObject(i);names[i]=t.optString("title")+"\n"+t.optString("cwd");}
            ui(()->new AlertDialog.Builder(activity).setTitle("继续哪个聊天？").setItems(names,(dialog,which)->{
                String id=threads.optJSONObject(which).optString("id");threadId=id;connection.begin(id);showConnection();status.setText("正在连接所选聊天…");connected=false;send.setEnabled(false);
                network.execute(()->{try{BridgeApi.call(activity,"/api/codex/select",new JSONObject().put("threadId",id));ui(()->{signature="";refresh();});}catch(Exception e){ui(()->status.setText(e.getMessage()));}});
            }).setNegativeButton("取消",null).show());
        }catch(Exception e){ui(()->status.setText(e.getMessage()));}});
    }
    private void refresh() {
        if(prefs.getString("token","").isEmpty()){connected=false;send.setEnabled(false);status.setText("请先在连接设置中配对电脑");return;}
        if(refreshing)return;refreshing=true;long generation=connection.generation();
        network.execute(()->{try{JSONObject state=BridgeApi.call(activity,"/api/codex/state",null);ui(()->{if(generation==connection.generation()){JSONObject selected=state.optJSONObject("selectedThread");connection.confirm(selected==null?"":selected.optString("id"),generation,android.os.SystemClock.elapsedRealtime(),state.optBoolean("connected"));render(state);}});}
            catch(Exception e){ui(()->{if(generation!=connection.generation())return;connection.begin(threadId);showConnection();connected=false;send.setEnabled(false);status.setText("连接暂不可用："+e.getMessage());});}
            finally{ui(()->refreshing=false);}});
    }
    private static String label(String value) {
        switch(value){case "processing":return "正在处理 · 下方为最近已完成回复";case "question":return "等待您回答问题";case "approval":return "等待审批";case "complete":return "本轮已完成";case "cancelled":return "本轮已取消";case "error":return "本轮出错，请查看电脑";default:return "未连接聊天，请选择";}
    }
    private void render(JSONObject state) {
        JSONObject thread=state.optJSONObject("selectedThread");threadId=thread==null?"":thread.optString("id");connected=state.optBoolean("connected")&&!threadId.isEmpty();
        title.setText((thread==null?"选择电脑上的聊天":thread.optString("title"))+"  ⌄");status.setText(!state.isNull("error")?state.optString("error"):label(state.optString("status")));
        JSONObject last=state.optJSONObject("lastReply");String content=last==null?"尚无已完成回复，新回复完成后会自动显示。":last.optString("text");copyReply.setEnabled(last!=null&&!content.isEmpty());if(!content.equals(replySource)){int position=replyScroll.getScrollY();replySource=content;Ui.markdown(activity,reply,content);replyScroll.post(()->replyScroll.scrollTo(0,position));}
        send.setEnabled(connected&&!sending);
        showConnection();
        replyTime.setVisibility(last==null?GONE:VISIBLE);if(last!=null)replyTime.setText(ChatStatus.formatTime(last.optLong("durationMs",-1),last.optLong("completedAtMs",-1),System.currentTimeMillis(),TimeZone.getDefault()));
        pendingItems=state.optJSONArray("pending");if(pendingItems==null)pendingItems=new JSONArray();lastPendingAt=android.os.SystemClock.elapsedRealtime();
        if(openQuestionDetail!=null&&openQuestionDetail.dialog.isShowing()&&!openQuestionDetail.submitted&&!pendingMatch(openQuestionThread,openQuestionId,openQuestionTurn)){openQuestionDetail.disable();openQuestionDetail.feedback.setText("问题已处理或连接已变化。");}
        if(openApprovalDetail!=null&&openApprovalDetail.dialog.isShowing()&&!openApprovalDetail.submitted&&!pendingMatch(openApprovalThread,openApprovalId,openApprovalTurn)){openApprovalDetail.disable();openApprovalDetail.feedback.setText("申请已处理或连接已变化。");}
        String next=pendingItems.toString();if(!signature.equals(next)){
            signature=next;pending.removeAllViews();int count=0;
            for(int i=0;i<pendingItems.length();i++){JSONObject q=pendingItems.optJSONObject(i);if(q==null)continue;String target=q.optString("threadId"),source=q.optString("threadTitle");
                if("question".equals(q.optString("kind"))){JSONArray fields=q.optJSONArray("questions");String text=fields==null||fields.length()==0?"Codex 需要回答":fields.optJSONObject(0).optString("question");pendingRow(source+" · 需要您回答",text,"查看并回答  ›",()->question(q,target));}
                else pendingRow(source+" · 需要审批",q.optString("title"),"查看申请详情  ›",()->approval(q,target));count++;
            }pendingChanged.accept(count);
        }
        String pendingId=prefs.getString("pendingMessageId","");JSONArray deliveries=state.optJSONArray("deliveries");
        if(deliveries!=null)for(int i=0;i<deliveries.length();i++){JSONObject d=deliveries.optJSONObject(i);if(d!=null&&pendingId.equals(d.optString("id"))&&"accepted".equals(d.optString("state"))){prefs.edit().remove("pendingMessageId").apply();feedback("电脑已收到上一条指令");}}
        if(!notificationThread.isEmpty()){
            boolean found=false;for(int i=0;i<pendingItems.length();i++){JSONObject q=pendingItems.optJSONObject(i);if(q!=null&&notificationThread.equals(q.optString("threadId"))&&notificationQuestion.equals(q.optString("questionId"))&&(notificationTurn.isEmpty()||notificationTurn.equals(q.optString("turnId")))){if("question".equals(q.optString("kind")))question(q,notificationThread);else approval(q,notificationThread);found=true;break;}}
            if(!found)feedback("这条通知已处理、过期或取消。");notificationThread="";notificationQuestion="";notificationTurn="";
        }
    }

    private void send() {
        String text=input.getText().toString().trim(), target=threadId;if(text.isEmpty()||!connected||sending)return;
        if(!prefs.getString("pendingMessageId","").isEmpty()){
            new AlertDialog.Builder(activity).setTitle("上一条消息仍待确认").setMessage("请先在电脑聊天核对是否已收到，避免重复执行。确认后才解除此提示。").setPositiveButton("已在电脑核对",(d,w)->{prefs.edit().remove("pendingMessageId").apply();feedback("已解除提示，请勿重复发送已收到的指令。");}).setNegativeButton("返回",null).show();return;
        }
        String id=UUID.randomUUID().toString();prefs.edit().putString("pendingMessageId",id).putString("commandDraft",text).apply();sending=true;send.setEnabled(false);feedback("正在发送…");
        network.execute(()->{try{
            JSONObject r=BridgeApi.call(activity,"/api/codex/message",new JSONObject().put("threadId",target).put("text",text).put("messageId",id));
            ui(()->{boolean ok="accepted".equals(r.optString("state"));feedback(ok?"电脑已收到，等待回复。":"送达状态待确认；请核对电脑，不会自动重发。");if(ok){prefs.edit().remove("pendingMessageId").remove("commandDraft").apply();if(input.getText().toString().trim().equals(text))input.setText("");}});
        }catch(Exception e){ui(()->{if(e instanceof BridgeApi.ApiException){prefs.edit().remove("pendingMessageId").apply();feedback("未发送："+e.getMessage());}else feedback("送达状态待确认；请核对电脑，不会自动重发。");});}
        finally{ui(()->{sending=false;refresh();});}});
    }
    private final Runnable freshness=new Runnable(){public void run(){if(!visible)return;showConnection();handler.postDelayed(this,1000);}};
    private void showConnection(){
        connected=visible&&connection.isConnected(android.os.SystemClock.elapsedRealtime());Ui.surface(dot,connected?Ui.TEAL:Ui.RED,9);connectionText.setText(connected?"已连接":"未连接 · 等待确认");send.setEnabled(connected&&!sending);
        if(connected&&pulse==null&&android.animation.ValueAnimator.areAnimatorsEnabled()){pulse=android.animation.ObjectAnimator.ofFloat(dot,"alpha",1f,.45f);pulse.setDuration(1000);pulse.setRepeatMode(android.animation.ValueAnimator.REVERSE);pulse.setRepeatCount(android.animation.ValueAnimator.INFINITE);pulse.start();}
        if(!connected&&pulse!=null){pulse.cancel();pulse=null;dot.setAlpha(1f);}
    }
    private boolean pendingMatch(String target,String id,String turn){
        if(prefs.getString("token","").isEmpty()||lastPendingAt<0||android.os.SystemClock.elapsedRealtime()-lastPendingAt>=10000)return false;
        for(int i=0;i<pendingItems.length();i++){JSONObject q=pendingItems.optJSONObject(i);if(q!=null&&target.equals(q.optString("threadId"))&&id.equals(q.optString("questionId"))&&turn.equals(q.optString("turnId")))return true;}return false;
    }
    private boolean checkRequest(JSONObject q,String target){if(!pendingMatch(target,q.optString("questionId"),q.optString("turnId"))){feedback("申请已处理或连接待确认，请刷新后重新打开。");return false;}return true;}
    private void pendingRow(String category,String title,String action,Runnable click) {
        LinearLayout card=Ui.card(activity,pending);TextView categoryView=Ui.text(activity,card,category,13,true);categoryView.setTextColor(Ui.TEAL);
        TextView heading=Ui.text(activity,card,Markdown.plain(title),17,true);heading.setMaxLines(3);heading.setEllipsize(android.text.TextUtils.TruncateAt.END);
        Ui.button(activity,card,action,click,false);
    }
    private void question(JSONObject q,String target) {
        if(!checkRequest(q,target))return;JSONArray fields=q.optJSONArray("questions");if(fields==null)return;
        Ui.Detail detail=new Ui.Detail(activity,"回答 Codex");Ui.text(activity,detail.body,"来源聊天："+q.optString("threadTitle",target),14,true);LinearLayout form=detail.body;Map<String,EditText> inputs=new LinkedHashMap<>();
        for(int i=0;i<fields.length();i++){
            JSONObject f=fields.optJSONObject(i);if(f==null)continue;
            LinearLayout section=Ui.card(activity,form);Ui.text(activity,section,"问题 "+(i+1)+" / "+fields.length(),13,false);
            LinearLayout heading=Ui.column(activity);section.addView(heading,Ui.width());Ui.markdown(activity,heading,f.optString("question"));
            EditText answer=new EditText(activity);answer.setTextSize(16);answer.setMinLines(2);answer.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE);answer.setHint("补充或输入您的回答");answer.setContentDescription(f.optString("question"));answer.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(16000)});
            JSONArray options=f.optJSONArray("options");java.util.List<Button> choices=new ArrayList<>();
            if(options!=null)for(int j=0;j<options.length();j++){
                Object o=options.opt(j);String value=o instanceof JSONObject?((JSONObject)o).optString("label"):String.valueOf(o);String desc=o instanceof JSONObject?((JSONObject)o).optString("description"):"";
                Button option=Ui.button(activity,section,Markdown.plain(value)+(desc.isEmpty()?"":"\n"+Markdown.plain(desc)),()->{},false);option.setTag(value);option.setTextAlignment(TEXT_ALIGNMENT_VIEW_START);choices.add(option);
                option.setOnClickListener(v->{answer.setText(value);});
            }
            answer.addTextChangedListener(new android.text.TextWatcher(){public void beforeTextChanged(CharSequence s,int start,int count,int after){}public void onTextChanged(CharSequence s,int start,int before,int count){for(Button option:choices){boolean chosen=s.toString().equals(option.getTag());option.setSelected(chosen);Ui.styleButton(option,chosen?Ui.TEAL:Ui.PALE,chosen?Color.WHITE:Ui.TEAL);}}public void afterTextChanged(android.text.Editable e){}});
            section.addView(answer,Ui.width());inputs.put(f.optString("id"),answer);
        }
        TextView result=detail.feedback;result.setText("答案将回到上方标注的来源聊天。");String qid=q.optString("questionId"),key="answer:"+target+":"+q.optString("turnId")+":"+qid;
        Button submit=detail.action(activity,"提交答案",()->{},true);
        openQuestionDetail=detail;openQuestionId=qid;openQuestionThread=target;openQuestionTurn=q.optString("turnId");
        detail.submitted=prefs.contains(key);submit.setEnabled(!detail.submitted);if(detail.submitted)result.setText("该问题已提交；请核对电脑确认结果。");
        submit.setOnClickListener(v->{if(!checkRequest(q,target)){result.setText("连接或所选聊天已变化，请返回后重新打开问题。");detail.disable();return;}JSONObject answers=new JSONObject();try{for(Map.Entry<String,EditText> e:inputs.entrySet()){String value=e.getValue().getText().toString().trim();if(value.isEmpty()){result.setText("请回答每个问题");e.getValue().requestFocus();return;}answers.put(e.getKey(),value);}}catch(Exception e){return;}
            String id=UUID.randomUUID().toString();prefs.edit().putString(key,id).apply();detail.submitted=true;submit.setEnabled(false);result.setText("正在提交…");
            network.execute(()->{try{JSONObject r=BridgeApi.call(activity,"/api/codex/answer",new JSONObject().put("threadId",target).put("questionId",qid).put("turnId",q.optString("turnId")).put("answers",answers).put("submissionId",id));ui(()->result.setText("accepted".equals(r.optString("state"))?"电脑已收到答案":"送达状态待确认，请查看电脑。"));}
                catch(Exception e){ui(()->{result.setText(e instanceof BridgeApi.ApiException?e.getMessage():"送达状态待确认，请勿重复提交。");if(e instanceof BridgeApi.ApiException&&((BridgeApi.ApiException)e).status==400){prefs.edit().remove(key).apply();detail.submitted=false;submit.setEnabled(true);}});}finally{ui(this::refresh);}});
        });
    }
    private void approval(JSONObject q,String target) {
        if(!checkRequest(q,target))return;Ui.Detail detail=new Ui.Detail(activity,"审批申请");
        openApprovalDetail=detail;openApprovalId=q.optString("questionId");openApprovalThread=target;openApprovalTurn=q.optString("turnId");
        Ui.text(activity,detail.body,"来源聊天："+q.optString("threadTitle",target),14,true);
        LinearLayout heading=Ui.column(activity);detail.body.addView(heading,Ui.width());Ui.markdown(activity,heading,q.optString("title"));
        Ui.text(activity,detail.body,"操作："+("file".equals(q.optString("approvalKind"))?"修改文件":"执行命令"),16,true);
        try{JSONObject parameters=new JSONObject(q.optString("body"));String command=parameters.optString("command","");if(!command.isEmpty())Ui.code(activity,detail.body,command);String cwd=parameters.optString("cwd","");if(!cwd.isEmpty())Ui.text(activity,detail.body,"目录："+cwd,14,false);}catch(JSONException ignored){}
        LinearLayout full=Ui.column(activity);Button expand=Ui.button(activity,detail.body,"查看完整申请与参数  ⌄",()->{},false);detail.body.addView(full,Ui.width());Ui.code(activity,full,q.optString("body"));full.setVisibility(GONE);expand.setOnClickListener(v->{boolean show=full.getVisibility()!=VISIBLE;full.setVisibility(show?VISIBLE:GONE);expand.setText(show?"收起完整申请与参数  ⌃":"查看完整申请与参数  ⌄");});
        detail.feedback.setText("仅处理这次申请。完整参数可在上方展开查看。");
        for(String choice:new String[]{"deny","approve"}){
            Button action=detail.action(activity,choice.equals("approve")?"批准":"拒绝",()->{
                if(!checkRequest(q,target)){detail.feedback.setText("连接或所选聊天已变化，请返回后重新打开申请。");detail.disable();return;}detail.submitted=true;detail.disable();detail.feedback.setText("正在提交选择…");
                network.execute(()->{try{JSONObject r=BridgeApi.call(activity,"/api/codex/approval",new JSONObject().put("threadId",target).put("questionId",q.optString("questionId")).put("turnId",q.optString("turnId")).put("choice",choice).put("submissionId",UUID.randomUUID().toString()));ui(()->{detail.feedback.setText("accepted".equals(r.optString("state"))?"电脑已收到审批选择":"送达状态待确认，请核对电脑");refresh();});}catch(Exception e){ui(()->{detail.feedback.setText(e.getMessage());refresh();});}});
            },choice.equals("approve"));if(choice.equals("deny"))Ui.styleButton(action,Color.WHITE,Ui.RED);
        }
    }
    private int dp(int n){return Ui.dp(activity,n);}
}
