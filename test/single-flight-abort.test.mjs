import test from 'node:test'
import assert from 'node:assert/strict'
import { singleFlight } from '../runtime-safety.mjs'

test('an already cancelled caller never starts a shared operation', async () => {
 const controller = new AbortController()
 const reason = new Error('cancelled')
 controller.abort(reason)
 let calls = 0
 await assert.rejects(singleFlight('already-aborted', () => { calls++; return 'value' }, controller.signal), error => error === reason)
 assert.equal(calls, 0)
})

test('an already cancelled caller cannot join or disturb a live shared operation', async () => {
 let finish, calls = 0
 const operation = () => { calls++; return new Promise(resolve => { finish = resolve }) }
 const live = singleFlight('live-aborted-join', operation, new AbortController().signal)
 await Promise.resolve()
 await assert.rejects(singleFlight('live-aborted-join', operation, AbortSignal.abort()))
 assert.equal(calls, 1)
 finish('value')
 assert.equal(await live, 'value')
})
