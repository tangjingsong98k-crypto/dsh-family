/**
 * 客户端半边的无浏览器自测：
 * 1. 用假的 `window.__ModuleLoader__` 加载 client.js，检查模块 id 与注入；
 * 2. 用假的 ctx 跑一遍 apply()，检查注册到哪些槽位、注入了什么；
 * 3. 用仓库自带的 react / react-dom/server 把面板组件渲染成静态 HTML，确认不抛错、
 *    关键内容在（金额、日期、表单、图表柱、分类占比）；
 * 4. 直接验证日历、金额、聚合这些纯函数；再静态检查样式只用主题变量、没有 import 其它 Harness 包。
 *
 * 运行：node test/client.test.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REACT_MODULES = 'C:/custom/dsh/deepseek-harness/deepseek-harness/packages/client/ui-renderer/node_modules'
const requireFromCheckout = createRequire(path.join(REACT_MODULES, 'noop.cjs'))
const React = requireFromCheckout('react')
const { renderToStaticMarkup } = requireFromCheckout('react-dom/server')
const h = React.createElement

const source = await fs.readFile(path.join(import.meta.dirname, '..', 'client.js'), 'utf8')

/** 捕获到的模块定义。 */
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}

await import(pathToFileURL(path.join(import.meta.dirname, '..', 'client.js')).href)

assert.ok(loaded !== null, 'client.js 应该调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, '@local/dsh-balance', '模块 id 必须等于包名')
assert.equal(typeof loaded.factory, 'function')

const plugin = loaded.factory((id) => {
  if (id === 'react') return React
  throw new Error(`客户端模块不该 require "${id}"`)
})
const internals = globalThis.window.__dshBalanceInternals
assert.ok(internals !== undefined, 'client.js 应该挂上测试缝 __dshBalanceInternals')

let passed = 0

/**
 * 跑一条断言并计数。
 * @param {string} label - 用例名
 * @param {() => void|Promise<void>} body - 用例
 * @returns {Promise<void>} 完成
 */
async function check(label, body) {
  await body()
  passed += 1
  console.log(`  ok  ${label}`)
}

/**
 * 把 `{name}` 占位符替换掉的简易翻译。
 * @param {Record<string, string>} dictionary - 词条
 * @returns {(key: string, params?: Record<string, unknown>) => string} 翻译函数
 */
function translator(dictionary) {
  return (key, params) => {
    let text = typeof dictionary[key] === 'string' ? dictionary[key] : key
    if (params !== null && typeof params === 'object') {
      for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value))
    }
    return text
  }
}

console.log('dsh-balance / client')

// ---------------------------------------------------------------------------
// 模块面
// ---------------------------------------------------------------------------

await check('plugin injects exactly the services it uses', () => {
  assert.deepEqual([...plugin.inject].sort(), ['locale', 'sidebarRight', 'sidebarRightTabs', 'slots'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(internals.NS, 'balance')
  assert.equal(internals.TAB_KIND, 'balance')
  assert.equal(internals.TAB_ID, '@local/dsh-balance')
  assert.equal(internals.CHANNEL, '/balance')
})

await check('dictionaries have the same keys in zh and en, all non-empty', () => {
  const zhKeys = Object.keys(internals.zh).sort()
  const enKeys = Object.keys(internals.en).sort()
  assert.deepEqual(enKeys, zhKeys)
  assert.ok(zhKeys.length > 30, '词条应该覆盖面板文案')
  for (const key of zhKeys) {
    assert.equal(typeof internals.zh[key], 'string', `${key} 应是字符串`)
    assert.ok(internals.zh[key] !== '', `${key} 不应为空`)
    assert.ok(internals.en[key] !== '', `${key} 英文不应为空`)
  }
})

await check('source requires only react and imports no Harness client package', () => {
  const required = [...source.matchAll(/\brequire\((['"])([^'"]+)\1\)/g)].map(match => match[2])
  assert.deepEqual([...new Set(required)], ['react'])
  assert.ok(!source.includes('@deepseek-ai/dsh-client-ui-primitives'), '不要引用 primitives')
  assert.ok(!source.includes('document.body'), '不要往 body 上挂东西')
  assert.ok(!source.includes('connection.rpc'), '面板接口走 fetch，不走 Connection RPC')
  const illegal = [...source.matchAll(/var\((--[a-z0-9-]+)\)/g)]
    .map(match => match[1])
    .filter(name => !name.startsWith('--dsw-'))
  assert.deepEqual(illegal, [], '样式变量必须是 --dsw-* 主题变量')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(source), '样式里不要写死颜色')
  assert.ok(!/\brgba?\(/.test(source), '样式里不要写死颜色')
})

// ---------------------------------------------------------------------------
// apply() 的注册面
// ---------------------------------------------------------------------------

/** @type {Array<{ url: string, method: string, body: any }>} */
const requests = []
/** 下一次请求要返回的物件（用来模拟 401 / 网络错误）。 */
let nextResponse = null

globalThis.fetch = async (url, init) => {
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
  requests.push({ url: String(url), method: init?.method, body })
  if (nextResponse !== null) {
    const response = nextResponse
    nextResponse = null
    return response
  }
  const endpoint = String(url).split('/').pop()
  if (endpoint === 'load') return { ok: true, status: 200, json: async () => ({ ok: true, value: { entries: [] } }) }
  if (endpoint === 'remove') return { ok: true, status: 200, json: async () => ({ ok: true, value: { id: body.id } }) }
  if (body?.entry?.amount === -1) {
    return { ok: true, status: 200, json: async () => ({ ok: false, error: { code: 'balance/bad-amount', message: '金额必须大于 0。', details: {} } }) }
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, value: { id: 'b1', ...body?.entry } }) }
}

const events = []
const noop = () => () => {}
const dictionaries = {}
const ctx = {
  effect(fn, label) {
    const dispose = fn()
    events.push({ kind: 'effect', label, cleanup: typeof dispose })
    return typeof dispose === 'function' ? dispose : noop()
  },
  locale: {
    register(ns, dict) {
      dictionaries[ns] = dict
      events.push({ kind: 'locale', ns, languages: Object.keys(dict).sort() })
      return noop()
    },
    bind(ns) {
      return translator(dictionaries[ns]?.zh ?? {})
    },
  },
  sidebarRightTabs: {
    register(definition) {
      events.push({ kind: 'tab', id: definition.id, tabKind: definition.kind, guide: definition.guide.map(entry => entry.id), title: definition.title() })
      return noop()
    },
  },
  slots: {
    inject(name, callback) {
      callback()
      return noop()
    },
    register(options) {
      events.push({ kind: 'slot', name: options.name, key: options.key ?? options.id, locale: options.locale })
      if (typeof options.inject === 'function') events.push({ kind: 'inject', name: options.name, face: options.inject() })
      return noop()
    },
  },
  sidebarRight: {
    openTab(kind) {
      events.push({ kind: 'openTab', tabKind: kind })
    },
  },
}

plugin.apply(ctx)

await check('registers one locale dictionary with zh + en', () => {
  const locale = events.find(event => event.kind === 'locale')
  assert.ok(locale !== undefined)
  assert.equal(locale.ns, 'balance')
  assert.deepEqual(locale.languages, ['en', 'zh'])
})

await check('registers the right sidebar tab type with a guide card', () => {
  const tab = events.find(event => event.kind === 'tab')
  assert.ok(tab !== undefined)
  assert.equal(tab.id, '@local/dsh-balance')
  assert.equal(tab.tabKind, 'balance')
  assert.deepEqual(tab.guide, ['balance'])
  assert.equal(tab.title, '生活')
})

await check('registers the pane body under the tab id', () => {
  const slot = events.find(event => event.kind === 'slot' && event.name === 'sidebar.right.pane.tab')
  assert.ok(slot !== undefined)
  assert.equal(slot.key, '@local/dsh-balance')
  assert.equal(slot.locale, 'balance')
})

await check('registers a session header entry that opens the tab', () => {
  const slot = events.find(event => event.kind === 'slot' && event.name === 'conversation.session.header.utilities')
  assert.ok(slot !== undefined)
  assert.equal(slot.key, 'balance')
  const face = events.find(event => event.kind === 'inject' && event.name === 'conversation.session.header.utilities').face
  face.open()
  assert.deepEqual(events.filter(event => event.kind === 'openTab').at(-1), { kind: 'openTab', tabKind: 'balance' })
})

await check('injected balance api posts to /balance endpoints', async () => {
  const face = events.find(event => event.kind === 'inject' && event.name === 'sidebar.right.pane.tab').face
  assert.equal(typeof face.balance.load, 'function')
  assert.equal(typeof face.balance.save, 'function')
  assert.equal(typeof face.balance.remove, 'function')

  const data = await face.balance.load(2026)
  assert.deepEqual(requests.at(-1), { url: 'balance/load', method: 'POST', body: { year: 2026 } })
  assert.deepEqual(data, { entries: [] })

  await face.balance.load()
  assert.deepEqual(requests.at(-1).body, {})

  await face.balance.save({ date: '2026-11-20', amount: 12 })
  assert.deepEqual(requests.at(-1), {
    url: 'balance/save', method: 'POST', body: { entry: { date: '2026-11-20', amount: 12 } },
  })

  await face.balance.remove('b1')
  assert.deepEqual(requests.at(-1), { url: 'balance/remove', method: 'POST', body: { id: 'b1' } })
})

await check('a failed result throws an Error carrying its code', async () => {
  const face = events.find(event => event.kind === 'inject' && event.name === 'sidebar.right.pane.tab').face
  await assert.rejects(face.balance.save({ amount: -1 }), (error) => {
    assert.equal(error.code, 'balance/bad-amount')
    assert.match(error.message, /金额/)
    return true
  })
})

await check('an unauthenticated response turns into a readable error', async () => {
  const face = events.find(event => event.kind === 'inject' && event.name === 'sidebar.right.pane.tab').face
  nextResponse = { ok: false, status: 401, json: async () => ({}) }
  await assert.rejects(face.balance.load(2026), (error) => {
    assert.equal(error.code, 'balance/http-401')
    assert.match(error.message, /未授权/)
    return true
  })
})

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

await check('calendar grid covers six weeks and marks outside days', () => {
  const grid = internals.buildMonthGrid(2026, 11)
  assert.equal(grid.length, 42)
  const lead = internals.weekdayIndex('2026-11-01')
  assert.equal(grid[lead].date, '2026-11-01')
  assert.equal(grid[lead].outside, false)
  assert.equal(grid[lead + 29].date, '2026-11-30')
  assert.equal(grid[lead + 30].outside, true)
  for (let index = 0; index < lead; index += 1) assert.equal(grid[index].outside, true)
  assert.equal(grid.at(-1).outside, true)
  assert.equal(grid[lead + 29].day, 30)
})

await check('weekday index is Monday-first (2026-01-01 is a Thursday)', () => {
  assert.equal(internals.weekdayIndex('2026-01-01'), 3)
  assert.equal(internals.weekdayIndex('2026-11-20'), 4)
  assert.equal(internals.daysInMonth(2028, 2), 29)
  assert.equal(internals.daysInMonth(2026, 2), 28)
})

await check('month navigation crosses the year boundary', () => {
  assert.deepEqual(internals.shiftMonth({ year: 2026, month: 12 }, 1), { year: 2027, month: 1 })
  assert.deepEqual(internals.shiftMonth({ year: 2026, month: 1 }, -1), { year: 2025, month: 12 })
  assert.deepEqual(internals.shiftMonth({ year: 2026, month: 6 }, -14), { year: 2025, month: 4 })
})

await check('money formatting and compact cell amounts', () => {
  assert.equal(internals.money(1234.5), '1,234.50')
  assert.equal(internals.money(0), '0.00')
  assert.equal(internals.money(-12.345), '-12.35')
  assert.equal(internals.compact(2550), '25.5')
  assert.equal(internals.compact(800000), '8000')
  assert.equal(internals.compact(100), '1')
})

const sample = [
  { id: 'a', date: '2026-11-01', kind: 'income', amount: 8000, category: '工资', note: '', createdAt: '1', updatedAt: '1' },
  { id: 'b', date: '2026-11-05', kind: 'expense', amount: 200, category: '餐饮', note: '午饭', createdAt: '2', updatedAt: '2' },
  { id: 'c', date: '2026-11-05', kind: 'expense', amount: 100.5, category: '餐饮', note: '', createdAt: '3', updatedAt: '3' },
  { id: 'd', date: '2026-11-06', kind: 'expense', amount: 50, category: '交通', note: '地铁', createdAt: '4', updatedAt: '4' },
  { id: 'e', date: '2026-10-31', kind: 'expense', amount: 7, category: '', note: '', createdAt: '5', updatedAt: '5' },
]

await check('month totals sum in cents', () => {
  assert.deepEqual(internals.monthTotals(sample, 2026, 11), { income: 800000, expense: 35050, net: 764950, count: 4 })
  assert.deepEqual(internals.monthTotals([], 2026, 11), { income: 0, expense: 0, net: 0, count: 0 })
})

await check('daily buckets group by date', () => {
  const map = internals.byDay(sample)
  assert.deepEqual(map.get('2026-11-05'), { income: 0, expense: 30050, count: 2 })
  assert.deepEqual(map.get('2026-11-01'), { income: 800000, expense: 0, count: 1 })
  assert.equal(map.size, 4)
})

await check('monthly series has twelve months and keeps the year apart', () => {
  const series = internals.monthlySeries(sample, 2026)
  assert.equal(series.length, 12)
  assert.deepEqual(series[10], { month: 11, income: 800000, expense: 35050 })
  assert.deepEqual(series[9], { month: 10, income: 0, expense: 700 })
  assert.deepEqual(series[0], { month: 1, income: 0, expense: 0 })
})

await check('category rows sort by amount and carry shares', () => {
  const rows = internals.categoryRows(sample, 2026, 11, 'expense')
  assert.deepEqual(rows.map(row => [row.label, row.cents, row.count]), [
    ['餐饮', 30050, 2],
    ['交通', 5000, 1],
  ])
  assert.equal(Math.round(rows[0].share * 1000), Math.round((30050 / 35050) * 1000))
  assert.equal(Math.round(rows[0].share * 100) + Math.round(rows[1].share * 100), 100)
  assert.deepEqual(internals.categoryRows(sample, 2026, 11, 'income').map(row => row.label), ['工资'])
})

await check('topRows folds the tail into an "other" row', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ key: `k${index}`, label: `c${index}`, cents: (10 - index) * 100, count: 1, share: 0.1 }))
  const folded = internals.topRows(rows, 5)
  assert.equal(folded.length, 5)
  assert.equal(folded[4].other, true)
  assert.equal(folded[4].cents, 100 + 200 + 300 + 400 + 500 + 600)
  assert.equal(folded[4].count, 6)
})

// ---------------------------------------------------------------------------
// 无浏览器渲染
// ---------------------------------------------------------------------------

await check('opening button renders a labelled calendar icon', () => {
  const markup = renderToStaticMarkup(h(internals.BalanceOpenButton, { t: translator(internals.zh), open() {} }))
  assert.match(markup, /aria-label="打开生活面板"/)
  assert.match(markup, /class="bal-open-btn"/)
  assert.match(markup, /<svg/)
  assert.match(markup, /<rect/)
})

await check('panel renders its loading state before data arrives', () => {
  const markup = renderToStaticMarkup(h(internals.BalanceBody, {
    t: translator(internals.zh),
    balance: { load: () => new Promise(() => {}), save: async () => ({}), remove: async () => ({}) },
  }))
  assert.match(markup, /正在读账本/)
  assert.match(markup, /role="region"/)
})

await check('diet card accepts a qq and the dictionary exposes the switcher label', () => {
  const markup = renderToStaticMarkup(h(internals.DietCard, {
    t: translator(internals.zh),
    balance: {},
    date: '2026-11-24',
    qq: '1044949250',
  }))
  assert.match(markup, /当天饮食/)
  assert.equal(internals.zh['diet.user'], '看谁')
  assert.equal(internals.en['diet.user'], 'Whose')
})

await check('diet card renders its empty state', () => {
  const markup = renderToStaticMarkup(h(internals.DietCard, {
    t: translator(internals.zh),
    balance: {},
    date: '2026-11-24',
  }))
  assert.match(markup, /当天饮食/)
  assert.match(markup, /这天还没有饮食记录/)
})

await check('kcal monthly bars render twelve months and the target caption', () => {
  const months = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    total: index === 10 ? 20548 : 0,
    logged_days: index === 10 ? 9 : 0,
    avg: index === 10 ? 2283 : 0,
  }))
  const markup = renderToStaticMarkup(h(internals.KcalMonthlyBars, {
    t: translator(internals.zh),
    year: 2026,
    month: 11,
    kcalData: { months, target: 2328 },
  }))
  assert.match(markup, /月度摄入/)
  assert.match(markup, /全年日均/)
  assert.equal((markup.match(/class="bal-bar-group"/g) ?? []).length, 12)
})

await check('kcal daily bars list days with intake', () => {
  const days = internals.monthDays(sample, 2026, 11)
  const markup = renderToStaticMarkup(h(internals.KcalDaily, {
    t: translator(internals.zh),
    days,
    selected: '2026-11-05',
    today: '2026-11-05',
    onPick: () => {},
    kcalData: { days: { '2026-11-05': 1712, '2026-11-06': 2000 }, target: 2328, logged_days: 2, total: 3712, avg: 1856 },
  }))
  assert.match(markup, /本月逐日摄入/)
  assert.match(markup, /1712/)
  assert.match(markup, /2000/)
})

await check('similar notes rank substring matches first', () => {
  const notes = ['午饭', '地铁', '午饭加鸡腿', '打车']
  assert.deepEqual(internals.similarNotes(notes, '午饭'), ['午饭', '午饭加鸡腿'])
  assert.deepEqual(internals.similarNotes(notes, '车'), ['打车'])
  assert.deepEqual(internals.similarNotes(notes, ''), ['午饭', '地铁', '午饭加鸡腿', '打车'])
})

await check('note field renders a combobox without an open menu', () => {
  const markup = renderToStaticMarkup(h(internals.NoteField, {
    t: translator(internals.zh), value: '', notes: ['午饭'], onChange() {},
  }))
  assert.match(markup, /role="combobox"/)
  assert.doesNotMatch(markup, /bal-note-menu/)
})

await check('day panel lists entries, totals and the add form', () => {
  const t = translator(internals.zh)
  const dayEntries = sample.filter(entry => entry.date === '2026-11-05')
  const markup = renderToStaticMarkup(h(internals.DayPanel, {
    t,
    date: '2026-11-05',
    entries: dayEntries,
    form: { id: '', date: '2026-11-05', kind: 'expense', amount: '', category: '', note: '' },
    busy: false,
    problem: '',
    pendingDelete: '',
    listId: 'bal-cats-test',
    categories: ['餐饮', '交通'],
    onFormChange() {},
    onSubmit() {},
    onCancelEdit() {},
    onStartEdit() {},
    onAskDelete() {},
    onDelete() {},
    onCancelDelete() {},
  }))
  assert.match(markup, /11月5日/)
  assert.match(markup, /2 笔/)
  assert.match(markup, /-200\.00/)
  assert.match(markup, /-100\.50/)
  assert.match(markup, /午饭/)
  assert.match(markup, /编辑/)
  assert.match(markup, /删除/)
  assert.match(markup, /<form/)
  assert.match(markup, /type="date"/)
  assert.match(markup, /value="2026-11-05"/)
  assert.match(markup, /type="number"/)
  assert.match(markup, /role="combobox"/)
  assert.match(markup, /记下/)
  assert.match(markup, /aria-label="收支类型"/)
})

await check('expense note groups merge notes containing a shorter label', () => {
  const entries = [
    { id: 'a', kind: 'expense', date: '2026-11-03', amount: 20, note: '外卖', category: '餐饮' },
    { id: 'b', kind: 'expense', date: '2026-11-05', amount: 30, note: '外卖咖喱猪排饭', category: '餐饮' },
    { id: 'c', kind: 'expense', date: '2026-11-06', amount: 10, note: '公交', category: '交通' },
    { id: 'd', kind: 'expense', date: '2026-11-07', amount: 5, note: '', category: '' },
    { id: 'e', kind: 'income', date: '2026-11-08', amount: 100, note: '工资' },
  ]
  const groups = internals.noteGroups(entries, 2026, 11)
  assert.equal(groups.length, 3)
  assert.equal(groups[0].label, '外卖')
  assert.equal(groups[0].cents, 5000)
  assert.equal(groups[0].count, 2)
  assert.equal(groups[1].label, '公交')
  assert.equal(groups[1].cents, 1000)
  const noNote = groups.find(group => group.label === '')
  assert.equal(noNote.cents, 500)
})

await check('expense note groups derive a shared prefix keyword', () => {
  const entries = [
    { id: 'a', kind: 'expense', date: '2026-11-01', amount: 20, note: '外卖华莱士' },
    { id: 'b', kind: 'expense', date: '2026-11-02', amount: 30, note: '外卖香河肉饼' },
  ]
  const groups = internals.noteGroups(entries, 2026, 11)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].label, '外卖')
  assert.equal(groups[0].cents, 5000)
  assert.equal(groups[0].count, 2)
})

await check('day panel switches to a confirm step before deleting', () => {
  const markup = renderToStaticMarkup(h(internals.DayPanel, {
    t: translator(internals.zh),
    date: '2026-11-05',
    entries: sample.filter(entry => entry.date === '2026-11-05'),
    form: { id: '', date: '2026-11-05', kind: 'expense', amount: '', category: '', note: '' },
    busy: false,
    problem: '金额必须大于 0。',
    pendingDelete: 'b',
    listId: 'bal-cats-test',
    categories: [],
    onFormChange() {},
    onSubmit() {},
    onCancelEdit() {},
    onStartEdit() {},
    onAskDelete() {},
    onDelete() {},
    onCancelDelete() {},
  }))
  assert.match(markup, /确认删除/)
  assert.match(markup, /取消/)
  assert.match(markup, /role="alert"/)
  assert.match(markup, /金额必须大于 0/)
})

await check('monthly chart draws twelve groups with heights', () => {
  const markup = renderToStaticMarkup(h(internals.MonthlyBars, {
    t: translator(internals.zh), entries: sample, year: 2026, month: 11,
  }))
  assert.equal((markup.match(/class="bal-bar-group"/g) ?? []).length, 12)
  assert.equal((markup.match(/data-current=""/g) ?? []).length, 1)
  assert.match(markup, /height:100%/)
  assert.match(markup, /月度收支/)
  assert.match(markup, /title="11 · 支出 ¥350\.50"/)
  assert.match(markup, /全年：收入 ¥8,000\.00 · 支出 ¥357\.50/)
})

await check('category chart lists shares and an empty state when there is nothing', () => {
  const rows = internals.categoryRows(sample, 2026, 11, 'expense')
  const markup = renderToStaticMarkup(h(internals.CategoryBars, { t: translator(internals.zh), rows }))
  assert.match(markup, /餐饮/)
  assert.match(markup, /¥300\.50/)
  assert.match(markup, /\b86%/)
  assert.match(markup, /支出分类/)
  const empty = renderToStaticMarkup(h(internals.CategoryBars, { t: translator(internals.zh), rows: [] }))
  assert.match(empty, /这个月还没有账目/)
})

await check('kind switch marks the active side', () => {
  const markup = renderToStaticMarkup(h(internals.KindSwitch, {
    kind: 'income', onChange() {}, t: translator(internals.zh),
  }))
  assert.match(markup, /aria-pressed="true"[^>]*>收入/)
  assert.match(markup, /aria-pressed="false"[^>]*>支出/)
})

await check('date arithmetic crosses months, years and leap days', () => {
  assert.equal(internals.shiftDate('2026-11-20', 1), '2026-11-21')
  assert.equal(internals.shiftDate('2026-11-30', 1), '2026-12-01')
  assert.equal(internals.shiftDate('2026-12-31', 1), '2027-01-01')
  assert.equal(internals.shiftDate('2026-01-01', -1), '2025-12-31')
  assert.equal(internals.shiftDate('2028-02-28', 1), '2028-02-29')
  assert.equal(internals.shiftDate('2026-03-01', -1), '2026-02-28')
  assert.equal(internals.shiftDate('2026-11-20', 7), '2026-11-27')
})

await check('footer status prefers busy, then the last notice, then the file', () => {
  const t = translator(internals.zh)
  assert.equal(internals.footerText({ busy: true, notice: '已记下', file: 'F' }, t), '正在读账本……')
  assert.equal(internals.footerText({ busy: false, notice: '已记下 11月20日', file: 'F' }, t), '已记下 11月20日')
  assert.equal(internals.footerText({ busy: false, notice: '', file: 'F' }, t), '数据文件：F')
})

await check('editing state is visible and switches the submit label', () => {
  const markup = renderToStaticMarkup(h(internals.DayPanel, {
    t: translator(internals.zh),
    date: '2026-11-05',
    entries: sample.filter(entry => entry.date === '2026-11-05'),
    form: { id: 'b', date: '2026-11-03', kind: 'expense', amount: '25.5', category: '餐饮', note: '午饭' },
    busy: false,
    problem: '',
    pendingDelete: '',
    listId: 'bal-cats-test',
    categories: [],
    onFormChange() {},
    onSubmit() {},
    onCancelEdit() {},
    onStartEdit() {},
    onAskDelete() {},
    onDelete() {},
    onCancelDelete() {},
  }))
  assert.match(markup, /正在编辑 11月3日[^的]*的支出：¥25\.5/)
  assert.match(markup, /<button type="submit"[^>]*>保存<\/button>/)
  assert.match(markup, /aria-label="编辑 餐饮 -200\.00"/)
  assert.match(markup, /aria-label="删除 餐饮 -200\.00"/)
})

await check('monthDays fills every day of the month', () => {
  const days = internals.monthDays(sample, 2026, 11)
  assert.equal(days.length, 30)
  assert.deepEqual(days[0], {
    date: '2026-11-01', day: 1, weekday: 6, income: 800000, expense: 0, net: 800000, count: 1,
  })
  assert.deepEqual(days[4], {
    date: '2026-11-05', day: 5, weekday: 3, income: 0, expense: 30050, net: -30050, count: 2,
  })
  assert.deepEqual(days[1], {
    date: '2026-11-02', day: 2, weekday: 0, income: 0, expense: 0, net: 0, count: 0,
  })
  assert.equal(internals.monthDays(sample, 2026, 11).filter(day => day.count > 0).length, 3)
  assert.equal(internals.monthDays(sample, 2028, 2).length, 29, '闰年二月 29 天')
  assert.equal(internals.monthDays([], 2026, 12).length, 31)
})

await check('daily breakdown draws one column per day and lists days with entries', () => {
  const markup = renderToStaticMarkup(h(internals.DailyBreakdown, {
    t: translator(internals.zh),
    days: internals.monthDays(sample, 2026, 11),
    selected: '2026-11-05',
    today: '2026-11-20',
    onPick() {},
  }))
  assert.equal((markup.match(/class="bal-daycol"/g) ?? []).length, 30)
  assert.equal((markup.match(/class="bal-dailyrow"/g) ?? []).length, 3)
  assert.match(markup, /本月逐日/)
  assert.match(markup, /本月每天收支图：3 天有账目/)
  assert.match(markup, /aria-label="11月5日[^"]*，支出 ¥300\.50 · 收入 ¥0\.00，2 笔"/)
  assert.match(markup, /title="11月5日[^"]*· 支出 ¥300\.50 · 收入 ¥0\.00"/)
  assert.equal((markup.match(/data-selected=""/g) ?? []).length, 2, '柱子与清单行同时高亮')
  assert.match(markup, /height:0%/, '没有账目的日子柱高为 0')
  assert.match(markup, />15</, '刻度每 5 天标一次')
  assert.match(markup, />30</)

  const empty = renderToStaticMarkup(h(internals.DailyBreakdown, {
    t: translator(internals.zh), days: internals.monthDays([], 2026, 12), selected: '', today: '', onPick() {},
  }))
  assert.match(empty, /本月还没有账目/)
  assert.equal((empty.match(/class="bal-dailyrow"/g) ?? []).length, 0)
})

await check('primary button and text colors follow the host theme tokens', () => {
  const markup = renderToStaticMarkup(h(internals.BalanceOpenButton, { t: translator(internals.zh), open() {} }))
  const css = markup.match(/<style>([\s\S]*?)<\/style>/)[1]
  assert.match(css, /\.bal-primary\{[^}]*color:var\(--dsw-alias-label-primary-foreground\)/)
  assert.ok(!css.includes('--dsw-alias-label-on-color'), '主按钮前景要用 label-primary-foreground（暗色下 on-color 是白字压白底）')
  assert.ok(!/\.bal-amt\[data-kind/.test(css), '日历金额不再用状态色当文字色')
  assert.ok(!/\.bal-entry-amt\[data-kind/.test(css))
  assert.match(css, /\.bal-link\{[^}]*min-height:24px/)
  assert.match(css, /@container \(min-width: 720px\)/)
})

console.log(`\n${passed} checks passed`)
