# dsh-convergence-notice

A DeepSeek Harness (DSH) plugin that keeps an agent pointed at its goal, with two
independent behaviours — both switchable from DSH's Settings page:

1. **Append to every user message** — the notice lands at the end of each message you send.
2. **Inject every N steps** — one extra context message on steps N, 2N, 3N … (default N = 5).

The line it adds by default:

> 【规划用最少的轮次达成目标。】

That sentence is the built-in default; it is also a configurable field (`text`), editable from the
Settings page and overridable per row in `cordis.patch.yml`.

## How it works

The plugin listens on the host event `agent/pre-step`. It awaits the downstream decision and,
when the step is admitted, rewrites the messages that step will carry:

- every message whose `source.kind === 'user'` (a prompt submitted through the web UI, the CLI,
  ACP or an SDK) gets one extra trailing `text` block — the user's own text is never modified,
  the notice is its own paragraph;
- one standalone `user` message is appended when the per-agent step counter reaches a multiple
  of `every` — unless that same step already appended the notice to a user message, in which case
  the batch already ends with the sentence and a second identical copy is skipped.

Because the agent loop journals `decision.messages` into the session log as `user/message` events
(`surfaceOp: "append"`), both are durable: they are part of the committed context, survive replay
and are exactly what the model reads on that step.

The counter is per agent (keyed by agent id) and dropped on `agent/disposed`.

## Configuration

```yaml
- insert:
    - id: convergence-notice
      name: dsh-convergence-notice
      config:
        every: 5                 # inject on every Nth executed step (default 5)
        stepNotice: true         # behaviour 2: the every-N-steps injection (default true)
        userAppend: true         # behaviour 1: append to every user message (default true)
        text: '【规划用最少的轮次达成目标。】'
```

| field | type | default | meaning |
|---|---|---|---|
| `every` | integer 1–1000 | `5` | inject the notice on every Nth executed step of an agent |
| `stepNotice` | boolean | `true` | switch behaviour 2 on/off |
| `userAppend` | boolean | `true` | switch behaviour 1 on/off |
| `text` | non-empty string, ≤ 1000 characters | the sentence above | the injected line |

Every field is overridable at runtime from the Settings page, without editing this patch.

## Settings page

The plugin ships a browser half (`client.js`) that contributes a section to DSH's Settings
navigation — title **收敛提示** / **Convergence notice**, placed right after *Our Free Model*.
It has one switch per behaviour, the step interval (1–1000), an editable field for the notice
sentence itself, a *Restore plugin defaults* button, and it prints the sentence that is in effect:

```
Settings → 收敛提示
  Behaviours
   [x] Append to every user message      你每次发消息，提示会作为该消息的最后一段进入上下文
   [x] Inject once every N steps         步数间隔 [ 5 ]
  The line  [ 【规划用最少的轮次达成目标。】 ]
   ( Save )  ( Restore plugin defaults )
  The line in effect: 【规划用最少的轮次达成目标。】
```

Persistence: the saved choices go to a small JSON file owned by the plugin —
`$DSH_PROFILE_DIR/convergence-notice.json` (falling back to `$DSH_HOME`, then `~/.dsh`),
written mode `0600` via temp-file + rename. The host half reads that file once, when the plugin
row is mounted; a value saved from the Settings page is applied in memory from the very next step —
no restart and no `cordis.patch.yml` edit — but editing the JSON by hand is only picked up by a
fresh mount (restart DSH, or touch a plugin file so the host hot-reloads it).
*Restore plugin defaults* deletes the file (route `DELETE`).

| precedence (per field) | source |
|---|---|
| 1 | the value saved from the Settings page (`convergence-notice.json`) |
| 2 | the row's `config` in `cordis.patch.yml` |
| 3 | built-in defaults: `every: 5`, `stepNotice: true`, `userAppend: true`, and the sentence above for `text` |

The page talks to the plugin's own host route (registered on the `webServer` service, and
skipped silently in compositions without an HTTP carrier):

| route | method | body | answer |
|---|---|---|---|
| `/api/convergence-notice/settings` | `GET` | — | the state (below) |
| `/api/convergence-notice/settings` | `POST` | `{ "text": "…" }` | the new state |
| `/api/convergence-notice/settings` | `DELETE` | — | drops the saved file, back to the Config defaults |

```jsonc
{
  "ok": true,
  "every": 10, "stepNotice": false, "userAppend": true,  // live values
  "min": 1, "max": 1000,
  "configured": { "every": 5, "stepNotice": true, "userAppend": true, "text": "【规划用最少的轮次达成目标。】" },  // from the patch
  "stored": { "every": 10, "stepNotice": false },        // what the page saved, {} when none
  "text": "【规划用最少的轮次达成目标。】",
  "file": "C:\\Users\\you\\.dsh\\profiles\\web\\convergence-notice.json"
}
```

`POST` accepts any subset of `every` / `stepNotice` / `userAppend` / `text`. Rejected requests answer `400`
with a message such as `every must be an integer between 1 and 1000`, `no settings provided`,
`stepNotice must be true or false` or `text must be a non-empty string of at most 1000 characters`;
`401`/`403` when the request fails the trust fence (loopback
`Host`, no cross-site fetch, `Origin`/`Referer` authority equal to the `Host` authority, plus the
connection service's own admission check when it is mounted).

## Install

```
dsh plugin add D:\dsh\dsh-convergence-notice
```

or from the plugin manager with the package directory as the target. The bundle patch
`cordis.patch.yml` is applied automatically and the row is remounted live.

The running host hot-reloads the plugin module when a file changes on disk (verified: a new
`text` took effect and a new HTTP route appeared mid-session), so a code change usually needs no
restart — reload the page (F5) to pick up `client.js`, and restart DSH only if a change does not
show up.

## Verify

- Behaviour 2: the notice appears as a user-role context message on the 5th, 10th, 15th … executed
  step of an agent (counting from the moment the plugin was activated for that agent).
- Behaviour 1: the sentence is the last paragraph of each message you send, in the transcript as
  well as in the request.
- `GET /api/convergence-notice/settings` answers JSON with `content-type: application/json` — an
  unauthenticated probe still proves the route is registered (an unknown path answers a bare
  `401 unauthorized` with no JSON content type).
- The sentence itself: edit the *The line* field and press Save — `GET` then answers the new line
  and the next injected notice carries it; *Restore plugin defaults* brings back the configured one.

From a checkout, `npm test` runs `test/behaviour.mjs`: it mounts the real `index.js` on a fake
harness context (no DSH process, no network, no dependencies) and covers both behaviours and their
switches, the per-agent step counter, the duplicate-suppression rule, the default sentence and its
code units, the `text` precedence chain, every route status (`200`/`400`/`403`/`404`/`405`) and the
store file on disk — 60 checks.

## License

MIT