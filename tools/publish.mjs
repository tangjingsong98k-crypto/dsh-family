/**
 * 主电脑上的发布器：把「账本 + 饮食快照 + 统计页 + 插件源码」写进套件仓库，
 * 提交并推送。家人电脑的 `agent.mjs` 每两分钟拉一次，于是他的 DSH 里看到的
 * 就是这里刚推上去的版本。
 *
 * 由计划任务每两分钟跑一次（`fam.mjs install-publish-task` 装）。
 * 单独跑：`node tools/publish.mjs`（`--no-git` 只写文件不提交）。
 *
 * 数据来源：
 *  - 账本：`publisher.json` 里的 `ledger`（默认 C:\custom\workzone\balance\ledger.json）；
 *  - 饮食：`docker exec astrbot python -` 跑 tools/diet-dump.py，只读 diet.db；
 *  - 插件：`publisher.json` 里的 `balancePlugin`（本地开发目录）。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  PATHS,
  ensureDirs,
  git,
  gitAvailable,
  isoNow,
  loadMirror,
  log,
  parseArgs,
  readJson,
  readText,
  resolveRemote,
  run,
  stamp,
  writeJson,
  writeText,
} from './common.mjs'
import { buildStats, renderHtml } from './stats.mjs'

/** 这台机器上的默认数据来源（publisher.json 可覆盖）。 */
const DEFAULT_PUBLISHER = {
  ledger: 'C:\\custom\\workzone\\balance\\ledger.json',
  balancePlugin: 'C:\\custom\\workzone\\playground\\dsh-balance',
  diet: {
    docker: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
    container: 'astrbot',
    pluginDir: '/AstrBot/data/plugins/astrbot_plugin_diet_log',
  },
}

/** 同步插件时跳过的目录。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.vscode'])

/**
 * 读发布器配置；没有就按这台机器的默认值落一份。
 * @returns {Promise<object>} 配置
 */
async function loadPublisher() {
  try {
    return await readJson(PATHS.publisher)
  } catch {
    await writeJson(PATHS.publisher, DEFAULT_PUBLISHER)
    return DEFAULT_PUBLISHER
  }
}

/**
 * 把一个目录同步到另一个目录：内容一样就不动（避免每两分钟改一次 mtime，
 * 家人那边看到「插件变了」就重启 DSH）；多出来的文件挪进 runtime/trash。
 *
 * @param {string} source - 源目录
 * @param {string} target - 目标目录
 * @returns {Promise<{ copied: number, same: number, moved: number }>} 结果
 */
async function syncTree(source, target) {
  let copied = 0
  let same = 0
  let moved = 0
  const trash = path.join(PATHS.runtime, 'trash', `plugins-${stamp().replace(/[: ]/g, '-')}`)

  /**
   * 递归同步一层。
   * @param {string} from - 源
   * @param {string} to - 目标
   * @returns {Promise<void>} 完成
   */
  async function walk(from, to) {
    await ensureDirs(to)
    const entries = await fs.readdir(from, { withFileTypes: true })
    const names = new Set()
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue
      names.add(entry.name)
      const sourcePath = path.join(from, entry.name)
      const targetPath = path.join(to, entry.name)
      if (entry.isDirectory()) {
        await walk(sourcePath, targetPath)
        continue
      }
      const content = await fs.readFile(sourcePath)
      let existing = null
      try {
        existing = await fs.readFile(targetPath)
      } catch {
        existing = null
      }
      if (existing !== null && existing.equals(content)) {
        same += 1
        continue
      }
      await fs.writeFile(targetPath, content)
      copied += 1
    }
    let current = []
    try {
      current = await fs.readdir(to, { withFileTypes: true })
    } catch {
      current = []
    }
    for (const entry of current) {
      if (names.has(entry.name)) continue
      const victim = path.join(to, entry.name)
      const destination = path.join(trash, path.relative(source, victim))
      await ensureDirs(path.dirname(destination))
      await fs.rename(victim, destination).catch(() => {})
      moved += 1
    }
  }

  await walk(source, target)
  return { copied, same, moved }
}

/**
 * 发布账本：校验后原样搬过去（字段一个不改，坏了就保留旧文件）。
 * @param {object} publisher - 配置
 * @returns {Promise<{ ok: boolean, count: number, error?: string }>} 结果
 */
async function publishLedger(publisher) {
  const file = path.join(PATHS.data, 'balance', 'ledger.json')
  try {
    const ledger = await readJson(publisher.ledger)
    if (ledger === null || typeof ledger !== 'object' || !Array.isArray(ledger.entries)) {
      return { ok: false, count: 0, error: '账本缺少 entries 数组，保留上一份' }
    }
    const payload = {
      version: 1,
      updatedAt: typeof ledger.updatedAt === 'string' ? ledger.updatedAt : isoNow(),
      entries: ledger.entries,
    }
    const before = await readText(file)
    const after = `${JSON.stringify(payload, null, 2)}\n`
    if (before !== after) await writeText(file, after)
    return { ok: true, count: ledger.entries.length }
  } catch (error) {
    return { ok: false, count: 0, error: `读账本失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 发布饮食快照：容器里跑 diet-dump.py，失败就保留上一份。
 * @param {object} publisher - 配置
 * @param {object} mirror - 套件清单（决定导出哪些人的记录）
 * @returns {Promise<{ ok: boolean, users: string[], error?: string }>} 结果
 */
async function publishDiet(publisher, mirror) {
  const file = path.join(PATHS.data, 'diet', 'diet.json')
  const script = await readText(path.join(PATHS.tools, 'diet-dump.py'))
  if (script === '') return { ok: false, users: [], error: 'tools/diet-dump.py 不见了' }
  const result = await run(publisher.diet.docker, [
    'exec', '-i', '-e', 'PYTHONIOENCODING=utf-8', '-w', publisher.diet.pluginDir, publisher.diet.container, 'python', '-',
  ], { input: script, timeoutMs: 180000 })
  const text = result.stdout.trim()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    payload = null
  }
  if (payload === null || payload.ok !== true || payload.snapshot === null || typeof payload.snapshot !== 'object') {
    const detail = (result.stderr || text || '').trim().split(/\r?\n/).slice(-3).join(' | ')
    return { ok: false, users: [], error: `导出失败：${detail || `docker exit ${result.code}`}` }
  }
  const snapshot = payload.snapshot
  // 只带 mirror.json 里点名的人（默认只有家人那位），不把主人的饮食记录也发过去。
  const wanted = Array.isArray(mirror.data.dietUsers) ? mirror.data.dietUsers.map(String) : []
  if (wanted.length > 0 && snapshot.users !== null && typeof snapshot.users === 'object') {
    for (const qq of Object.keys(snapshot.users)) {
      if (!wanted.includes(qq)) delete snapshot.users[qq]
    }
  }
  const users = Object.keys(snapshot.users ?? {})
  const previous = await readJson(file, null)
  if (previous !== null) {
    // 比内容不比时间：数据没变就不重写文件，否则仓库每两分钟多一个提交。
    const strip = value => JSON.stringify({ ...value, exportedAt: '' })
    if (strip(previous) === strip(snapshot)) return { ok: true, users }
  }
  const before = await readText(file)
  const after = `${JSON.stringify(snapshot, null, 2)}\n`
  if (before !== after) await writeText(file, after)
  return { ok: true, users }
}

/**
 * 提交并推送（没有远端/没有改动就跳过）。
 * @param {object} mirror - 配置
 * @param {string} message - 提交说明
 * @returns {Promise<string>} 结果说明
 */
async function commitAndPush(mirror, message) {
  if (!(await gitAvailable())) return '没有 git，跳过提交'
  const remote = await resolveRemote(mirror)
  if (remote === '') return '没有配置远端，只写了本地文件'
  await git(['add', '--', 'data', 'plugins'])
  const staged = (await git(['diff', '--cached', '--name-only'])).stdout.trim()
  if (staged === '') return '没有变化'
  const commit = await git(['-c', 'user.name=dsh-family-publisher', '-c', 'user.email=publisher@dsh-family', 'commit', '-m', message])
  if (commit.code !== 0) return `提交失败：${(commit.stderr || '').trim().split(/\r?\n/).slice(-2).join(' ')}`
  const push = await git(['push', 'origin', `HEAD:${mirror.git.branch}`], { timeoutMs: 180000 })
  if (push.code === 0) return '已提交并推送'
  await git(['pull', '--rebase', '--autostash', 'origin', mirror.git.branch], { timeoutMs: 180000 })
  const retry = await git(['push', 'origin', `HEAD:${mirror.git.branch}`], { timeoutMs: 180000 })
  return retry.code === 0 ? '已提交并推送（重试成功）' : `推送失败：${(retry.stderr || '').trim().split(/\r?\n/).slice(-2).join(' ')}`
}

/**
 * 发布一次。
 * @param {object} options - `{ noGit }`
 * @returns {Promise<object>} 摘要
 */
export async function publish({ noGit = false } = {}) {
  const mirror = await loadMirror()
  const publisher = await loadPublisher()
  await ensureDirs(PATHS.data, path.join(PATHS.data, 'balance'), path.join(PATHS.data, 'diet'), path.join(PATHS.data, 'stats'), PATHS.logs)

  const plugin = await syncTree(publisher.balancePlugin, path.join(PATHS.plugins, 'dsh-balance'))
  const ledger = await publishLedger(publisher)
  const diet = await publishDiet(publisher, mirror)

  const ledgerDoc = await readJson(path.join(PATHS.data, 'balance', 'ledger.json'), { entries: [] })
  const dietDoc = await readJson(path.join(PATHS.data, 'diet', 'diet.json'), { users: {} })
  const sourceHash = crypto.createHash('sha1')
    .update(JSON.stringify(ledgerDoc))
    .update(JSON.stringify(dietDoc))
    .digest('hex')
  const statsFile = path.join(PATHS.data, 'stats', 'latest.json')
  const previousStats = await readJson(statsFile, {})
  let stats = previousStats
  if (previousStats.sourceHash !== sourceHash) {
    stats = buildStats({ ledger: ledgerDoc, diet: dietDoc, dietQq: mirror.data.dietQq, sourceHash })
    await writeJson(statsFile, stats)
    await writeText(path.join(PATHS.data, 'stats', 'index.html'), renderHtml(stats))
  }

  const summary = {
    at: isoNow(),
    plugin,
    ledger,
    diet,
    stats: {
      today: stats.today,
      month: stats.month,
      ledgerMonthExpense: stats.ledger.month.expense,
      dietTodayKcal: stats.diet.today.kcal,
    },
  }
  if (ledger.ok === false) await log('publish', `账本没发出去：${ledger.error}`)
  if (diet.ok === false) await log('publish', `饮食没发出去：${diet.error}`)
  if (!noGit) {
    const gitNote = await commitAndPush(mirror, `data: ${stamp()} 账本 ${ledger.count} 笔 / 饮食 ${diet.users.length} 人`)
    summary.git = gitNote
    if (gitNote !== '没有变化' && gitNote !== '没有 git，跳过提交' && gitNote !== '没有配置远端，只写了本地文件') {
      await log('publish', gitNote)
    }
  }
  await writeJson(path.join(PATHS.logs, 'publish-last.json'), summary)
  return summary
}

// 直接运行
const isMain = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const { flags } = parseArgs(process.argv.slice(2))
  try {
    const summary = await publish({ noGit: flags['no-git'] === true })
    await log('publish', `发布完成：插件 ${summary.plugin.copied} 改/${summary.plugin.same} 同，`
      + `账本 ${summary.ledger.count} 笔，饮食 ${summary.diet.users.length} 人，`
      + `本月支出 ¥${summary.stats.ledgerMonthExpense}，今日摄入 ${summary.stats.dietTodayKcal} kcal`
      + (summary.git ? `，git：${summary.git}` : ''))
    if (summary.ledger.ok === false || summary.diet.ok === false) process.exit(1)
    process.exit(0)
  } catch (error) {
    await log('publish', `失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exit(1)
  }
}
