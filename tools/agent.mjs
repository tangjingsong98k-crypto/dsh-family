/**
 * 家人电脑的收敛代理：每两分钟跑一遍，跑完就退出（由计划任务反复拉起）。
 *
 * 一趟做六件事：
 *  1. 拉仓库（有远端时）——主电脑推上来的版本、插件、数据在这里落地；
 *  2. 应用 mirror.json（DSH 版本、profile 依赖、补丁层）；
 *  3. 进程没在跑就拉起来；刚改过东西就重启一次；
 *  4. 处理 `ops/` 里的远程指令（重启、体检、看日志、跑一条 PowerShell）；
 *  5. 写 `status/<主机名>.json`（版本、端口、数据时间、最近错误、日志尾巴）；
 *  6. 把状态提交并推回远端——主电脑 `fam.mjs status` 就是看这份文件。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PATHS,
  ensureDirs,
  git,
  gitAvailable,
  hostName,
  installedDshVersion,
  isoNow,
  loadMirror,
  log,
  parseArgs,
  readJson,
  readText,
  resolveRemote,
  run,
  sleep,
  stamp,
  writeJson,
} from './common.mjs'
import { apply } from './apply.mjs'
import { canaryCheck } from './canary.mjs'
import { serverStatus, startServer, stopServer } from './server.mjs'
import {
  enterSafeMode,
  hasLastGood,
  markNormal,
  readFailures,
  readHold,
  readSafety,
  restoreLastGood,
  saveLastGood,
  waitBoot,
  writeFailures,
  writeHold,
} from './safety.mjs'

/**
 * 确保 origin 指向配置里的远端。
 * @param {string} remote - 远端地址
 * @returns {Promise<void>} 完成
 */
async function ensureOrigin(remote) {
  const current = await git(['remote', 'get-url', 'origin'])
  if (current.code !== 0) {
    await git(['remote', 'add', 'origin', remote])
    return
  }
  if (current.stdout.trim() !== remote) await git(['remote', 'set-url', 'origin', remote])
}

/**
 * 拉一次仓库（失败不致命，用本地已有的内容继续）。
 * @param {object} mirror - 配置
 * @returns {Promise<string>} 结果说明
 */
async function syncRepo(mirror) {
  if (!(await gitAvailable())) return '没有 git，跳过同步'
  const remote = await resolveRemote(mirror)
  if (remote === '') return '没有配置远端，跳过同步'
  await ensureOrigin(remote)
  const before = (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim()
  const pull = await git(['pull', '--rebase', '--autostash', 'origin', mirror.git.branch], { timeoutMs: 180000 })
  if (pull.code !== 0) {
    const detail = (pull.stderr || pull.stdout).trim().split(/\r?\n/).slice(-3).join(' | ')
    return `拉取失败：${detail}`
  }
  const after = (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim()
  return before === after ? '已是最新' : `已更新 ${before} -> ${after}`
}

/**
 * 读日志文件的尾巴。
 * @param {string} file - 日志
 * @param {number} lines - 行数
 * @returns {Promise<string[]>} 行
 */
async function tail(file, lines) {
  const text = await readText(file)
  if (text === '') return []
  return text.trimEnd().split(/\r?\n/).slice(-lines)
}

/**
 * 跑一条远程指令。
 * @param {object} op - `{ action, args }`
 * @param {object} mirror - 配置
 * @returns {Promise<object>} 结果
 */
async function runOp(op, mirror) {
  const action = typeof op.action === 'string' ? op.action : ''
  const args = op.args !== null && typeof op.args === 'object' ? op.args : {}
  const port = Number(mirror.dsh.port)
  switch (action) {
    case 'restart': {
      const stopped = await stopServer(port)
      await sleep(1500)
      const started = await startServer(mirror, { force: true })
      return { ok: true, stopped, started }
    }
    case 'canary': {
      const result = await canaryCheck(mirror)
      return { ok: result.ok === true, result }
    }
    case 'safe-mode': {
      const on = args.on === true
      if (on) {
        await enterSafeMode({ profileName: mirror.profile.name })
      } else {
        await markNormal()
        await writeHold({ cleared: true, at: isoNow() })
      }
      await stopServer(port)
      await sleep(1200)
      if (!on) await apply({ force: true })
      const started = await startServer(mirror, { force: true })
      return { ok: true, safeMode: on, url: started.url }
    }
    case 'rollback': {
      const probe = await apply({ check: true })
      const restored = await restoreLastGood({ profileName: mirror.profile.name })
      if (!restored.ok) return { ok: false, error: restored.reason ?? '没有可回滚的快照' }
      await writeHold({
        fingerprint: probe.fingerprint ?? '',
        at: isoNow(),
        reason: '主电脑人工回滚',
      })
      await stopServer(port)
      await sleep(1200)
      const started = await startServer(mirror, { force: true })
      const up = await waitBoot(port, Number(mirror.safety?.bootTimeoutSec) || 75)
      return { ok: up, version: restored.version, url: started.url, booted: up }
    }
    case 'apply': {
      const result = await apply()
      return { ok: true, result }
    }
    case 'diagnose': {
      const status = await serverStatus(port)
      const npm = await run(process.execPath, [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), '--version'], { timeoutMs: 30000 })
      return {
        ok: true,
        node: process.version,
        npm: (npm.stdout || '').trim(),
        dsh: await installedDshVersion(),
        running: status.running,
        http: status.http,
        pids: status.pids,
        url: status.url,
        version: await git(['describe', '--tags', '--always']).then(result => result.stdout.trim()),
        mirror: { version: mirror.dsh.version, port, plugins: mirror.plugins.filter(plugin => plugin.enabled === true).map(plugin => plugin.name) },
      }
    }
    case 'logs': {
      const lines = Number(args.lines) > 0 ? Math.min(Number(args.lines), 200) : 60
      return {
        ok: true,
        agent: await tail(path.join(PATHS.logs, 'agent.log'), lines),
        apply: await tail(path.join(PATHS.logs, 'apply.log'), Math.min(lines, 80)),
      }
    }
    case 'shell': {
      const command = typeof args.command === 'string' ? args.command : ''
      if (command.trim() === '') return { ok: false, error: 'shell 需要 args.command' }
      const result = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { timeoutMs: 120000 })
      const clip = text => text.length > 8000 ? `${text.slice(0, 8000)}\n…(截断)` : text
      return { ok: result.code === 0, code: result.code, stdout: clip(result.stdout), stderr: clip(result.stderr) }
    }
    default:
      return { ok: false, error: `不认识的指令：${action}` }
  }
}

/**
 * 处理 `ops/` 里排队的指令。
 * @param {object} mirror - 配置
 * @returns {Promise<Array<object>>} 结果列表
 */
async function drainOps(mirror) {
  const results = []
  let entries = []
  try {
    entries = (await fs.readdir(PATHS.ops, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
  } catch {
    return results
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  await ensureDirs(path.join(PATHS.ops, 'done'), path.join(PATHS.status, 'ops'))
  for (const entry of entries) {
    const file = path.join(PATHS.ops, entry.name)
    let op = {}
    try {
      op = await readJson(file)
    } catch (error) {
      results.push({ id: entry.name, ok: false, error: `指令不是合法 JSON：${error.message}` })
      await fs.rename(file, path.join(PATHS.ops, 'done', entry.name)).catch(() => {})
      continue
    }
    const id = path.basename(entry.name, '.json')
    // 一台机器可能同时有好几台在读同一个仓库：指令带 target 的只让目标机器执行，
    // 不带的（或 target=*）谁都执行；不是给自己的就留在队列里，等目标机器来取。
    const target = typeof op.target === 'string' ? op.target.trim() : ''
    const self = hostName()
    if (target !== '' && target !== '*' && target.toLowerCase() !== self.toLowerCase()) {
      results.push({ id, action: op.action, skipped: true, target })
      continue
    }
    await log('agent', `执行远程指令 ${id}：${op.action}`)
    const result = await runOp(op, mirror).catch(error => ({ ok: false, error: String(error) }))
    const record = { id, action: op.action, ranAt: isoNow(), ...result }
    await writeJson(path.join(PATHS.status, 'ops', `${id}.json`), record)
    await fs.rename(file, path.join(PATHS.ops, 'done', entry.name)).catch(() => {})
    results.push(record)
  }
  return results
}

/**
 * 统计账本与饮食数据的规模（状态里给主电脑看个大概）。
 * @returns {Promise<object>} 摘要
 */
async function dataSummary() {
  const ledger = await readJson(path.join(PATHS.data, 'balance', 'ledger.json'), { entries: [] })
  const diet = await readJson(path.join(PATHS.data, 'diet', 'diet.json'), { users: {} })
  const stats = await readJson(path.join(PATHS.data, 'stats', 'latest.json'), {})
  const users = diet.users !== null && typeof diet.users === 'object' ? Object.keys(diet.users) : []
  return {
    ledgerCount: Array.isArray(ledger.entries) ? ledger.entries.length : 0,
    dietUsers: users,
    stats: {
      generatedAt: typeof stats.generatedAt === 'string' ? stats.generatedAt : '',
      month: typeof stats.month === 'string' ? stats.month : '',
      todayExpense: typeof stats.today?.expense === 'number' ? stats.today.expense : 0,
      monthExpense: typeof stats.monthTotals?.expense === 'number' ? stats.monthTotals.expense : 0,
    },
  }
}

/**
 * 主流程。
 * @param {object} options - `{ quiet }`
 * @returns {Promise<object>} 状态
 */
export async function once({ quiet = false } = {}) {
  await ensureDirs(PATHS.logs, PATHS.status, PATHS.ops, PATHS.data, PATHS.work)
  const mirror = await loadMirror()
  const port = Number(mirror.dsh.port)
  const errors = []

  const syncNote = await syncRepo(mirror)
  if (!quiet || syncNote.startsWith('拉取失败')) await log('agent', `仓库：${syncNote}`)

  let applied = { changed: false, versionChanged: false, reasons: [] }
  let plan = { changed: false }
  try {
    plan = await apply({ check: true })
  } catch (error) {
    errors.push(`plan: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 先把要装的东西装进独立实例试一次；通过了才动正在跑的那份。
  let canary = null
  if (plan.changed === true && plan.held !== true && plan.safeMode !== true && mirror.canary?.enabled !== false) {
    canary = await canaryCheck(mirror).catch(error => ({
      ok: false,
      stage: 'canary',
      error: error instanceof Error ? error.message : String(error),
    }))
    if (canary.ok !== true) {
      await writeHold({
        fingerprint: plan.fingerprint ?? '',
        at: isoNow(),
        reason: `金丝雀失败：${canary.error || canary.stage}`,
      })
      errors.push(`金丝雀失败，未应用到本机：${canary.error || canary.stage}`)
      await log('agent', `金丝雀失败，保持现状：${canary.error || canary.stage}`)
    } else {
      await log('agent', `金丝雀通过（DSH ${canary.version}，${canary.ms}ms），开始应用`)
    }
  }

  if (canary === null || canary.ok === true) {
    try {
      applied = await apply()
      if (applied.changed) await log('agent', `应用配置：${applied.reasons.join('；')}`)
    } catch (error) {
      errors.push(`apply: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  let restarted = false
  let recovered = ''
  let rolledBack = false
  let bootFailures = (await readFailures()).count
  const before = await serverStatus(port)
  if (applied.changed || !before.running || !before.ours) {
    const started = await startServer(mirror, { force: before.running && applied.changed })
    restarted = started.started
    const timeout = Number(mirror.safety?.bootTimeoutSec) || 75
    const up = await waitBoot(port, timeout)
    if (up) {
      bootFailures = 0
      await writeFailures(0)
      await saveLastGood({ profileName: mirror.profile.name })
      if (started.url === '') errors.push('服务器没有给出登录链接')
    } else {
      bootFailures += 1
      await writeFailures(bootFailures)
      await log('agent', `启动失败（第 ${bootFailures} 次），开始自救`)
      const restored = await restoreLastGood({ profileName: mirror.profile.name })
      if (restored.ok) {
        await stopServer(port)
        await startServer(mirror, { force: true })
        if (await waitBoot(port, timeout)) {
          await writeHold({
            fingerprint: applied.fingerprint ?? '',
            at: isoNow(),
            reason: '启动失败，已回滚到上次好使的配置',
          })
          rolledBack = true
          recovered = `已回滚到 ${restored.version || '上次好使的配置'}`
        }
      }
      if (recovered === '') {
        const safeOk = await enterSafeMode({ profileName: mirror.profile.name })
        if (safeOk) {
          await stopServer(port)
          await startServer(mirror, { force: true })
          if (await waitBoot(port, timeout)) recovered = '已进入安全模式'
        }
      }
      if (recovered === '') errors.push('启动失败，回滚与安全模式都没能起来')
      else await log('agent', recovered)
    }
    await log('agent', recovered !== '' ? recovered : (restarted ? 'DSH 已启动/重启' : 'DSH 已在运行'))
  } else if (!(await hasLastGood())) {
    // 一直在跑但从没存过快照（老机器升级上来的）：补一张，回滚才有得用。
    await saveLastGood({ profileName: mirror.profile.name })
  }

  const ops = await drainOps(mirror)
  const after = await serverStatus(port)
  if (!rolledBack && after.running && bootFailures > 0) {
    // 这一轮没出事、服务也确实在跑：把历史失败计数清掉。
    bootFailures = 0
    await writeFailures(0)
  }
  const version = await installedDshVersion()
  const data = await dataSummary()
  const state = await readJson(PATHS.state, {})
  const safety = await readSafety()
  const holdNow = await readHold()
  const canaryLast = await readJson(PATHS.canaryResult, null)
  const commit = (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim()
  const dirty = (await git(['status', '--porcelain'])).stdout.trim() !== ''

  const status = {
    host: hostName(),
    checkedAt: isoNow(),
    dshVersion: version,
    mirrorVersion: mirror.dsh.version,
    port,
    running: after.running,
    http: after.http,
    pids: after.pids,
    url: after.url,
    appliedAt: (await readJson(PATHS.state, {})).appliedAt ?? '',
    dietQq: typeof state.dietQq === 'string' ? state.dietQq : '',
    applied: applied.reasons,
    held: rolledBack || (holdNow !== null && holdNow.cleared !== true),
    safeMode: safety.mode === 'safe',
    bootFailures,
    lastGoodAt: typeof safety.lastGoodAt === 'string' ? safety.lastGoodAt : '',
    canary: canaryLast === null ? null : {
      ok: canaryLast.ok === true,
      version: canaryLast.version ?? '',
      at: canaryLast.at ?? '',
      stage: canaryLast.stage ?? '',
      error: canaryLast.error ?? '',
    },
    recovered,
    restarted,
    ops: ops.map(op => ({ id: op.id, action: op.action, ok: op.ok === true })),
    data,
    repo: { commit, dirty, sync: syncNote },
    errors,
    logTail: await tail(path.join(PATHS.logs, 'agent.log'), Number(mirror.agent?.keepLogLines) || 40),
  }
  const statusFile = path.join(PATHS.status, `${status.host}.json`)
  const previous = await readJson(statusFile, null)
  /**
   * 只比较「有信息量」的字段：`checkedAt` 每轮都变，日志尾巴也一直在长，
   * 拿它们做比较会让仓库每两分钟多一个提交。
   * @param {object} value - 状态
   * @returns {string} 指纹
   */
  const fingerprint = value => JSON.stringify({
    ...value,
    checkedAt: '',
    logTail: [],
    ops: (value.ops ?? []).slice(-5),
  })
  const metaFile = path.join(PATHS.runtime, 'status-meta.json')
  const meta = await readJson(metaFile, {})
  const lastCommitAt = Date.parse(typeof meta.committedAt === 'string' ? meta.committedAt : '')
  const heartbeatDue = Number.isNaN(lastCommitAt) || (Date.now() - lastCommitAt) > 30 * 60 * 1000
  const shouldPublish = previous === null || fingerprint(previous) !== fingerprint(status) || heartbeatDue

  if (shouldPublish) {
    await writeJson(statusFile, status)
    await writeJson(metaFile, { committedAt: isoNow() })
  } else {
    // 内容没变就不写：文件保持上次提交的版本，仓库不会每两分钟抖一下。
    return status
  }

  // 状态回写：只有配了远端才提交推送。
  const remote = await resolveRemote(mirror)
  if (remote !== '' && (await gitAvailable())) {
    await git(['add', '--', 'status'])
    // 指令执行完会从 ops/ 挪进 ops/done/，这个移动也要提交，否则工作区一直是脏的。
    await git(['add', '--', 'ops'])
    const staged = await git(['diff', '--cached', '--name-only'])
    if (staged.stdout.trim() !== '') {
      await git(['-c', 'user.name=dsh-family-agent', '-c', 'user.email=agent@dsh-family', 'commit', '-m', `status: ${status.host} ${stamp()}`])
      const push = await git(['push', 'origin', `HEAD:${mirror.git.branch}`], { timeoutMs: 120000 })
      if (push.code !== 0) {
        await git(['pull', '--rebase', '--autostash', 'origin', mirror.git.branch], { timeoutMs: 120000 })
        const retry = await git(['push', 'origin', `HEAD:${mirror.git.branch}`], { timeoutMs: 120000 })
        if (retry.code !== 0) await log('agent', `状态推送失败：${(retry.stderr || '').split(/\r?\n/).slice(-2).join(' ')}`)
      }
    }
  }

  return status
}

// 直接运行
const isMain = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const { flags } = parseArgs(process.argv.slice(2))
  const loop = flags.loop === true
  const quiet = flags.quiet === true
  do {
    try {
      const status = await once({ quiet })
      if (!quiet) {
        await log('agent', `检查完成：DSH ${status.dshVersion}，${status.running ? '在运行' : '没起来'}，`
          + `账本 ${status.data.ledgerCount} 笔，数据 ${status.data.stats.generatedAt || '(还没同步过)'}`)
      }
      if (status.errors.length > 0) await log('agent', `有错误：${status.errors.join('；')}`)
    } catch (error) {
      await log('agent', `本轮失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }
    if (loop) await sleep(120000)
  } while (loop)
}
