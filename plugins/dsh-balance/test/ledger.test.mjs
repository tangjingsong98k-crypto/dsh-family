/**
 * 账本数据层自测：临时目录里建账本，跑增删改查、校验、并发、损坏文件、汇总和 RPC 错误形状。
 *
 * 运行：node test/ledger.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BalanceError, createLedger, handleRpc, internals } from '../index.js'

const { todayString, monthBounds, recentMonthList } = internals
const roots = []
let passed = 0

/**
 * 跑一条断言并计数。
 * @param {string} label - 用例名
 * @param {() => Promise<void>} body - 用例
 * @returns {Promise<void>} 完成
 */
async function check(label, body) {
  await body()
  passed += 1
  console.log(`  ok  ${label}`)
}

/**
 * 新开一个空账本（独立临时目录）。
 * @returns {Promise<{ root: string, ledger: object }>} 账本
 */
async function fresh() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-balance-test-'))
  roots.push(root)
  return { root, ledger: createLedger({ root }) }
}

/**
 * 断言一个账本错误。
 * @param {Promise<any>} promise - 待观察的调用
 * @param {string} code - 期望的错误码
 * @param {RegExp} [message] - 期望的错误文案
 * @returns {Promise<void>} 完成
 */
async function rejects(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof BalanceError, `应为 BalanceError，实际是 ${String(error)}`)
    assert.equal(error.code, code)
    if (message !== undefined) assert.match(error.message, message)
    return true
  })
}

console.log('dsh-balance / ledger')

try {
  // -------------------------------------------------------------------------
  // 读写基础
  // -------------------------------------------------------------------------

  await check('empty ledger reads as an empty year', async () => {
    const { root, ledger } = await fresh()
    const year = await ledger.loadYear(2026)
    assert.equal(year.year, 2026)
    assert.deepEqual(year.entries, [])
    assert.equal(year.today, todayString())
    assert.equal(year.file, path.join(root, 'ledger.json'))
    assert.deepEqual(year.defaults, internals.DEFAULT_CATEGORIES)
    assert.deepEqual(year.totals, { income: 0, expense: 0, net: 0 })
  })

  await check('create normalizes fields and writes the file', async () => {
    const { root, ledger } = await fresh()
    const entry = await ledger.save({ date: '2026-11-20', amount: 25.5, kind: 'expense', category: '  餐饮 ', note: ' 午饭 ' })
    assert.match(entry.id, /^b[0-9a-z]+$/)
    assert.equal(entry.date, '2026-11-20')
    assert.equal(entry.kind, 'expense')
    assert.equal(entry.amount, 25.5)
    assert.equal(entry.category, '餐饮')
    assert.equal(entry.note, '午饭')
    assert.equal(typeof entry.createdAt, 'string')
    assert.equal(entry.createdAt, entry.updatedAt)

    const text = await fs.readFile(path.join(root, 'ledger.json'), 'utf8')
    const parsed = JSON.parse(text)
    assert.equal(parsed.version, 1)
    assert.equal(parsed.entries.length, 1)
    assert.equal(parsed.entries[0].id, entry.id)

    const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8')
    assert.match(readme, /ledger\.json/)
  })

  await check('defaults: today, expense, empty category', async () => {
    const { ledger } = await fresh()
    const entry = await ledger.save({ amount: 9.9 })
    assert.equal(entry.date, todayString())
    assert.equal(entry.kind, 'expense')
    assert.equal(entry.category, '')
    assert.equal(entry.note, '')
  })

  await check('loadYear only returns that year, ascending', async () => {
    const { ledger } = await fresh()
    await ledger.save({ date: '2026-12-31', amount: 1 })
    await ledger.save({ date: '2026-01-02', amount: 2 })
    await ledger.save({ date: '2025-12-31', amount: 3 })
    const year = await ledger.loadYear(2026)
    assert.deepEqual(year.entries.map(entry => entry.date), ['2026-01-02', '2026-12-31'])
    assert.deepEqual(year.totals, { income: 0, expense: 3, net: -3 })
  })

  await check('update keeps the id, changes only given fields', async () => {
    const { ledger } = await fresh()
    const created = await ledger.save({ date: '2026-11-20', amount: 25.5, category: '餐饮', note: '午饭' })
    const updated = await ledger.save({ id: created.id, amount: 30 })
    assert.equal(updated.id, created.id)
    assert.equal(updated.amount, 30)
    assert.equal(updated.category, '餐饮')
    assert.equal(updated.note, '午饭')
    assert.equal(updated.date, '2026-11-20')
    const year = await ledger.loadYear(2026)
    assert.equal(year.entries.length, 1)
    assert.equal(year.entries[0].amount, 30)
  })

  await check('update of a missing id fails', async () => {
    const { ledger } = await fresh()
    await rejects(ledger.save({ id: 'nope', amount: 1 }), 'balance/not-found')
  })

  await check('remove deletes exactly one entry', async () => {
    const { ledger } = await fresh()
    const first = await ledger.save({ date: '2026-11-01', amount: 1 })
    const second = await ledger.save({ date: '2026-11-02', amount: 2 })
    const removed = await ledger.remove(first.id)
    assert.equal(removed.id, first.id)
    const year = await ledger.loadYear(2026)
    assert.deepEqual(year.entries.map(entry => entry.id), [second.id])
    await rejects(ledger.remove(first.id), 'balance/not-found')
  })

  // -------------------------------------------------------------------------
  // 校验
  // -------------------------------------------------------------------------

  await check('amount rules', async () => {
    const { ledger } = await fresh()
    await rejects(ledger.save({ amount: 0 }), 'balance/bad-amount')
    await rejects(ledger.save({ amount: -3 }), 'balance/bad-amount')
    await rejects(ledger.save({ amount: 'abc' }), 'balance/bad-amount')
    await rejects(ledger.save({ amount: 1e12 }), 'balance/bad-amount')
    const rounded = await ledger.save({ amount: '12.345' })
    assert.equal(rounded.amount, 12.35)
  })

  await check('date must exist on the calendar', async () => {
    const { ledger } = await fresh()
    await rejects(ledger.save({ amount: 1, date: '2026-02-30' }), 'balance/bad-date')
    await rejects(ledger.save({ amount: 1, date: '2026-13-01' }), 'balance/bad-date')
    await rejects(ledger.save({ amount: 1, date: '2026/11/20' }), 'balance/bad-date')
    const leap = await ledger.save({ amount: 1, date: '2028-02-29' })
    assert.equal(leap.date, '2028-02-29')
  })

  await check('kind aliases and rejection', async () => {
    const { ledger } = await fresh()
    assert.equal((await ledger.save({ amount: 1, kind: '收入' })).kind, 'income')
    assert.equal((await ledger.save({ amount: 1, kind: 'out' })).kind, 'expense')
    await rejects(ledger.save({ amount: 1, kind: 'gift' }), 'balance/bad-kind')
  })

  await check('text length limits', async () => {
    const { ledger } = await fresh()
    await rejects(ledger.save({ amount: 1, category: 'x'.repeat(internals.MAX_CATEGORY + 1) }), 'balance/bad-category')
    await rejects(ledger.save({ amount: 1, note: 'x'.repeat(internals.MAX_NOTE + 1) }), 'balance/bad-note')
    await rejects(ledger.save({ amount: 1, note: 42 }), 'balance/bad-note')
    const folded = await ledger.save({ amount: 1, note: '  两   个   空格  ' })
    assert.equal(folded.note, '两 个 空格')
  })

  // -------------------------------------------------------------------------
  // 并发与损坏
  // -------------------------------------------------------------------------

  await check('parallel saves all land', async () => {
    const { ledger } = await fresh()
    const created = await Promise.all(Array.from({ length: 12 }, (_, index) => ledger.save({
      date: '2026-12-01',
      amount: index + 1,
      note: `n${index}`,
    })))
    assert.equal(new Set(created.map(entry => entry.id)).size, 12)
    const year = await ledger.loadYear(2026)
    assert.equal(year.entries.length, 12)
    assert.equal(year.totals.expense, 78)
  })

  await check('invalid JSON fails loudly and leaves the file alone', async () => {
    const { root, ledger } = await fresh()
    const file = path.join(root, 'ledger.json')
    const broken = '{ "version": 1, "entries": [ '
    await fs.writeFile(file, broken, 'utf8')
    await rejects(ledger.loadYear(2026), 'balance/corrupt', /JSON/)
    assert.equal(await fs.readFile(file, 'utf8'), broken)
  })

  await check('a broken entry names its position', async () => {
    const { root, ledger } = await fresh()
    const file = path.join(root, 'ledger.json')
    await fs.writeFile(file, JSON.stringify({ version: 1, entries: [
      { id: 'a', date: '2026-11-01', kind: 'expense', amount: 1 },
      { date: '2026-11-02', kind: 'expense', amount: 2 },
    ] }), 'utf8')
    await rejects(ledger.loadYear(2026), 'balance/corrupt', /第 2 条/)
  })

  await check('a bare array ledger is accepted', async () => {
    const { root, ledger } = await fresh()
    await fs.writeFile(path.join(root, 'ledger.json'), JSON.stringify([
      { id: 'x1', date: '2026-11-01', kind: 'expense', amount: 3 },
    ]), 'utf8')
    const year = await ledger.loadYear(2026)
    assert.equal(year.entries.length, 1)
    assert.equal(year.entries[0].category, '')
    assert.equal(year.entries[0].createdAt, new Date(0).toISOString())
  })

  await check('hand edits are picked up on the next read', async () => {
    const { root, ledger } = await fresh()
    await ledger.save({ date: '2026-11-01', amount: 1 })
    const file = path.join(root, 'ledger.json')
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    parsed.entries[0].amount = 88
    await fs.writeFile(file, JSON.stringify(parsed), 'utf8')
    const year = await ledger.loadYear(2026)
    assert.equal(year.entries[0].amount, 88)
  })

  // -------------------------------------------------------------------------
  // 查询与汇总
  // -------------------------------------------------------------------------

  await check('list filters by range, kind and limit', async () => {
    const { ledger } = await fresh()
    await ledger.save({ date: '2026-11-01', kind: 'income', amount: 8000, category: '工资' })
    await ledger.save({ date: '2026-11-05', amount: 200, category: '餐饮' })
    await ledger.save({ date: '2026-11-06', amount: 50, category: '交通' })
    await ledger.save({ date: '2026-10-30', amount: 999, category: '购物' })

    const all = await ledger.list()
    assert.equal(all.count, 4)
    assert.deepEqual(all.totals, { income: 8000, expense: 1249, net: 6751 })
    assert.equal(all.entries[0].date, '2026-11-06', '新账在前')

    const november = await ledger.list({ from: '2026-11-01', to: '2026-11-30' })
    assert.equal(november.count, 3)
    assert.deepEqual(november.totals, { income: 8000, expense: 250, net: 7750 })

    const expenses = await ledger.list({ kind: 'expense' })
    assert.equal(expenses.count, 3)
    assert.ok(expenses.entries.every(entry => entry.kind === 'expense'))

    const limited = await ledger.list({ limit: 2 })
    assert.equal(limited.entries.length, 2)
    assert.equal(limited.count, 4, 'limit 只截明细，合计仍是全量')

    await rejects(ledger.list({ from: '2026-12-01', to: '2026-11-01' }), 'balance/bad-range')
    await rejects(ledger.list({ limit: 0 }), 'balance/bad-limit')
    await rejects(ledger.list({ from: '2026-02-30' }), 'balance/bad-date')
  })

  await check('summary groups by category and day, with six-month trend', async () => {
    const { ledger } = await fresh()
    await ledger.save({ date: '2026-11-01', kind: 'income', amount: 8000, category: '工资' })
    await ledger.save({ date: '2026-11-05', amount: 200, category: '餐饮' })
    await ledger.save({ date: '2026-11-05', amount: 100, category: '餐饮' })
    await ledger.save({ date: '2026-11-06', amount: 50, category: '交通' })
    await ledger.save({ date: '2026-10-30', amount: 999, category: '购物' })

    const summary = await ledger.summary({ month: '2026-11' })
    assert.equal(summary.month, '2026-11')
    assert.equal(summary.count, 4)
    assert.deepEqual(summary.totals, { income: 8000, expense: 350, net: 7650 })
    assert.deepEqual(summary.categories.map(row => [row.kind, row.category, row.amount, row.count]), [
      ['income', '工资', 8000, 1],
      ['expense', '餐饮', 300, 2],
      ['expense', '交通', 50, 1],
    ])
    assert.deepEqual(summary.days, [
      { date: '2026-11-01', income: 8000, expense: 0 },
      { date: '2026-11-05', income: 0, expense: 300 },
      { date: '2026-11-06', income: 0, expense: 50 },
    ])
    assert.deepEqual(summary.recent.map(row => row.month), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'])
    assert.deepEqual(summary.recent.at(-1), { month: '2026-11', income: 8000, expense: 350, net: 7650 })
    assert.equal(summary.recent[4].expense, 999)

    await rejects(ledger.summary({ month: '2026-13' }), 'balance/bad-month')
    await rejects(ledger.loadYear(1800), 'balance/bad-year')
  })

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------

  await check('RPC endpoints answer in the Connection envelope shape', async () => {
    const { ledger } = await fresh()
    const loaded = await handleRpc(ledger, 'load', { year: 2026 })
    assert.equal(loaded.ok, true)
    assert.deepEqual(loaded.value.entries, [])

    const saved = await handleRpc(ledger, 'save', { entry: { date: '2026-11-20', amount: 12 } })
    assert.equal(saved.ok, true)
    const id = saved.value.id
    assert.equal(id, saved.value.id)

    const removed = await handleRpc(ledger, 'remove', { id })
    assert.equal(removed.ok, true)
    assert.equal(removed.value.id, id)

    const summary = await handleRpc(ledger, 'summary', { month: '2026-11' })
    assert.equal(summary.ok, true)
    assert.equal(summary.value.count, 0)

    const info = await handleRpc(ledger, 'info', {})
    assert.equal(info.ok, true)
    assert.equal(typeof info.value.count, 'number')

    const unknown = await handleRpc(ledger, 'whatever', {})
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'balance/unknown-endpoint')

    const failure = await handleRpc(ledger, 'save', { entry: { amount: -1 } })
    assert.equal(failure.ok, false)
    assert.equal(failure.error.code, 'balance/bad-amount')
    assert.equal(typeof failure.error.message, 'string')
    assert.deepEqual(failure.error.details, {})
  })

  // -------------------------------------------------------------------------
  // 纯函数
  // -------------------------------------------------------------------------

  await check('date helpers', async () => {
    assert.equal(internals.isValidDate('2026-02-28'), true)
    assert.equal(internals.isValidDate('2026-02-29'), false)
    assert.equal(internals.isValidDate('2028-02-29'), true)
    assert.equal(internals.isValidDate('2026-2-28'), false)
    assert.deepEqual(monthBounds('2026-02'), { from: '2026-02-01', to: '2026-02-28' })
    assert.deepEqual(monthBounds('2028-02'), { from: '2028-02-01', to: '2028-02-29' })
    assert.deepEqual(recentMonthList('2026-02', 4), ['2025-11', '2025-12', '2026-01', '2026-02'])
    assert.equal(internals.requireKind('支出'), 'expense')
  })

  await check('totals are computed in cents', async () => {
    const totals = internals.totalsOf([
      { kind: 'expense', amount: 0.1 },
      { kind: 'expense', amount: 0.2 },
      { kind: 'income', amount: 1 },
    ])
    assert.deepEqual(totals, { income: 1, expense: 0.3, net: 0.7 })
  })
} finally {
  for (const root of roots) {
    // 只删自己刚建在系统临时目录里的测试账本。
    if (path.basename(root).startsWith('dsh-balance-test-') && root.startsWith(os.tmpdir())) {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
}

console.log(`\n${passed} checks passed`)
