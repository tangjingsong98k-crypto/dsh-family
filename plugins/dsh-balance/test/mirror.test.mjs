/**
 * 只读镜像自测：家人电脑那份「账本只读 + 饮食快照」的行为。
 *
 * 覆盖：快照的 day / month / year 三种查询与容器接口同形、快照缺文件时的错误、
 * 只读账本挡住 save/remove、只读饮食挡住写端点。
 *
 * 运行：node test/mirror.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BalanceError, createDietAccess, createLedger, handleRpc, internals } from '../index.js'

const { readDietSnapshot } = internals
const dirs = []
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
 * 新开一个临时目录。
 * @returns {Promise<string>} 目录
 */
async function scratch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-balance-mirror-'))
  dirs.push(dir)
  return dir
}

/**
 * 一份两天三餐的快照。
 * @returns {object} 快照文档
 */
function sampleSnapshot() {
  return {
    version: 1,
    exportedAt: '2026-11-26T10:00:00.000Z',
    users: {
      99132013: {
        qq: '99132013',
        target: 1800,
        profile: { goal: 'lose', weight_kg: 70 },
        days: {
          '2026-11-25': {
            meals: [
              { id: 1, qq: '99132013', day: '2026-11-25', meal_type: '早餐', clock: '08:10', kcal: 300, protein: 10, fat: 8, carb: 40, raw_text: '', note: '', items: [] },
              { id: 2, qq: '99132013', day: '2026-11-25', meal_type: '午餐', clock: '12:20', kcal: 700.5, protein: 30, fat: 25, carb: 80, raw_text: '', note: '', items: [] },
            ],
          },
          '2026-11-26': {
            meals: [
              { id: 3, qq: '99132013', day: '2026-11-26', meal_type: '早餐', clock: '07:50', kcal: 400, protein: 12, fat: 10, carb: 50, raw_text: '', note: '', items: [] },
            ],
          },
        },
      },
      1044949250: {
        qq: '1044949250',
        target: 2000,
        profile: { goal: 'maintain', weight_kg: 60 },
        days: {
          '2026-11-26': {
            meals: [
              { id: 9, qq: '1044949250', day: '2026-11-26', meal_type: '晚餐', clock: '18:30', kcal: 600, protein: 20, fat: 18, carb: 70, raw_text: '', note: '', items: [] },
            ],
          },
        },
      },
    },
  }
}

/**
 * 把快照写进临时目录。
 * @returns {Promise<string>} 快照路径
 */
async function writeSnapshot() {
  const dir = await scratch()
  const file = path.join(dir, 'diet.json')
  await fs.writeFile(file, JSON.stringify(sampleSnapshot()), 'utf8')
  return file
}

const root = await scratch()
const snapshotPath = await writeSnapshot()

await check('快照 day 与容器接口同形', async () => {
  const value = await readDietSnapshot(snapshotPath, '99132013', { cmd: 'day', day: '2026-11-25' })
  assert.equal(value.day, '2026-11-25')
  assert.equal(value.qq, '99132013')
  assert.equal(value.meals.length, 2)
  assert.equal(value.total.kcal, 1000.5)
  assert.equal(value.total.carb, 120)
  assert.equal(value.target, 1800)
  assert.deepEqual(value.profile, { goal: 'lose', weight_kg: 70 })
})

await check('快照 day 没记录的一天是空餐次', async () => {
  const value = await readDietSnapshot(snapshotPath, '99132013', { cmd: 'day', day: '2026-11-01' })
  assert.deepEqual(value.meals, [])
  assert.equal(value.total.kcal, 0)
})

await check('快照 month 按天汇总、算日均', async () => {
  const value = await readDietSnapshot(snapshotPath, '99132013', { cmd: 'month', year: 2026, month: 11 })
  assert.equal(value.days['2026-11-25'], 1000.5)
  assert.equal(value.days['2026-11-26'], 400)
  assert.equal(value.total, 1400.5)
  assert.equal(value.logged_days, 2)
  assert.equal(value.avg, 700.3)
  assert.equal(value.target, 1800)
})

await check('快照 month 只看选中的 QQ', async () => {
  const value = await readDietSnapshot(snapshotPath, '1044949250', { cmd: 'month', year: 2026, month: 11 })
  assert.equal(value.logged_days, 1)
  assert.equal(value.days['2026-11-26'], 600)
  assert.equal(value.target, 2000)
})

await check('快照 year 补齐 12 个月', async () => {
  const value = await readDietSnapshot(snapshotPath, '99132013', { cmd: 'year', year: 2026 })
  assert.equal(value.months.length, 12)
  assert.deepEqual(value.months[10], { month: 11, total: 1400.5, logged_days: 2, avg: 700.3 })
  assert.deepEqual(value.months[0], { month: 1, total: 0, logged_days: 0, avg: 0 })
})

await check('快照拒绝写命令', async () => {
  await assert.rejects(
    () => readDietSnapshot(snapshotPath, '99132013', { cmd: 'add_item', meal_id: 1, name: 'x', grams: 100 }),
    error => error instanceof BalanceError && error.code === 'balance/diet-readonly',
  )
})

await check('快照文件缺失时报出路径', async () => {
  const missing = path.join(await scratch(), 'nope.json')
  await assert.rejects(
    () => readDietSnapshot(missing, '99132013', { cmd: 'day', day: '2026-11-25' }),
    error => error instanceof BalanceError && error.code === 'balance/diet-snapshot' && error.message.includes(missing),
  )
})

await check('快照文件不是 JSON 时不死撑', async () => {
  const dir = await scratch()
  const bad = path.join(dir, 'bad.json')
  await fs.writeFile(bad, '{ nope', 'utf8')
  await assert.rejects(
    () => readDietSnapshot(bad, '99132013', { cmd: 'day', day: '2026-11-25' }),
    error => error instanceof BalanceError && error.code === 'balance/diet-snapshot',
  )
})

await check('dietSnapshot 配置切到快照模式，dietQq 选人', async () => {
  const diet = createDietAccess({ dietSnapshot: snapshotPath, dietQq: '1044949250' })
  assert.equal(diet.mode, 'snapshot')
  assert.equal(diet.readOnly, true)
  assert.equal(diet.qq, '1044949250')
  const value = await diet.call({ cmd: 'day', day: '2026-11-26' })
  assert.equal(value.target, 2000)
})

await check('没配 dietSnapshot 时仍是主电脑的 docker 源', async () => {
  const diet = createDietAccess({})
  assert.equal(diet.mode, 'docker')
  assert.equal(diet.readOnly, false)
  assert.equal(diet.qq, '99132013')
})

await check('只读账本挡住 save 和 remove', async () => {
  const ledger = createLedger({ root, readOnly: true })
  await assert.rejects(() => ledger.save({ date: '2026-11-26', kind: 'expense', amount: 1 }), error => error instanceof BalanceError && error.code === 'balance/readonly')
  await assert.rejects(() => ledger.remove('b1'), error => error instanceof BalanceError && error.code === 'balance/readonly')
})

await check('只读账本仍能读、能汇总', async () => {
  const writable = createLedger({ root: path.join(root, 'real') })
  await writable.save({ date: '2026-11-26', kind: 'expense', amount: 12.5, category: '餐饮', note: '午饭' })
  const mirror = createLedger({ root: path.join(root, 'real'), readOnly: true })
  const info = await mirror.info()
  assert.equal(info.count, 1)
  const summary = await mirror.summary({ month: '2026-11' })
  assert.equal(summary.totals.expense, 12.5)
})

await check('RPC 在只读镜像里回业务错误信封', async () => {
  const ledger = createLedger({ root, readOnly: true })
  const diet = createDietAccess({ dietSnapshot: snapshotPath, dietQq: '99132013' })
  const saved = await handleRpc(ledger, 'save', { amount: 5 }, diet)
  assert.equal(saved.ok, false)
  assert.equal(saved.error.code, 'balance/readonly')
  const added = await handleRpc(ledger, 'diet-add-item', { mealId: 1, name: '苹果', grams: 100 }, diet)
  assert.equal(added.ok, false)
  assert.equal(added.error.code, 'balance/diet-readonly')
  const loaded = await handleRpc(ledger, 'diet-load', { day: '2026-11-25' }, diet)
  assert.equal(loaded.ok, true)
  assert.equal(loaded.value.total.kcal, 1000.5)
})

await check('RPC 快照里 month/year 也能走通', async () => {
  const ledger = createLedger({ root, readOnly: true })
  const diet = createDietAccess({ dietSnapshot: snapshotPath, dietQq: '99132013' })
  const month = await handleRpc(ledger, 'diet-month', { year: 2026, month: 11 }, diet)
  assert.equal(month.ok, true)
  assert.equal(month.value.logged_days, 2)
  const year = await handleRpc(ledger, 'diet-year', { year: 2026 }, diet)
  assert.equal(year.ok, true)
  assert.equal(year.value.months.length, 12)
})

for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true })

console.log(`\n${passed} checks passed`)
