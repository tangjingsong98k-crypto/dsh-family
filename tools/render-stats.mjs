/**
 * 每台设备给自己渲染一份统计页（`data/stats/local.html`）。
 *
 * 为什么在设备本地渲染：`mirror.json` 里的 `dietQq` 只是仓库默认值，每台设备可以用
 * `config.local.json` 选自己看谁。如果统计页也由主电脑生成，那它就是「默认那个人」的；
 * 设备自己拿同一份快照 + 同一份账本算一遍，数字才对得上自己的面板。
 *
 * 产物不进仓库（`.gitignore` 里），所以不会和 `git pull` 打架。
 *
 * 用法：
 *   node tools/render-stats.mjs            # 按 config.local / mirror 的 dietQq
 *   node tools/render-stats.mjs --qq 123   # 指定看谁
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PATHS, loadLocalConfig, loadMirror, parseArgs, readJson, writeJson, writeText } from './common.mjs'
import { buildStats, renderHtml } from './stats.mjs'

/**
 * 渲染一份本地统计。
 * @param {object} [options] - `{ dietQq, ledgerFile, dietFile, outDir }`（测试用，可全给默认）
 * @returns {Promise<object>} buildStats 的结果
 */
export async function renderLocalStats(options = {}) {
  const {
    dietQq,
    ledgerFile = path.join(PATHS.data, 'balance', 'ledger.json'),
    dietFile = path.join(PATHS.data, 'diet', 'diet.json'),
    outDir = path.join(PATHS.data, 'stats'),
  } = options
  const ledger = await readJson(ledgerFile, { entries: [] })
  const diet = await readJson(dietFile, { users: {} })
  const stats = buildStats({ ledger, diet, dietQq: String(dietQq ?? '') })
  await writeJson(path.join(outDir, 'local.json'), stats)
  await writeText(path.join(outDir, 'local.html'), renderHtml(stats))
  return stats
}

/**
 * 这台设备该看谁：config.local 优先，其次 mirror 的默认值。
 * @returns {Promise<{ dietQq: string, name: string }>} 选择结果
 */
export async function localDietQq() {
  const local = await loadLocalConfig()
  if (typeof local.dietQq === 'string' && local.dietQq.trim() !== '') {
    return { dietQq: local.dietQq.trim(), name: '设备本地配置' }
  }
  const mirror = await loadMirror()
  return { dietQq: String(mirror.data.dietQq), name: '仓库默认' }
}

const isMain = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const { flags } = parseArgs(process.argv.slice(2))
  const picked = await localDietQq()
  const dietQq = typeof flags.qq === 'string' && flags.qq.trim() !== '' ? flags.qq.trim() : picked.dietQq
  const stats = await renderLocalStats({ dietQq })
  console.log(`统计页已生成：${path.join(PATHS.data, 'stats', 'local.html')}`)
  console.log(`看的是 QQ ${dietQq}（${typeof flags.qq === 'string' ? '命令行' : picked.name}）：`)
  console.log(`  今天支出 ¥${stats.ledger.today.expense}，本月支出 ¥${stats.ledger.month.expense}，`
    + `今日摄入 ${stats.diet.today.kcal} kcal（${stats.diet.hasData ? '有记录' : '还没有记录'}）`)
}
