import { prepareSafety as prepareV1 } from "./safety-patch-v1.mjs"
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
const unique = (source, old, replacement) => {
 if (source.split(old).length !== 2) throw new Error('Safety patch anchor drift')
 return source.replace(old, replacement)
}
const signatures = {
 'local/dist/index.js': 'a7a52c898534d43c1f5cfbb3345147b1d4b1604b0ea170e25d0a8838d73407e9',
 'local/dist/auth-file.js': '5324eb942739b6bb33a65cb7d664d66b3189f0b1b3d609fe69169d1e3589d157',
 'core/dist/runtime.js': '8209c6f9fb1e552b4edd04203f38e38586e338b1d25949729232b34bce2dda47',
 'core/dist/sse.js': '6e0acdef93162f62ad3536797c33d51da7f69d8632d04c5aeb79ea805a7abe3c',
}
const marker = '// oauth-docker-safety-v2\n'
export function prepareSafety(root, source) {
 if (source.includes('// oauth-server-safety-v1') && !source.includes('// oauth-server-safety-v2')) prepareV1(root, source)
 const writes = []
 for (const [relative, signature] of Object.entries(signatures)) {
  const component = relative.split('/')[0]
  const base = resolve(root, 'node_modules/@openai-oauth', component)
  const metadata = JSON.parse(readFileSync(resolve(base, 'package.json'), 'utf8'))
  if (metadata.version !== '2.0.0' || metadata.name !== '@openai-oauth/' + component) throw new Error('Dependency version drift')
  const file = resolve(root, 'node_modules/@openai-oauth', relative)
  let text = readFileSync(file, 'utf8')
  if (/^\/\/ oauth-docker-safety-v[12]\n/.test(text)) {
   // Reconstruct expected content from retained original, then compare exact bytes.
   const original = readFileSync(file + '.oauth-original', 'utf8')
   if (createHash('sha256').update(original).digest('hex') !== signature) throw new Error('Original dependency drift')
   text = original
  } else if (createHash('sha256').update(text).digest('hex') !== signature) throw new Error('Dependency source drift')
  const original = text
  if (relative === 'local/dist/index.js') {
   text = unique(text, 'getSession: async () => toSession(await loadAuthTokens({', 'getSession: async (sessionOptions = {}) => toSession(await loadAuthTokens({\n        signal: sessionOptions.signal,')
  } else if (component === 'local') {
   const a = text.indexOf('const writeAuthFile = async'), b = text.indexOf('export const resolveCodexAuthFilePath', a)
   if (a < 0 || b < 0) throw new Error('Auth write drift')
   text = text.slice(0,a) + 'const writeAuthFile = privateWrite;\n' + text.slice(b)
   text = unique(text, 'export const loadAuthTokens = async (options) => {', 'const loadAuthTokensInternal = async (options) => {')
   text += '\nexport const loadAuthTokens = (options) => singleFlight(credentialKey(options, resolveCodexAuthFilePath()), (signal) => loadAuthTokensInternal({ ...options, fetch: (url, init = {}) => boundedFetch(options.fetch)(url, { ...init, signal }) }), options.signal);\n'
   text = 'import { privateWrite, singleFlight, credentialKey, boundedFetch } from "./runtime-safety.mjs";\n' + text
  } else if (relative.endsWith('sse.js')) {
   text = unique(text, '    if (latestResponse) {\n        return withCollectedOutput(latestResponse);\n    }', '    throw new Error("Upstream SSE ended without a terminal response.");')
   text = text.replaceAll('return withCollectedOutput(latestResponse);', 'if (latestResponse.status !== "completed") throw new Error("Upstream response did not complete.");\n                return withCollectedOutput(latestResponse);')
   text = unique(text, '        catch { }\n        if (terminal && latestResponse)', '        catch (error) { if (error?.message === "Upstream response did not complete.") throw error; }\n        if (terminal && latestResponse)')
  } else {
   text = unique(text, 'const resolveAuth = async (source) => {', 'const resolveAuth = async (source, signal) => {')
   text = unique(text, 'typeof source === "function" ? await source() : source', 'typeof source === "function" ? await source(signal) : source')
   text = unique(text, '        const auth = await resolveAuth(settings.auth);', '        const auth = await resolveAuth(settings.auth, boundedSignal(request.signal));')
   text = unique(text, '    const fetch = pickFetch(settings.fetch);', '    const fetch = boundedFetch(pickFetch(settings.fetch));')
   const ca = text.indexOf('const createModelCatalogResolver ='), cb = text.indexOf('const resolveAuth =', ca)
   if (ca < 0 || cb < 0) throw new Error('Catalog anchor drift')
   text = text.slice(0, ca) + `const createModelCatalogResolver = (fetch, baseURL, settings) => {
    const cache = new Map(); const namespace = crypto.randomUUID();
    return async (auth, signal) => {
     const key = auth.accountId + ':' + (auth.isFedRamp === true);
     const cached = cache.get(key);
     if (cached && cached.expiresAt > Date.now()) { signal?.throwIfAborted(); return cached.result; }
     return singleFlight(namespace + key, async sharedSignal => {
      let version = settings.codexVersion;
      if (!version) {
       try { const response = await fetch('https://registry.npmjs.org/@openai/codex/latest', { signal: sharedSignal });
        const payload = await response.json(); version = typeof payload.version === 'string' ? payload.version : '0.144.1';
       } catch { sharedSignal.throwIfAborted(); version = '0.144.1'; }
      }
      const models = await fetchCodexModelCatalog({ request: async (path, init) => {
       const headers = new Headers(settings.headers); new Headers(init?.headers).forEach((v,k)=>headers.set(k,v));
       applyAuthHeaders(headers, auth);
       return fetch(new URL(path.replace(/^\\//, ''), baseURL + '/').toString(), { ...init, headers, signal: sharedSignal });
      } }, { codexVersion: version, fetchImpl: (url, init={}) => fetch(url, { ...init, signal: sharedSignal }) });
      const result = { models }; cache.set(key, { result, expiresAt: Date.now() + MODEL_CATALOG_TTL_MS }); return result;
     }, signal);
    };
};
` + text.slice(cb)
   text = unique(text, 'const resolveModelInfo = async (auth, model) => (await resolveModelCatalog(auth)).models.find((entry) => entry.slug === model);', 'const resolveModelInfo = async (auth, model, signal) => (await resolveModelCatalog(auth, signal)).models.find((entry) => entry.slug === model);')
   text = unique(text, '        const request = await readRequestParts(input, init);', '        const request = await readRequestParts(input, init);\n        request.signal = boundedSignal(request.signal);')
   text = unique(text, 'await resolveModelCatalog(auth);', 'await resolveModelCatalog(auth, request.signal);')
   text = unique(text, 'responsesState, auth, resolveModelInfo);', 'responsesState, auth, (auth, model) => resolveModelInfo(auth, model, request.signal));')
   text = unique(text, '        return finalizeResponsesResponse(response, preparedBody, responsesState);', `        const guarded = response.ok && preparedBody.requestBody && response.body ? new Response(terminalStream(response.body, request.signal), { status: response.status, headers: response.headers }) : response;
        return finalizeResponsesResponse(guarded, preparedBody, responsesState);`)
   text = 'import { singleFlight, terminalStream, boundedFetch, boundedSignal } from "./runtime-safety.mjs";\n' + text
  }
  const expected = marker + text
  const current = readFileSync(file, 'utf8')
  if (current.startsWith(marker) && current !== expected) throw new Error('Modified safety dependency')
  writes.push([file, expected], [file + '.oauth-original', original])
 }
 const serverFile = resolve(root, 'dist/chunk-INHW7GRB.js')
 const currentServer = source
 if ((/oauth-server-safety-v[12]/.test(source))) source = readFileSync(serverFile + '.oauth-before-safety', 'utf8')
 const beforeSafety = source
 {
  source = unique(source, '  const auth = openaiCredentials(settings);', '  // oauth-server-safety-v2\n  settings = { ...settings, fetch: boundedFetch(settings.fetch) };\n  const auth = openaiCredentials(settings);')
  source = unique(source, '    auth: () => auth.getSession(),', '    auth: (signal) => auth.getSession({ signal }),')
  const ra = source.indexOf('var readNodeBody ='), rb = source.indexOf('var toHeaders =', ra)
  if (ra < 0 || rb < 0) throw new Error('Body adapter drift')
  source = source.slice(0, ra) + 'var readNodeBody = readLimitedBody;\n' + source.slice(rb)
  source = unique(source, 'await readNodeBody(request)', 'await readNodeBody(request, options.signal)')
  source = unique(source, 'var toWebRequest = async (request, options) => {', 'var toWebRequest = async (request, options) => {')
  source = unique(source, '    duplex: "half"', '    signal: options.signal,\n    duplex: "half"')
  const a = source.indexOf('var writeWebResponse ='), b = source.indexOf('var resolveAddress', a)
  if (a < 0 || b < 0) throw new Error('Response adapter drift')
  source = source.slice(0,a) + 'var writeWebResponse = writeResponse;\n' + source.slice(b)
  source = unique(source, '      const request = await toWebRequest(req, { host, port });', '      const controller = new AbortController();\n      req.once("aborted", () => controller.abort());\n      res.once("close", () => controller.abort());\n      const request = await toWebRequest(req, { host, port, signal: boundedSignal(controller.signal) });')
  source = unique(source, '  const body = await request.json();\n  if (!isChatRequest', '  const body = await request.json();\n  if (hasUnsupportedLimit(body)) return toErrorResponse("Explicit token limits are unsupported by this OAuth transport.", 400, "unsupported_token_limit");\n  if (!isChatRequest')
  source = unique(source, '  if (usesServerReplayState(body)) {', '  if (hasUnsupportedLimit(body)) return toErrorResponse("Explicit token limits are unsupported by this OAuth transport.", 400, "unsupported_token_limit");\n  if (usesServerReplayState(body)) {')
  source = unique(source, '    return streamChatCompletions(body, provider, {', '    return streamChatCompletions({ ...body, abortSignal: request.signal }, provider, {')
  source = unique(source, '    maxOutputTokens: request.max_tokens,', '    abortSignal: boundedSignal(request.abortSignal),\n    maxOutputTokens: request.max_completion_tokens ?? request.max_tokens,')
  source = unique(source, '      maxOutputTokens: body.max_tokens,', '      abortSignal: boundedSignal(request.signal),\n      maxOutputTokens: body.max_completion_tokens ?? body.max_tokens,')
  source = unique(source, '  const result = streamText({', '  const streamAbort = new AbortController();\n  const result = streamText({')
  source = unique(source, 'abortSignal: boundedSignal(request.abortSignal)', 'abortSignal: boundedSignal(AbortSignal.any([streamAbort.signal, ...(request.abortSignal ? [request.abortSignal] : [])]))')
  source = unique(source, '  const stream = new ReadableStream({\n    async start(controller) {', '  const stream = demandStream(async (controller) => {')
  source = unique(source, '      controller.close();\n    }\n  });', '      controller.close();\n  }, () => streamAbort.abort());')
  const sa = source.indexOf('var summarizeChatRequest ='), sb = source.indexOf('var copyUpstreamResponse =', sa)
  if (sa < 0 || sb < 0) throw new Error('Summary drift')
  source = source.slice(0, sa) + 'var summarizeChatRequest = safeChatSummary;\n' + source.slice(sb)
  source = unique(source, 'var readModelList = async (client) => {', 'var readModelList = async (client, signal) => {')
  source = unique(source, 'client.request("/models")', 'client.request("/models", { signal })')
  source = unique(source, 'var resolveOpenAIOAuthModels = async (client, configuredModels)', 'var resolveOpenAIOAuthModels = async (client, configuredModels, signal)')
  source = unique(source, 'readModelList(client);', 'readModelList(client, signal);')
  source = unique(source, '() => resolveOpenAIOAuthModels(client, configuredModels);', '(signal) => resolveOpenAIOAuthModels(client, configuredModels, signal);')
  source = unique(source, 'await resolveModels();', 'await resolveModels(request.signal);')
  source = unique(source, '  const models = await runtime.resolveModels();', '  const startupSignal = boundedSignal(settings.signal);\n  const models = await waitFor(runtime.resolveModels(startupSignal), startupSignal);')
  source = unique(source, 'toErrorResponse(message, 500, "server_error")', 'toErrorResponse(message, error?.status === 413 ? 413 : 500, "server_error")')
  source = source.replaceAll('controller.enqueue(', 'await controller.enqueue(')
  source = source.replaceAll('error instanceof Error ? error.message : "Unexpected server error."', '"Upstream request failed."')
  source = source.replaceAll('error instanceof Error ? error.message : "Failed to load models."', '"Model discovery unavailable."')
  source = source.replaceAll('part.error instanceof Error ? part.error.message : "Streaming chat completion failed."', '"Upstream stream failed."')
  source = 'import { boundedFetch, boundedSignal, demandStream, writeResponse, hasUnsupportedLimit, readLimitedBody, safeChatSummary, waitFor } from "./runtime-safety.mjs";\n' + source
 }
 if (currentServer.includes('// oauth-server-safety-v2') && currentServer !== source) throw new Error('Modified safety server')
 writes.push([serverFile + '.oauth-before-safety', beforeSafety])
 return { source, writes }
}
