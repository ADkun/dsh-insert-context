/**
 * Convergence notice — browser half.
 *
 * Contributes one Settings section (`settings.section` id `convergence-notice`,
 * shown in 设置 → 收敛提示) that switches this plugin's two behaviours and edits
 * the injection interval:
 *
 *   1. append the notice to the end of every message the user sends;
 *   2. inject the notice as its own message every N executed steps.
 *
 * Both are read and written over the plugin's own same-origin route
 * `/api/convergence-notice/settings`; the host half persists them beside the
 * profile and applies a change from the next step onwards.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. Every colour comes from theme variables so
 * the page survives a scheme switch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-convergence-notice',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const NS = 'settings.convergenceNotice'
    const ROUTE = '/api/convergence-notice/settings'
    const inject = ['slots', 'locale']

    // ── copy ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        'meta.title': '收敛提示',
        'meta.description': '每执行 N 步向 Agent 上下文注入一句收敛提示（默认「【规划用最少的轮次达成目标。】」），并在每条用户消息末尾追加该提示；两项都可在设置页开关，提示句本身也可在设置页编辑。',
        nav: '收敛提示',
        title: '收敛提示',
        subtitle: '两种提醒方式，各有开关：每条用户消息的末尾追加一句，以及每执行 N 步单独注入一次。',
        behaviour: '行为开关',
        stepNoticeLabel: '每 N 步注入一次',
        stepNoticeHint: 'Agent 执行到第 N、2N、3N… 步时，额外插入一条提示消息。',
        userAppendLabel: '追加到每条用户消息末尾',
        userAppendHint: '你每次发消息，提示会作为该消息的最后一段进入上下文；若同一步恰好也该注入，则只出现一次。',
        everyLabel: '步数间隔',
        everyHint: '1–1000 的整数。5 表示每 5 步注入一次，1 表示每一步都注入。',
        current: '当前生效',
        sep: '：',
        stateStep: '每 {n} 步注入',
        stateAppend: '用户消息追加',
        on: '开',
        off: '关',
        fromStored: '以上来自设置页，重启后仍然保留。',
        fromConfigured: '还没在设置页保存过，暂用插件配置里的默认值。',
        textLabel: '提示句',
        textHint: '最多 1000 个字符，不能为空。恢复插件默认后回到插件配置里的那句。',
        textInvalid: '提示句不能为空，且最多 1000 个字符',
        textPlaceholder: '【规划用最少的轮次达成目标。】',
        sentence: '当前生效的提示句',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        reset: '恢复插件默认',
        resetting: '恢复中…',
        resetDone: '已恢复插件配置里的默认值',
        invalid: '请输入 1–1000 之间的整数',
        loading: '正在读取…',
        failed: '读取失败，无法连接插件后端',
        retry: '重试',
      },
      en: {
        'meta.title': 'Convergence notice',
        'meta.description':
          'Injects "【规划用最少的轮次达成目标。】" into the agent context every N steps, and appends it to every user message; both behaviours are switchable on the Settings page.',
        nav: 'Convergence notice',
        title: 'Convergence notice',
        subtitle:
          'Two ways to remind the agent, each with its own switch: one line at the end of every user message, and one standalone message every N steps.',
        behaviour: 'Behaviours',
        stepNoticeLabel: 'Inject once every N steps',
        stepNoticeHint: 'On steps N, 2N, 3N … of an agent, one extra notice message enters the context.',
        userAppendLabel: 'Append to every user message',
        userAppendHint:
          'Each message you send carries the notice as its final paragraph; a step that would also inject it stays a single copy.',
        everyLabel: 'Step interval',
        everyHint: 'An integer from 1 to 1000. 5 injects every 5 steps; 1 injects on every step.',
        current: 'In effect',
        sep: ': ',
        stateStep: 'once every {n} step(s)',
        stateAppend: 'appended to user messages',
        on: 'on',
        off: 'off',
        fromStored: 'These come from this page and survive a restart.',
        fromConfigured: 'Nothing saved here yet; the plugin Config values are in use.',
        textLabel: 'The line',
        textHint: 'At most 1000 characters, and it cannot be empty. Restoring the plugin defaults brings back the configured line.',
        textInvalid: 'The line cannot be empty and takes at most 1000 characters',
        textPlaceholder: '【规划用最少的轮次达成目标。】',
        sentence: 'The line in effect',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        reset: 'Restore plugin defaults',
        resetting: 'Restoring…',
        resetDone: 'Back to the plugin Config values',
        invalid: 'Enter an integer between 1 and 1000',
        loading: 'Reading…',
        failed: 'Could not reach the plugin backend',
        retry: 'Retry',
      },
    }

    const STYLE = [
      '.cn_root{display:flex;flex-direction:column;gap:16px;max-width:760px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary)}',
      '.cn_head{display:flex;flex-direction:column;gap:6px}',
      '.cn_title{margin:0;font-size:15px;font-weight:650}',
      '.cn_sub{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);max-width:62ch}',
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
      '.cn_dim{opacity:.45}',
      '.cn_row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-left:48px}',
      '.cn_input{font:inherit;font-size:13px;width:110px;padding:6px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.cn_input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.cn_input:disabled{opacity:.45}',
      '.cn_area{font:inherit;font-size:12.5px;line-height:1.5;box-sizing:border-box;width:100%;min-height:60px;resize:vertical;padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.cn_area:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.cn_area:disabled{opacity:.45}',
      '.cn_btn{font:inherit;font-size:12px;padding:6px 14px;border-radius:9px;border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);cursor:pointer}',
      '.cn_btn:disabled{opacity:.55;cursor:default}',
      '.cn_btnGhost{font:inherit;font-size:12px;padding:6px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.cn_btnGhost:disabled{opacity:.55;cursor:default}',
      '.cn_actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.cn_hint{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.cn_state{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px}',
      '.cn_state b{font-variant-numeric:tabular-nums}',
      '.cn_note{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.cn_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;padding:8px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.cn_ok{color:var(--dsw-alias-state-success-primary)}',
      '.cn_err{color:var(--dsw-alias-state-error-primary)}',
    ].join('')

    function fill(text, value) {
      return String(text).replace('{n}', String(value))
    }

    // ── the section ───────────────────────────────────────────────────────────
    function ConvergenceNoticeSection(props) {
      const { t } = props
      const [state, setState] = useState({ status: 'loading' })
      const [draftEvery, setDraftEvery] = useState('5')
      const [draftStep, setDraftStep] = useState(true)
      const [draftAppend, setDraftAppend] = useState(true)
      const [draftText, setDraftText] = useState('')
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState('')
      const [failure, setFailure] = useState('')

      const adopt = payload => {
        setState({ status: 'ready', value: payload })
        setDraftEvery(String(payload?.every ?? 5))
        setDraftStep(payload?.stepNotice !== false)
        setDraftAppend(payload?.userAppend !== false)
        setDraftText(String(payload?.text ?? ''))
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

      const save = () => {
        const wanted = Number(draftEvery)
        if (!Number.isInteger(wanted) || wanted < 1 || wanted > 1000) {
          setFailure(t('invalid'))
          setMessage('')
          return
        }
        if (draftText.trim() === '' || draftText.length > 1000) {
          setFailure(t('textInvalid'))
          setMessage('')
          return
        }
        setBusy('save')
        send('POST', { every: wanted, stepNotice: draftStep, userAppend: draftAppend, text: draftText }, t('saved'))
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
        const toggle = (key, checked, set) =>
          h('label', { className: 'cn_switch' },
            h('input', {
              type: 'checkbox',
              checked,
              disabled: busy !== '',
              'aria-label': key === 'step' ? t('stepNoticeLabel') : t('userAppendLabel'),
              onChange: event => {
                set(event.target.checked)
                clear()
              },
            }),
            h('span', { className: 'cn_track', 'aria-hidden': 'true' }, h('span', { className: 'cn_knob' })))

        body.push(
          h('div', { className: 'cn_card', key: 'behaviour' },
            h('span', { className: 'cn_label' }, t('behaviour')),
            h('div', { className: 'cn_opt' },
              toggle('append', draftAppend, setDraftAppend),
              h('span', { className: 'cn_optText' },
                h('span', { className: 'cn_optLabel' }, t('userAppendLabel')),
                h('span', { className: 'cn_hint' }, t('userAppendHint')))),
            h('div', { className: 'cn_opt' },
              toggle('step', draftStep, setDraftStep),
              h('span', { className: 'cn_optText' },
                h('span', { className: 'cn_optLabel' }, t('stepNoticeLabel')),
                h('span', { className: 'cn_hint' }, t('stepNoticeHint')))),
            h('div', { className: 'cn_row' },
              h('span', { className: draftStep ? 'cn_label' : 'cn_label cn_dim' }, t('everyLabel')),
              h('input', {
                className: 'cn_input',
                type: 'number',
                min: value.min ?? 1,
                max: value.max ?? 1000,
                step: 1,
                value: draftEvery,
                'aria-label': t('everyLabel'),
                disabled: busy !== '' || !draftStep,
                onChange: event => {
                  setDraftEvery(event.target.value)
                  clear()
                },
                onKeyDown: event => {
                  if (event.key === 'Enter') save()
                },
              })),
            h('span', { className: 'cn_hint' }, t('everyHint')),
            h('span', { className: 'cn_label' }, t('textLabel')),
            h('textarea', {
              className: 'cn_area',
              rows: 2,
              maxLength: 1000,
              value: draftText,
              placeholder: t('textPlaceholder'),
              'aria-label': t('textLabel'),
              disabled: busy !== '',
              onChange: event => {
                setDraftText(event.target.value)
                clear()
              },
            }),
            h('span', { className: 'cn_hint' }, t('textHint')),
            h('div', { className: 'cn_actions' },
              h('button', { className: 'cn_btn', type: 'button', onClick: save, disabled: busy !== '' },
                busy === 'save' ? t('saving') : t('save')),
              h('button', { className: 'cn_btnGhost', type: 'button', onClick: reset, disabled: busy !== '' },
                busy === 'reset' ? t('resetting') : t('reset')),
              failure !== '' ? h('span', { className: 'cn_err', role: 'alert' }, failure) : null,
              message !== '' ? h('span', { className: 'cn_ok', role: 'status' }, message) : null),
            h('span', { className: 'cn_hint' }, t('sentence')),
            h('div', { className: 'cn_mono' }, String(value.text ?? ''))),
          h('div', { className: 'cn_state', key: 'state' },
            h('span', null, t('current'), t('sep'),
              h('b', null, fill(t('stateStep'), value.every ?? draftEvery)),
              value.stepNotice === false ? `（${t('off')}）` : ''),
            h('span', null, t('stateAppend'), t('sep'),
              h('b', null, value.userAppend === false ? t('off') : t('on'))),
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
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'convergence-notice: dictionaries')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'convergence-notice',
        order: 36,
        label: () => t('nav'),
        locale: NS,
      }, props => h(ConvergenceNoticeSection, {
        ...props,
        t: Object.assign(text => t(text), { locale: localeTag(ctx) }),
      })))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'convergence-notice'
    return module.exports
  },
})