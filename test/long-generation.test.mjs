import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { patchOpenAIOAuth } from '../patch-openai-oauth.mjs'

// Opt-in because this intentionally crosses the old real 30-second deadline.
// Uses the pinned npm package and synthetic OAuth/inference; no credentials.
test('HTTP generation survives 30 seconds, direct and through router, both protocols and stream modes', {
 skip: process.env.LONG_GENERATION_TEST !== '1', timeout: 60000,
}, async () => {
 const root=await mkdtemp(join(tmpdir(),'oauth-long-'))
 let instance, router
 try {
  await cp(new URL('../.inspection/verification/package',import.meta.url),root,{recursive:true})
  const target=patchOpenAIOAuth(root)
  await writeFile(join(root,'dist/session.mjs'),'export const openaiCredentials=()=>({getSession:async()=>({accessToken:"synthetic",accountId:"synthetic"})});')
  await writeFile(join(root,'dist/probe.js'),(await readFile(target,'utf8')).replace('from "@openai-oauth/local"','from "./session.mjs"'))
  const {startOpenAIOAuthServer}=await import('file://'+root+'/dist/probe.js')
  const terminal='event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{id:'resp_synthetic',status:'completed',model:'synthetic',output:[]}})+'\n\n'
  instance=await startOpenAIOAuthServer({host:'127.0.0.1',port:0,models:['synthetic'],codexVersion:'0.144.1',fetch:async(url,{signal})=>{
   if(url.includes('/models'))return Response.json({models:[{slug:'synthetic'}]})
   return new Response(new ReadableStream({async start(controller){
    try {
     // Activity every second also proves an active stream was subject to the old absolute limit.
     for(let i=0;i<33;i++) { await delay(1000,undefined,{signal});controller.enqueue(new TextEncoder().encode(': heartbeat\n\n')) }
     controller.enqueue(new TextEncoder().encode(terminal));controller.close()
    }catch(error){controller.error(error)}
   }}),{headers:{'content-type':'text/event-stream'}})
  }})
  const direct=`http://127.0.0.1:${instance.port}`
  // Optional sibling checkout exercises the complete local deployment chain.
  const urls=[direct]
  if(process.env.ROUTER_PROJECT) {
   const {createRouterServer}=await import('file://'+process.env.ROUTER_PROJECT+'/src/server.mjs')
   const {loadConfig}=await import('file://'+process.env.ROUTER_PROJECT+'/src/config.mjs')
   router=createRouterServer(loadConfig({UPSTREAMS:direct,UPSTREAM_TIMEOUT_MS:'240000'}),{quotaFetchImpl:async()=>Response.json({rateLimits:null})})
   router.listen(0,'127.0.0.1');await once(router,'listening');urls.push(`http://127.0.0.1:${router.address().port}`)
  }
  await Promise.all(urls.flatMap((url,index)=>['chat/completions','responses'].flatMap(path=>[false,true].map(async stream=>{
   const start=Date.now()
   const response=await fetch(`${url}/v1/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'synthetic',messages:[{role:'user',content:'synthetic'}],input:[],stream}),signal:AbortSignal.timeout(50000)})
   assert.equal(response.status,200)
   const text=await response.text()
   const elapsed=Date.now()-start
   assert.ok(elapsed>30000)
   if(stream)assert.match(text,path==='chat/completions'?/\[DONE\]/:/response.completed/)
   else assert.ok(JSON.parse(text))
   console.log(JSON.stringify({route:index?'router':'direct',path,stream,status:response.status,elapsedMs:elapsed,complete:true}))
  }))))
 } finally {
  if(router){router.closeAllConnections();await new Promise(resolve=>router.close(resolve))}
  await instance?.close()
  await rm(root,{recursive:true,force:true})
 }
})
