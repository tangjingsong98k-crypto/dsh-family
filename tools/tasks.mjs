/**
 * 计划任务：让家人电脑上的代理每两分钟自己跑一次，登录后立刻跑一次。
 *
 * 用 Task Scheduler 的 XML 定义（`schtasks /Create /XML`），不用 `/TR "..."`：
 * 后者要把引号一层层塞进命令行，路径一有空格就碎；XML 里参数原样写，稳定。
 *
 * 两个任务：
 *  - `DSHFamilyAgent`：每 2 分钟收敛一次（版本、插件、数据、进程）；
 *  - `DSHFamilyLogon`：用户登录后立刻跑一次，省得开机后干等两分钟。
 *
 * 都跑 `wscript run-hidden.vbs ...\run\agent.cmd`，不闪黑窗。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PATHS, ensureDirs, log, parseArgs, run } from './common.mjs'

/** 任务名前缀。 */
const AGENT_TASK = 'DSHFamilyAgent'
const LOGON_TASK = 'DSHFamilyLogon'

/**
 * 当前用户的 `DOMAIN\user`（任务主体要它）。
 * @returns {string} 用户标识
 */
function currentUser() {
  const user = process.env.USERNAME ?? ''
  const domain = process.env.USERDOMAIN ?? process.env.COMPUTERNAME ?? ''
  return domain === '' ? user : `${domain}\\${user}`
}

/**
 * 把 XML 写成 schtasks 认的 UTF-16LE + BOM。
 * @param {string} file - 目标文件
 * @param {string} xml - XML 文本
 * @returns {Promise<void>} 完成
 */
async function writeTaskXml(file, xml) {
  const body = Buffer.from(`\uFEFF${xml}`, 'utf16le')
  await fs.writeFile(file, body)
}

/**
 * 任务动作：wscript 跑隐藏的 agent.cmd。
 * @returns {{ command: string, arguments: string }} 动作
 */
function action() {
  const vbs = path.join(PATHS.tools, 'run-hidden.vbs')
  const cmd = path.join(PATHS.tools, 'run', 'agent.cmd')
  return { command: 'wscript.exe', arguments: `"${vbs}" "${cmd}"` }
}

/**
 * 公共的设置段。
 * @returns {string} XML 片段
 */
function settings() {
  return [
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
  ].join('\r\n')
}

/**
 * 生成任务 XML。
 * @param {object} options - `{ name, description, trigger }`
 * @returns {string} XML
 */
function taskXml({ name, description, trigger }) {
  const exec = action()
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${description}</Description>`,
    `    <URI>\\${name}</URI>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    trigger,
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${currentUser()}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    settings(),
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${exec.command}</Command>`,
    `      <Arguments>${exec.arguments}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n')
}

/**
 * 每两分钟的触发器。
 * @param {number} minutes - 间隔
 * @returns {string} XML
 */
function everyMinutesTrigger(minutes) {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  const start = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:00`
  return [
    '    <CalendarTrigger>',
    `      <StartBoundary>${start}</StartBoundary>`,
    '      <Enabled>true</Enabled>',
    '      <ScheduleByDay>',
    '        <DaysInterval>1</DaysInterval>',
    '      </ScheduleByDay>',
    '      <Repetition>',
    `        <Interval>PT${minutes}M</Interval>`,
    '        <Duration>PT24H</Duration>',
    '        <StopAtDurationEnd>false</StopAtDurationEnd>',
    '      </Repetition>',
    '    </CalendarTrigger>',
  ].join('\r\n')
}

/**
 * 登录触发器。
 * @returns {string} XML
 */
function logonTrigger() {
  return [
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    '    </LogonTrigger>',
  ].join('\r\n')
}

/**
 * 建一个任务（已存在就覆盖）。
 * @param {string} name - 任务名
 * @param {string} xml - 定义
 * @returns {Promise<boolean>} 成功与否
 */
export async function createTask(name, xml) {
  await ensureDirs(path.join(PATHS.runtime, 'tasks'))
  const file = path.join(PATHS.runtime, 'tasks', `${name}.xml`)
  await writeTaskXml(file, xml)
  const result = await run('schtasks.exe', ['/Create', '/TN', name, '/XML', file, '/F'], { timeoutMs: 60000 })
  if (result.code !== 0) {
    await log('tasks', `建任务 ${name} 失败：${(result.stderr || result.stdout).trim()}`)
    return false
  }
  return true
}

/**
 * 安装两个计划任务。
 * @param {number} minutes - 收敛间隔
 * @returns {Promise<boolean>} 全部成功与否
 */
export async function installTasks(minutes) {
  const interval = Number(minutes) > 0 ? Number(minutes) : 2
  const okAgent = await createTask(AGENT_TASK, taskXml({
    name: AGENT_TASK,
    description: 'dsh-family-kit: 每两分钟同步版本/插件/数据并保证 DSH 在跑',
    trigger: everyMinutesTrigger(interval),
  }))
  const okLogon = await createTask(LOGON_TASK, taskXml({
    name: LOGON_TASK,
    description: 'dsh-family-kit: 登录后立刻跑一次收敛',
    trigger: logonTrigger(),
  }))
  if (okAgent && okLogon) await log('tasks', `计划任务已装：${AGENT_TASK} 每 ${interval} 分钟，${LOGON_TASK} 登录时`)
  return okAgent && okLogon
}

/**
 * 删掉两个计划任务。
 * @returns {Promise<void>} 完成
 */
export async function removeTasks() {
  for (const name of [AGENT_TASK, LOGON_TASK]) {
    const result = await run('schtasks.exe', ['/Delete', '/TN', name, '/F'], { timeoutMs: 30000 })
    await log('tasks', result.code === 0 ? `已删除任务 ${name}` : `删除任务 ${name}：${(result.stderr || result.stdout).trim()}`)
  }
}

/**
 * 任务状态（给 `fam.mjs status` / 排障用）。
 * @param {string} [name] - 任务名，默认收敛任务
 * @returns {Promise<Array<object>>} 状态
 */
export async function taskStatus(name = AGENT_TASK) {
  const result = await run('schtasks.exe', ['/Query', '/TN', name, '/V', '/FO', 'LIST'], { timeoutMs: 30000 })
  if (result.code !== 0) return [{ name, exists: false }]
  const fields = {}
  for (const line of result.stdout.split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key !== '') fields[key] = value
  }
  return [{
    name,
    exists: true,
    status: fields['Status'] ?? '',
    lastRun: fields['Last Run Time'] ?? '',
    lastResult: fields['Last Result'] ?? '',
    nextRun: fields['Next Run Time'] ?? '',
  }]
}

// 直接运行：`node tools/tasks.mjs install|remove|status [minutes]`
const isMain = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const { _, flags } = parseArgs(process.argv.slice(2))
  const action = _[0] ?? 'status'
  if (action === 'install') {
    const minutes = Number(flags.minutes) > 0 ? Number(flags.minutes) : 2
    const ok = await installTasks(minutes)
    process.exit(ok ? 0 : 1)
  } else if (action === 'remove') {
    await removeTasks()
    process.exit(0)
  } else {
    console.log(JSON.stringify(await taskStatus(), null, 2))
    process.exit(0)
  }
}
