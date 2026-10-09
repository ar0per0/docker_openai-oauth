import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { patchOpenAIOAuth } from '../patch-openai-oauth.mjs'
import { hasUnsupportedLimit, safeChatSummary } from '../runtime-safety.mjs'
const fixture = async fn => {
 const root=await mkdtemp(join(tmpdir(),'oauth-closure-'))
 try {
 await cp(new URL('../.inspection/verification/package',import.meta.url),root,{recursive:true})
 const target=patchOpenAIOAuth(root);patchOpenAIOAuth(root)
 const source=await readFile(target,'utf8')
 await writeFile(join(root,'dist/session.mjs'),'export let calls=0; export const openaiCredentials=()=>({getSession:async()=>{calls++;return {accessToken:"synthetic",accountId:"synthetic"}}});')
 await writeFile(join(root,'dist/probe.js'),source.replace('from "@openai-oauth/local"','from "./session.mjs"'))
 await fn(await import('file://'+root+'/dist/probe.js'),await import('file://'+root+'/dist/session.mjs'))
 } finally {await rm(root,{recursive:true,force:true})}
}
const req=(path,body,signal)=>new Request('http://localhost/v1/'+path,{method:'POST',signal,body:JSON.stringify(body)})
const event=(type,status)=>`event: ${type}\ndata: ${JSON.stringify({type,response:{id:'resp_synthetic',status,model:'synthetic',output:[]}})}\n\n`
const mock = content => async url => url.includes('/models')?Response.json({models:[{slug:'synthetic'}]}):new Response(content,{headers:{'content-type':'text/event-stream'}})
test('all real routes reject created-only EOF and failed/incomplete/error; successful terminals preserve null usage',()=>fixture(async ({createOpenAIOAuthFetchHandler})=>{
 for (const content of [event('response.created','in_progress'),event('response.failed','failed'),event('response.incomplete','incomplete'),'event: error\ndata: {"type":"error","message":"PRIVATE_SECRET"}\n\n']) {
 for(const path of ['chat/completions','responses']) for(const stream of [false,true]) {
 const handler=createOpenAIOAuthFetchHandler({codexVersion:'0.144.1',fetch:mock(content)})
 const response=await handler(req(path,{model:'synthetic',messages:[{role:'user',content:'synthetic'}],input:[],stream}))
 if(!stream){assert.equal(response.status,500);assert.doesNotMatch(await response.text(),/PRIVATE_SECRET/)}
 else {await assert.rejects(response.text());}
 }
 }
 for(const path of ['chat/completions','responses']) for(const stream of [false,true]) {
 const handler=createOpenAIOAuthFetchHandler({codexVersion:'0.144.1',fetch:mock(event('response.completed','completed'))})
 const response=await handler(req(path,{model:'synthetic',messages:[{role:'user',content:'synthetic'}],input:[],stream}))
 assert.equal(response.status,200);const text=await response.text();assert.ok(text.length>0)
 if(path==='chat/completions'){assert.match(text,/"prompt_tokens":null/);if(stream)assert.match(text,/\[DONE\]/)}
 }
}))
test('limits root and generation_config reject before session; tool payload is not configuration',()=>fixture(async({createOpenAIOAuthFetchHandler},session)=>{
 const handler=createOpenAIOAuthFetchHandler({fetch:()=>{throw Error('must not call')}})
 for(const path of ['chat/completions','responses'])for(const key of ['max_tokens','max_completion_tokens','max_output_tokens','maxOutputTokens','max_new_tokens'])for(const nested of [false,true]){
 const body={messages:[],input:[],...(nested?{generation_config:{[key]:1}}:{[key]:1})}
 const response=await handler(req(path,body));assert.equal(response.status,400);assert.equal((await response.json()).error.type,'unsupported_token_limit')
 }
 assert.equal(session.calls,0)
 assert.equal(hasUnsupportedLimit({tools:[{function:{parameters:{properties:{max_tokens:{type:'number'}}}}}],input:[{max_tokens:1}]}),false)
}))
test('safe request logs omit arbitrary values and free key names',()=>{
 const output=JSON.stringify(safeChatSummary({PRIVATE_KEY:'PRIVATE_SECRET',model:'PRIVATE_SECRET',reasoning_effort:{secret:'PRIVATE_SECRET'},messages:[{role:'PRIVATE_SECRET'}],tools:[],stream:true}))
 assert.doesNotMatch(output,/PRIVATE/);assert.deepEqual(JSON.parse(output),{messageCount:1,stream:true,toolCount:0})
})
test('model discovery shares registry/catalog; one cancel retains other, last cancel aborts upstream',()=>fixture(async({createOpenAIOAuthFetchHandler})=>{
 let calls=0,aborts=0
 const fetch=async(url,{signal})=>new Promise((resolve,reject)=>{
 calls++;let settled=false;const timer=setTimeout(()=>{settled=true;resolve(url.includes('registry')?Response.json({version:'0.144.1'}):Response.json({models:[{slug:'synthetic'}]}))},40)
 signal.addEventListener('abort',()=>{if(settled)return;aborts++;clearTimeout(timer);reject(signal.reason)},{once:true})
 })
 const handler=createOpenAIOAuthFetchHandler({fetch})
 const a=new AbortController(),b=new AbortController()
 const first=handler(new Request('http://localhost/v1/models',{signal:a.signal})),second=handler(new Request('http://localhost/v1/models',{signal:b.signal}))
 setTimeout(()=>a.abort(),5);assert.equal((await first).status,502);assert.equal((await second).status,200);assert.equal(calls,2);assert.equal(aborts,0)
 const other=createOpenAIOAuthFetchHandler({fetch,codexVersion:'0.144.1'}),c=new AbortController()
 const last=other(new Request('http://localhost/v1/models',{signal:c.signal}));setTimeout(()=>c.abort(),5);assert.equal((await last).status,502);await new Promise(r=>setTimeout(r,10));assert.equal(aborts,1)
}))
test('loopback real HTTP server returns 413 before auth and cuts incomplete Responses stream',()=>fixture(async({startOpenAIOAuthServer},session)=>{
 const instance=await startOpenAIOAuthServer({host:'127.0.0.1',port:0,models:['synthetic'],codexVersion:'0.144.1',fetch:mock(event('response.created','in_progress'))})
 try {
 const status=await new Promise((resolve,reject)=>{
 const request=httpRequest({host:'127.0.0.1',port:instance.port,path:'/v1/responses',method:'POST'},response=>{let body='';response.setEncoding('utf8');response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(body)}))});request.on('error',reject);request.end('x'.repeat(16777217))
 });assert.equal(status.status,413);assert.deepEqual(status.body,{error:{message:'Upstream request failed.',type:'server_error'}});assert.equal(session.calls,0)
 await assert.rejects(async()=>{const response=await fetch(`http://127.0.0.1:${instance.port}/v1/responses`,{method:'POST',body:JSON.stringify({input:[],stream:true})});await response.text()})
 }finally{await instance.close()}
}))
test('startup has a single deadline; downstream abort propagates through real Responses route',()=>fixture(async({startOpenAIOAuthServer,createOpenAIOAuthFetchHandler})=>{
 const c=new AbortController()
 const startup=startOpenAIOAuthServer({host:'127.0.0.1',port:0,signal:c.signal,fetch:async(_, {signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))})
 setTimeout(()=>c.abort(),5);await assert.rejects(startup)
 let aborted=false
 const handler=createOpenAIOAuthFetchHandler({codexVersion:'0.144.1',fetch:async(url,{signal})=>{
 if(url.includes('/models'))return Response.json({models:[{slug:'synthetic'}]})
 return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason)},{once:true}))
 }})
 const cancel=new AbortController(),task=handler(req('responses',{input:[],stream:true},cancel.signal));setTimeout(()=>cancel.abort(),15)
 assert.equal((await task).status,500);assert.equal(aborted,true)
}))
test('successful Chat tools and embedded image reach transport with unknown usage preserved',()=>fixture(async({createOpenAIOAuthFetchHandler})=>{
 let received
 const output=[{id:'fc_synthetic',type:'function_call',call_id:'call_synthetic',name:'synthetic_tool',arguments:'{"max_tokens":1}',status:'completed'}]
 const handler=createOpenAIOAuthFetchHandler({codexVersion:'0.144.1',fetch:async(url,init)=>{
 if(url.includes('/models'))return Response.json({models:[{slug:'synthetic'}]})
 received=JSON.parse(init.body)
 return new Response(`event: response.output_item.done\ndata: ${JSON.stringify({type:'response.output_item.done',output_index:0,item:output[0]})}\n\nevent: response.completed\ndata: ${JSON.stringify({type:'response.completed',response:{id:'resp_synthetic',status:'completed',model:'synthetic',output}})}\n\n`,{headers:{'content-type':'text/event-stream'}})
 }})
 const response=await handler(req('chat/completions',{model:'synthetic',messages:[{role:'user',content:[{type:'text',text:'synthetic'},{type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8='}}]}],tools:[{type:'function',function:{name:'synthetic_tool',parameters:{type:'object',properties:{max_tokens:{type:'number'}}}}}]}))
 assert.equal(response.status,200);const body=await response.json();assert.equal(body.usage.total_tokens,null);assert.equal(body.choices[0].message.tool_calls[0].function.name,'synthetic_tool');assert.ok(JSON.stringify(received).includes('data:image/png;base64,aGVsbG8='))
}))
test('exact previous v1 upgrade and v2 reapply validate before mutations',async()=>{
 const {prepareSafety:prepareV1}=await import('../safety-patch-v1.mjs')
 const {originalImageBlock,patchedImageBlock,originalUsageBlock,patchedUsageBlock,originalAuthAnchor,patchedAuthAnchor,originalRouteAnchor,patchedRouteAnchor,rateLimitsImport}=await import('../patch-openai-oauth.mjs')
 const root=await mkdtemp(join(tmpdir(),'oauth-upgrade-'))
 try{
 await cp(new URL('../.inspection/verification/package',import.meta.url),root,{recursive:true})
 const file=join(root,'dist/chunk-INHW7GRB.js')
 let source=await readFile(file,'utf8');for(const [old,replacement]of [[originalImageBlock,patchedImageBlock],[originalUsageBlock,patchedUsageBlock],[originalAuthAnchor,patchedAuthAnchor],[originalRouteAnchor,patchedRouteAnchor]])source=source.replace(old,replacement)
 const previous=prepareV1(root,source.includes(rateLimitsImport)?source:rateLimitsImport+source)
 for(const [path,text]of previous.writes)await writeFile(path,text)
 await writeFile(file,previous.source)
 patchOpenAIOAuth(root);const upgraded=await readFile(file,'utf8');assert.match(upgraded,/oauth-server-safety-v2/);patchOpenAIOAuth(root);assert.equal(await readFile(file,'utf8'),upgraded)
 const dependency=join(root,'node_modules/@openai-oauth/core/dist/runtime.js');await writeFile(dependency,(await readFile(dependency,'utf8'))+'\n// drift')
 assert.throws(()=>patchOpenAIOAuth(root));assert.equal(await readFile(file,'utf8'),upgraded)
 }finally{await rm(root,{recursive:true,force:true})}
})
