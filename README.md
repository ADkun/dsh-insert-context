# dsh-insert-context

A DeepSeek Harness (DSH) plugin that inserts context into an agent **during** a task, on a schedule
you define. Two independent behaviours, both configured from DSH's Settings page:

1. **Rule injection** — a rule says *from step X, every Y steps, Z times, with this text*. When the
   agent's current step number is one of the steps the rule hits, the text is injected as one extra
   context message. `{{step}}` in the text is replaced by the current step number.
2. **Append to every user message** — one sentence is appended to the end of each user message you
   send. **Off by default**; turn it on in Settings if you want it.

Either behaviour can be turned off (an empty rule list injects nothing; `userAppend: false` stops
the append — the shipped default), and nothing is injected unless a rule or the append is actually
configured.

## Rules

A rule is `{ start, every, repeat, text }`. Its **hit set** is

```
start, start + every, start + 2·every, … , start + (repeat − 1)·every     ← exactly `repeat` hits
start, start + every, start + 2·every, …                                  ← when `repeat` is 0 (unlimited)
```

| rule | hits |
|---|---|
| `{ start: 10, every: 10, repeat: 0 }` | 10, 20, 30, 40, … forever (**unlimited**) |
| `{ start: 5, every: 5, repeat: 9 }` | 5, 10, 15, 20, 25, 30, 35, 40, 45 |
| `{ start: 60, every: 10, repeat: 5 }` | 60, 70, 80, 90, 100 |

`repeat: 0` is the special value for **unlimited**: from `start` onwards the rule fires on every
`every`-th step and never stops (`repeat` is validated as 0–1000, where 0 means unlimited). The
Settings page previews an unlimited rule as `将注入第 10,20,30,… 步（无限次）` — the preview lists the
first 10 hits and never walks an endless list.

So free-form intervals are possible — inject on 5, 10, 15 … 50 and then on 60, 70 … 100 by listing
two rules. Rules are independent: one agent can be hit by any number of them.

`{{step}}` is the **only** supported placeholder, and it is only recognised in a rule's `text`
(not in `appendText`). It is replaced by the current step number of that agent's counter — the same
counter described under *Step counting* below. Any other `{{…}}` is left in the text verbatim and
logged as a warning by the host (prefix `insert-context:`), never silently swallowed:

```
insert-context: unknown placeholder {{turn}} in rules[0].text; it is injected verbatim (only {{step}} is supported)
```

### Several rules on the same step

If one step hits several rules, they are **merged into a single injected message**: each hit rule
contributes one paragraph with its own `{{step}}` filled in, and the paragraphs are joined with a
newline in the order the rules appear in the settings list (`rules[0]` first). One hit — one
message, no matter how many rules matched. Reordering the rows on the Settings page therefore
reorders the paragraphs.

### Step counting

The counter is **per agent**, keyed by the agent id of the step payload, and it is dropped when that
agent is disposed (`agent/disposed`). Steps that are rejected downstream are not counted. There is
**no layer filtering**: a dispatcher and each of its subagents keep separate counters, so a subagent
that is on its 5th step is hit by `{ start: 5, every: 5, repeat: 9 }` even if its parent is on step
50. Counting starts from the moment the plugin is mounted/active.

### Duplicate suppression

If a step already appended the sentence to a user message (behaviour 2), no rule message is injected
for that same step — the appended sentence already ends the batch, and a second copy is noise.

## Defaults

The built-in default `rules` holds **exactly one rule** — playful in tone (a nudge, not an order),
from step 10, every 10 steps, unlimited:

| # | rule | text |
|---|---|---|
| 1 | `{ start: 10, every: 10, repeat: 0 }` (unlimited) | `现在是第 {{step}} 步，用户催你搞快点啦！但是如果还有没做完的事情就先别理用户哦~` |

About that wording:

- it is the **plain literal** the user asked for — no `【 … 】` brackets and no compression sentence;
- the tone check holds: it contains none of 必须 / 不许 / 立刻;
- the second clause is **conditional on the agent's own state** (`如果还有没做完的事情`) and names an
  action, where the older wording named a virtue (`别牺牲回答质量`) with no trigger and no action to
  take. A model reading `用户催你搞快点啦` alone resolves that tension by wrapping the task up early —
  the very failure the notice exists to prevent — so the exception has to be spelled out as *what to
  do instead of hurrying*, not as a quality to keep in mind.
- the known sharp edge: the injected notice is appended **after** the user's own message of that step
  (`index.js:478`), so on a hit step a fresh user instruction is read first and this line last; read
  strictly, `先别理用户` then defers a real instruction rather than only the impatience. It is a nudge,
  not a gate, and it is tunable per profile from the Settings page without a commit.
- it stays **short** on purpose. The reminder is reread on every hit, and this host has **no
  session-level turn budget or hard gate**, so an older wording's branch about "触及轮数或预算上限"
  could essentially never fire. Longer, more coercive texts cost tokens on every hit while shaping the
  reply more than they help.

The built-in default `appendText` is used only when you turn the append switch on: it asks for a
readable answer without a replay of the process, and the square brackets are part of the text.

> [注：回复不复述过程，结构清晰可读性好。]

Both the append switch and the appended line are **off/absent by default** (`userAppend: false`): the
shipped default is just the every-10-steps injection above.

Older/longer wordings the user has used are **not defaults** — they are kept here as copy-paste
examples only (paste one into a new row on the Settings page if you want it):

| rule (example, not a default) | text |
|---|---|
| `{ start: 10, every: 10, repeat: 0 }` | `【这是第 {{step}} 步。思考：验收清单已完成则收工交付，未完成则继续。压缩时不保留本括号内的内容。】` |
| `{ start: 10, every: 10, repeat: 0 }` | `【这是第 {{step}} 步。按需收敛：这一轮结束后，会不会改变验收标准里某一条的判定？一条都不变，就收工交付当前结果；要继续，就把“下一步要改变哪一条判定”写清楚。已通过的验证不必再确认一遍。这一轮没能收尾时（被中断、或还需要继续），交付已完成部分 + 未完成清单（原因 / 下次继续的第一步），状态标 budget-limited，不要拿残缺当完成。压缩时不保留本括号内的内容。】` |
| `{ start: 60, every: 10, repeat: 5 }` | `这是第 {{step}} 步。按边界收尾：交付“已完成 / 未完成 / 未完成原因 / 下次继续的第一步”，状态标 budget-limited，不许用不完整的答案冒充完成。` |

Two of those examples carry a **compression-time instruction** in their tail:
`压缩时不保留本括号内的内容。` The notice is a one-off nudge for that step, not a fact to deliver, so
a context compaction need not copy it into a folded summary — leaving it there only spends tokens.
That instruction covers the bracketed reminder itself only; it says nothing about dropping
*unverified / not-covered* items from a delivery, which the rules above still require.

## How it works

The plugin listens on the host event `agent/pre-step`. It awaits the downstream decision and, when
the step is admitted, rewrites the messages that step will carry:

- every message whose `source.kind === 'user'` gets one extra trailing `text` block when
  `userAppend` is on — the user's own text is never modified; the sentence is its own paragraph;
- one standalone `user` message (source kind `insert-context`) is appended when the step number
  hits at least one rule, carrying the merged paragraphs.

Because the agent loop journals `decision.messages` into the session log as `user/message` events
(`surfaceOp: "append"`), both are durable: they are part of the committed context, survive replay
and are exactly what the model reads on that step.

## Configuration

```yaml
- insert:
    - id: insert-context
      name: dsh-insert-context
      config:
        rules:
          - start: 10
            every: 10
            repeat: 0
            text: '现在是第 {{step}} 步，用户催你搞快点啦！但是如果还有没做完的事情就先别理用户哦~'
        userAppend: false
        appendText: '[注：回复不复述过程，结构清晰可读性好。]'
```

| field | type | default | meaning |
|---|---|---|---|
| `rules` | array of rule objects, any length (an empty list is valid) | the one default rule above | the injection schedule; row order is the merge order |
| `rules[].start` | integer 1–100000 | `10` | the first step the rule fires on |
| `rules[].every` | integer 1–1000 | `10` | the interval between hits |
| `rules[].repeat` | integer 0–1000; **`0` = unlimited** | `0` (unlimited) | how many hits in total; after that the rule goes quiet. `0` never goes quiet |
| `rules[].text` | non-empty string, ≤ 1000 characters | see *Defaults* | the injected text; `{{step}}` is filled in |
| `userAppend` | boolean | `false` (off) | append `appendText` to every user message |
| `appendText` | non-empty string, ≤ 1000 characters | the sentence above (used only when the switch is on) | the appended sentence (`{{step}}` is **not** substituted here) |

Every field is overridable at runtime from the Settings page, without editing this patch.
The old `every` / `stepNotice` / `text` fields were replaced by `rules` / `appendText`; a saved
settings file that still holds them is ignored (unknown keys are dropped, and an unusable saved rule
is dropped with a warning while the usable ones are kept).

## Settings page

The plugin ships a browser half (`client.js`) that contributes a section to DSH's Settings
navigation — title **过程插入** / **Context insertion**, placed right after *Our Free Model*:

```
Settings → 过程插入
  Rules
   1  start [ 10 ]  every [ 10 ]  repeat [ 0 ]
      text [ 现在是第 {{step}} 步，用户催你搞快点啦！但是如果还有没做完的事情就先别理用户哦~ ]
      将注入第 10,20,30,40,50,60,70,80,90,100,… 步（无限次）
   ( + Add rule )     ( − Remove this rule )
  Append to every user message  [ ]      ← off by default
  The sentence  "[注：回复不复述过程，结构清晰可读性好。]"   ← those brackets are part of the text
   {{step}} is only substituted in rule texts, not here.
   ( Save )  ( Restore plugin defaults )
  In effect: 1 rule · append off
```

Each row shows a **live preview** of the steps it will hit — the first 10 hits plus the total:
`将注入第 10,20,30,…,100 步（共 10 次）` for a ten-hit rule, `将注入第 10,20,30,40,50,60,70,80,90,100,… 步（无限次）`
for an unlimited one (`repeat: 0`), and `将注入第 60,70,80,90,100,110,120,130,140,150 … 步（共 100 次）` when a
finite rule has more than 10 hits; a row whose numbers are not valid yet reads
`这条规则没有命中步数（当前输入还不合法）`. An invalid row (not an integer, out of range, empty text)
shows the exact error inline and **Save refuses to submit** — the message names the row, e.g.
`第 2 条："步数间隔"必须是 1–1000 之间的整数`. The `repeat` error text spells the convention out
itself: `提醒次数必须是 0–1000 之间的整数（0 = 无限）` / `Repeat must be an integer between 0 and 1000 (0 = unlimited)`.
Rows can be added and removed; the row order is the order of the paragraphs when one step hits
several rules.

## Persistence

The saved choices go to a small JSON file owned by the plugin —
`$DSH_PROFILE_DIR/insert-context.json` (falling back to `$DSH_HOME`, then `~/.dsh`), written mode
`0600` via temp-file + rename. The host half reads that file once, when the plugin row is mounted;
a value saved from the Settings page is applied in memory from the very next step — no restart and
no `cordis.patch.yml` edit — but editing the JSON by hand is only picked up by a fresh mount
(restart DSH, or touch a plugin file so the host hot-reloads it). *Restore plugin defaults* deletes
the file (route `DELETE`).

> The old `convergence-notice.json` file (if you have one, e.g. `~/.dsh/convergence-notice.json`)
> is **no longer read or written** by this plugin: the settings file is `insert-context.json`. The
> old file is left untouched on disk; delete it yourself if you want it gone.

| precedence (per field) | source |
|---|---|
| 1 | the value saved from the Settings page (`insert-context.json`) |
| 2 | the row's `config` in `cordis.patch.yml` |
| 3 | the built-in defaults listed under *Defaults* |

## API

The page talks to the plugin's own host route (registered on the `webServer` service, and skipped
silently in compositions without an HTTP carrier):

| route | method | body | answer |
|---|---|---|---|
| `/api/insert-context/settings` | `GET` | — | the state (below) |
| `/api/insert-context/settings` | `POST` | `{ "rules": [ … ], "userAppend": true, "appendText": "…" }` (any subset) | the new state |
| `/api/insert-context/settings` | `DELETE` | — | drops the saved file, back to the Config defaults |

```jsonc
{
  "ok": true,
  "rules": [ { "start": 10, "every": 10, "repeat": 0, "text": "现在是第 {{step}} 步，用户催你搞快点啦！但是如果还有没做完的事情就先别理用户哦~" } ],  // live values
  "userAppend": false,
  "appendText": "[注：回复不复述过程，结构清晰可读性好。]",
  "bounds": { "start": [1, 100000], "every": [1, 1000], "repeat": [0, 1000], "text": 1000 },
  "previewHits": 10,
  "configured": { … },                                   // from the patch (same shape as above)
  "stored": { "userAppend": false },                     // what the page saved, {} when none
  "file": "C:\\Users\\you\\.dsh\\profiles\\web\\insert-context.json"
}
```

`POST` accepts any subset of `rules` / `userAppend` / `appendText` (`"rules": null` is the same as
an empty list). Rejected requests answer `400` with a message such as
`start must be an integer between 1 and 100000`, `rules[1]: repeat must be an integer between 0 and 1000 (0 = unlimited)`
(the offending row index is always named), `rules must be an array of rules`,
`appendText must be a non-empty string of at most 1000 characters`, or `no settings provided` when
the body carries none of them. `401`/`403` when the request fails the trust fence (loopback `Host`,
no cross-site fetch, `Origin`/`Referer` authority equal to the `Host` authority, plus the connection
service's own admission check when it is mounted).

## Install

```
dsh plugin add D:\dsh\dsh-insert-context
```

or from the plugin manager with the package directory as the target.

### When a change takes effect

The three sources are read at different moments — worth knowing before you edit a default:

| you changed | read when | what it needs |
|---|---|---|
| a rule / the switch / the sentence on the **Settings page** (Save) | never re-read from disk: `POST` rewrites the live values in memory (`index.js:490-492`), and the next step already sees them | nothing — no restart, no patch edit |
| `cordis.patch.yml` (the row's `config`) | **once, when the plugin row is mounted**: `apply(ctx, config)` copies `config.rules` / `config.userAppend` / `config.appendText` into a frozen `configured` object (`index.js:404-409`), and the `agent/pre-step` handler only reads those closure variables (`index.js:454`) | a **remount** — restart DSH (the host stacks and parses the patch layers during profile boot) |
| the built-in defaults inside `index.js` (`DEFAULT_RULES`, `DEFAULT_APPEND_TEXT`, `DEFAULT_USER_APPEND`) | the same mount-time read, through `configured` | a remount / restart — *unless* the host hot-reloads the plugin module (it re-imports the module when a file changes on disk; observed mid-session: a new `text` took effect and a new HTTP route appeared) |

There is **no per-step config read and no cache to invalidate**: the event handler looks at the closure
variables once per step (`if (userAppend)`, `index.js:454`) and never at `ctx` config. So a running
process keeps whatever it captured at mount, and the only way to change an already-mounted row without
a restart is the Settings page.

`client.js` is a browser half: reload the page (F5) after changing it. If a change does not show up
even after the host hot-reloads the plugin file, restart DSH.

## Verify

- Rules: the text appears as a user-role context message (source kind `insert-context`) on exactly
  the steps of the hit set — e.g. with the default, on the 10th, 20th, 30th … step of an agent
  (`repeat: 0` never stops), each carrying its own step number in `现在是第 N 步`.
- Append (only when the switch is on): the sentence is the last paragraph of each message you send, in
  the transcript as well as in the request. With the shipped default (`userAppend: false`) no message
  carries it.
- `GET /api/insert-context/settings` answers JSON with `content-type: application/json` — an
  unauthenticated probe still proves the route is registered (an unknown path answers a bare
  `401 unauthorized` with no JSON content type). The old `/api/convergence-notice/settings` no
  longer exists (404 under the new prefix).
- The texts themselves: edit a rule or the append sentence and press Save — `GET` then answers the
  new values and the next hit carries them; *Restore plugin defaults* brings back the configured ones.

From a checkout, `npm test` runs `test/behaviour.mjs`: it mounts the real `index.js` on a fake
harness context (no DSH process, no network, no dependencies) and covers the hit-set arithmetic for
`{10,10,0}` (unlimited, asserted over 200 executed steps and again at step 300), `{5,5,9}` and
`{60,10,5}` step by step, silence before `start` and after `repeat` runs out, `{{step}}`
substitution, unknown placeholders kept verbatim plus the warning, the merge order, the
duplicate-suppression rule, the per-agent counter, the defaults, the precedence chain, every route
status (`200`/`400`/`403`/`404`/`405`) and the store file on disk — 73 checks.

## License

MIT