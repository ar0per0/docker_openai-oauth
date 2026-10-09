import assert from 'node:assert/strict'
import test from 'node:test'
import { handleOAuthRateLimits, normalizeRateLimits } from '../oauth-rate-limits.mjs'
const request = (authorization, method = 'GET') => new Request('http://localhost/oauth/rate-limits', { method, headers: authorization === undefined ? {} : { authorization } })
test('endpoint sin clave local conserva sesión OAuth obligatoria y GET', async () => {
 let sessions=0
 const auth = { getSession() { sessions++; throw Error('private') } }
 for (const authorization of [undefined, 'Bearer wrong', 'Basic bad']) {
  const result = await handleOAuthRateLimits(request(authorization), auth)
  assert.equal(result.status,503);assert.doesNotMatch(await result.text(),/private/)
 }
 assert.equal(sessions,3)
 assert.equal((await handleOAuthRateLimits(request(undefined,'POST'),auth)).status,405)
 assert.equal(sessions,3)
 for (const session of [null, {}, {accessToken:'synthetic'}, {accountId:'account'}]) {
  assert.equal((await handleOAuthRateLimits(request(),{getSession:async()=>session},{fetch:()=>{throw Error('must not run')}})).status,503)
 }
})
test('session manager único, contexto cuenta, headers no heredados y no redirects', async () => {
 let sessions = 0
 const result = await handleOAuthRateLimits(request('Bearer client-must-not-be-forwarded'), { async getSession(){ sessions++; return {accessToken:'synthetic-token',accountId:'synthetic-account',isFedRamp:true} } }, {fetch:async (url,options) => {
  assert.equal(url,'https://chatgpt.com/backend-api/wham/usage')
  assert.equal(options.method,'GET'); assert.equal(options.redirect,'error')
  assert.equal(options.headers.get('authorization'),'Bearer synthetic-token')
  assert.equal(options.headers.get('chatgpt-account-id'),'synthetic-account')
  assert.equal(options.headers.get('x-openai-fedramp'),'true')
  assert.equal(options.headers.has('x-openai-codex-luna-reserve'),false)
  return Response.json({plan_type:'plus',rate_limit:null})
 }})
 assert.equal(sessions,1); assert.equal(result.status,200); assert.equal(result.headers.get('cache-control'),'no-store')
})
test('errores saneados sesión, upstream, JSON y timeout', async () => {
 const auth = {getSession:async()=>({accessToken:'synthetic',accountId:'account'})}
 assert.equal((await handleOAuthRateLimits(request(),{getSession:async()=>{throw Error('private')}},{})).status,503)
 for (const fetch of [async()=>new Response('private',{status:401}),async()=>new Response('private'),async()=>Response.json({}),async()=>{throw Error('private')}]) {
  const result = await handleOAuthRateLimits(request(),auth,{fetch})
  assert.equal(result.status,502); assert.doesNotMatch(await result.text(),/private|synthetic/)
 }
})
test('null desconocido, multi límites, segundos Unix, duración real y créditos string', () => {
 const result = normalizeRateLimits({plan_type:'plus',rate_limit:{allowed:false,primary_window:{used_percent:83,limit_window_seconds:7200,reset_at:1800000000},secondary_window:null},credits:{has_credits:true,unlimited:false,balance:'12.345'},additional_rate_limits:[{metered_feature:'other',limit_name:'Other',normal_model_slug:'model',rate_limit:{secondary_window:{used_percent:0,limit_window_seconds:604800,reset_at:1800000010}}}]})
 assert.equal(result.rateLimits.primary.usedPercent,83)
 assert.equal(result.rateLimits.primary.windowDurationMins,120)
 assert.equal(result.rateLimits.primary.resetsAt,1800000000)
 assert.equal(result.rateLimits.secondary,null)
 assert.equal(result.rateLimits.credits.balance,'12.345')
 assert.equal(result.rateLimitsByLimitId.other.secondary.windowDurationMins,10080)
 assert.equal(result.rateLimitsByLimitId.other.primary,null)
 assert.equal(result.rateLimitsByLimitId.other.credits,null)
 assert.equal(result.ordinaryUsageAllowed,false)
 const unknown = normalizeRateLimits({rate_limit:null,credits:null,additional_rate_limits:null})
 assert.equal(unknown.ordinaryUsageAllowed,null); assert.equal(unknown.rateLimits.primary,null)
 const incomplete = normalizeRateLimits({rate_limit:{primary_window:{used_percent:null,limit_window_seconds:0}}})
 assert.deepEqual(incomplete.rateLimits.primary,{usedPercent:null,windowDurationMins:null,resetsAt:null})
 assert.throws(()=>normalizeRateLimits({additional_rate_limits:[{metered_feature:'codex'}]}))
 assert.throws(()=>normalizeRateLimits({additional_rate_limits:{}}))
})
test('esquemas incompatibles fallan; valores desconocidos no se convierten en cero', () => {
 for (const payload of [{rate_limit:[]}, {rate_limit:'bad'}, {credits:false}, {rate_limit:{primary_window:[]}}, {additional_rate_limits:[{metered_feature:'other',rate_limit:false}]}]) {
  assert.throws(()=>normalizeRateLimits(payload))
 }
 const payload = normalizeRateLimits({rate_limit:{primary_window:{used_percent:'0',limit_window_seconds:'300',reset_at:'1800000000',reset_after_seconds:10},secondary_window:{used_percent:0,limit_window_seconds:61,reset_at:1800000000}}})
 assert.deepEqual(payload.rateLimits.primary,{usedPercent:null,windowDurationMins:null,resetsAt:null})
 assert.deepEqual(payload.rateLimits.secondary,{usedPercent:0,windowDurationMins:2,resetsAt:1800000000})
 const limits = normalizeRateLimits({additional_rate_limits:[{metered_feature:'__proto__',rate_limit:null},{metered_feature:'constructor',rate_limit:null}]})
 assert.equal(Object.keys(limits.rateLimitsByLimitId).length,3)
 assert.equal(limits.rateLimitsByLimitId.__proto__.limitId,'__proto__')
})
test('timeout real, cancelación y cuenta distinta no filtran resultados', async () => {
 const auth = {getSession:async()=>({accessToken:'synthetic',accountId:'account'})}
 const blockedFetch = async (_, {signal}) => new Promise((resolve,reject)=> {
  if (signal.aborted) return reject(signal.reason)
  signal.addEventListener('abort',()=>reject(signal.reason),{once:true})
 })
 // Keep the event loop alive: AbortSignal.timeout uses an unref timer.
 const keepAlive = setInterval(()=>{},100)
 try {
  const timed = await handleOAuthRateLimits(request(),auth,{timeoutMs:15,fetch:blockedFetch})
  assert.equal(timed.status,502)
  const controller = new AbortController(); controller.abort()
  const aborted = new Request('http://localhost/oauth/rate-limits',{signal:controller.signal})
  assert.equal((await handleOAuthRateLimits(aborted,auth,{fetch:blockedFetch})).status,502)
 } finally {clearInterval(keepAlive)}
 const mismatch = await handleOAuthRateLimits(request(),auth,{fetch:async()=>Response.json({plan_type:'plus',account_id:'wrong-private'})})
 assert.equal(mismatch.status,502); assert.doesNotMatch(await mismatch.text(),/wrong-private/)
})
test('respuesta uso acotada a 256 KiB no devuelve cuerpos enormes',async()=>{
 const result=await handleOAuthRateLimits(request(),{getSession:async()=>({accessToken:'synthetic',accountId:'account'})},{fetch:async()=>new Response('x'.repeat(262145))})
 assert.equal(result.status,502);assert.ok((await result.text()).length<200)
})
