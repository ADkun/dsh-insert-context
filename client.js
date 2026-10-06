/**
 * dsh-insert-context — browser half.
 *
 * Contributes one Settings section (`settings.section` id `insert-context`,
 * shown in 设置 → 过程插入) that owns a list of injection rules: each row says
 * from which executed step it starts, how often it repeats, how many times it
 * fires in total, and what it injects. `{{step}}` inside a rule's text is
 * replaced with the agent's current step number when it fires, and each row
 * previews its own hit steps live.
 *
 * The section reads and writes the plugin's own same-origin route
 * `/api/insert-context/settings`; the host half persists the rules beside the
 * profile and applies a change from the next step onwards.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. Every colour comes from theme variables so
 * the page survives a scheme switch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-insert-context',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const NS = 'settings.insertContext'
    const ROUTE = '/api/insert-context/settings'
    const inject = ['slots', 'locale']

    /** Field bounds, mirrored from the host half (its GET also reports them). */
    const BOUNDS = {
      start: { min: 1, max: 100000 },
      every: { min: 1, max: 1000 },
      repeat: { min: 0, max: 1000 },
      text: 1000,
    }
    /** How many hit steps a row previews before it only prints the count. */
    const PREVIEW_HITS = 10

    // ── copy ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        'meta.title': '过程插入',
        'meta.description': '按规则在任务过程中的指定步数向 Agent 上下文插入提示：从第 X 步开始、每 Y 步一次、共 Z 次，文案里可用 {{step}} 占位当前步数。',
        nav: '过程插入',
        title: '过程插入',
        subtitle: '每条规则写清「从第 X 步开始、每 Y 步提醒一次、共提醒 Z 次」和文案；命中时插入一条独立消息。可增删多行，行序就是同一步多条命中时的拼接顺序。',
        rules: '注入规则',
        rulesHint: '文案里的 {{step}} 会在注入时替换成当前步数；同一个 Agent 各自计步，调度者与子代理互不干扰。「提醒次数」填 0 表示无限次：从起始步开始每 N 步一直命中。',
        addRule: '添加一行',
        removeRule: '删除这一行',
        rowTitle: '第 {n} 条',
        fieldStart: '起始步',
        fieldEvery: '步数间隔',
        fieldRepeat: '提醒次数',
        fieldText: '文案',
        preview: '命中步数',
        previewHits: '将注入第 {steps} 步（共 {count} 次）',
        previewMore: '将注入第 {steps} … 步（共 {count} 次）',
        previewUnlimited: '将注入第 {steps},… 步（无限次）',
        previewNone: '这条规则没有命中步数（当前输入还不合法）',
        noRules: '规则列表为空：不会插入任何规则消息。',
        errInt: '{field}必须是 {min}–{max} 之间的整数',
        errRepeatLimit: '{field}必须是 {min}–{max} 之间的整数（0 = 无限）',
        errText: '文案不能为空，且最多 1000 个字符',
        invalid: '还有不合法的输入，未保存',
        append: '追加到每条用户消息',
        appendHint: '开关与文案独立于规则列表：开启后每条你发的消息末尾都会追加下面这句；{{step}} 只在规则文案里生效，这句里会原样输出。',
        appendLabel: '追加文案',
        appendPlaceholder: '交付看验收标准是否逐条达标，不看探索得多深多广；回复只写结论与证据落点，不复述过程。',
        appendInvalid: '追加文案不能为空，且最多 1000 个字符',
        current: '当前生效',
        sep: '：',
        stateRules: '{n} 条规则',
        stateAppend: '用户消息追加',
        stateAppendText: '追加文案',
        on: '开',
        off: '关',
        fromStored: '以上来自设置页，重启后仍然保留。',
        fromConfigured: '还没在设置页保存过，暂用插件配置里的默认值。',
        save: '保存',
        saving: '保存中…',
        saved: '已保存，从下一步起生效',
        reset: '恢复插件默认',
        resetting: '恢复中…',
        resetDone: '已恢复插件配置里的默认值',
        loading: '正在读取…',
        failed: '读取失败，无法连接插件后端',
        retry: '重试',
      },
      en: {
        'meta.title': 'Context insertion',
        'meta.description':
          'Insert a notice into the agent context at chosen executed steps: start at step X, every Y steps, Z times, with {{step}} in the text replaced by the current step number.',
        nav: 'Context insertion',
        title: 'Context insertion',
        subtitle:
          'Each rule says from which step it starts, how often it repeats, how many times it fires and what it injects. Rules fire as one standalone message; add or remove rows freely — row order is the order hits are joined on a step that trips several rules.',
        rules: 'Injection rules',
        rulesHint:
          '{{step}} in a rule text is replaced with the current step number when it fires. Steps are counted per agent, so the dispatcher and each subagent count independently. A repeat count of 0 means unlimited: the rule keeps firing every N steps from its start step on.',
        addRule: 'Add a rule',
        removeRule: 'Remove this rule',
        rowTitle: 'Rule {n}',
        fieldStart: 'Start step',
        fieldEvery: 'Every',
        fieldRepeat: 'Repeat',
        fieldText: 'Text',
        preview: 'Hit steps',
        previewHits: 'Injects on step {steps} ({count} time(s))',
        previewMore: 'Injects on steps {steps} … ({count} time(s))',
        previewUnlimited: 'Injects on steps {steps},… (unlimited)',
        previewNone: 'No hit steps yet (the input is not valid)',
        noRules: 'The rule list is empty: no rule message is inserted.',
        errInt: '{field} must be an integer between {min} and {max}',
        errRepeatLimit: '{field} must be an integer between {min} and {max} (0 = unlimited)',
        errText: 'The text cannot be empty and takes at most 1000 characters',
        invalid: 'Some input is invalid; nothing was saved',
        append: 'Append to every user message',
        appendHint:
          'This switch and its text are independent of the rules: when on, every message you send carries the line below. {{step}} only works inside rule texts — here it is printed verbatim.',
        appendLabel: 'Appended line',
        appendPlaceholder: '交付看验收标准是否逐条达标，不看探索得多深多广；回复只写结论与证据落点，不复述过程。',
        appendInvalid: 'The appended line cannot be empty and takes at most 1000 characters',
        current: 'In effect',
        sep: ': ',
        stateRules: '{n} rule(s)',
        stateAppend: 'appended to user messages',
        stateAppendText: 'Appended line',
        on: 'on',
        off: 'off',
        fromStored: 'These come from this page and survive a restart.',
        fromConfigured: 'Nothing saved here yet; the plugin Config values are in use.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved; live from the next step',
        reset: 'Restore plugin defaults',
        resetting: 'Restoring…',
        resetDone: 'Back to the plugin Config values',
        loading: 'Reading…',
        failed: 'Could not reach the plugin backend',
        retry: 'Retry',
      },
    }

    const STYLE = [
      '.cn_root{display:flex;flex-direction:column;gap:16px;max-width:860px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary)}',
      '.cn_head{display:flex;flex-direction:column;gap:6px}',
      '.cn_title{margin:0;font-size:15px;font-weight:650}',
      '.cn_sub{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);max-width:66ch}',
      '.cn_card{display:flex;flex-direction:column;gap:12px;padding:14px 15px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.cn_label{font-size:12px;font-weight:600}',
      '.cn_opt{display:flex;align-items:flex-start;gap:12px}',
      '.cn_switch{position:relative;display:inline-flex;flex:0 0 auto;width:36px;height:20px;margin-top:1px;cursor:pointer}',
      '.cn_switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}',
      '.cn_track{pointer-events:none;position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);transition:background .15s ease,border-color .15s ease}',
      '.cn_knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s ease,background .15s ease}',
      '.cn_switch input:checked+.cn_track{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.cn_switch input:checked+.cn_track .cn_knob{transform:translateX(16px);background:var(--dsw-alias-bg-base)}',
      '.cn_switch input:focus-visible+.cn_track{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.cn_switch input:disabled+.cn_track{opacity:.5}',
      '.cn_optText{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.cn_optLabel{font-size:12.5px;font-weight:600}',
      '.cn_rules{display:flex;flex-direction:column;gap:10px}',
      '.cn_rule{display:flex;flex-direction:column;gap:8px;padding:11px 12px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.cn_ruleHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.cn_ruleTitle{font-size:12px;font-weight:650}',
      '.cn_spacer{flex:1 1 auto}',
      '.cn_nums{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.cn_field{display:flex;align-items:center;gap:6px}',
      '.cn_fieldLabel{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.cn_input{font:inherit;font-size:12.5px;width:88px;padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.cn_input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.cn_input:disabled{opacity:.45}',
      '.cn_area{font:inherit;font-size:12.5px;line-height:1.5;box-sizing:border-box;width:100%;min-height:58px;resize:vertical;padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.cn_area:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.cn_area:disabled{opacity:.45}',
      '.cn_areaBad{border-color:var(--dsw-alias-state-error-primary)}',
      '.cn_preview{display:flex;flex-direction:column;gap:2px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.cn_preview b{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.cn_btn{font:inherit;font-size:12px;padding:6px 14px;border-radius:9px;border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);cursor:pointer}',
      '.cn_btn:disabled{opacity:.55;cursor:default}',
      '.cn_btnGhost{font:inherit;font-size:12px;padding:6px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.cn_btnGhost:disabled{opacity:.55;cursor:default}',
      '.cn_btnDanger{font:inherit;font-size:11.5px;padding:5px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-state-error-primary);cursor:pointer}',
      '.cn_btnDanger:disabled{opacity:.55;cursor:default}',
      '.cn_actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.cn_hint{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.cn_state{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px}',
      '.cn_state b{font-variant-numeric:tabular-nums}',
      '.cn_note{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.cn_ok{color:var(--dsw-alias-state-success-primary)}',
      '.cn_err{color:var(--dsw-alias-state-error-primary)}',
      '.cn_fieldErr{font-size:11.5px;color:var(--dsw-alias-state-error-primary)}',
    ].join('')

    function fill(text, values) {
      return String(text).replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole))
    }

    /** The hit steps of one accepted rule: `start`, `start+every`, … — capped for preview. */
    function hitSteps(rule) {
      const total = rule.repeat === 0 ? PREVIEW_HITS : Math.min(rule.repeat, PREVIEW_HITS)
      const steps = []
      for (let index = 0; index < total; index += 1) steps.push(rule.start + index * rule.every)
      return steps
    }

    /** The message for a bad numeric field; `repeat` also spells out the 0 = unlimited convention. */
    function numberError(t, field, key, bound) {
      if (key === 'repeat') return fill(t('errRepeatLimit'), { field, min: bound.min, max: bound.max })
      return fill(t('errInt'), { field, min: bound.min, max: bound.max })
    }

    /** Read one numeric draft field, returning the integer or an error string. */
    function readNumber(t, draft, key) {
      const field = t(`field${key[0].toUpperCase()}${key.slice(1)}`)
      const bound = BOUNDS[key]
      const raw = String(draft ?? '').trim()
      if (!/^-?\d+$/.test(raw)) return { error: numberError(t, field, key, bound) }
      const value = Number(raw)
      if (!Number.isInteger(value) || value < bound.min || value > bound.max) {
        return { error: numberError(t, field, key, bound) }
      }
      return { value }
    }

    /** Check one draft rule: `{rule, errors}` — `rule` is absent when anything fails. */
    function checkRule(t, draft) {
      const errors = {}
      const start = readNumber(t, draft.start, 'start')
      const every = readNumber(t, draft.every, 'every')
      const repeat = readNumber(t, draft.repeat, 'repeat')
      if (start.error) errors.start = start.error
      if (every.error) errors.every = every.error
      if (repeat.error) errors.repeat = repeat.error
      const text = String(draft.text ?? '')
      if (text.trim() === '' || text.length > BOUNDS.text) errors.text = t('errText')
      if (Object.keys(errors).length > 0) return { errors }
      return { rule: { start: start.value, every: every.value, repeat: repeat.value, text }, errors }
    }

    /** The preview line of one draft rule, or the "not valid yet" note. */
    function previewOf(t, draft) {
      const checked = checkRule(t, draft)
      if (checked.rule === undefined) return t('previewNone')
      const steps = hitSteps(checked.rule)
      const shown = steps.join(',')
      if (checked.rule.repeat === 0) return fill(t('previewUnlimited'), { steps: shown })
      return fill(checked.rule.repeat > PREVIEW_HITS ? t('previewMore') : t('previewHits'), {
        steps: shown,
        count: checked.rule.repeat,
      })
    }

    // ── the section ───────────────────────────────────────────────────────────
    function InsertContextSection(props) {
      const { t } = props
      const [state, setState] = useState({ status: 'loading' })
      const [drafts, setDrafts] = useState([])
      const [draftAppend, setDraftAppend] = useState(true)
      const [draftAppendText, setDraftAppendText] = useState('')
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState('')
      const [failure, setFailure] = useState('')

      const adopt = payload => {
        setState({ status: 'ready', value: payload })
        const rows = Array.isArray(payload?.rules) ? payload.rules : []
        setDrafts(
          rows.map(rule => ({
            start: String(rule?.start ?? ''),
            every: String(rule?.every ?? ''),
            repeat: String(rule?.repeat ?? ''),
            text: String(rule?.text ?? ''),
          })),
        )
        setDraftAppend(payload?.userAppend !== false)
        setDraftAppendText(String(payload?.appendText ?? ''))
      }

      const load = useCallback(() => {
        let alive = true
        setState({ status: 'loading' })
        fetch(ROUTE, { headers: { accept: 'application/json' } })
          .then(response => response.json())
          .then(payload => {
            if (alive) adopt(payload)
          })
          .catch(() => {
            if (alive) setState({ status: 'failed' })
          })
        return () => {
          alive = false
        }
      }, [])

      useEffect(() => load(), [load])

      const clear = () => {
        setMessage('')
        setFailure('')
      }

      const send = (method, body, done) => {
        setFailure('')
        setMessage('')
        fetch(ROUTE, {
          method,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
          .then(response =>
            response.json().then(payload => {
              if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
              return payload
            }),
          )
          .then(payload => {
            adopt(payload)
            setMessage(done)
          })
          .catch(error => setFailure(String(error?.message ?? error)))
          .finally(() => setBusy(''))
      }

      const patched = (index, field, value) => {
        setDrafts(rows => rows.map((row, at) => (at === index ? { ...row, [field]: value } : row)))
        clear()
      }

      const addRow = () => {
        setDrafts(rows => [...rows, { start: '1', every: '5', repeat: '1', text: '' }])
        clear()
      }

      const removeRow = index => {
        setDrafts(rows => rows.filter((_, at) => at !== index))
        clear()
      }

      const save = () => {
        if (draftAppendText.trim() === '' || draftAppendText.length > BOUNDS.text) {
          setFailure(t('appendInvalid'))
          setMessage('')
          return
        }
        const rules = []
        for (const draft of drafts) {
          const checked = checkRule(t, draft)
          if (checked.rule === undefined) {
            setFailure(t('invalid'))
            setMessage('')
            return
          }
          rules.push(checked.rule)
        }
        setBusy('save')
        send('POST', { rules, userAppend: draftAppend, appendText: draftAppendText }, t('saved'))
      }

      const reset = () => {
        setBusy('reset')
        send('DELETE', undefined, t('resetDone'))
      }

      const body = []
      body.push(
        h('div', { className: 'cn_head', key: 'head' },
          h('h2', { className: 'cn_title' }, t('title')),
          h('p', { className: 'cn_sub' }, t('subtitle'))),
      )

      if (state.status === 'loading') {
        body.push(h('div', { className: 'cn_state', key: 'loading' }, t('loading')))
      } else if (state.status === 'failed') {
        body.push(
          h('div', { className: 'cn_state', key: 'failed' },
            h('span', { className: 'cn_err' }, t('failed')),
            h('div', null, h('button', { className: 'cn_btn', type: 'button', onClick: load }, t('retry')))),
        )
      } else {
        const value = state.value ?? {}
        const stored = value.stored ?? {}
        const locked = busy !== ''

        const numberField = (rowIndex, field) => {
          const checked = checkRule(t, drafts[rowIndex] ?? {})
          const label = t(`field${field[0].toUpperCase()}${field.slice(1)}`)
          return h('span', { className: 'cn_field', key: field },
            h('span', { className: 'cn_fieldLabel' }, label),
            h('input', {
              className: 'cn_input',
              type: 'number',
              min: BOUNDS[field].min,
              max: BOUNDS[field].max,
              step: 1,
              value: drafts[rowIndex]?.[field] ?? '',
              'aria-label': `${t('rowTitle')} · ${label}`,
              disabled: locked,
              onChange: event => patched(rowIndex, field, event.target.value),
            }),
            checked.errors?.[field]
              ? h('span', { className: 'cn_fieldErr', role: 'alert' }, checked.errors[field])
              : null)
        }

        const ruleRow = (draft, index) => {
          const checked = checkRule(t, draft)
          return h('div', { className: 'cn_rule', key: `rule-${index}` },
            h('div', { className: 'cn_ruleHead' },
              h('span', { className: 'cn_ruleTitle' }, fill(t('rowTitle'), { n: index + 1 })),
              h('span', { className: 'cn_spacer' }),
              h('button', {
                className: 'cn_btnDanger',
                type: 'button',
                disabled: locked,
                'aria-label': `${t('removeRule')} ${index + 1}`,
                onClick: () => removeRow(index),
              }, t('removeRule'))),
            h('div', { className: 'cn_nums' },
              numberField(index, 'start'),
              numberField(index, 'every'),
              numberField(index, 'repeat')),
            h('textarea', {
              className: checked.errors?.text ? 'cn_area cn_areaBad' : 'cn_area',
              rows: 3,
              maxLength: BOUNDS.text,
              value: draft.text ?? '',
              'aria-label': `${t('rowTitle')} · ${t('fieldText')}`,
              disabled: locked,
              onChange: event => patched(index, 'text', event.target.value),
            }),
            checked.errors?.text
              ? h('span', { className: 'cn_fieldErr', role: 'alert' }, checked.errors.text)
              : null,
            h('div', { className: 'cn_preview' },
              h('span', null, t('preview'), t('sep')),
              h('b', null, previewOf(t, draft))),
          )
        }

        body.push(
          h('div', { className: 'cn_card', key: 'rules' },
            h('span', { className: 'cn_label' }, t('rules')),
            drafts.length === 0
              ? h('span', { className: 'cn_hint' }, t('noRules'))
              : h('div', { className: 'cn_rules' }, drafts.map(ruleRow)),
            h('span', { className: 'cn_hint' }, t('rulesHint')),
            h('div', { className: 'cn_actions' },
              h('button', { className: 'cn_btnGhost', type: 'button', onClick: addRow, disabled: locked }, t('addRule')),
              h('button', { className: 'cn_btn', type: 'button', onClick: save, disabled: locked },
                busy === 'save' ? t('saving') : t('save')),
              h('button', { className: 'cn_btnGhost', type: 'button', onClick: reset, disabled: locked },
                busy === 'reset' ? t('resetting') : t('reset')),
              failure !== '' ? h('span', { className: 'cn_err', role: 'alert' }, failure) : null,
              message !== '' ? h('span', { className: 'cn_ok', role: 'status' }, message) : null)),
          h('div', { className: 'cn_card', key: 'append' },
            h('span', { className: 'cn_label' }, t('append')),
            h('div', { className: 'cn_opt' },
              h('label', { className: 'cn_switch' },
                h('input', {
                  type: 'checkbox',
                  checked: draftAppend,
                  disabled: locked,
                  'aria-label': t('append'),
                  onChange: event => {
                    setDraftAppend(event.target.checked)
                    clear()
                  },
                }),
                h('span', { className: 'cn_track', 'aria-hidden': 'true' }, h('span', { className: 'cn_knob' }))),
              h('span', { className: 'cn_optText' }, h('span', { className: 'cn_hint' }, t('appendHint')))),
            h('span', { className: 'cn_label' }, t('appendLabel')),
            h('textarea', {
              className: 'cn_area',
              rows: 2,
              maxLength: BOUNDS.text,
              value: draftAppendText,
              placeholder: t('appendPlaceholder'),
              'aria-label': t('appendLabel'),
              disabled: locked,
              onChange: event => {
                setDraftAppendText(event.target.value)
                clear()
              },
            })),
          h('div', { className: 'cn_state', key: 'state' },
            h('span', null, t('current'), t('sep'),
              h('b', null, fill(t('stateRules'), { n: Array.isArray(value.rules) ? value.rules.length : 0 }))),
            h('span', null, t('stateAppend'), t('sep'),
              h('b', null, value.userAppend === false ? t('off') : t('on'))),
            h('span', null, t('stateAppendText'), t('sep'), h('b', null, String(value.appendText ?? ''))),
            h('span', { className: 'cn_note' },
              Object.keys(stored).length > 0 ? t('fromStored') : t('fromConfigured'))),
        )
      }

      return h('div', { className: 'cn_root' }, h('style', null, STYLE), body)
    }

    // ── registration ──────────────────────────────────────────────────────────
    // The shell mirrors the active language onto <html lang>, so a render-time
    // read survives a language switch without owning a subscription.
    function localeTag(ctx) {
      try {
        const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.()
        const value = snapshot?.active ?? ctx.locale?.locale
        return typeof value === 'string' ? value : document.documentElement.lang || 'en'
      } catch {
        return 'en'
      }
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'insert-context: dictionaries')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'insert-context',
        order: 36,
        label: () => t('nav'),
        locale: NS,
      }, props => h(InsertContextSection, {
        ...props,
        t: Object.assign(text => t(text), { locale: localeTag(ctx) }),
      })))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'insert-context'
    return module.exports
  },
})