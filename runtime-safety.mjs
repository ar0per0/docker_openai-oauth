import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const boundedSignal = (signal, timeout = Number(process.env.UPSTREAM_TIMEOUT_MS || 30000)) => {
 if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) throw new Error('Invalid upstream timeout')
 return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)])
}
export const boundedFetch = (fetchImpl = globalThis.fetch) => (url, init = {}) => fetchImpl(url, { ...init, signal: boundedSignal(init.signal) })
export const waitFor = (promise, signal) => new Promise((resolve, reject) => {
 const abort = () => reject(signal.reason)
 if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return abort() }
 signal.addEventListener('abort', abort, { once: true })
 Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
})
const flights = new Map()
export async function singleFlight(key, operation, signal = boundedSignal()) {
 let flight = flights.get(key)
 if (!flight) {
  const controller = new AbortController()
  flight = { controller, waiters: 0 }
  flight.task = Promise.resolve().then(() => operation(boundedSignal(controller.signal)))
  flights.set(key, flight)
  const cleanup = () => { if (flights.get(key) === flight) flights.delete(key) }
  flight.task.then(cleanup, cleanup)
 }
 flight.waiters++
 try { return await waitFor(flight.task, signal) }
 finally {
  if (--flight.waiters === 0) {
   flight.controller.abort()
   if (flights.get(key) === flight) flights.delete(key)
  }
 }
}
export const credentialKey = (options, defaultPath) => JSON.stringify([resolve(options.authFilePath || defaultPath), options.clientId || '', options.issuer || '', options.tokenUrl || ''])
export async function privateWrite(file, data) {
 const dir = dirname(file)
 await fs.mkdir(dir, { recursive: true, mode: 0o700 })
 const info = await fs.lstat(dir)
 if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe credential directory')
 // Do not chmod an arbitrary shared parent directory; the credential itself is private.
 try {
  const existing = await fs.lstat(file)
  if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Unsafe credential file')
 } catch (error) { if (error.code !== 'ENOENT') throw error }
 const temp = `${file}.${randomUUID()}.tmp`
 let handle
 try {
  handle = await fs.open(temp, 'wx', 0o600)
  await handle.writeFile(JSON.stringify(data, null, 2), 'utf8')
  await handle.sync(); await handle.close(); handle = null
  await fs.rename(temp, file)
  const directory = await fs.open(dir, 'r'); try { await directory.sync() } finally { await directory.close() }
 } finally { await handle?.close(); await fs.rm(temp, { force: true }) }
}
export const demandStream = (produce, abort) => {
 let wake, stopped = false
 return new ReadableStream({
  start(controller) {
   const sink = {
    async enqueue(value) {
     while (!stopped && controller.desiredSize <= 0) await new Promise(r => { wake = r })
     if (stopped) throw new Error('Stream cancelled')
     controller.enqueue(value)
    },
    close() { if (!stopped) controller.close() },
    error() { if (!stopped) controller.error(new Error('Upstream stream failed.')) },
   }
   void (async () => { try { await produce(sink) } catch { sink.error() } finally { abort?.() } })()
  },
  pull() { wake?.(); wake = null },
  cancel() { stopped = true; abort?.(); wake?.(); wake = null },
 })
}
export async function writeResponse(response, webResponse) {
 response.statusCode = webResponse.status
 webResponse.headers.forEach((value, key) => response.setHeader(key, value))
 if (!webResponse.body) { response.end(); return }
 const reader = webResponse.body.getReader()
 const cancel = () => { void reader.cancel().catch(() => {}) }
 response.once('close', cancel)
 try {
  while (!response.destroyed) {
   const { done, value } = await reader.read()
   if (done) break
   if (!response.write(Buffer.from(value))) {
    const controller = new AbortController()
    const close = () => controller.abort()
    response.once('close', close)
    try { if (response.destroyed) break; await once(response, 'drain', { signal: controller.signal }) }
    finally { response.off('close', close) }
   }
  }
  if (!response.destroyed) response.end()
 } finally { response.off('close', cancel); await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export const safeChatSummary = body => ({
 messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
 stream: body.stream === true,
 toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
})
export class BodyLimitError extends Error { constructor() { super('Request body too large.'); this.status = 413 } }
export async function readLimitedBody(request, signal) {
 const chunks = []; let bytes = 0
 for await (const chunk of request) {
  signal?.throwIfAborted()
  bytes += chunk.length
  if (bytes > 16777216) throw new BodyLimitError()
  chunks.push(Buffer.from(chunk))
 }
 return Buffer.concat(chunks)
}
// Validate before SDK parsing: EOF and failed terminals are stream errors, never DONE.
export function terminalStream(body, signal) {
 const reader = body.getReader(); const decoder = new TextDecoder()
 let buffer = '', completed = false, finished = false
 const check = block => {
  const lines = block.split(/\r?\n/)
  const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
  const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
  if (!data || data === '[DONE]') return
  let parsed; try { parsed = JSON.parse(data) } catch { throw new Error('Invalid upstream SSE.') }
  const type = parsed.type || event
  if (type === 'error' || ['response.failed','response.incomplete','response.cancelled','response.canceled'].includes(type)) throw new Error('Upstream response did not complete.')
  if (type === 'response.completed') {
   if (parsed.response?.status !== 'completed') throw new Error('Invalid upstream terminal.')
   completed = true
  }
 }
 const cancel = () => { void reader.cancel().catch(() => {}) }
 signal?.addEventListener('abort', cancel, { once: true })
 const cleanup = () => { signal?.removeEventListener('abort', cancel); reader.releaseLock() }
 return new ReadableStream({
  async pull(controller) {
   try {
    signal?.throwIfAborted()
    const { value, done } = await waitFor(reader.read(), signal || boundedSignal())
    signal?.throwIfAborted()
    if (done) {
     buffer += decoder.decode()
     if (buffer.trim()) check(buffer)
     if (!completed) throw new Error('Upstream SSE ended without a completed terminal.')
     finished = true; cleanup(); controller.close(); return
    }
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop() || ''
    if (buffer.length > 16777216) throw new Error('Upstream SSE event too large.')
    for (const block of blocks) check(block)
    controller.enqueue(value)
   } catch {
    finished = true; await reader.cancel().catch(() => {}); cleanup()
    controller.error(new Error('Upstream stream failed.'))
   }
  },
  async cancel() { if (!finished) { finished = true; await reader.cancel().catch(() => {}); cleanup() } },
 })
}
