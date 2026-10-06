/**
 * Verification harness for dsh-insert-context.
 *
 * Runs the real `index.js` against a fake Cordis context: no DSH process, no
 * network, no dependencies. Covers the rule model (hit-step sets, `{{step}}`,
 * merge order, unknown placeholders), the append-to-every-user-message
 * behaviour, the saved-settings precedence, and the whole HTTP surface
 * including the trust fence.
 *
 *   node test/behaviour.mjs
 *
 * Note on counts: a rule fires on the agent's Nth *executed* step, not on a step
 * ordinal, so a run that skips rejected steps still fires on the same executed
 * counts (a rejected step neither counts nor injects). Steps are counted per
 * agent id, with no filtering by agent layer: the dispatcher and each subagent
 * count independently.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-profile-'))
process.env.DSH_PROFILE_DIR = profile
const settingsPath = path.join(profile, 'insert-context.json')

const { apply } = await import(pathToFileURL(path.join(here, '..', 'index.js')).href)

const APPEND_TEXT = '[注：回复不复述过程，结构清晰可读性好。]'
const DEFAULT_RULE_TEXT = '现在是第 {{step}} 步，用户催你搞快点啦！但别牺牲回答质量哦！'
const KIND = 'insert-context'
const RULE_1_TEXT =
  '这是第 {{step}} 步。停一下：你这一轮结束会改变哪一条验收判定？写不出就现在收工交付。验证只做一层，重跑要说明想改变哪条判定；自评不算达标；返工上限 1 轮且只许点名补缺（缺哪条 + 缺什么证据）。'
const RULE_2_TEXT =
  '这是第 {{step}} 步。按边界收尾：交付“已完成 / 未完成 / 未完成原因 / 下次继续的第一步”，状态标 budget-limited，不许用不完整的答案冒充完成。'
const DEFAULT_RULES = [
  {
    start: 10,
    every: 10,
    repeat: 0,
    text: DEFAULT_RULE_TEXT,
  },
]

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
/** Run an async body with the same reporting as `check`. */
async function checkAsync(label, fn) {
  try {
    await fn()
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
  const warnings = []
  const ctx = {
    logger: { debug() {}, info() {}, warn: message => warnings.push(String(message)) },
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
  return { listeners, routes, warnings }
}

/** Drive one pre-step through every registered listener. */
async function step(mounted, { agentId = 'a1', messages = [], kind = 'enter', turn = 1, step: ordinal = 1 } = {}) {
  const payload = { agent: { id: agentId }, messages, turn, step: ordinal }
  let decision = kind === 'enter' ? { kind: 'enter', messages } : { kind: 'reject' }
  for (const fn of mounted.listeners.get('agent/pre-step') ?? []) {
    const inner = decision
    decision = await fn(payload, async () => inner)
  }
  return decision
}

/** Drive `n` executed steps for one agent, collecting the injected texts. */
async function runSteps(mounted, agentId, n) {
  const hits = new Map()
  for (let count = 1; count <= n; count += 1) {
    const decision = await step(mounted, { agentId, turn: 1, step: count })
    const injected = (decision.messages ?? []).filter(message => message?.source?.kind === KIND)
    if (injected.length > 0) hits.set(count, injected)
  }
  return hits
}

/** The injected text of one step, or `undefined` when nothing was injected. */
function injectedText(hits, count) {
  const injected = hits.get(count)
  if (!injected) return undefined
  assert.equal(injected.length, 1, `step ${count} injects exactly one message`)
  assert.equal(injected[0].content.length, 1, `step ${count} injects exactly one text block`)
  return injected[0].content[0].text
}

function userMessage(text = 'do the thing') {
  return { id: 'u1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'r1' } }
}
function contextMessage(text = 'ctx') {
  return { id: 'c1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'runtime-context' } }
}

/** Call the registered route handler with a fake request/response. */
async function request(mounted, { method = 'GET', path: routePath = '/settings', body, headers = {}, prefix = '/api/insert-context' } = {}) {
  const handler = mounted.routes.find(route => route.kind === 'prefix')?.handler
  assert.ok(handler, 'the webServer route is registered')
  const req = new EventEmitter()
  req.method = method
  req.url = `${prefix}${routePath}`
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

console.log('rule model — hit steps, {{step}}, merge order')
{
  const mounted = mount({})
  const fresh = await request(mounted)
  check('the built-in default is the single unlimited rule, verbatim', () => {
    assert.deepEqual(fresh.body.configured.rules, DEFAULT_RULES)
    assert.deepEqual(fresh.body.rules, DEFAULT_RULES)
  })
  check('the default rule text is the short step-10 nudge, verbatim', () => {
    const [rule] = fresh.body.rules
    assert.equal(rule.text, DEFAULT_RULE_TEXT, 'the default rule text is the short step-10 nudge')
    assert.equal(rule.text, '现在是第 {{step}} 步，用户催你搞快点啦！但别牺牲回答质量哦！')
    assert.ok(!rule.text.includes('【') && !rule.text.includes('】'), 'the default rule text carries no 【 】')
    assert.ok(!rule.text.includes('压缩时'), 'the default rule text carries no compression sentence')
    assert.ok(rule.text.length <= 1000, `default rule text is ${rule.text.length} characters`)
  })
  check('the default appendText is the bracketed reply notice, verbatim', () => {
    assert.equal(APPEND_TEXT, '[注：回复不复述过程，结构清晰可读性好。]')
    assert.equal(fresh.body.appendText, APPEND_TEXT)
    assert.equal(fresh.body.configured.appendText, APPEND_TEXT)
  })
  check('userAppend is off by default (only the every-10-steps injection is on)', () => {
    assert.equal(fresh.body.userAppend, false)
    assert.equal(fresh.body.configured.userAppend, false)
    assert.deepEqual(fresh.body.stored, {}, 'no saved file, so the new default is what is live')
  })

  // Rule 1 alone: {start:5, every:5, repeat:9} → 5,10,15,20,25,30,35,40,45 — the
  // exact set the feature was asked for, asserted step by step over 50 executed
  // steps (rule 2 would only start at 60, so this run isolates rule 1).
  const onlyFirst = mount({ rules: [{ start: 5, every: 5, repeat: 9, text: RULE_1_TEXT }] })
  const first = await runSteps(onlyFirst, 'r1', 50)
  const expected1 = [5, 10, 15, 20, 25, 30, 35, 40, 45]
  await checkAsync('rule {5,5,9} fires on exactly 5,10,15,20,25,30,35,40,45', async () => {
    assert.deepEqual([...first.keys()], expected1)
  })
  await checkAsync('the defaults are exactly one unlimited rule starting at step 10', async () => {
    assert.equal(DEFAULT_RULES.length, 1, 'the wrap-up rule is no longer a default')
    const [rule] = DEFAULT_RULES
    assert.equal(rule.start, 10)
    assert.equal(rule.every, 10)
    assert.equal(rule.repeat, 0, 'repeat 0 = unlimited')
  })
  await checkAsync('nothing is injected before start, and nothing after repeat is used up', async () => {
    for (const count of [1, 2, 3, 4, 6, 49, 50]) {
      assert.equal(injectedText(first, count), undefined, `step ${count} stays silent`)
    }
  })
  await checkAsync('{{step}} is replaced with the current step number on every hit', async () => {
    for (const count of expected1) {
      const text = injectedText(first, count)
      assert.ok(text.includes(`这是第 ${count} 步。`), `step ${count} carries its own number`)
      assert.equal(text.includes('{{step}}'), false, `step ${count} has no leftover placeholder`)
    }
  })
  await checkAsync('the injected message is tagged, frozen and shaped like harness context', async () => {
    const notice = first.get(5)[0]
    assert.equal(notice.role, 'user')
    assert.equal(notice.source.kind, KIND)
    assert.ok(Object.isFrozen(notice))
    assert.ok(Object.isFrozen(notice.content))
    assert.ok(typeof notice.id === 'string' && notice.id.length > 0)
  })

  // Rule 2 (kept as a README example only, not a default): {start:60, every:10,
  // repeat:5} → 60,70,80,90,100 — asserted over 101 executed steps (the first
  // hit needs 60 counted steps, the last 100).
  const onlySecond = mount({ rules: [{ start: 60, every: 10, repeat: 5, text: RULE_2_TEXT }] })
  const second = await runSteps(onlySecond, 'r2', 101)
  await checkAsync('rule {60,10,5} fires on exactly 60,70,80,90,100', async () => {
    assert.deepEqual([...second.keys()], [60, 70, 80, 90, 100])
  })
  await checkAsync('the second rule injects its own text, numbered per hit', async () => {
    for (const count of [60, 70, 80, 90, 100]) {
      const text = injectedText(second, count)
      assert.ok(text.includes(`这是第 ${count} 步。`))
      assert.ok(text.includes('budget-limited'))
    }
    assert.equal(injectedText(second, 61), undefined)
    assert.equal(injectedText(second, 101), undefined)
  })

  // A step that trips several rules contributes one paragraph each, joined in
  // rule order, inside a single injected message.
  const merged = mount({
    rules: [
      { start: 2, every: 2, repeat: 5, text: 'A{{step}}' },
      { start: 2, every: 1, repeat: 5, text: 'B{{step}}' },
      { start: 99, every: 1, repeat: 1, text: 'C{{step}}' },
    ],
  })
  // A brand-new agent id, because the counter lives in the plugin instance and
  // follows the agent id across mounts: reusing 'm1' here would continue its
  // 60-step run (and re-trip rule 1 of the default pair).
  const mergedHits = await runSteps(merged, 'm2', 6)
  await checkAsync('two rules hitting the same step merge into ONE message, in rule order', async () => {
    // Every rule here starts at 2, so step 1 must stay silent; A then fires on
    // the even steps 2 and 4 (5 repeats = 2,4,6,8,10), B fires on every step
    // from 2, and C never fires inside this run.
    assert.deepEqual([...mergedHits.keys()], [2, 3, 4, 5, 6])
    for (const count of [2, 3, 4, 5, 6]) {
      assert.equal(mergedHits.get(count).length, 1, `step ${count} has one injected message`)
    }
    assert.equal(injectedText(mergedHits, 1), undefined, 'step 1 precedes every rule start')
    assert.equal(injectedText(mergedHits, 2), 'A2\nB2', 'two rules → rule order, newline-joined')
    assert.equal(injectedText(mergedHits, 3), 'B3', 'one rule → one paragraph')
    assert.equal(injectedText(mergedHits, 4), 'A4\nB4')
    assert.equal(injectedText(mergedHits, 5), 'B5')
    assert.equal(injectedText(mergedHits, 6), 'A6\nB6', 'A reaches its 3rd of 5 repeats')
  })

  // `repeat: 0` means unlimited: the rule keeps firing from `start` on, forever.
  const unlimited = mount({ rules: [{ start: 10, every: 10, repeat: 0, text: 'U{{step}}' }] })
  const unlimitedHits = await runSteps(unlimited, 'u1', 200)
  await checkAsync('rule {10,10,0} (unlimited) fires on exactly 10,20,…,200 over 200 executed steps', async () => {
    const expected = []
    for (let count = 10; count <= 200; count += 10) expected.push(count)
    assert.deepEqual([...unlimitedHits.keys()], expected)
    assert.equal(unlimitedHits.size, 20)
    for (const count of [1, 2, 5, 9, 11, 19, 99]) {
      assert.equal(injectedText(unlimitedHits, count), undefined, `step ${count} stays silent`)
    }
    assert.equal(injectedText(unlimitedHits, 200), 'U200')
  })
  const unlimitedLong = await runSteps(unlimited, 'u2', 300)
  await checkAsync('an unlimited rule is still firing at step 300 (no repeat cap)', async () => {
    assert.deepEqual([...unlimitedLong.keys()].slice(-3), [280, 290, 300])
    assert.equal(injectedText(unlimitedLong, 300), 'U300')
    assert.equal(unlimitedLong.size, 30)
  })
  await checkAsync('hitSteps() of an unlimited rule is finite (it cannot loop forever)', async () => {
    const { hitSteps } = await import(pathToFileURL(path.join(here, '..', 'index.js')).href)
    const capped = hitSteps({ start: 10, every: 10, repeat: 0 }, 100)
    assert.equal(capped.length, 100)
    assert.equal(capped[0], 10)
    assert.equal(capped[99], 1000)
    const defaultSize = hitSteps({ start: 10, every: 10, repeat: 0 }).length
    assert.ok(Number.isInteger(defaultSize) && defaultSize > 0 && defaultSize <= 100000)
  })

  const warned = mount({ rules: [{ start: 1, every: 1, repeat: 1, text: 'keep {{step}} and {{turn}} as-is' }] })
  const warnedHits = await runSteps(warned, 'w1', 1)
  await checkAsync('an unknown placeholder is injected verbatim, never swallowed', async () => {
    assert.equal(injectedText(warnedHits, 1), 'keep 1 and {{turn}} as-is')
    assert.ok(warned.warnings.some(line => line.includes('{{turn}}')), 'the host logged a warning')
    assert.ok(warned.warnings.every(line => line.startsWith('insert-context:')), 'the logger prefix is the new name')
  })

  const empty = mount({ rules: [] })
  const emptyHits = await runSteps(empty, 'e1', 3)
  await checkAsync('an empty rule list injects nothing at all', async () => {
    assert.equal(emptyHits.size, 0)
  })
}

console.log('append behaviour and the duplicate-suppression rule')
{
  const mounted = mount({ rules: [{ start: 2, every: 2, repeat: 3, text: 'RULE {{step}}' }], userAppend: true })
  const original = userMessage()
  const decision = await step(mounted, { messages: [original] })
  check('the message keeps its own text, id and source, and gains a trailing block', () => {
    assert.equal(decision.messages.length, 1)
    const message = decision.messages[0]
    assert.equal(message.id, 'u1')
    assert.equal(message.source.kind, 'user')
    assert.equal(message.source.rpcId, 'r1')
    assert.deepEqual(message.content[0], { type: 'text', text: 'do the thing' })
    assert.deepEqual(message.content[1], { type: 'text', text: APPEND_TEXT })
  })
  check('the incoming message object is not mutated', () => {
    assert.equal(original.content.length, 1)
    assert.equal(original.content[0].text, 'do the thing')
  })
  check('the rewritten message is frozen, like the harness freezes its own', () => {
    assert.ok(Object.isFrozen(decision.messages[0]))
    assert.ok(Object.isFrozen(decision.messages[0].content))
  })
  const foreign = await step(mounted, { messages: [contextMessage()] })
  check('non-user sources (runtime context) stay untouched', () => {
    assert.equal(foreign.messages[0].content.length, 1)
    assert.equal(foreign.messages[0].content[0].text, 'ctx')
  })
  const rejected = await step(mounted, { messages: [userMessage()], kind: 'reject' })
  check('a rejected step is passed through untouched', () => {
    assert.deepEqual(rejected, { kind: 'reject' })
  })
  const mixed = await step(mounted, { messages: [contextMessage('ctx'), userMessage('hello')] })
  check('only user messages in a mixed batch are rewritten', () => {
    assert.equal(mixed.messages[0].content.length, 1)
    assert.equal(mixed.messages[1].content.length, 2)
  })

  const dup = mount({ rules: [{ start: 1, every: 1, repeat: 1, text: 'RULE {{step}}' }], userAppend: true })
  const dupDecision = await step(dup, { agentId: 'dup', messages: [userMessage()] })
  await checkAsync('a step that already appended to a user message does NOT also inject the rule', async () => {
    assert.equal(dupDecision.messages.length, 1, 'no extra message this step')
    assert.equal(dupDecision.messages[0].content.length, 2, 'the append is the only addition')
    assert.equal(dupDecision.messages[0].content[1].text, APPEND_TEXT)
  })

  const off = mount({ rules: [{ start: 1, every: 1, repeat: 2, text: 'RULE {{step}}' }], userAppend: false })
  const untouched = await step(off, { agentId: 'off', messages: [userMessage()] })
  check('userAppend:false — the user message is returned unchanged (the rule is its own message)', () => {
    assert.equal(untouched.messages.length, 2, 'the user message plus the rule message')
    assert.equal(untouched.messages[0].content.length, 1)
    assert.equal(untouched.messages[0].content[0].text, 'do the thing')
    assert.equal(untouched.messages[1].source.kind, KIND)
    assert.equal(untouched.messages[1].content[0].text, 'RULE 1')
  })
  const offHits = await runSteps(off, 'off2', 4)
  await checkAsync('userAppend:false — the rules still fire on their own schedule', async () => {
    assert.deepEqual([...offHits.keys()], [1, 2])
    assert.equal(injectedText(offHits, 2), 'RULE 2')
  })
}

console.log('step counting')
{
  const mounted = mount({ rules: [{ start: 2, every: 1, repeat: 5, text: 'S{{step}}' }] })
  const perAgent = await runSteps(mounted, 'p1', 3)
  await checkAsync('counters are per agent, not per plugin', async () => {
    assert.deepEqual([...perAgent.keys()], [2, 3])
    const other = await step(mounted, { agentId: 'p2' })
    assert.deepEqual(other.messages, [], 'a second agent starts at its own step 1')
  })
  const rejected = await step(mounted, { agentId: 'p3', kind: 'reject' })
  const after = await runSteps(mounted, 'p3', 3)
  await checkAsync('a rejected step neither counts nor injects', async () => {
    assert.deepEqual(rejected, { kind: 'reject' })
    assert.deepEqual([...after.keys()], [2, 3], 'the rejected step did not consume a count')
  })
  const disposed = mounted.listeners.get('agent/disposed') ?? []
  await checkAsync('agent/disposed drops the counter', async () => {
    assert.equal(disposed.length, 1)
    disposed[0]({ agent: { id: 'p1' } })
    const again = await step(mounted, { agentId: 'p1' })
    assert.deepEqual(again.messages, [], 'the counter restarted from 0')
  })
}

console.log('HTTP surface')
{
  const mounted = mount({ rules: [{ start: 5, every: 5, repeat: 9, text: 'R {{step}}' }], userAppend: true })
  const initial = await request(mounted)
  check('GET answers the live rules, the Config defaults and an empty store', () => {
    assert.equal(initial.status, 200)
    assert.equal(initial.body.ok, true)
    assert.deepEqual(initial.body.rules, [{ start: 5, every: 5, repeat: 9, text: 'R {{step}}' }])
    assert.equal(initial.body.userAppend, true)
    assert.equal(initial.body.appendText, APPEND_TEXT)
    assert.deepEqual(initial.body.bounds, { start: [1, 100000], every: [1, 1000], repeat: [0, 1000], text: 1000 })
    assert.equal(initial.body.previewHits, 10)
    assert.deepEqual(initial.body.stored, {})
    assert.equal(initial.body.file, settingsPath)
    assert.equal('every' in initial.body, false, 'the old every field is gone')
    assert.equal('stepNotice' in initial.body, false, 'the old stepNotice field is gone')
    assert.equal('text' in initial.body, false, 'the old text field is gone')
  })

  const missing = await request(mounted, { path: '/nope' })
  check('an unknown path under the prefix answers 404', () => {
    assert.equal(missing.status, 404)
  })
  const legacy = await request(mounted, {
    path: '/settings',
    prefix: '/api/convergence-notice',
  })
  check('the old convergence-notice route no longer answers (404 under the new prefix)', () => {
    assert.equal(legacy.status, 404)
    assert.equal(legacy.body.error, 'not found')
  })

  const saved = await request(mounted, {
    method: 'POST',
    body: { rules: [{ start: 3, every: 2, repeat: 2, text: 'saved {{step}}' }], userAppend: false },
  })
  check('POST accepts a subset and answers the new state', () => {
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.body.rules, [{ start: 3, every: 2, repeat: 2, text: 'saved {{step}}' }])
    assert.equal(saved.body.userAppend, false)
    assert.deepEqual(saved.body.stored, {
      rules: [{ start: 3, every: 2, repeat: 2, text: 'saved {{step}}' }],
      userAppend: false,
    })
  })
  check('the store file holds exactly what was saved', () => {
    assert.deepEqual(stored(), { rules: [{ start: 3, every: 2, repeat: 2, text: 'saved {{step}}' }], userAppend: false })
  })
  const liveHits = await runSteps(mounted, 'http1', 7)
  await checkAsync('the saved rules are live at once, with no restart', async () => {
    assert.deepEqual([...liveHits.keys()], [3, 5])
    assert.equal(injectedText(liveHits, 3), 'saved 3')
    assert.equal(injectedText(liveHits, 5), 'saved 5')
  })

  // A second mount prefers the saved file over its own Config (precedence).
  const remounted = mount({ rules: [{ start: 1, every: 1, repeat: 1, text: 'config {{step}}' }], appendText: 'config append' })
  const reread = await request(remounted)
  check('a second mount prefers the saved file over the Config (precedence)', () => {
    assert.deepEqual(reread.body.rules, [{ start: 3, every: 2, repeat: 2, text: 'saved {{step}}' }])
    assert.equal(reread.body.userAppend, false)
    assert.equal(reread.body.configured.appendText, 'config append')
  })
  const remountHits = await runSteps(remounted, 'http2', 4)
  await checkAsync('and behaves on the stored values, not the configured ones', async () => {
    assert.deepEqual([...remountHits.keys()], [3])
  })

  const cleared = await request(remounted, { method: 'DELETE' })
  check('DELETE drops the file and falls back to the Config', () => {
    assert.equal(cleared.status, 200)
    assert.deepEqual(cleared.body.stored, {})
    assert.deepEqual(cleared.body.rules, [{ start: 1, every: 1, repeat: 1, text: 'config {{step}}' }])
    assert.equal(cleared.body.userAppend, false, 'the Config default is now off')
    assert.equal(cleared.body.appendText, 'config append')
    assert.deepEqual(stored(), {})
  })

  const emptyList = await request(remounted, { method: 'POST', body: { rules: [] } })
  check('an empty rule list is a valid patch (inject nothing)', () => {
    assert.equal(emptyList.status, 200)
    assert.deepEqual(emptyList.body.rules, [])
    assert.deepEqual(stored(), { rules: [] })
  })
  const nullList = await request(remounted, { method: 'POST', body: { rules: null } })
  check('rules: null is the same as an empty list', () => {
    assert.equal(nullList.status, 200)
    assert.deepEqual(nullList.body.rules, [])
  })
  const onlyAppend = await request(remounted, { method: 'POST', body: { appendText: 'just this line' } })
  check('a body holding nothing but appendText is a valid patch', () => {
    assert.equal(onlyAppend.status, 200)
    assert.equal(onlyAppend.body.appendText, 'just this line')
    assert.deepEqual(onlyAppend.body.rules, [])
  })

  const empty = await request(remounted, { method: 'POST', body: {} })
  check('400 on an empty patch', () => {
    assert.equal(empty.status, 400)
    assert.equal(empty.body.error, 'no settings provided')
  })
  const put = await request(remounted, { method: 'PUT', body: {} })
  check('405 for an unsupported method', () => {
    assert.equal(put.status, 405)
  })
  const noBody = await request(remounted, { method: 'POST' })
  check('400 on a body-less POST', () => {
    assert.equal(noBody.status, 400)
  })
}

console.log('invalid input is rejected')
{
  const mounted = mount({})
  const before = JSON.stringify(stored())
  const cases = [
    ['rules not an array', { rules: {} }, 'rules must be an array of rules'],
    ['start below 1', { rules: [{ start: 0, every: 1, repeat: 1, text: 'x' }] }, 'rules[0]: start must be an integer between 1 and 100000'],
    ['start above 100000', { rules: [{ start: 100001, every: 1, repeat: 1, text: 'x' }] }, 'rules[0]: start must be an integer between 1 and 100000'],
    ['start not an integer', { rules: [{ start: 2.5, every: 1, repeat: 1, text: 'x' }] }, 'rules[0]: start must be an integer between 1 and 100000'],
    ['every below 1', { rules: [{ start: 1, every: 0, repeat: 1, text: 'x' }] }, 'rules[0]: every must be an integer between 1 and 1000'],
    ['every above 1000', { rules: [{ start: 1, every: 1001, repeat: 1, text: 'x' }] }, 'rules[0]: every must be an integer between 1 and 1000'],
    ['repeat below 0', { rules: [{ start: 1, every: 1, repeat: -1, text: 'x' }] }, 'rules[0]: repeat must be an integer between 0 and 1000 (0 = unlimited)'],
    ['repeat above 1000', { rules: [{ start: 1, every: 1, repeat: 1001, text: 'x' }] }, 'rules[0]: repeat must be an integer between 0 and 1000 (0 = unlimited)'],
    ['repeat not an integer', { rules: [{ start: 1, every: 1, repeat: 0.5, text: 'x' }] }, 'rules[0]: repeat must be an integer between 0 and 1000 (0 = unlimited)'],
    ['empty text', { rules: [{ start: 1, every: 1, repeat: 1, text: '' }] }, 'rules[0]: text must be a non-empty string of at most 1000 characters'],
    ['whitespace-only text', { rules: [{ start: 1, every: 1, repeat: 1, text: ' \n\t ' }] }, 'rules[0]: text must be a non-empty string of at most 1000 characters'],
    ['non-string text', { rules: [{ start: 1, every: 1, repeat: 1, text: 42 }] }, 'rules[0]: text must be a non-empty string of at most 1000 characters'],
    ['text above 1000 code units', { rules: [{ start: 1, every: 1, repeat: 1, text: 'x'.repeat(1001) }] }, 'rules[0]: text must be a non-empty string of at most 1000 characters'],
    ['a rule that is not an object', { rules: ['nope'] }, 'rules[0]: a rule must be an object with start, every, repeat and text'],
    ['the second row is named in the error', { rules: [{ start: 1, every: 1, repeat: 1, text: 'ok' }, { start: 1, every: 1, repeat: 1001, text: 'ok' }] }, 'rules[1]: repeat must be an integer between 0 and 1000 (0 = unlimited)'],
    ['non-boolean userAppend', { userAppend: 'yes' }, 'userAppend must be true or false'],
    ['empty appendText', { appendText: '' }, 'appendText must be a non-empty string of at most 1000 characters'],
    ['appendText above 1000 code units', { appendText: 'x'.repeat(1001) }, 'appendText must be a non-empty string of at most 1000 characters'],
    ['non-string appendText', { appendText: 42 }, 'appendText must be a non-empty string of at most 1000 characters'],
  ]
  for (const [label, body, error] of cases) {
    await checkAsync(`400 — ${label}`, async () => {
      const answer = await request(mounted, { method: 'POST', body })
      assert.equal(answer.status, 400)
      assert.equal(answer.body.error, error)
    })
  }
  check('no rejected patch touched the store', () => {
    assert.equal(JSON.stringify(stored()), before)
  })

  const limits = await request(mounted, {
    method: 'POST',
    body: { rules: [{ start: 100000, every: 1000, repeat: 1000, text: 'y'.repeat(1000) }] },
  })
  check('the boundary values are accepted', () => {
    assert.equal(limits.status, 200)
    assert.deepEqual(limits.body.rules, [{ start: 100000, every: 1000, repeat: 1000, text: 'y'.repeat(1000) }])
  })
  const unlimitedEdge = await request(mounted, {
    method: 'POST',
    body: { rules: [{ start: 1, every: 1000, repeat: 0, text: 'unlimited {{step}}' }] },
  })
  check('repeat 0 (unlimited) is accepted at the other end of its range', () => {
    assert.equal(unlimitedEdge.status, 200)
    assert.deepEqual(unlimitedEdge.body.rules, [{ start: 1, every: 1000, repeat: 0, text: 'unlimited {{step}}' }])
  })
  const stringy = await request(mounted, {
    method: 'POST',
    body: { rules: [{ start: '7', every: '2', repeat: '3', text: 'stringy {{step}}' }] },
  })
  check('numeric strings are accepted and stored as numbers', () => {
    assert.equal(stringy.status, 200)
    assert.deepEqual(stringy.body.rules, [{ start: 7, every: 2, repeat: 3, text: 'stringy {{step}}' }])
  })
}

console.log('the trust fence')
{
  const mounted = mount({})
  const crossSite = await request(mounted, { headers: { origin: 'http://evil.example' } })
  check('403 when the Origin authority differs from the Host', () => {
    assert.equal(crossSite.status, 403)
  })
  const remote = await request(mounted, { headers: { host: '10.0.0.9:3080' } })
  check('403 for a non-loopback Host', () => {
    assert.equal(remote.status, 403)
  })
  const crossFetch = await request(mounted, { headers: { 'sec-fetch-site': 'cross-site' } })
  check('403 for a cross-site fetch', () => {
    assert.equal(crossFetch.status, 403)
  })
  const good = await request(mounted, {
    headers: { origin: 'http://127.0.0.1:3080', referer: 'http://127.0.0.1:3080/settings' },
  })
  check('200 when Origin and Referer match the Host', () => {
    assert.equal(good.status, 200)
  })
}

console.log('the saved store itself')
{
  check('the store file lives beside the profile under the new name', () => {
    assert.equal(settingsPath, path.join(profile, 'insert-context.json'))
    assert.equal(fs.existsSync(path.join(profile, 'convergence-notice.json')), false)
  })
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bad-'))
  fs.writeFileSync(
    path.join(bad, 'insert-context.json'),
    JSON.stringify({ rules: [{ start: 1, every: 1, repeat: 1, text: 'good' }, { start: 'x', every: 1, repeat: 1, text: 'bad' }], appendText: 'kept' }),
  )
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = bad
  const moduleUrl = pathToFileURL(path.join(here, '..', 'index.js')).href
  // A fresh module instance is not needed: the settings file is resolved at
  // apply() time, so mounting again with the other DSH_PROFILE_DIR is enough.
  const { apply: applyAgain } = await import(`${moduleUrl}?fresh=${Date.now()}`)
  const warnings = []
  const ctx = {
    logger: { warn: message => warnings.push(String(message)) },
    on() {},
    inject() {},
    get: () => undefined,
  }
  applyAgain(ctx, {})
  check('an unusable saved rule is dropped, the good one is kept, and it is reported', () => {
    assert.ok(warnings.some(line => line.includes('dropping an unusable saved rule')))
  })
  fs.rmSync(bad, { recursive: true, force: true })
  process.env.DSH_PROFILE_DIR = previous
}

fs.rmSync(profile, { recursive: true, force: true })
console.log(`\n${passed} checks passed${failed.length ? `, ${failed.length} failed` : ''}`)
process.exitCode = failed.length ? 1 : 0