/**
 * 主电脑上的远程运维台：改版本、开关插件、发指令、看家人电脑的状态。
 *
 * 所有动作都走同一条链路：改文件 -> 提交推送 -> 家人电脑两分钟内拉取执行 ->
 * 结果写回 `status/`。没有穿透、没有公网端口，能推这个私有仓库就等于能运维。
 *
 * 常用：
 *   node tools/fam.mjs status                 # 家人电脑现在什么版本、在不在跑、数据多新
 *   node tools/fam.mjs version 0.2.2-rc.5     # 远程升级 DSH（改 mirror.json 并推送）
 *   node tools/fam.mjs plugin dshmarket on    # 远程开关插件
 *   node tools/fam.mjs restart                # 远程重启（排队，等它两分钟内执行）
 *   node tools/fam.mjs logs --lines 80        # 远程取日志（等结果）
 *   node tools/fam.mjs shell "Get-Process node"  # 远程跑一条 PowerShell
 *   node tools/fam.mjs data                   # 立刻发布一次账本/饮食/统计
 *   node tools/fam.mjs pack                   # 打包给家人电脑首次安装
 *   node tools/fam.mjs remote <git-url>       # 绑定远端仓库
 *   node tools/fam.mjs install-publish-task   # 本机装「每两分钟发布」的计划任务
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PATHS,
  ensureDirs,
  git,
  gitAvailable,
  isoNow,
  loadLocalConfig,
  loadMirror,
  log,
  parseArgs,
  readJson,
  readText,
  resolveRemote,
  run,
  sleep,
  stamp,
  winPath,
  writeJson,
  writeText,
} from './common.mjs'
import { publish } from './publish.mjs'
import { createTask, installTasks, taskStatus } from './tasks.mjs'

/**
 * 拉一次远端（失败只提示，不中断）。
 * @returns {Promise<string>} 说明
 */
async function pull() {
  if (!(await gitAvailable())) return '没有 git'
  const mirror = await loadMirror()
  const remote = await resolveRemote(mirror)
  if (remote === '') return '没有远端'
  const result = await git(['pull', '--rebase', '--autostash', 'origin', mirror.git.branch], { timeoutMs: 120000 })
  return result.code === 0 ? '已拉取' : `拉取失败：${(result.stderr || '').trim().split(/\r?\n/).slice(-2).join(' ')}`
}

/**
 * 提交并推送（只提交给定路径）。
 * @param {string[]} paths - 路径
 * @param {string} message - 说明
 * @returns {Promise<string>} 结果
 */
async function commitPush(paths, message) {
  const mirror = await loadMirror()
  const remote = await resolveRemote(mirror)
  if (remote === '') {
    await log('fam', '还没绑远端：先跑 `fam.mjs remote <git-url>`，否则改动只在本地')
    return '没有远端'
  }
  await git(['add', '--', ...paths])
  const staged = (await git(['diff', '--cached', '--name-only'])).stdout.trim()
  if (staged === '') return '没有变化'
  await git(['-c', 'user.name=dsh-family-admin', '-c', 'user.email=admin@dsh-family', 'commit', '-m', message])
  const push = await git(['push', 'origin', `HEAD:${mirror.git.branch}`], { timeoutMs: 120000 })
  if (push.code === 0) return `已推送：${message}`
  await git(['pull', '--rebase', '--autostash', 'origin', mirror.git.branch], { timeoutMs: 120000 })
  const retry = await git(['push', 'origin', `HEAD:${mirror.git.branch}`], { timeoutMs: 120000 })
  return retry.code === 0 ? `已推送（重试）：${message}` : `推送失败：${(retry.stderr || '').trim().split(/\r?\n/).slice(-1)[0]}`
}

/**
 * 排一条远程指令，等结果（最多等四分钟，两分钟一轮的代理通常一轮就执行）。
 * @param {string} action - 指令
 * @param {object} args - 参数
 * @param {object} options - `{ wait }`
 * @returns {Promise<object>} 结果
 */
async function enqueue(action, args, { wait = true } = {}) {
  const id = `${stamp().replace(/[-: ]/g, '')}-${Math.random().toString(36).slice(2, 6)}`
  await ensureDirs(PATHS.ops)
  await writeJson(path.join(PATHS.ops, `${id}.json`), { id, action, args, createdAt: isoNow() })
  const pushNote = await commitPush(['ops'], `ops: ${action} ${id}`)
  console.log(`已排队 ${action}（${id}）${pushNote}`)
  if (!wait) return { id, pushed: pushNote }
  const deadline = Date.now() + 240000
  let pulled = 0
  while (Date.now() < deadline) {
    await sleep(10000)
    await pull()
    pulled += 1
    const resultFile = path.join(PATHS.status, 'ops', `${id}.json`)
    const result = await readJson(resultFile, null)
    if (result !== null) return result
    if (pulled % 6 === 0) console.log(`还在等家人电脑执行…（已等 ${Math.round((Date.now() - (deadline - 240000)) / 1000)} 秒）`)
  }
  console.log('等超时了：指令还在 ops/ 里排队，家人电脑开机后第一轮会执行。')
  return { id, timeout: true }
}

/**
 * 打印远程状态。
 * @returns {Promise<void>} 完成
 */
async function showStatus() {
  const pullNote = await pull()
  console.log(`仓库：${pullNote}`)
  let files = []
  try {
    files = (await fs.readdir(PATHS.status)).filter(name => name.endsWith('.json'))
  } catch {
    files = []
  }
  if (files.length === 0) {
    console.log('还没有任何家人电脑上报状态（status/ 是空的）。')
    return
  }
  for (const name of files) {
    const status = await readJson(path.join(PATHS.status, name), {})
    console.log('')
    console.log(`== ${status.host ?? name} ==`)
    console.log(`  检查时间   ${status.checkedAt ?? '(无)'}`)
    console.log(`  DSH 版本   ${status.dshVersion ?? '?'}（清单要求 ${status.mirrorVersion ?? '?'}）`)
    console.log(`  运行状态   ${status.running ? '在跑' : '没起来'}${status.http ? `，HTTP ${status.http}` : ''}${status.pids?.length ? `，pid ${status.pids.join(',')}` : ''}`)
    console.log(`  登录链接   ${status.url || '(无)'}`)
    console.log(`  数据时间   ${status.data?.stats?.generatedAt || '(还没同步过)'}`)
    console.log(`  账本/饮食  ${status.data?.ledgerCount ?? 0} 笔 / ${(status.data?.dietUsers ?? []).join(', ') || '无'}`)
    console.log(`  仓库       ${status.repo?.commit ?? '?'}${status.repo?.dirty ? '（有未提交改动）' : ''}；${status.repo?.sync ?? ''}`)
    if (Array.isArray(status.applied) && status.applied.length > 0) console.log(`  最近应用   ${status.applied.join('；')}`)
    if (Array.isArray(status.errors) && status.errors.length > 0) console.log(`  错误       ${status.errors.join('；')}`)
    if (Array.isArray(status.logTail) && status.logTail.length > 0) console.log(`  日志尾巴   ${status.logTail.slice(-3).join(' / ')}`)
  }
  console.log('')
}

/**
 * 打包给家人电脑首次安装的 zip。
 *
 * 有远端就先 `git clone` 一份干净仓库（家人那边拿到手就能 pull），
 * 没远端就把当前目录拷一份（能跑，但不会自动同步）。
 *
 * @returns {Promise<string>} zip 路径
 */
async function pack() {
  const mirror = await loadMirror()
  const remote = await resolveRemote(mirror)
  const local = await loadLocalConfig()
  const dist = path.join(PATHS.kit, 'dist')
  // 暂存放在系统临时目录，并固定叫 `family-kit`：这样解压出来就是同名目录，
  // 家人电脑直接放到 C:\custom\dsh\ 下即可（fs.cp 不允许拷进自己的子目录）。
  const stage = path.join(os.tmpdir(), 'family-kit')
  if (await pathExists(stage)) {
    await fs.rename(stage, path.join(os.tmpdir(), `family-kit-old-${stamp().replace(/[: ]/g, '-')}`)).catch(() => {})
  }
  await ensureDirs(dist)

  let note = ''
  if (remote !== '') {
    const clone = await git(['clone', '--quiet', '--branch', mirror.git.branch, remote, stage], { timeoutMs: 300000 })
    if (clone.code !== 0) {
      note = `克隆失败（${(clone.stderr || '').trim().split(/\r?\n/).slice(-1)[0]}），退回本地拷贝`
      await fs.cp(PATHS.kit, stage, { recursive: true, filter: packFilter })
    } else {
      note = '取自远端仓库'
    }
  } else {
    await fs.cp(PATHS.kit, stage, { recursive: true, filter: packFilter })
    note = '取自本地目录（没有远端，不会自动同步）'
  }
  await ensureDirs(path.join(stage, 'data'), path.join(stage, 'status'), path.join(stage, 'ops'))

  const apiKey = await localApiKey()
  await writeJson(path.join(stage, 'config.local.json'), { remote, apiKey, packedAt: isoNow() })

  const zipFile = path.join(dist, `dsh-family-kit-${stamp().replace(/[: ]/g, '-')}.zip`)
  if (await pathExists(zipFile)) {
    await fs.rename(zipFile, `${zipFile}.old-${Date.now()}`).catch(() => {})
  }
  // 用 .NET 的 ZipFile 而不是 Compress-Archive：后者会跳过隐藏目录，而 `.git` 正是
  // Hidden —— 没有它，家人电脑那份就只是个文件夹，永远 pull 不了。
  const result = await run('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; "
      + `[IO.Compression.ZipFile]::CreateFromDirectory('${stage}', '${zipFile}', 'Optimal', $true)`,
  ], { timeoutMs: 300000 })
  if (result.code !== 0) throw new Error(`压缩失败：${(result.stderr || result.stdout).trim()}`)
  console.log(`已打包：${winPath(zipFile)}（${note}）`)
  console.log('拷到家人电脑，解压到 C:\\custom\\dsh\\（得到 family-kit 目录），双击里面的 install.cmd。')
  return zipFile
}

/**
 * 打包时跳过的东西：运行时、日志、发行包、git 元数据、状态与指令。
 * @param {string} source - 源路径
 * @returns {boolean} 要不要带上
 */
function packFilter(source) {
  const relative = path.relative(PATHS.kit, source).replace(/\\/g, '/')
  if (relative === '') return true
  const first = relative.split('/')[0]
  if (['runtime', 'logs', 'dist', '.git', 'status', 'ops', 'node_modules'].includes(first)) return false
  // 发布器的本机路径与配置不带给家人电脑（它不发布数据）。
  if (relative === 'publisher.json' || relative === 'config.local.json') return false
  return true
}

/**
 * 路径是否存在。
 * @param {string} file - 路径
 * @returns {Promise<boolean>} 存在与否
 */
async function pathExists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/**
 * 从本机 DSH 的凭据文件里取 API key（打包时带过去，家人不用自己填）。
 * @returns {Promise<string>} key 或空串
 */
async function localApiKey() {
  const local = await loadLocalConfig()
  if (typeof local.apiKey === 'string' && local.apiKey.trim() !== '') return local.apiKey.trim()
  const file = path.join(process.env.USERPROFILE ?? '', '.dsh', '.credentials.yaml')
  const text = await readText(file)
  const match = text.match(/DEEPSEEK_API_KEY:\s*"?([^"\r\n]+)"?/)
  return match === null ? '' : match[1].trim()
}

/**
 * 入口。
 * @returns {Promise<void>} 完成
 */
async function main() {  const { _, flags } = parseArgs(process.argv.slice(2))
  const command = _[0] ?? 'status'

  switch (command) {
    case 'status': {
      await showStatus()
      const agent = await taskStatus('DSHFamilyAgent')
      const publisher = await taskStatus('DSHFamilyPublish')
      console.log('本机任务：', [...agent, ...publisher]
        .map(task => `${task.name}=${task.exists ? `${task.status || '已装'} ${task.lastRun || ''}` : '未安装'}`)
        .join('，'))
      return
    }
    case 'data': {
      const summary = await publish({ noGit: flags['no-git'] === true })
      console.log(`发布完成：账本 ${summary.ledger.count} 笔，饮食 ${summary.diet.users.length} 人，本月支出 ¥${summary.stats.ledgerMonthExpense}，今日摄入 ${summary.stats.dietTodayKcal} kcal`)
      if (summary.ledger.ok === false) console.log(`账本：${summary.ledger.error}`)
      if (summary.diet.ok === false) console.log(`饮食：${summary.diet.error}`)
      if (summary.git) console.log(`git：${summary.git}`)
      return
    }
    case 'push': {
      const note = await commitPush(['.'], `kit: ${stamp()}`)
      console.log(note)
      return
    }
    case 'version': {
      const version = _[1]
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/.test(version)) {
        console.log('用法：fam.mjs version 0.2.2-rc.5')
        return
      }
      const raw = await readJson(PATHS.mirror)
      raw.dsh.version = version
      await writeJson(PATHS.mirror, raw)
      console.log(await commitPush(['mirror.json'], `dsh: ${version}`))
      console.log('家人电脑两分钟内会自己 npm install 这个版本；装不上会留在旧版本并在 status 里报错。')
      return
    }
    case 'plugin': {
      const name = _[1]
      const state = (_[2] ?? '').toLowerCase()
      if (typeof name !== 'string' || !['on', 'off'].includes(state)) {
        console.log('用法：fam.mjs plugin <包名> on|off')
        return
      }
      const raw = await readJson(PATHS.mirror)
      const plugin = (raw.plugins ?? []).find(item => item.name === name)
      if (plugin === undefined) {
        console.log(`清单里没有 ${name}。现有：${(raw.plugins ?? []).map(item => item.name).join(', ')}`)
        return
      }
      plugin.enabled = state === 'on'
      await writeJson(PATHS.mirror, raw)
      console.log(await commitPush(['mirror.json'], `plugin: ${name} ${state}`))
      if (state === 'on' && plugin.bundle === true) {
        console.log('提示：打开后 profile 会重新 pnpm install，家人电脑那一轮会重启一次 DSH。')
      }
      return
    }
    case 'restart':
    case 'apply':
    case 'diagnose':
    case 'logs':
    case 'shell': {
      const args = {}
      if (command === 'logs') args.lines = Number(flags.lines) > 0 ? Number(flags.lines) : 60
      if (command === 'shell') args.command = _.slice(1).join(' ')
      const result = await enqueue(command, args)
      console.log(JSON.stringify(result, null, 2))
      return
    }
    case 'ops': {
      await pull()
      let files = []
      try {
        files = (await fs.readdir(path.join(PATHS.status, 'ops'))).filter(name => name.endsWith('.json')).sort().reverse()
      } catch {
        files = []
      }
      for (const name of files.slice(0, 10)) {
        const record = await readJson(path.join(PATHS.status, 'ops', name), {})
        console.log(`${record.id ?? name}  ${record.action ?? ''}  ${record.ranAt ?? ''}  ${record.ok === true ? 'OK' : 'FAIL'}`)
      }
      if (files.length === 0) console.log('还没有执行过的指令。')
      return
    }
    case 'remote': {
      const url = _[1]
      if (typeof url !== 'string' || url.trim() === '') {
        console.log('用法：fam.mjs remote git@github.com:you/dsh-family-kit.git')
        return
      }
      const local = await loadLocalConfig()
      await writeJson(PATHS.localConfig, { ...local, remote: url.trim() })
      const existing = await git(['remote', 'get-url', 'origin'])
      if (existing.code === 0) await git(['remote', 'set-url', 'origin', url.trim()])
      else await git(['remote', 'add', 'origin', url.trim()])
      const branch = (await loadMirror()).git.branch
      const push = await git(['push', '-u', 'origin', `HEAD:${branch}`], { timeoutMs: 180000 })
      console.log(push.code === 0 ? `已绑定并推送：${url}` : `绑定成功，推送失败：${(push.stderr || '').trim().split(/\r?\n/).slice(-2).join(' ')}`)
      return
    }
    case 'init': {
      const mirror = await loadMirror()
      if (!(await gitAvailable())) {
        console.log('本机没有 git')
        return
      }
      await git(['init'])
      await git(['add', '-A'])
      await git(['-c', 'user.name=dsh-family-admin', '-c', 'user.email=admin@dsh-family', 'commit', '-m', 'kit: init family kit'])
      await git(['branch', '-M', mirror.git.branch])
      console.log('已初始化本地仓库并提交。下一步：fam.mjs remote <git-url>')
      return
    }
    case 'pack': {
      await pack()
      return
    }
    case 'install-publish-task': {
      await ensureDirs(path.join(PATHS.tools, 'run'))
      await writeText(path.join(PATHS.tools, 'run', 'publish.cmd'), [
        '@echo off',
        `"${process.execPath}" "${path.join(PATHS.tools, 'publish.mjs')}"`,
        '',
      ].join('\r\n'))
      const result = await createTask('DSHFamilyPublish', publishTaskXml())
      console.log(result ? '已装本机发布任务（每 2 分钟）' : '安装失败，看 logs/fam.log')
      return
    }
    case 'install-agent-tasks': {
      const ok = await installTasks(Number((await loadMirror()).agent?.intervalMinutes) || 2)
      console.log(ok ? '已装家人电脑那两个任务（本机测试用）' : '安装失败')
      return
    }
    default:
      console.log('命令：status | data | push | version <v> | plugin <名> on|off | restart | apply | diagnose | logs [--lines n] | shell "<命令>" | ops | remote <url> | init | pack | install-publish-task | install-agent-tasks')
  }
}

/**
 * 本地发布任务的定义（每两分钟跑一次 publish.mjs）。
 * @returns {string} XML
 */
function publishTaskXml() {
  const cmd = path.join(PATHS.tools, 'run', 'publish.cmd')
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  const start = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:00`
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>dsh-family-kit: publish ledger/diet/stats every 2 minutes</Description>',
    '    <URI>\\DSHFamilyPublish</URI>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <CalendarTrigger>',
    `      <StartBoundary>${start}</StartBoundary>`,
    '      <Enabled>true</Enabled>',
    '      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>',
    '      <Repetition>',
    '        <Interval>PT2M</Interval>',
    '        <Duration>PT24H</Duration>',
    '        <StopAtDurationEnd>false</StopAtDurationEnd>',
    '      </Repetition>',
    '    </CalendarTrigger>',
    '  </Triggers>',
    '  <Principals><Principal id="Author">',
    `    <UserId>${process.env.USERDOMAIN ?? process.env.COMPUTERNAME}\\${process.env.USERNAME}</UserId>`,
    '    <LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>',
    '  </Principal></Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>',
    '    <Enabled>true</Enabled>',
    '  </Settings>',
    '  <Actions Context="Author"><Exec>',
    '    <Command>wscript.exe</Command>',
    `    <Arguments>"${path.join(PATHS.tools, 'run-hidden.vbs')}" "${cmd}"</Arguments>`,
    '  </Exec></Actions>',
    '</Task>',
    '',
  ].join('\r\n')
}

try {
  await main()
} catch (error) {
  console.error(`失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
}
