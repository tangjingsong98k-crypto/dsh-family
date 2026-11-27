/**
 * 冲突处理：pull 变基失败时，先按「数据能合就合、代码别乱合」的原则自救。
 *
 * 规则（只碰数据文件）：
 *   data/balance/ledger.json  按 id 并集；同 id 取 updatedAt 更新的那条
 *   data/diet/diet.json       取 exportedAt 更新的那份；缺字段就当合不了
 *   data/stats/*              统计是派生物，取上游（rebase 的 ours，即 :2）
 *   status/**                 每台机器自己的回执，取上游
 *
 * 代码/配置（tools/、mirror.json、plugins/…）一律不自动合：rebase --abort，
 * 写 runtime/conflict.json，并把问题交给会话（见 triageConflict）。
 *
 * rebase 的语义容易记反：`:2` 是 upstream（新的基底，git 叫 ours），`:3` 是你正在
 * 重放的那个提交（git 叫 theirs）。所以「以上游为准」= 取 `:2`。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { PATHS, ensureDirs, git, isoNow, log, readText, writeJson, writeText } from './common.mjs'

/** 自动合并规则。 */
const RULES = [
  { match: file => file === 'data/balance/ledger.json', kind: 'ledger' },
  { match: file => file === 'data/diet/diet.json', kind: 'diet' },
  { match: file => file.startsWith('data/stats/'), kind: 'upstream' },
  { match: file => file.startsWith('status/'), kind: 'upstream' },
]

/**
 * 取 rebase 里某一侧的版本。
 * @param {number} stage - 2=upstream，3=本地提交
 * @param {string} file - 仓库相对路径
 * @returns {Promise<string>} 内容（不存在为空串）
 */
async function side(stage, file, cwd) {
  const result = await git(['show', `:${stage}:${file}`], { cwd })
  return result.code === 0 ? result.stdout : ''
}

/**
 * 合并两个账本：按 id 并集，同 id 取 updatedAt 更新的。
 * @param {string} upstreamText - upstream 侧
 * @param {string} localText - 本地提交侧
 * @returns {object | null} 合并结果；解析不了返回 null
 */
export function mergeLedgers(upstreamText, localText) {
  const parse = (text) => {
    try {
      const doc = JSON.parse(text)
      return doc !== null && typeof doc === 'object' && Array.isArray(doc.entries) ? doc : null
    } catch {
      return null
    }
  }
  const left = parse(upstreamText)
  const right = parse(localText)
  if (left === null || right === null) return null
  const map = new Map()
  for (const entry of [...left.entries, ...right.entries]) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') return null
    const previous = map.get(entry.id)
    if (previous === undefined) {
      map.set(entry.id, entry)
      continue
    }
    const before = Date.parse(previous.updatedAt ?? previous.createdAt ?? '') || 0
    const after = Date.parse(entry.updatedAt ?? entry.createdAt ?? '') || 0
    if (after > before) map.set(entry.id, entry)
  }
  const entries = [...map.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))
    || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
  return { version: 1, updatedAt: new Date().toISOString(), entries }
}

/**
 * 合并饮食快照：取 exportedAt 更新的那份；时间相同取并集里更完整的。
 * @param {string} upstreamText - upstream 侧
 * @param {string} localText - 本地提交侧
 * @returns {object | null} 结果；合不了返回 null
 */
export function mergeDiet(upstreamText, localText) {
  const parse = (text) => {
    try {
      const doc = JSON.parse(text)
      return doc !== null && typeof doc === 'object' && doc.users !== null && typeof doc.users === 'object' ? doc : null
    } catch {
      return null
    }
  }
  const left = parse(upstreamText)
  const right = parse(localText)
  if (left === null || right === null) return null
  const leftAt = Date.parse(left.exportedAt ?? '') || 0
  const rightAt = Date.parse(right.exportedAt ?? '') || 0
  if (leftAt === rightAt) {
    // 同一时刻：取人数/天数更多的那份（发布器是唯一写者，这种情形极少）。
    const size = doc => Object.keys(doc.users).length
    return size(right) > size(left) ? right : left
  }
  return rightAt > leftAt ? right : left
}

/**
 * 把当前未合并的文件都试着解掉。
 * @returns {Promise<{ resolved: string[], unresolved: string[], aborted: boolean, error: string }>} 结果
 */
async function healUnmerged(cwd) {
  const listed = await git(['diff', '--name-only', '--diff-filter=U'], { cwd })
  const files = listed.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const resolved = []
  const unresolved = []
  for (const file of files) {
    const rule = RULES.find(item => item.match(file))
    if (rule === undefined) {
      unresolved.push(file)
      continue
    }
    try {
      if (rule.kind === 'upstream') {
        const upstream = await side(2, file, cwd)
        if (upstream === '') {
          unresolved.push(file)
          continue
        }
        await writeText(path.join(cwd, file), upstream)
      } else if (rule.kind === 'ledger') {
        const merged = mergeLedgers(await side(2, file, cwd), await side(3, file, cwd))
        if (merged === null) {
          unresolved.push(file)
          continue
        }
        await writeText(path.join(cwd, file), `${JSON.stringify(merged, null, 2)}\n`)
      } else if (rule.kind === 'diet') {
        const merged = mergeDiet(await side(2, file, cwd), await side(3, file, cwd))
        if (merged === null) {
          unresolved.push(file)
          continue
        }
        await writeText(path.join(cwd, file), `${JSON.stringify(merged, null, 2)}\n`)
      }
      await git(['add', '--', file], { cwd })
      resolved.push(file)
    } catch {
      unresolved.push(file)
    }
  }
  return { resolved, unresolved, aborted: false, error: '' }
}

/**
 * 把冲突情况写出去（状态 + 报告）。
 * @param {object} report - `{ at, files, note, questions }`
 * @returns {Promise<void>} 完成
 */
async function writeReport(report) {
  await ensureDirs(PATHS.runtime)
  await writeJson(PATHS.conflictReport, report)
  await writeJson(path.join(PATHS.status, `${report.host ?? 'kit'}-conflict.json`), report)
}

/**
 * 拉一次；失败时按规则处理冲突。
 *
 * @param {object} options - `{ branch }`
 * @returns {Promise<{ ok: boolean, note: string, resolved: string[], unresolved: string[] }>} 结果
 */
export async function pullSafe({ branch, cwd = PATHS.kit }) {
  const pull = await git(['pull', '--rebase', '--autostash', 'origin', branch], { cwd, timeoutMs: 240000 })
  if (pull.code === 0) return { ok: true, note: '', resolved: [], unresolved: [] }

  const detail = (pull.stderr || pull.stdout).trim().split(/\r?\n/).slice(-3).join(' | ')
  const healed = await healUnmerged(cwd)
  if (healed.unresolved.length === 0) {
    // 全解掉了：继续变基。
    const cont = await git(['-c', 'core.editor=true', 'rebase', '--continue'], { cwd, timeoutMs: 120000 })
    if (cont.code === 0) {
      await log('conflict', `pull 冲突已自动解决：${healed.resolved.join(', ')}`)
      await writeReport({
        at: isoNow(),
        resolved: healed.resolved,
        files: [],
        note: 'pull 冲突已自动解决（数据文件按规则合并）',
      })
      return { ok: true, note: 'auto-resolved', resolved: healed.resolved, unresolved: [] }
    }
    // 继续失败：把 rebase 收掉，别留半截。
    await git(['rebase', '--abort'], { cwd })
    const files = (await git(['diff', '--name-only', '--diff-filter=U'], { cwd })).stdout
      .split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    await writeReport({ at: isoNow(), resolved: healed.resolved, files, note: `rebase --continue 失败：${(cont.stderr || '').slice(-300)}` })
    return { ok: false, note: 'rebase-continue-failed', resolved: healed.resolved, unresolved: files }
  }

  // 有代码/配置冲突：不猜，收起来交给会话/人。
  await git(['rebase', '--abort'], { cwd })
  await writeReport({
    at: isoNow(),
    resolved: healed.resolved,
    files: healed.unresolved,
    note: `无法自动合并：${detail}`,
  })
  await log('conflict', `pull 冲突需要人处理：${healed.unresolved.join(', ')}（${detail}）`)
  return { ok: false, note: 'conflict', resolved: healed.resolved, unresolved: healed.unresolved }
}

/**
 * 让一个 DSH 会话来初判冲突：能按事实解决的自己解决，涉及事实矛盾的写成问题。
 *
 * @param {object} options - `{ command }`：形如 `{ execPath, args }`，省略则不启动会话
 * @returns {Promise<{ ok: boolean, reply?: string, error?: string }>} 结果
 */
export async function triageConflict({ command } = {}) {
  const report = await readText(PATHS.conflictReport)
  if (report === '') return { ok: false, error: '没有冲突报告' }
  if (command === undefined || command === null) return { ok: false, error: '没有配置会话命令' }
  const prompt = [
    '你是运行在家人电脑套件上的排障会话。仓库 pull 变基出现了冲突，已执行 rebase --abort，工作区是干净的。',
    `仓库：${PATHS.kit}`,
    '冲突报告（JSON）：',
    report,
    '',
    '请你：',
    '1. 读冲突涉及的文件和 git log，先判断能不能按事实解决（例如同一笔账两边金额不同、同一人两处体重不同——那是事实矛盾）；',
    '2. 能确定事实的，直接改文件并 commit（说明依据）；',
    '3. 不能确定的，把问题写进 runtime/conflict-questions.md（一条一行，含文件与两种取值），不要猜、不要覆盖。',
    '4. 最后用一两句话说明你做了什么。',
  ].join('\n')
  const result = await spawnOnce(command, prompt)
  return result
}

/**
 * 跑一次会话命令，收回复。
 * @param {object} command - `{ execPath, args }`
 * @param {string} prompt - 提示词
 * @returns {Promise<{ ok: boolean, reply?: string, error?: string }>} 结果
 */
function spawnOnce(command, prompt) {
  return new Promise((resolve) => {
    // 延迟 require，避免把 child_process 拖进纯函数测试。
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(command.execPath, command.args, {
        cwd: PATHS.kit,
        env: { ...process.env, DSH_KIT_CONFLICT: '1' },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // 已经退了。
        }
        resolve({ ok: false, error: `会话超时：${err.slice(-300)}` })
      }, 180000)
      child.stdout.on('data', chunk => { out += chunk.toString('utf8') })
      child.stderr.on('data', chunk => { err += chunk.toString('utf8') })
      child.on('error', error => {
        clearTimeout(timer)
        resolve({ ok: false, error: error.message })
      })
      child.on('close', code => {
        clearTimeout(timer)
        resolve(code === 0 ? { ok: true, reply: out.trim() } : { ok: false, error: `${err.slice(-400)}` })
      })
      child.stdin.end(prompt)
    }, () => resolve({ ok: false, error: 'spawn unavailable' }))
  })
}
