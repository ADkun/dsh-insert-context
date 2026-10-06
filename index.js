import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'insert-context'

/** The default sentence appended to every user message (behaviour 1). */
const DEFAULT_APPEND_TEXT = '【探索过程深度要深、广度要广，但最终回复简洁明了。】'

/** Longest accepted rule text / append text, in UTF-16 code units. */
const MAX_TEXT_LENGTH = 1000

/** Rule field bounds. */
const MIN_START = 1
const MAX_START = 100000
const MIN_EVERY = 1
const MAX_EVERY = 1000
const MIN_REPEAT = 0
const MAX_REPEAT = 1000

/** The only placeholder a rule text may carry: replaced with the agent's step number. */
const STEP_TOKEN = '{{step}}'

/** How many hit steps the Settings page previews before it just prints the count. */
const PREVIEW_HITS = 10

/** Hard cap on how many hit steps `hitSteps()` will ever materialise (unlimited rules). */
const MAX_HITS = 100000

/** Behaviour 1 (append `appendText` to every user message) is on unless switched off. */
const DEFAULT_USER_APPEND = true

/** Producer tag recorded on every injected message (unknown kinds fall through by contract). */
const SOURCE_KIND = 'insert-context'

/** Same-origin route the Settings section reads and writes. */
const ROUTE_PATH = '/api/insert-context'

const MAX_BODY_BYTES = 64 * 1024

/**
 * The one rule shipped as the built-in default: from step 10, every 10 steps,
 * unlimited (the user removed the second "wrap-up" rule from the defaults and
 * asked for an advisory tone — a suggestion, not an order). The wrap-up text
 * survives in the README as an example only.
 */
const DEFAULT_RULES = Object.freeze([
  Object.freeze({
    start: 10,
    every: 10,
    repeat: 0,
    text:
      '这是第 {{step}} 步。按需收敛：这一轮结束后如果没有任何验收判定会改变，就可以收工交付当前结果；要继续时，先把“下一步要改变哪一条判定”写清楚。已通过的验证不必再确认一遍；触及轮数或预算上限时，交付已完成部分 + 未完成清单（原因 / 下次继续的第一步），状态标 budget-limited。',
  }),
])

/** Every `{{…}}` a text carries, whatever is inside it. */
const PLACEHOLDER_RE = /{{[\s\S]*?}}/g

/** Freeze the message the way the harness's own immutable messages are frozen. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * The unknown placeholders a text carries: `{{step}}` is the one supported
 * token, anything else is left in the text verbatim and reported, never
 * silently swallowed.
 *
 * @returns {string[]} the placeholders to complain about, in order of appearance.
 */
function unknownPlaceholders(text) {
  if (typeof text !== 'string') return []
  const found = text.match(PLACEHOLDER_RE) ?? []
  return found.filter((token) => token !== STEP_TOKEN)
}

/** Report every unknown placeholder of a text once. */
function warnUnknownPlaceholders(text, logger, where) {
  for (const token of unknownPlaceholders(text)) {
    logger?.warn?.(
      `insert-context: unknown placeholder ${token} in ${where}; it is injected verbatim (only ${STEP_TOKEN} is supported)`,
    )
  }
}

/**
 * Rule text with `{{step}}` replaced by the current step number. Only the exact
 * literal `{{step}}` is a placeholder; unknown `{{…}}` tokens pass through.
 */
function fillStep(text, count) {
  return String(text).split(STEP_TOKEN).join(String(count))
}

/**
 * The steps one rule fires on: `start`, `start+every`, … — exactly `repeat`
 * entries, or an endless run when `repeat` is 0 (unlimited). The walk is capped
 * at `limit` entries so a preview of an unlimited rule cannot loop forever.
 * `{start:5, every:5, repeat:9}` → 5,10,15,20,25,30,35,40,45.
 * Exported so the test can prove an unlimited rule produces a finite list.
 */
export function hitSteps(rule, limit = MAX_HITS) {
  const capped = rule.repeat === 0 ? Math.max(0, limit) : Math.min(rule.repeat, Math.max(0, limit))
  const steps = []
  for (let index = 0; index < capped; index += 1) {
    steps.push(rule.start + index * rule.every)
  }
  return steps
}

/** Does this rule fire on this executed step? (Its hit set is `start + k·every`; `repeat: 0` = unlimited.) */
function ruleHits(rule, count) {
  if (count < rule.start) return false
  if (!Number.isInteger((count - rule.start) / rule.every)) return false
  if (rule.repeat === 0) return true
  return (count - rule.start) / rule.every < rule.repeat
}

/** Is a coerced number an integer inside `[min, max]`? */
function inRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max
}

/** An accepted `start`, or `undefined`. */
function validStart(value) {
  const number = Number(value)
  return inRange(number, MIN_START, MAX_START) ? number : undefined
}

/** An accepted `every`, or `undefined`. */
function validEvery(value) {
  const number = Number(value)
  return inRange(number, MIN_EVERY, MAX_EVERY) ? number : undefined
}

/** An accepted `repeat`, or `undefined`. */
function validRepeat(value) {
  const number = Number(value)
  return inRange(number, MIN_REPEAT, MAX_REPEAT) ? number : undefined
}

/** An accepted switch value (a real boolean, or its string form), or `undefined`. */
function validFlag(value) {
  if (value === true || value === false) return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

/** An accepted text, returned as written, or `undefined` when the value is not one. */
function validText(value) {
  if (typeof value !== 'string') return undefined
  if (value.trim().length === 0) return undefined
  return value.length <= MAX_TEXT_LENGTH ? value : undefined
}

/**
 * A rule with every field coerced and checked, or a `{field, message}` refusal.
 * The first bad field wins, so the Settings page can show one clear sentence.
 */
function validRule(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: { field: 'rule', message: 'a rule must be an object with start, every, repeat and text' } }
  }
  const start = validStart(raw.start)
  if (start === undefined) {
    return { error: { field: 'start', message: `start must be an integer between ${MIN_START} and ${MAX_START}` } }
  }
  const every = validEvery(raw.every)
  if (every === undefined) {
    return { error: { field: 'every', message: `every must be an integer between ${MIN_EVERY} and ${MAX_EVERY}` } }
  }
  const repeat = validRepeat(raw.repeat)
  if (repeat === undefined) {
    return { error: { field: 'repeat', message: `repeat must be an integer between ${MIN_REPEAT} and ${MAX_REPEAT} (0 = unlimited)` } }
  }
  const text = validText(raw.text)
  if (text === undefined) {
    return { error: { field: 'text', message: `text must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters` } }
  }
  return { rule: { start, every, repeat, text } }
}

/**
 * An accepted rule list. Every row is checked (not just the first one that
 * fails) so the caller can report all of them; `rules` may be empty, which
 * means "inject nothing".
 */
function validRules(value) {
  if (!Array.isArray(value)) return { error: { message: 'rules must be an array of rules' } }
  const rules = []
  const errors = []
  for (const row of value) {
    const checked = validRule(row)
    if (checked.error) {
      errors.push({ index: rules.length, ...checked.error })
      return { error: errors[0], errors }
    }
    rules.push(checked.rule)
  }
  return { rules }
}

/** The rules to use when the caller supplied none at all. */
function defaultRules() {
  return DEFAULT_RULES.map((rule) => ({ ...rule }))
}

/** Is one configured rule list usable as a whole? */
function usableRules(rules) {
  return Array.isArray(rules) && rules.every((rule) => validRule(rule).rule !== undefined)
}

/**
 * Where the user's choices live: beside the profile that owns this plugin row, so
 * a restart keeps them and the row's own Config keeps the defaults.
 */
function settingsFile() {
  const base =
    process.env.DSH_PROFILE_DIR ||
    process.env.DSH_HOME ||
    path.join(os.homedir(), '.dsh')
  return path.join(base, 'insert-context.json')
}

/**
 * The fields this plugin persists, keeping only values that pass validation.
 * Bad rows are dropped rather than poisoning the whole file, so one hand-edited
 * typo cannot silently disable every rule.
 */
function normalizeSettings(raw, logger) {
  const settings = {}
  if (Array.isArray(raw?.rules)) {
    const rules = []
    for (const row of raw.rules) {
      const checked = validRule(row)
      if (checked.rule === undefined) {
        logger?.warn?.(`insert-context: dropping an unusable saved rule (${checked.error.message})`)
        continue
      }
      warnUnknownPlaceholders(checked.rule.text, logger, 'a saved rule')
      rules.push(checked.rule)
    }
    settings.rules = rules
  } else if (raw !== undefined && raw !== null && 'rules' in raw) {
    logger?.warn?.('insert-context: dropping a saved rules value that is not an array')
  }
  const userAppend = validFlag(raw?.userAppend)
  if (userAppend !== undefined) settings.userAppend = userAppend
  const appendText = validText(raw?.appendText)
  if (appendText !== undefined) {
    warnUnknownPlaceholders(appendText, logger, 'appendText')
    settings.appendText = appendText
  }
  return settings
}

/** Read the saved choices; an absent or unreadable file simply means "none". */
function readStored(file, logger) {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')), logger)
  } catch {
    return {}
  }
}

/** Persist the saved choices atomically, readable only by their owner. */
function writeStored(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(settings, undefined, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

/** Hostnames a same-machine caller can legitimately use. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

/** Split a Host/Origin/Referer value into {scheme, hostname, port}, defaulting the port. */
function authorityOf(value, defaultScheme = 'http') {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme}://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}

/**
 * Request trust fence for this plugin's HTTP surface.
 *
 * The prefix registered here is longer than the kernel's `/api`, and webServer
 * dispatch is longest-prefix-wins — so these routes would otherwise run before
 * the connection service's own admission check. Two layers, tried in order:
 * that service's exact decision when the composition mounts it, else a
 * structural replica (loopback Host, no cross-site fetch, Origin/Referer
 * matching the Host authority).
 *
 * @returns {number|undefined} the status to reject with, or `undefined` to answer.
 */
function rejectionFor(req, connection) {
  if (connection && typeof connection.admit === 'function') {
    try {
      const admission = connection.admit(req)
      if (admission && typeof admission === 'object' && 'rejection' in admission) return admission.rejection
      return undefined
    } catch {
      // A throwing connection service is a composition bug; fall through to the
      // structural fence rather than rejecting every request with a 500.
    }
  }
  const host = authorityOf(req.headers.host)
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403
  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403
  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const authority = authorityOf(raw.trim())
    if (authority === null) return 403
    if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) {
      return 403
    }
  }
  return undefined
}

/** Read a JSON request body, resolving `{}` for anything unreadable. */
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy?.()
        finish({})
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        finish({})
      }
    })
    req.on('error', () => finish({}))
  })
}

/** Build a user-role context message shaped like the harness's own injected context. */
function createNoticeMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND },
  })
}

/**
 * Did a person write this message? The harness tags every submitted prompt
 * (`agent.prompt` from the web UI, the CLI, ACP or an SDK) with
 * `source: { kind: 'user', rpcId, ... }`, while the loop's own context messages,
 * this plugin's injections and subagent steering all use their own kinds.
 */
function isUserMessage(message) {
  return message?.source?.kind === 'user'
}

/**
 * Copy of one user message with the append text as a final text block. Content
 * blocks are never merged: the text the user wrote stays byte-for-byte in the
 * log, and the appended text is its own trailing paragraph.
 */
function withNotice(message, text) {
  const content = Array.isArray(message?.content) ? message.content : []
  return deepFreeze({ ...message, content: [...content, { type: 'text', text }] })
}

export function apply(ctx, config = {}) {
  /** Defaults from the plugin row's Config; the Settings page overrides them. */
  const configuredRules = usableRules(config.rules) ? config.rules.map((rule) => validRule(rule).rule) : defaultRules()
  const configured = Object.freeze({
    rules: configuredRules,
    userAppend: validFlag(config.userAppend) ?? DEFAULT_USER_APPEND,
    appendText: validText(config.appendText) ?? DEFAULT_APPEND_TEXT,
  })
  for (const rule of configuredRules) warnUnknownPlaceholders(rule.text, ctx.logger, 'a configured rule')
  warnUnknownPlaceholders(configured.appendText, ctx.logger, 'the configured appendText')

  const file = settingsFile()

  /** What the Settings page saved; empty until it saves something. */
  let stored = readStored(file, ctx.logger)

  /** Live behaviour: the saved choice when there is one, else the row's Config. */
  let rules = Array.isArray(stored.rules) ? stored.rules : configured.rules
  let userAppend = stored.userAppend ?? configured.userAppend
  let appendText = stored.appendText ?? configured.appendText

  /** Per-agent step counter, keyed by agent id. */
  const steps = new Map()

  const describe = () => ({
    ok: true,
    rules,
    userAppend,
    appendText,
    bounds: {
      start: [MIN_START, MAX_START],
      every: [MIN_EVERY, MAX_EVERY],
      repeat: [MIN_REPEAT, MAX_REPEAT],
      text: MAX_TEXT_LENGTH,
    },
    previewHits: PREVIEW_HITS,
    configured: { ...configured, rules: configured.rules.map((rule) => ({ ...rule })) },
    stored: { ...stored },
    file,
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision

    const claimed = decision.messages

    // Behaviour 1 — the append text trails every prompt the user just sent. The
    // decision's messages are the ones this step journals, so the appended copy
    // is what the model reads *and* what the session log keeps.
    let messages = claimed
    let appended = false
    if (userAppend) {
      for (const message of claimed) {
        if (isUserMessage(message)) {
          appended = true
          break
        }
      }
      if (appended) {
        messages = claimed.map((message) => (isUserMessage(message) ? withNotice(message, appendText) : message))
      }
    }

    const agentId = payload.agent.id
    const count = (steps.get(agentId) ?? 0) + 1
    steps.set(agentId, count)

    // Behaviour 2 — every rule whose hit set contains this step contributes one
    // paragraph. The hits are merged into a single injected message, in the
    // order the rules are listed, so a step that trips several rules still adds
    // one message rather than several.
    const hits = rules.filter((rule) => ruleHits(rule, count))
    if (hits.length > 0 && !appended) {
      const text = hits.map((rule) => fillStep(rule.text, count)).join('\n')
      ctx.logger?.debug?.(`insert-context: injected into step ${count} of turn ${payload.turn} (${hits.length} rule(s))`)
      return { ...decision, messages: [...messages, createNoticeMessage(text)] }
    }

    return messages === claimed ? decision : { ...decision, messages }
  })

  ctx.on('agent/disposed', (payload) => {
    steps.delete(payload.agent.id)
  })

  const applySettings = (next) => {
    stored = next
    rules = Array.isArray(next.rules) ? next.rules : configured.rules
    userAppend = next.userAppend ?? configured.userAppend
    appendText = next.appendText ?? configured.appendText
  }

  // The Settings section's data source. `webServer` is asked for, not injected:
  // a composition without an HTTP carrier loses the page and nothing else.
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'prefix',
          path: ROUTE_PATH,
          handler: async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const routePath = url.pathname.slice(ROUTE_PATH.length).replace(/\/+$/, '') || '/'
            const method = String(req.method ?? 'GET').toUpperCase()
            const send = (status, payload) => {
              const body = JSON.stringify(payload)
              res.writeHead(status, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              })
              res.end(body)
            }

            const rejection = rejectionFor(req, ctx.get('connection'))
            if (rejection !== undefined) {
              return send(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
            }
            if (routePath !== '/settings') return send(404, { error: 'not found' })

            if (method === 'GET') return send(200, describe())
            if (method === 'DELETE') {
              try {
                fs.rmSync(file, { force: true })
              } catch (error) {
                ctx.logger?.warn?.(`insert-context: could not clear the settings (${error?.message ?? error})`)
                return send(500, { error: `could not clear: ${error?.message ?? error}` })
              }
              applySettings({})
              ctx.logger?.info?.('insert-context: settings cleared, back to the plugin Config')
              return send(200, describe())
            }
            if (method !== 'POST') return send(405, { error: 'method not allowed' })

            const patch = await readJson(req)
            const next = { ...stored }
            let error
            let touched = false
            const body = patch && typeof patch === 'object' ? patch : {}

            if ('rules' in body) {
              touched = true
              // `null` / `[]` are the documented way to say "inject nothing".
              if (body.rules === null) {
                next.rules = []
              } else {
                const checked = validRules(body.rules)
                if (checked.error) {
                  error = checked.error.index === undefined
                    ? checked.error.message
                    : `rules[${checked.error.index}]: ${checked.error.message}`
                } else {
                  next.rules = checked.rules
                  for (const rule of checked.rules) warnUnknownPlaceholders(rule.text, ctx.logger, 'a saved rule')
                }
              }
            }
            if ('userAppend' in body) {
              touched = true
              const value = validFlag(body.userAppend)
              if (value === undefined) error = 'userAppend must be true or false'
              else next.userAppend = value
            }
            if ('appendText' in body) {
              touched = true
              const value = validText(body.appendText)
              if (value === undefined) {
                error = `appendText must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`
              } else {
                next.appendText = value
                warnUnknownPlaceholders(value, ctx.logger, 'appendText')
              }
            }

            if (error === undefined && !touched) error = 'no settings provided'
            if (error !== undefined) return send(400, { error })

            try {
              writeStored(file, next)
            } catch (failure) {
              ctx.logger?.warn?.(`insert-context: could not save the settings (${failure?.message ?? failure})`)
              return send(500, { error: `could not save: ${failure?.message ?? failure}` })
            }
            applySettings(next)
            ctx.logger?.info?.(
              `insert-context: ${rules.length} rule(s), user-message append ${userAppend ? 'on' : 'off'}, append text of ${appendText.length} character(s)`,
            )
            return send(200, describe())
          },
        }),
      'insert-context: settings api',
    )
  })
}