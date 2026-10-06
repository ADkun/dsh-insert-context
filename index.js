import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'convergence-notice'

/** The one-line notice. */
const DEFAULT_TEXT =
  '【规划用最少的轮次达成目标。】'

/** Longest accepted notice, in UTF-16 code units. */
const MAX_TEXT_LENGTH = 1000

const DEFAULT_EVERY = 5
const MIN_EVERY = 1
const MAX_EVERY = 1000

/** Behaviour 2 (inject one message every `every` steps) is on unless switched off. */
const DEFAULT_STEP_NOTICE = true

/** Behaviour 1 (append the notice to every user message) is on unless switched off. */
const DEFAULT_USER_APPEND = true

/** Producer tag recorded on every injected message (unknown kinds fall through by contract). */
const SOURCE_KIND = 'convergence-notice'

/** Same-origin route the Settings section reads and writes. */
const ROUTE_PATH = '/api/convergence-notice'

const MAX_BODY_BYTES = 64 * 1024

/** Freeze the message the way the harness's own immutable messages are frozen. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * Build a user-role context message shaped exactly like the harness's own
 * injected context (id + role + text content block + producer source).
 */
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
 * this plugin's notices and subagent steering all use their own kinds.
 */
function isUserMessage(message) {
  return message?.source?.kind === 'user'
}

/**
 * Copy of one user message with the notice as a final text block. Content blocks
 * are never merged: the text the user wrote stays byte-for-byte in the log, and
 * the notice is its own trailing paragraph.
 */
function withNotice(message, text) {
  const content = Array.isArray(message?.content) ? message.content : []
  return deepFreeze({ ...message, content: [...content, { type: 'text', text }] })
}

/** An accepted interval, or `undefined` when the value is not one. */
function validEvery(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= MIN_EVERY && number <= MAX_EVERY ? number : undefined
}

/** An accepted switch value (a real boolean, or its string form), or `undefined`. */
function validFlag(value) {
  if (value === true || value === false) return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

/** An accepted notice, returned as written, or `undefined` when the value is not one. */
function validText(value) {
  if (typeof value !== 'string') return undefined
  if (value.trim().length === 0) return undefined
  return value.length <= MAX_TEXT_LENGTH ? value : undefined
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
  return path.join(base, 'convergence-notice.json')
}

/** The fields this plugin persists, keeping only values that pass validation. */
function normalizeSettings(raw) {
  const settings = {}
  const every = validEvery(raw?.every)
  if (every !== undefined) settings.every = every
  const stepNotice = validFlag(raw?.stepNotice)
  if (stepNotice !== undefined) settings.stepNotice = stepNotice
  const userAppend = validFlag(raw?.userAppend)
  if (userAppend !== undefined) settings.userAppend = userAppend
  const text = validText(raw?.text)
  if (text !== undefined) settings.text = text
  return settings
}

/** Read the saved choices; an absent or unreadable file simply means "none". */
function readStored(file) {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')))
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

export function apply(ctx, config = {}) {
  /** Defaults from the plugin row's Config; the Settings page overrides them. */
  const configured = Object.freeze({
    every: validEvery(config.every) ?? DEFAULT_EVERY,
    stepNotice: validFlag(config.stepNotice) ?? DEFAULT_STEP_NOTICE,
    userAppend: validFlag(config.userAppend) ?? DEFAULT_USER_APPEND,
    text: validText(config.text) ?? DEFAULT_TEXT,
  })

  const file = settingsFile()

  /** What the Settings page saved; empty until it saves something. */
  let stored = readStored(file)

  /** Live behaviour: the saved choice when there is one, else the row's Config. */
  let every = stored.every ?? configured.every
  let stepNotice = stored.stepNotice ?? configured.stepNotice
  let userAppend = stored.userAppend ?? configured.userAppend
  let text = stored.text ?? configured.text

  /** Per-agent step counter, keyed by agent id. */
  const steps = new Map()

  const describe = () => ({
    ok: true,
    every,
    stepNotice,
    userAppend,
    min: MIN_EVERY,
    max: MAX_EVERY,
    configured: { ...configured },
    stored: { ...stored },
    text,
    file,
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision

    const claimed = decision.messages

    // Behaviour 1 — the notice trails every prompt the user just sent. The
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
        messages = claimed.map((message) => (isUserMessage(message) ? withNotice(message, text) : message))
      }
    }

    const agentId = payload.agent.id
    const count = (steps.get(agentId) ?? 0) + 1
    steps.set(agentId, count)

    // Behaviour 2 — one extra context message every `every` steps. A step that
    // just appended the notice to a user message already ends with the sentence,
    // so a second identical copy would only be noise.
    if (stepNotice && count % every === 0 && !appended) {
      ctx.logger?.debug?.(`convergence-notice: injected into step ${count} of turn ${payload.turn}`)
      return { ...decision, messages: [...messages, createNoticeMessage(text)] }
    }

    return messages === claimed ? decision : { ...decision, messages }
  })

  ctx.on('agent/disposed', (payload) => {
    steps.delete(payload.agent.id)
  })

  const applySettings = (next) => {
    stored = next
    every = next.every ?? configured.every
    stepNotice = next.stepNotice ?? configured.stepNotice
    userAppend = next.userAppend ?? configured.userAppend
    text = next.text ?? configured.text
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
                ctx.logger?.warn?.(`convergence-notice: could not clear the settings (${error?.message ?? error})`)
                return send(500, { error: `could not clear: ${error?.message ?? error}` })
              }
              applySettings({})
              ctx.logger?.info?.('convergence-notice: settings cleared, back to the plugin Config')
              return send(200, describe())
            }
            if (method !== 'POST') return send(405, { error: 'method not allowed' })

            const patch = await readJson(req)
            const next = { ...stored }
            let error
            let touched = false
            const body = patch && typeof patch === 'object' ? patch : {}

            if ('every' in body) {
              touched = true
              const value = validEvery(body.every)
              if (value === undefined) error = `every must be an integer between ${MIN_EVERY} and ${MAX_EVERY}`
              else next.every = value
            }
            for (const key of ['stepNotice', 'userAppend']) {
              if (!(key in body)) continue
              touched = true
              const value = validFlag(body[key])
              if (value === undefined) error = `${key} must be true or false`
              else next[key] = value
            }
            if ('text' in body) {
              touched = true
              const value = validText(body.text)
              if (value === undefined) {
                error = `text must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`
              } else next.text = value
            }

            if (error === undefined && !touched) error = 'no settings provided'
            if (error !== undefined) return send(400, { error })

            try {
              writeStored(file, next)
            } catch (failure) {
              ctx.logger?.warn?.(`convergence-notice: could not save the settings (${failure?.message ?? failure})`)
              return send(500, { error: `could not save: ${failure?.message ?? failure}` })
            }
            applySettings(next)
            ctx.logger?.info?.(
              `convergence-notice: every ${every} step(s), step notice ${stepNotice ? 'on' : 'off'}, user-message append ${userAppend ? 'on' : 'off'}, notice of ${text.length} character(s)`,
            )
            return send(200, describe())
          },
        }),
      'convergence-notice: settings api',
    )
  })
}