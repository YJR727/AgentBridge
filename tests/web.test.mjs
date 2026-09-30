import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMarkdown, plainMarkdown} from '../public/markdown.js';
import {ChatStatus,formatReplyTime} from '../public/chat-status.js';

test('chat status expires even with hung requests; old target and resumed requests cannot reconnect',()=>{
 const s=new ChatStatus(),a=s.begin('A');s.confirm('A',a,1000,true);
 assert.equal(s.isConnected(10999),true);assert.equal(s.isConnected(11000),false);
 s.begin('B');s.confirm('A',a,11001,true);assert.equal(s.isConnected(11001),false);
 const b=s.begin('');s.confirm('B',b,12000,true);assert.equal(s.isConnected(12000),true);
 s.begin('');s.confirm('B',b,12001,true);assert.equal(s.isConnected(12001),false);
});
test('reply times preserve actual duration and local calendar without guessing missing data',()=>{
 assert.equal(formatReplyTime({durationMs:null,completedAtMs:1000}), '时间不可用');
 assert.equal(formatReplyTime({durationMs:-1,completedAtMs:1000}), '时间不可用');
 const text=formatReplyTime({durationMs:138000,completedAtMs:86460000},90000000,'UTC');
 assert.match(text,/2 分 18 秒.*今日 00:01/);
 assert.match(formatReplyTime({durationMs:0,completedAtMs:1000},86400000,'UTC'),/1970-01-01/);
});

test('web readable text formats bold, lists and preserves code symbols and blank lines',()=>{
  const blocks=parseMarkdown('# 标题\n\n**批准/拒绝**\n- 苹果\n```sh\n\na*b **原样**\n\n```');
  assert.equal(blocks[0].kind,'heading');
  assert.equal(blocks[1].parts[0].text,'批准/拒绝');
  assert.equal(blocks[1].parts[0].kind,'bold');
  assert.equal(blocks[2].text,'• 苹果');
  assert.equal(blocks[3].text,'\na*b **原样**\n');
  assert.equal(plainMarkdown('正文 `a*b`'),'正文 a*b');
});
test('web text never converts HTML or unsafe links into executable markup',()=>{
  const source='<img src=x onerror=alert(1)> [危险](javascript:alert) [官网](https://example.com)';
  const parts=parseMarkdown(source)[0].parts;
  assert.equal(parts.filter(p=>p.kind==='link').length,1);
  assert.equal(parts.find(p=>p.kind==='link').target,'https://example.com');
  assert.ok(plainMarkdown(source).includes('<img src=x onerror=alert(1)>'));
  assert.ok(plainMarkdown(source).includes('[危险](javascript:alert)'));
});
test('web parsing retains long Chinese text and unclosed code',()=>{
  assert.equal(plainMarkdown('中文'.repeat(30000)).length,60000);
  assert.equal(parseMarkdown('```\nx ** y')[0].text,'x ** y');
});
