package dev.agentbridge.island;

import android.app.*;
import android.content.*;
import android.content.res.ColorStateList;
import android.graphics.*;
import android.graphics.drawable.*;
import android.os.Build;
import android.text.*;
import android.text.method.LinkMovementMethod;
import android.text.style.*;
import android.view.*;
import android.widget.*;
import java.util.function.Consumer;

/** Shared native styling and readable text, used by the three existing screens. */
final class Ui {
    static final int BG=Color.rgb(244,247,246),INK=Color.rgb(24,43,38),MUTED=Color.rgb(79,96,91),TEAL=Color.rgb(15,118,110),PALE=Color.rgb(232,244,241),LINE=Color.rgb(222,232,228),RED=Color.rgb(180,35,35);
    static int dp(Context c,int value){return Math.round(value*c.getResources().getDisplayMetrics().density);}
    static LinearLayout column(Context c){LinearLayout v=new LinearLayout(c);v.setOrientation(LinearLayout.VERTICAL);return v;}
    static LinearLayout.LayoutParams width(){return new LinearLayout.LayoutParams(-1,-2);}
    static GradientDrawable background(Context c,int color,int radius){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(c,radius));return d;}
    static void surface(View v,int color,int radius){v.setBackground(background(v.getContext(),color,radius));}
    static TextView text(Context c,LinearLayout parent,String value,int size,boolean bold){TextView v=new TextView(c);v.setText(value);v.setTextColor(INK);v.setTextSize(size);v.setLineSpacing(dp(c,4),1);if(bold)v.setTypeface(Typeface.DEFAULT,Typeface.BOLD);v.setPadding(0,dp(c,5),0,dp(c,7));parent.addView(v,width());return v;}
    static Button button(Context c,LinearLayout parent,String value,Runnable action,boolean primary){Button b=new Button(c);b.setText(value);b.setTextSize(16);b.setAllCaps(false);b.setMinHeight(dp(c,48));b.setMinimumHeight(dp(c,48));b.setPadding(dp(c,16),dp(c,8),dp(c,16),dp(c,8));styleButton(b,primary?TEAL:PALE,primary?Color.WHITE:TEAL);b.setOnClickListener(v->action.run());LinearLayout.LayoutParams p=width();p.topMargin=dp(c,6);p.bottomMargin=dp(c,6);parent.addView(b,p);return b;}
    static void styleButton(Button b,int color,int textColor){Context c=b.getContext();GradientDrawable shape=background(c,color,12);b.setStateListAnimator(null);b.setElevation(0);b.setBackground(new RippleDrawable(ColorStateList.valueOf(0x18000000),shape,null));b.setTextColor(new ColorStateList(new int[][]{{-android.R.attr.state_enabled},{}},new int[]{0xFF869A94,textColor}));}
    static LinearLayout card(Context c,LinearLayout parent){LinearLayout v=column(c);v.setPadding(dp(c,18),dp(c,14),dp(c,18),dp(c,14));surface(v,Color.WHITE,16);LinearLayout.LayoutParams p=width();p.topMargin=dp(c,12);parent.addView(v,p);return v;}
    static void copy(Context c,String label,String value){c.getSystemService(android.content.ClipboardManager.class).setPrimaryClip(ClipData.newPlainText(label,value));Toast.makeText(c,"已复制",Toast.LENGTH_SHORT).show();}
    static ScrollView scroll(Context c,View child){ScrollView s=new ScrollView(c);s.setFillViewport(true);s.setClipToPadding(false);s.addView(child);return s;}
    static void insets(View root,Consumer<Boolean> keyboard){root.setOnApplyWindowInsetsListener((v,i)->{
        if(Build.VERSION.SDK_INT>=30){Insets bars=i.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout());int ime=i.getInsets(WindowInsets.Type.ime()).bottom;v.setPadding(bars.left,bars.top,bars.right,Math.max(bars.bottom,ime));if(keyboard!=null)keyboard.accept(ime>bars.bottom);}
        else {v.setPadding(i.getSystemWindowInsetLeft(),i.getSystemWindowInsetTop(),i.getSystemWindowInsetRight(),i.getSystemWindowInsetBottom());}
        return i;
    });}
    static void markdown(Activity activity,LinearLayout parent,String source){
        parent.removeAllViews();
        for(Markdown.Block block:Markdown.parse(source)){
            if(block.kind.equals("code")){code(activity,parent,block.text);continue;}
            LinearLayout holder=parent;
            TextView t=text(activity,holder,"",block.kind.equals("heading")?(block.level==1?23:19):16,block.kind.equals("heading"));t.setTextIsSelectable(true);
            if(block.kind.equals("quote")){t.setTextColor(MUTED);t.setPadding(dp(activity,12),dp(activity,8),dp(activity,12),dp(activity,8));surface(t,PALE,8);}
            SpannableString styled=new SpannableString(block.text);
            for(Markdown.Mark m:block.marks){Object span;
                if(m.kind.equals("bold"))span=new StyleSpan(Typeface.BOLD);
                else if(m.kind.equals("code")){span=new TypefaceSpan("monospace");styled.setSpan(new BackgroundColorSpan(0xFFEAF0ED),m.start,m.end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);}
                else {span=new ClickableSpan(){public void onClick(View v){try{activity.startActivity(new Intent(Intent.ACTION_VIEW,android.net.Uri.parse(m.target)));}catch(Exception e){Toast.makeText(activity,"无法打开链接",Toast.LENGTH_SHORT).show();}}public void updateDrawState(TextPaint p){p.setColor(TEAL);p.setUnderlineText(true);}};t.setMovementMethod(LinkMovementMethod.getInstance());}
                styled.setSpan(span,m.start,m.end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
            t.setText(styled);
        }
    }
    static void code(Activity activity,LinearLayout parent,String source){
        LinearLayout holder=card(activity,parent);surface(holder,0xFFF0F3F5,12);
        Button copy=button(activity,holder,"复制代码",()->copy(activity,"代码",source),false);copy.setTextSize(13);
        TextView content=text(activity,holder,source,15,false);content.setTypeface(Typeface.MONOSPACE);content.setTextIsSelectable(true);
    }
    static final class Detail {
        final Dialog dialog;final LinearLayout body,actions;final TextView feedback;
        boolean submitted;
        Detail(Activity activity,String title){
            dialog=new Dialog(activity);dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);LinearLayout root=column(activity);root.setBackgroundColor(BG);
            LinearLayout header=new LinearLayout(activity);header.setGravity(Gravity.CENTER_VERTICAL);header.setPadding(dp(activity,16),dp(activity,8),dp(activity,20),dp(activity,8));root.addView(header,width());
            LinearLayout back=column(activity);header.addView(back,new LinearLayout.LayoutParams(-2,-2));button(activity,back,"‹ 返回",dialog::dismiss,false);
            TextView heading=new TextView(activity);heading.setText(title);heading.setTextColor(INK);heading.setTextSize(21);heading.setTypeface(Typeface.DEFAULT,Typeface.BOLD);heading.setPadding(dp(activity,16),0,0,0);header.addView(heading,new LinearLayout.LayoutParams(0,-2,1));
            body=column(activity);body.setPadding(dp(activity,20),dp(activity,8),dp(activity,20),dp(activity,20));root.addView(scroll(activity,body),new LinearLayout.LayoutParams(-1,0,1));
            LinearLayout footer=column(activity);footer.setPadding(dp(activity,20),dp(activity,8),dp(activity,20),dp(activity,12));footer.setBackgroundColor(Color.WHITE);root.addView(footer,width());
            feedback=text(activity,footer,"",14,false);feedback.setTextColor(MUTED);feedback.setMaxLines(4);feedback.setEllipsize(android.text.TextUtils.TruncateAt.END);actions=new LinearLayout(activity);footer.addView(actions,width());
            dialog.setContentView(root);Window window=dialog.getWindow();if(Build.VERSION.SDK_INT>=30)window.setDecorFitsSystemWindows(false);window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);insets(root,null);
            dialog.show();window.setLayout(-1,-1);window.setBackgroundDrawable(new ColorDrawable(BG));
        }
        Button action(Activity a,String label,Runnable click,boolean primary){LinearLayout slot=column(a);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(0,-2,1);if(actions.getChildCount()>0)p.leftMargin=dp(a,12);actions.addView(slot,p);return button(a,slot,label,click,primary);}
        void disable(){for(int i=0;i<actions.getChildCount();i++){LinearLayout slot=(LinearLayout)actions.getChildAt(i);slot.getChildAt(0).setEnabled(false);}}
    }
}
