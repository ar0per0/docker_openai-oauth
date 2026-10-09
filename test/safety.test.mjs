import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { patchOpenAIOAuth } from '../patch-openai-oauth.mjs'
import { demandStream, writeResponse, privateWrite, boundedFetch, singleFlight } from '../runtime-safety.mjs'
import { handleOAuthRateLimits } from '../oauth-rate-limits.mjs'
const keep = async fn => { const timer=setInterval(()=>{},50);try{return await fn()}finally{clearInterval(timer)} }
test('quota timeout covers blocked session; rejection safely observed',()=>keep(async()=>{
 let calls=0
 const r=await handleOAuthRateLimits(new Request('http://localhost/oauth/rate-limits'),{getSession:()=>new Promise((_,reject)=>setTimeout(()=>reject(Error('private')),50))},{timeoutMs:10,fetch:()=>{calls++;throw Error()}})
 assert.equal(r.status,502);assert.equal(calls,0)
 await new Promise(r=>setTimeout(r,60))
}))
test('private atomic write replaces existing broad mode, preserves shared parent',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'oauth-private-'));try{const file=join(dir,'synthetic.json');await writeFile(file,'{}',{mode:0o644});const before=(await stat(dir)).mode;await privateWrite(file,{synthetic:true});assert.equal((await stat(file)).mode&0o777,0o600);assert.equal((await stat(dir)).mode,before);assert.deepEqual(JSON.parse(await readFile(file)),{synthetic:true})}finally{await rm(dir,{recursive:true,force:true})}
})
test('demand stream stops producing when unread and cancels cleanly',async()=>{
 let produced=0,cancelled=false
 const stream=demandStream(async sink=>{for(let i=0;i<100;i++){await sink.enqueue(new Uint8Array([i]));produced++}sink.close()},()=>{cancelled=true})
 await new Promise(r=>setTimeout(r,10));assert.ok(produced<=1)
 const reader=stream.getReader();await reader.read();await reader.cancel();await new Promise(r=>setTimeout(r,10));assert.equal(cancelled,true);assert.ok(produced<100)
})
test('HTTP writer waits drain, and close cancels upstream reader',async()=>{
 class Response extends EventEmitter{destroyed=false;setHeader(){};write(){this.writes=(this.writes||0)+1;return false}end(){}}
 let cancelled=false
 const response=new Response();const body=new ReadableStream({pull(c){c.enqueue(new Uint8Array([1]))},cancel(){cancelled=true}})
 const task=writeResponse(response,{status:200,headers:new Headers(),body}).catch(e=>{assert.equal(e.name,'AbortError')})
 await new Promise(r=>setTimeout(r,10));assert.equal(response.writes,1);response.destroyed=true;response.emit('close');await task;assert.equal(cancelled,true)
})
test('bounded fetch forwards abort to startup discovery and refresh',()=>keep(async()=>{
 const controller=new AbortController();let signal
 const fetch=boundedFetch(async(_,init)=>{signal=init.signal;return new Promise((_,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true})})})
 const task=fetch('http://synthetic',{signal:controller.signal});controller.abort();await assert.rejects(task);assert.equal(signal.aborted,true)
}))
test('real pinned package: single flight, scoped identity, permissions, strict SSE and safe errors',async()=>{
 const root=await mkdtemp(join(tmpdir(),'oauth-safety-package-'))
 try {
 await cp(new URL('../.inspection/verification/package',import.meta.url),root,{recursive:true})
 const target=patchOpenAIOAuth(root);patchOpenAIOAuth(root)
 const text=await readFile(target,'utf8');assert.ok(text.includes('max_completion_tokens ??'));assert.ok(text.includes('signal: options.signal'));assert.ok(text.includes('demandStream'));assert.ok(!text.includes('error instanceof Error ? error.message : "Unexpected server error."'))
 const {createOpenAIOAuthFetchHandler}=await import(`file://${root}/dist/index.js`)
 let upstream=0
 const handler=createOpenAIOAuthFetchHandler({authFilePath:join(root,'missing-synthetic.json'),fetch:async()=>{upstream++;throw Error('private')}})
 for(const path of ['chat/completions','responses']) for(const limit of ['max_tokens','max_completion_tokens','max_output_tokens']) {
 const response=await handler(new Request('http://localhost/v1/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[],input:[],[limit]:128})}));assert.equal(response.status,400);assert.equal((await response.json()).error.type,'unsupported_token_limit')
 }
 assert.equal(upstream,0)
 const allowed=await handler(new Request('http://localhost/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:[]})}));assert.notEqual(allowed.status,400);assert.doesNotMatch(await allowed.text(),/private/)
 const {openaiCredentials}=await import(`file://${root}/node_modules/@openai-oauth/local/dist/index.js`)
 const file=join(root,'synthetic.json');await writeFile(file,JSON.stringify({tokens:{access_token:'synthetic',refresh_token:'synthetic-refresh',account_id:'account'},last_refresh:'2000-01-01T00:00:00Z'}),{mode:0o644})
 let calls=0;const fetch=async()=>{calls++;await new Promise(r=>setTimeout(r,15));return Response.json({access_token:'synthetic-new',refresh_token:'synthetic-new-refresh'})}
 const auth=openaiCredentials({authFilePath:file,fetch});const results=await Promise.all([auth.getSession(),auth.getSession()]);assert.equal(calls,1);assert.equal(results[0].accountId,'account');assert.equal((await stat(file)).mode&0o777,0o600)
 const {collectCompletedResponseFromSse}=await import(`file://${root}/node_modules/@openai-oauth/core/dist/sse.js`)
 for(const status of ['in_progress','failed','incomplete']){const type=status==='in_progress'?'response.created':'response.'+status;await assert.rejects(collectCompletedResponseFromSse(new Response(`event: ${type}\ndata: ${JSON.stringify({type,response:{id:'synthetic',status,output:[]}})}\n\n`).body))}
 const completed=await collectCompletedResponseFromSse(new Response('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n').body);assert.equal(completed.status,'completed')
 const core=join(root,'node_modules/@openai-oauth/core/dist/runtime.js');await writeFile(core,(await readFile(core,'utf8'))+'\n// drift');await assert.rejects(async()=>patchOpenAIOAuth(root));assert.equal(await readFile(target,'utf8'),text)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('single-flight cancellation retains other waiter and aborts last; identities isolated',()=>keep(async()=>{
 let calls=0,aborts=0
 const operation=signal=>{calls++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve('session'),40);signal.addEventListener('abort',()=>{aborts++;clearTimeout(timer);reject(signal.reason)},{once:true})})}
 const a=new AbortController(),b=new AbortController()
 const first=singleFlight('shared-synthetic',operation,a.signal),second=singleFlight('shared-synthetic',operation,b.signal)
 await new Promise(r=>setTimeout(r,5));a.abort();await assert.rejects(first);assert.equal(await second,'session');assert.equal(calls,1)
 const c=new AbortController();const last=singleFlight('last-synthetic',operation,c.signal);await new Promise(r=>setTimeout(r,5));c.abort();await assert.rejects(last);assert.ok(aborts>=1)
 const [x,y]=await Promise.all([singleFlight('account-a',()=> 'a'),singleFlight('account-b',()=> 'b')]);assert.deepEqual([x,y],['a','b'])
}))
test('demand stream successful multi-chunk delivery preserves ordering',async()=>{
 const stream=demandStream(async sink=>{for(let i=0;i<20;i++)await sink.enqueue(Uint8Array.of(i));sink.close()})
 assert.deepEqual([...new Uint8Array(await new Response(stream).arrayBuffer())],Array.from({length:20},(_,i)=>i))
})
