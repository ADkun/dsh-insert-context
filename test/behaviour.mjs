/**
 * Verification harness for dsh-convergence-notice.
 *
 * Runs the real `index.js` against a fake Cordis context: no DSH process, no
 * network, no dependencies. Covers both behaviours (append-to-every-user-message,
 * inject-every-N-executed-steps), their switches, the saved-settings precedence,
 * and the whole HTTP surface including the trust fence.
 *
 *   node test/behaviour.mjs
 *
 * Note on counts: "every N steps" counts the steps an agent actually executes,
 * not the step ordinal, so a run that skips rejected steps still fires on every
 * Nth *executed* step (a rejected step neither counts nor injects).
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-profile-'))
process.env.DSH_PROFILE_DIR = profile
const settingsPath = path.join(profile, 'convergence-notice.json')

const { apply } = await import(pathToFileURL(path.join(here, '..', 'index.js')).href)

const TEXT =
  '【规划用最少的轮次达成目标。】'

let passed = 0
const failed = []
function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed.push(label)
    console.error(`FAIL  ${label}\n      ${error?.message ?? error}`)
  }
}
function stored() {
  return fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {}
}

/** Mount the plugin on a fake context, returning its listeners and routes. */
function mount(config) {
  const listeners = new Map()
  const routes = []
  const ctx = {
    logger: { debug() {}, info() {}, warn() {} },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
    },
    inject(keys, callback) {
      callback({
        effect: run => {
          run()
          return () => {}
        },
        webServer: {
          register: route => {
            routes.push(route)
            return () => {}
          },
        },
      })
      return () => {}
    },
    get: () => undefined,
  }
  apply(ctx, config)
  return { listeners, routes }
}

/** Drive one pre-step through every registered listener. */
async function step(mounted, { agentId = 'a1', messages = [], kind = 'enter' } = {}) {
  const payload = { agent: { id: agentId }, messages, turn: 1, step: 1 }
  let decision = kind === 'enter' ? { kind: 'enter', messages } : { kind: 'reject' }
  for (const fn of mounted.listeners.get('agent/pre-step') ?? []) {
    const inner = decision
    decision = await fn(payload, async () => inner)
  }
  return decision
}

function userMessage(text = 'do the thing') {
  return { id: 'u1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'r1' } }
}
function contextMessage(text = 'ctx') {
  return { id: 'c1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'runtime-context' } }
}

/** Call the registered route handler with a fake request/response. */
async function request(mounted, { method = 'GET', path: routePath = '/settings', body, headers = {} } = {}) {
  const handler = mounted.routes.find(route => route.kind === 'prefix')?.handler
  assert.ok(handler, 'the webServer route is registered')
  const req = new EventEmitter()
  req.method = method
  req.url = `/api/convergence-notice${routePath}`
  req.headers = { host: '127.0.0.1:3080', ...headers }
  let status
  let answer = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(payload) {
      answer = payload
    },
  }
  const pending = handler(req, res)
  if (method === 'POST') {
    setImmediate(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
  }
  await pending
  return { status, body: answer === '' ? undefined : JSON.parse(answer) }
}

console.log('behaviour 1 — append to every user message')
{
  const mounted = mount({ every: 100 })
  const original = userMessage()
  const decision = await step(mounted, { messages: [original] })
  check('the message keeps its own text, id and source, and gains a trailing block', () => {
    assert.equal(decision.messages.length, 1)
    const message = decision.messages[0]
    assert.equal(message.id, 'u1')
    assert.equal(message.source.kind, 'user')
    assert.equal(message.source.rpcId, 'r1')
    assert.deepEqual(message.content[0], { type: 'text', text: 'do the thing' })
    assert.deepEqual(message.content[1], { type: 'text', text: TEXT })
  })
  check('the incoming message object is not mutated', () => {
    assert.equal(original.content.length, 1)
    assert.equal(original.content[0].text, 'do the thing')
  })
  check('the rewritten message is frozen, like the harness freezes its own', () => {
    assert.ok(Object.isFrozen(decision.messages[0]))
    assert.ok(Object.isFrozen(decision.messages[0].content))
  })
  const empty = await step(mounted, {})
  check('a step with no user message passes an empty batch through', () => {
    assert.deepEqual(empty.messages, [])
  })
  const foreign = await step(mounted, { messages: [contextMessage()] })
  check('non-user sources (runtime context) stay untouched', () => {
    assert.equal(foreign.messages.length, 1)
    assert.equal(foreign.messages[0].content.length, 1)
    assert.equal(foreign.messages[0].content[0].text, 'ctx')
  })
  const rejected = await step(mounted, { messages: [userMessage()], kind: 'reject' })
  check('a rejected step is passed through untouched', () => {
    assert.deepEqual(rejected, { kind: 'reject' })
  })
  const mixed = await step(mounted, { messages: [contextMessage('ctx'), userMessage('hello')] })
  check('only user messages in a mixed batch are rewritten', () => {
    assert.equal(mixed.messages.length, 2)
    assert.equal(mixed.messages[0].content.length, 1)
    assert.equal(mixed.messages[1].content.length, 2)
  })
  const two = await step(mounted, { messages: [userMessage('one'), userMessage('two')] })
  check('every user message in the batch is rewritten', () => {
    assert.equal(two.messages.length, 2)
    assert.equal(two.messages[0].content.length, 2)
    assert.equal(two.messages[1].content.length, 2)
  })

  const dense = mount({ every: 1 })
  const coinciding = await step(dense, { messages: [userMessage()] })
  check('on a coinciding step behaviour 2 yields — no duplicate sentence', () => {
    assert.equal(coinciding.messages.length, 1)
    assert.equal(coinciding.messages[0].content.length, 2)
    assert.equal(coinciding.messages[0].content[1].text, TEXT)
  })
}

console.log('behaviour 2 — inject once every N executed steps')
{
  const mounted = mount({ every: 3 })
  const one = await step(mounted, { agentId: 'b1' })
  const two = await step(mounted, { agentId: 'b1' })
  const three = await step(mounted, { agentId: 'b1' })
  check('nothing on the 1st and 2nd step', () => {
    assert.deepEqual(one.messages, [])
    assert.deepEqual(two.messages, [])
  })
  check('one standalone notice on the 3rd, tagged and frozen', () => {
    assert.equal(three.messages.length, 1)
    const notice = three.messages[0]
    assert.equal(notice.role, 'user')
    assert.equal(notice.source.kind, 'convergence-notice')
    assert.deepEqual(notice.content, [{ type: 'text', text: TEXT }])
    assert.ok(Object.isFrozen(notice))
    assert.ok(typeof notice.id === 'string' && notice.id.length > 0)
  })
  const four = await step(mounted, { agentId: 'b1' })
  const five = await step(mounted, { agentId: 'b1' })
  const six = await step(mounted, { agentId: 'b1' })
  check('silent again on the 4th and 5th, repeating on the 6th', () => {
    assert.deepEqual(four.messages, [])
    assert.deepEqual(five.messages, [])
    assert.equal(six.messages.length, 1)
    assert.equal(six.messages[0].source.kind, 'convergence-notice')
  })
  const fresh = await step(mounted, { agentId: 'b2' })
  check('counters are per agent, not per plugin', () => {
    assert.deepEqual(fresh.messages, [])
  })
  const rejected = await step(mounted, { agentId: 'b3', kind: 'reject' })
  const afterOne = await step(mounted, { agentId: 'b3' })
  const afterTwo = await step(mounted, { agentId: 'b3' })
  const afterThree = await step(mounted, { agentId: 'b3' })
  check('a rejected step neither counts nor injects', () => {
    assert.deepEqual(rejected, { kind: 'reject' })
    assert.deepEqual(afterOne.messages, [])
    assert.deepEqual(afterTwo.messages, [])
    assert.equal(afterThree.messages.length, 1)
    assert.equal(afterThree.messages[0].source.kind, 'convergence-notice')
  })
}

console.log('switches')
{
  const off = mount({ every: 1, stepNotice: false })
  const withUser = await step(off, { agentId: 'c1', messages: [userMessage()] })
  const bare = await step(off, { agentId: 'c1' })
  check('stepNotice:false — no standalone notice, even at every step', () => {
    assert.deepEqual(bare.messages, [])
    assert.equal(withUser.messages.length, 1)
  })
  check('stepNotice:false — behaviour 1 still appends', () => {
    assert.equal(withUser.messages[0].content.length, 2)
    assert.equal(withUser.messages[0].content[1].text, TEXT)
  })

  const noAppend = mount({ every: 2, userAppend: false })
  const untouched = await step(noAppend, { agentId: 'd1', messages: [userMessage()] })
  const stillNotices = await step(noAppend, { agentId: 'd1' })
  check('userAppend:false — the user message is returned unchanged', () => {
    assert.equal(untouched.messages.length, 1)
    assert.equal(untouched.messages[0].content.length, 1)
    assert.equal(untouched.messages[0].content[0].text, 'do the thing')
  })
  check('userAppend:false — behaviour 2 still injects on its own schedule', () => {
    assert.equal(stillNotices.messages.length, 1)
    assert.equal(stillNotices.messages[0].source.kind, 'convergence-notice')
  })

  const neither = mount({ every: 1, stepNotice: false, userAppend: false })
  const quiet = await step(neither, { agentId: 'e1', messages: [userMessage()] })
  check('both switches off — the plugin is completely silent', () => {
    assert.equal(quiet.messages.length, 1)
    assert.equal(quiet.messages[0].content.length, 1)
  })
}

console.log('HTTP surface')
{
  const mounted = mount({ every: 5, stepNotice: true, userAppend: true })
  const initial = await request(mounted)
  check('GET answers the live state, the Config defaults and an empty store', () => {
    assert.equal(initial.status, 200)
    assert.equal(initial.body.ok, true)
    assert.equal(initial.body.every, 5)
    assert.equal(initial.body.stepNotice, true)
    assert.equal(initial.body.userAppend, true)
    assert.equal(initial.body.min, 1)
    assert.equal(initial.body.max, 1000)
    assert.deepEqual(initial.body.configured, { every: 5, stepNotice: true, userAppend: true, text: TEXT })
    assert.deepEqual(initial.body.stored, {})
    assert.equal(initial.body.text, TEXT)
    assert.equal(initial.body.file, settingsPath)
  })

  const missing = await request(mounted, { path: '/nope' })
  check('an unknown path under the prefix answers 404', () => {
    assert.equal(missing.status, 404)
  })

  const saved = await request(mounted, { method: 'POST', body: { every: 1, stepNotice: false } })
  check('POST accepts a subset and answers the new state', () => {
    assert.equal(saved.status, 200)
    assert.equal(saved.body.every, 1)
    assert.equal(saved.body.stepNotice, false)
    assert.equal(saved.body.userAppend, true)
    assert.deepEqual(saved.body.stored, { every: 1, stepNotice: false })
  })
  check('the store file holds exactly what was saved', () => {
    assert.deepEqual(stored(), { every: 1, stepNotice: false })
  })
  const one = await step(mounted, { agentId: 'f1', messages: [userMessage()] })
  const two = await step(mounted, { agentId: 'f1' })
  check('the saved switches are live at once: behaviour 1 appends, the notice is off', () => {
    assert.equal(one.messages.length, 1)
    assert.equal(one.messages[0].content.length, 2)
    assert.deepEqual(two.messages, [])
  })

  const repatched = await request(mounted, {
    method: 'POST',
    body: { every: 3, stepNotice: true, userAppend: false },
  })
  check('a second patch overwrites the store', () => {
    assert.equal(repatched.status, 200)
    assert.deepEqual(stored(), { every: 3, stepNotice: true, userAppend: false })
  })
  const g1 = await step(mounted, { agentId: 'g1', messages: [userMessage()] })
  const g2 = await step(mounted, { agentId: 'g1' })
  const g3 = await step(mounted, { agentId: 'g1' })
  check('userAppend:false is live and the interval is 3, not the Config\'s 5', () => {
    assert.equal(g1.messages.length, 1)
    assert.equal(g1.messages[0].content.length, 1)
    assert.deepEqual(g2.messages, [])
    assert.equal(g3.messages.length, 1)
    assert.equal(g3.messages[0].source.kind, 'convergence-notice')
  })

  const remounted = mount({ every: 9, stepNotice: true, userAppend: true })
  const reread = await request(remounted)
  check('a second mount prefers the saved file over the Config (precedence)', () => {
    assert.equal(reread.body.every, 3)
    assert.equal(reread.body.stepNotice, true)
    assert.equal(reread.body.userAppend, false)
    assert.deepEqual(reread.body.configured, { every: 9, stepNotice: true, userAppend: true, text: TEXT })
  })
  const h1 = await step(remounted, { agentId: 'h1', messages: [userMessage()] })
  const h2 = await step(remounted, { agentId: 'h1' })
  const h3 = await step(remounted, { agentId: 'h1' })
  check('and behaves on the stored values, not the configured ones', () => {
    assert.equal(h1.messages[0].content.length, 1)
    assert.deepEqual(h2.messages, [])
    assert.equal(h3.messages.length, 1)
  })

  const cleared = await request(remounted, { method: 'DELETE' })
  check('DELETE drops the file and falls back to the Config', () => {
    assert.equal(cleared.status, 200)
    assert.deepEqual(cleared.body.stored, {})
    assert.equal(cleared.body.every, 9)
    assert.equal(cleared.body.stepNotice, true)
    assert.equal(cleared.body.userAppend, true)
    assert.deepEqual(stored(), {})
  })

  const bad = await request(remounted, { method: 'POST', body: { every: 0 } })
  check('400 on an out-of-range interval', () => {
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error, 'every must be an integer between 1 and 1000')
  })
  const stringy = await request(remounted, { method: 'POST', body: { every: '4' } })
  check('a numeric string is accepted and stored as a number', () => {
    assert.equal(stringy.status, 200)
    assert.equal(stringy.body.every, 4)
    assert.deepEqual(stored(), { every: 4 })
  })
  const empty = await request(remounted, { method: 'POST', body: {} })
  check('400 on an empty patch', () => {
    assert.equal(empty.status, 400)
    assert.equal(empty.body.error, 'no settings provided')
  })
  const wrong = await request(remounted, { method: 'POST', body: { userAppend: 'yes' } })
  check('400 on a non-boolean switch', () => {
    assert.equal(wrong.status, 400)
    assert.equal(wrong.body.error, 'userAppend must be true or false')
  })
  const noBody = await request(remounted, { method: 'POST' })
  check('400 on a body-less POST', () => {
    assert.equal(noBody.status, 400)
  })
  check('no rejected patch touched the store', () => {
    assert.deepEqual(stored(), { every: 4 })
  })
  const put = await request(remounted, { method: 'PUT', body: {} })
  check('405 for an unsupported method', () => {
    assert.equal(put.status, 405)
  })

  const crossSite = await request(remounted, { headers: { origin: 'http://evil.example' } })
  check('403 when the Origin authority differs from the Host', () => {
    assert.equal(crossSite.status, 403)
  })
  const remote = await request(remounted, { headers: { host: '10.0.0.9:3080' } })
  check('403 for a non-loopback Host', () => {
    assert.equal(remote.status, 403)
  })
  const good = await request(remounted, {
    headers: { origin: 'http://127.0.0.1:3080', referer: 'http://127.0.0.1:3080/settings' },
  })
  check('200 when Origin and Referer match the Host', () => {
    assert.equal(good.status, 200)
  })
}

console.log('the notice text — default, override and precedence')
{
  const mounted = mount({ every: 100 })
  await request(mounted, { method: 'DELETE' })

  const initial = await request(mounted)
  check('the built-in default text is the exact sentence, with its own code units', () => {
    assert.equal(initial.body.text, TEXT)
    assert.equal(initial.body.text.length, 15)
    assert.equal(initial.body.text[0], '【')
    assert.equal(initial.body.text[13], '。')
    assert.equal(initial.body.text[14], '】')
    assert.equal(initial.body.text.charCodeAt(0), 0x3010)
    assert.equal(initial.body.text.charCodeAt(13), 0x3002)
    assert.equal(initial.body.text.charCodeAt(14), 0x3011)
    for (const blank of [' ', '\u3000', '\u00a0', '\u200b', '\ufeff', '\t', '\n', '\r']) {
      assert.equal(initial.body.text.includes(blank), false, `unexpected ${JSON.stringify(blank)}`)
    }
    assert.equal(/\s/u.test(initial.body.text), false)
  })

  const first = await step(mounted, { agentId: 't0', messages: [userMessage()] })
  check('the default sentence is what is injected', () => {
    assert.equal(first.messages[0].content[1].text, TEXT)
  })

  const configuredText = '插件配置里的句子。'
  const overridden = mount({ every: 100, text: configuredText })
  const readBack = await request(overridden)
  check('config.text overrides the built-in default', () => {
    assert.equal(readBack.body.text, configuredText)
    assert.deepEqual(readBack.body.configured, {
      every: 100,
      stepNotice: true,
      userAppend: true,
      text: configuredText,
    })
  })
  const onConfig = await step(overridden, { agentId: 't1', messages: [userMessage()] })
  check('the injected sentence is the configured one', () => {
    assert.equal(onConfig.messages[0].content[1].text, configuredText)
  })

  const storedText = '存盘里的句子。'
  const saved = await request(overridden, { method: 'POST', body: { text: storedText } })
  check('POST { text } is accepted, stored verbatim and answered live', () => {
    assert.equal(saved.status, 200)
    assert.equal(saved.body.text, storedText)
    assert.equal(saved.body.stored.text, storedText)
    assert.deepEqual(stored(), { text: storedText })
  })
  const onStored = await step(overridden, { agentId: 't2', messages: [userMessage()] })
  check('the saved sentence is live on the very next step, no restart', () => {
    assert.equal(onStored.messages[0].content[1].text, storedText)
  })

  const remounted = mount({ every: 3, text: '另一个配置句子。' })
  const reread = await request(remounted)
  check('a remount prefers the saved text over config.text', () => {
    assert.equal(reread.body.text, storedText)
    assert.equal(reread.body.configured.text, '另一个配置句子。')
  })
  const onRemount = await step(remounted, { agentId: 't3', messages: [userMessage()] })
  check('and injects the stored sentence, not the configured one', () => {
    assert.equal(onRemount.messages[0].content[1].text, storedText)
  })

  const live = '只 POST text 也要合法。'
  const onlyText = await request(remounted, { method: 'POST', body: { text: live } })
  check('a POST body holding nothing but text is a valid patch', () => {
    assert.equal(onlyText.status, 200)
    assert.equal(onlyText.body.text, live)
    assert.equal(onlyText.body.every, 3)
  })

  const whitespace = ' \n\t '
  const beforeBad = JSON.stringify(stored())
  const blank = await request(remounted, { method: 'POST', body: { text: '' } })
  check('400 on an empty string', () => {
    assert.equal(blank.status, 400)
    assert.equal(blank.body.error, 'text must be a non-empty string of at most 1000 characters')
  })
  const spaced = await request(remounted, { method: 'POST', body: { text: whitespace } })
  check('400 on a whitespace-only string', () => {
    assert.equal(spaced.status, 400)
    assert.equal(spaced.body.error, 'text must be a non-empty string of at most 1000 characters')
  })
  const number = await request(remounted, { method: 'POST', body: { text: 42 } })
  check('400 on a non-string', () => {
    assert.equal(number.status, 400)
    assert.equal(number.body.error, 'text must be a non-empty string of at most 1000 characters')
  })
  const none = await request(remounted, { method: 'POST', body: { text: null } })
  check('400 on null', () => {
    assert.equal(none.status, 400)
    assert.equal(none.body.error, 'text must be a non-empty string of at most 1000 characters')
  })
  const overlong = await request(remounted, { method: 'POST', body: { text: 'x'.repeat(1001) } })
  check('400 above 1000 code units', () => {
    assert.equal(overlong.status, 400)
    assert.equal(overlong.body.error, 'text must be a non-empty string of at most 1000 characters')
  })
  const boundary = await request(remounted, { method: 'POST', body: { text: 'y'.repeat(1000) } })
  check('1000 code units is still accepted', () => {
    assert.equal(boundary.status, 200)
    assert.equal(boundary.body.text.length, 1000)
  })
  check('no rejected patch changed the store', () => {
    assert.equal(JSON.stringify(stored()).includes('x'.repeat(10)), false)
  })

  const accepted = await request(remounted, { method: 'POST', body: { text: live } })
  check('a text-only patch rewrites the stored file and leaves the rest live', () => {
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.text, live)
    assert.deepEqual(accepted.body.stored, { text: live })
    assert.deepEqual(stored(), { text: live })
    assert.equal(accepted.body.every, 3)
    assert.equal(accepted.body.stepNotice, true)
    assert.equal(accepted.body.userAppend, true)
  })
  const beforeDelete = JSON.stringify(stored())
  check('the store was reachable before the reset', () => {
    assert.notEqual(beforeDelete, '{}')
  })

  const cleared = await request(remounted, { method: 'DELETE' })
  check('DELETE falls the text back to config.text', () => {
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.stored.text, undefined)
    assert.equal(cleared.body.text, '另一个配置句子。')
    assert.deepEqual(stored(), {})
  })
  const afterDelete = await step(remounted, { agentId: 't4', messages: [userMessage()] })
  check('and the next step injects the configured sentence again', () => {
    assert.equal(afterDelete.messages[0].content[1].text, '另一个配置句子。')
  })

  const bare = mount({ every: 100 })
  const bareRead = await request(bare)
  check('with neither store nor config text, the built-in default returns', () => {
    assert.equal(bareRead.body.text, TEXT)
  })
}

fs.rmSync(profile, { recursive: true, force: true })
console.log(`\n${passed} checks passed${failed.length ? `, ${failed.length} failed` : ''}`)
process.exitCode = failed.length ? 1 : 0