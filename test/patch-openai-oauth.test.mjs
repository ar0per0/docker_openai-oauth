import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, cp } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { originalImageBlock, patchedImageBlock, originalRouteAnchor, patchOpenAIOAuth } from '../patch-openai-oauth.mjs'
const parent = new URL('../.inspection/', import.meta.url).pathname
const fixture = async fn => {
 const root = await mkdtemp(join(parent, 'test-patch-'))
 try { await cp(join(parent, 'verification/package'), root, { recursive: true }); await fn(root) }
 finally { await rm(root, { recursive: true, force: true }) }
}
test('npm real: idempotencia, imágenes preservadas y handler integrado', async () => fixture(async root => {
 const target = patchOpenAIOAuth(root)
 const first = await readFile(target, 'utf8')
 patchOpenAIOAuth(root)
 assert.equal(await readFile(target, 'utf8'), first)
 assert.ok(first.includes(patchedImageBlock))
 assert.equal(first.split('openaiCredentials(settings)').length, 2)
 const { createOpenAIOAuthFetchHandler } = await import(`file://${root}/dist/index.js`)
 const handler = createOpenAIOAuthFetchHandler({ authFilePath: join(root, 'never-created.json') })
 const result = await handler(new Request('http://localhost/oauth/rate-limits'))
 assert.equal(result.status, 503)
 assert.match((await result.json()).error.message,/OAuth session unavailable/)
 assert.equal((await handler(new Request('http://localhost/health'))).status, 200)
 // Replace only the isolated copy's session provider; never read auth.json.
 const localEntry = join(root, 'node_modules/@openai-oauth/local/dist/index.js')
 await writeFile(localEntry, `export const openaiCredentials = () => ({ getSession: async () => ({ accessToken: "synthetic", accountId: "test-account" }) });`)
 // Import a second isolated chunk URL to avoid the already loaded provider cache.
 const source2 = first.replace('from "@openai-oauth/local"', 'from "./synthetic-session.mjs"')
 await writeFile(join(root,'dist/synthetic-session.mjs'), 'export let calls=0; export const openaiCredentials=()=>({getSession:async()=>{calls++;return {accessToken:"synthetic",accountId:"test-account"}}});')
 await writeFile(join(root,'dist/integration.js'), source2)
 const module2 = await import(`file://${root}/dist/integration.js`)
 let upstreamCalls=0
 const authenticated = module2.createOpenAIOAuthFetchHandler({ fetch: async (url,options)=> {
  upstreamCalls++; assert.equal(url,'https://chatgpt.com/backend-api/wham/usage')
  assert.equal(options.headers.get('chatgpt-account-id'),'test-account')
  assert.equal(options.headers.get('authorization'),'Bearer synthetic')
  return Response.json({plan_type:'plus',rate_limit:null})
 } })
 for (const headers of [{}, {authorization:'Bearer client-not-oauth'}]) {
  const response = await authenticated(new Request('http://localhost/oauth/rate-limits',{headers}))
  assert.equal(response.status,200)
 }
 assert.equal(upstreamCalls,2)
 assert.equal((await import(`file://${root}/dist/synthetic-session.mjs`)).calls,2)

}))
test('npm real: actualiza helper antiguo con clave y sigue idempotente', async () => fixture(async root => {
 const target = patchOpenAIOAuth(root)
 const before = await readFile(target,'utf8')
 const helper = join(root,'dist/oauth-rate-limits.mjs')
 await writeFile(helper,'// previous key-gated helper\nexport const handleOAuthRateLimits = () => new Response(null,{status:401});\n')
 patchOpenAIOAuth(root)
 const expected = await readFile(new URL('../oauth-rate-limits.mjs',import.meta.url),'utf8')
 assert.equal(await readFile(helper,'utf8'),expected)
 assert.equal(await readFile(target,'utf8'),before)
 patchOpenAIOAuth(root)
 assert.equal(await readFile(helper,'utf8'),expected)
}))
test('npm real: acepta parche previo exclusivamente de imágenes', async () => fixture(async root => {
 const target = join(root, 'dist/chunk-INHW7GRB.js')
 await writeFile(target, (await readFile(target, 'utf8')).replace(originalImageBlock, patchedImageBlock))
 assert.ok((await readFile(patchOpenAIOAuth(root), 'utf8')).includes(patchedImageBlock))
}))
test('npm real: rechaza versión y anclas incompatibles/ambiguas sin mutaciones', async () => {
 for (const mode of ['version', 'missing', 'duplicate']) await fixture(async root => {
  const chunk = join(root, 'dist/chunk-INHW7GRB.js')
  if (mode === 'version') await writeFile(join(root, 'package.json'), '{"name":"openai-oauth","version":"2.0.1"}')
  if (mode === 'missing') await writeFile(chunk, (await readFile(chunk,'utf8')).replace(originalRouteAnchor, 'invalid'))
  if (mode === 'duplicate') await writeFile(chunk, (await readFile(chunk,'utf8'))+'\n'+originalRouteAnchor)
  const before = await readFile(chunk,'utf8')
  assert.throws(() => patchOpenAIOAuth(root))
  assert.equal(await readFile(chunk,'utf8'), before)
 })
})

test('usage patch preserves unknown versus explicit zero, strict and idempotent without archived writes', async () => {
 const { originalUsageBlock,patchedUsageBlock } = await import('../patch-openai-oauth.mjs')
 const { runInNewContext } = await import('node:vm')
 const { tmpdir } = await import('node:os')
 const root=await mkdtemp(join(tmpdir(),'oauth-usage-patch-'))
 try {
  await cp(join(parent,'verification/package'),root,{recursive:true})
  const target=patchOpenAIOAuth(root),first=await readFile(target,'utf8')
  assert.ok(first.includes(patchedUsageBlock));assert.ok(!first.includes(originalUsageBlock))
  const start=first.indexOf('var toUsage ='),end=first.indexOf('var summarizeChatRequest',start)
  const convert=runInNewContext(first.slice(start,end)+';toUsage')
  const absent=convert({});assert.equal(absent.prompt_tokens,null);assert.equal(absent.total_tokens,null)
  const zero=convert({inputTokens:0,outputTokens:0,totalTokens:0,cachedInputTokens:0,reasoningTokens:0})
  assert.equal(zero.prompt_tokens,0);assert.equal(zero.prompt_tokens_details.cached_tokens,0)
  patchOpenAIOAuth(root);assert.equal(await readFile(target,'utf8'),first)
  await writeFile(target,first.replace(patchedUsageBlock,''));const broken=await readFile(target,'utf8')
  assert.throws(()=>patchOpenAIOAuth(root));assert.equal(await readFile(target,'utf8'),broken)
 } finally {await rm(root,{recursive:true,force:true})}
})
