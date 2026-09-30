// Display-only Markdown subset matching the native client. Never inserts source as HTML.
function inline(source) {
  const pattern=/(`+)([^`\n]+)\1|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const parts=[];let previous=0;
  for(const m of source.matchAll(pattern)) {
    if(m.index>previous)parts.push({kind:'text',text:source.slice(previous,m.index)});
    parts.push(m[1]?{kind:'code',text:m[2]}:m[3]||m[4]?{kind:'bold',text:m[3]??m[4]}:{kind:'link',text:m[5],target:m[6]});
    previous=m.index+m[0].length;
  }
  if(previous<source.length)parts.push({kind:'text',text:source.slice(previous)});
  return parts;
}
export function parseMarkdown(source='') {
  const blocks=[];let paragraph=[],code=[],fence=null;
  const add=(kind,text,level=0)=>blocks.push({kind,text,level,parts:kind==='code'?[]:inline(text)});
  const flush=()=>{if(paragraph.length){add('paragraph',paragraph.join('\n'));paragraph=[];}};
  for(const line of String(source).replace(/\r\n/g,'\n').split('\n')) {
    const trimmed=line.trim();
    if(fence){if(trimmed.startsWith(fence)){add('code',code.join('\n'));code=[];fence=null;}else code.push(line);continue;}
    if(trimmed.startsWith('```')||trimmed.startsWith('~~~')){flush();fence=trimmed.slice(0,3);continue;}
    if(!trimmed){flush();continue;}
    const heading=/^(#{1,6})\s+(.+)$/.exec(line),list=/^\s*[-*+]\s+(.+)$/.exec(line);
    if(heading){flush();add('heading',heading[2],heading[1].length);}
    else if(list){flush();add('list','• '+list[1]);}
    else if(trimmed.startsWith('> ')){flush();add('quote',trimmed.slice(2));}
    else paragraph.push(line);
  }
  if(fence)add('code',code.join('\n'));flush();return blocks;
}
export function plainMarkdown(source){return parseMarkdown(source).map(b=>b.kind==='code'?b.text:b.parts.map(p=>p.text).join('')).join('\n');}
export function renderMarkdown(parent,source,copy) {
  parent.replaceChildren();
  for(const b of parseMarkdown(source)){
    if(b.kind==='code'){renderCode(parent,b.text,copy);continue;}
    const el=document.createElement(b.kind==='heading'?'h'+Math.min(b.level,4):b.kind==='quote'?'blockquote':'p');
    if(b.kind==='list')el.className='md-list';
    for(const p of b.parts){
      if(p.kind==='text')el.append(document.createTextNode(p.text));
      else {const child=document.createElement({bold:'strong',code:'code',link:'a'}[p.kind]);child.textContent=p.text;
        if(p.kind==='link'){child.href=p.target;child.target='_blank';child.rel='noopener noreferrer';}
        el.append(child);
      }
    }parent.append(el);
  }
}
export function renderCode(parent,source,copy){
  const box=document.createElement('div');box.className='code-block';
  const button=document.createElement('button');button.className='code-copy';button.type='button';button.textContent='复制代码';button.onclick=()=>copy(source);
  const pre=document.createElement('pre');pre.textContent=source;box.append(button,pre);parent.append(box);
}
