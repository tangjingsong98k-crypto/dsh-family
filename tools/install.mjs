/**
 * 家人电脑的一次性安装。
 *
 * 做五件事：
 *  1. 落 `config.local.json`（远端地址、API key 这类不进仓库的东西）；
 *  2. 写 DSH 的凭据文件（DeepSeek API key），没有 key 也能装，装上再补；
 *  3. 生成双击启动器（`start.cmd` / `stop.cmd`，里面写死当前 node 的路径）；
 *  4. 装配 DSH（`apply.mjs`：钉版本 + profile 依赖 + 补丁层）；
 *  5. 装计划任务、拉起 DSH、打印登录链接。
 *
 * 用法（一般由 `install.cmd` 调）：
 *   node tools/install.mjs --remote https://user:token@github.com/u/repo.git --api-key sk-xxx
 *   node tools/install.mjs --no-tasks --no-start      # 只装配，不装任务、不启动
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  PATHS,
  ensureDirs,
  loadLocalConfig,
  log,
  parseArgs,
  readText,
  saveLocalConfig,
  winPath,
  writeText,
} from './common.mjs'
import { apply } from './apply.mjs'
import { installTasks } from './tasks.mjs'
import { once } from './agent.mjs'

/**
 * 写 DSH 的凭据文件（只放 API key；浏览器会话凭据由 DSH 自己生成）。
 * @param {string} apiKey - DeepSeek API key
 * @returns {Promise<boolean>} 有没有改动
 */
async function writeCredentials(apiKey) {
  const file = path.join(PATHS.home, '.credentials.yaml')
  const current = await readText(file)
  const quoted = `DEEPSEEK_API_KEY: "${apiKey}"`
  if (current.includes(quoted) || current.includes(`DEEPSEEK_API_KEY: ${apiKey}`)) return false
  await ensureDirs(PATHS.home)
  await writeText(file, `version: 1\nrefs:\n  ${quoted}\n`)
  return true
}

/**
 * 生成双击启动器（node 的绝对路径写死，家人不用配 PATH）。
 * @param {string} nodeExe - node 可执行文件
 * @returns {Promise<void>} 完成
 */
async function writeLaunchers(nodeExe) {
  const startCmd = [
    '@echo off',
    'chcp 65001 >nul',
    `"${nodeExe}" "${path.join(PATHS.tools, 'start.mjs')}" --open %*`,
    'pause',
    '',
  ].join('\r\n')
  const stopCmd = [
    '@echo off',
    `"${nodeExe}" "${path.join(PATHS.tools, 'stop.mjs')}"`,
    'pause',
    '',
  ].join('\r\n')
  await writeText(path.join(PATHS.kit, 'start.cmd'), startCmd)
  await writeText(path.join(PATHS.kit, 'stop.cmd'), stopCmd)

  await ensureDirs(path.join(PATHS.tools, 'run'))
  await writeText(path.join(PATHS.tools, 'run', 'agent.cmd'), [
    '@echo off',
    `"${nodeExe}" "${path.join(PATHS.tools, 'agent.mjs')}" --quiet`,
    '',
  ].join('\r\n'))
  await writeText(PATHS.nodePath, `${nodeExe}\n`)
}

/**
 * 从 `config.local.json` / 参数 / 环境变量里找 API key。
 * @param {object} flags - 命令行参数
 * @param {object} local - 本地配置
 * @returns {string} key 或空串
 */
function pickApiKey(flags, local) {
  if (typeof flags['api-key'] === 'string' && flags['api-key'].trim() !== '') return flags['api-key'].trim()
  if (typeof local.apiKey === 'string' && local.apiKey.trim() !== '') return local.apiKey.trim()
  if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.trim() !== '') return process.env.DEEPSEEK_API_KEY.trim()
  return ''
}

/**
 * 主流程。
 * @returns {Promise<number>} 退出码
 */
async function main() {
  const { flags } = parseArgs(process.argv.slice(2))
  await ensureDirs(PATHS.runtime, PATHS.home, PATHS.logs, PATHS.data, PATHS.work, PATHS.status, PATHS.ops)
  await log('install', `开始安装：${winPath(PATHS.kit)}`)

  const patch = {}
  if (typeof flags.remote === 'string' && flags.remote.trim() !== '') patch.remote = flags.remote.trim()
  if (typeof flags['api-key'] === 'string' && flags['api-key'].trim() !== '') patch.apiKey = flags['api-key'].trim()
  if (typeof flags.registry === 'string' && flags.registry.trim() !== '') {
    const mirror = JSON.parse(await readText(PATHS.mirror))
    mirror.dsh.npmRegistry = flags.registry.trim()
    await writeText(PATHS.mirror, `${JSON.stringify(mirror, null, 2)}\n`)
  }
  if (Object.keys(patch).length > 0) await saveLocalConfig(patch)

  const local = await loadLocalConfig()
  const apiKey = pickApiKey(flags, local)
  if (apiKey !== '') {
    const changed = await writeCredentials(apiKey)
    if (changed) await log('install', '已写入 DeepSeek API key（runtime/home/.credentials.yaml）')
  } else {
    await log('install', '还没有 API key：装好后在 DSH 的 设置 里填，或者重新跑 install.cmd 带上 --api-key')
  }

  await writeLaunchers(process.execPath)

  const applied = await apply()
  await log('install', applied.changed ? `装配完成：${applied.reasons.join('；')}` : '装配完成：已经是最新')

  if (flags['no-tasks'] !== true) {
    const mirror = JSON.parse(await readText(PATHS.mirror))
    await installTasks(Number(mirror.agent?.intervalMinutes) || 2)
  }

  if (flags['no-start'] !== true) {
    const status = await once({ quiet: true })
    console.log('')
    console.log('==============================================')
    console.log(' 装好了。')
    console.log(` DSH 版本 : ${status.dshVersion}`)
    console.log(` 运行状态 : ${status.running ? '在跑' : '没起来（看 logs）'}`)
    console.log(` 登录链接 : ${status.url === '' ? '(没抓到，看 logs/dsh-*.log)' : status.url}`)
    console.log(` 双击入口 : ${winPath(path.join(PATHS.kit, '打开 DSH.url'))}`)
    console.log(` 数据目录 : ${winPath(PATHS.data)}`)
    console.log(' 之后每两分钟自动同步一次；改了 mirror.json 推上去就行。')
    console.log('==============================================')
    console.log('')
  }

  await fs.writeFile(path.join(PATHS.runtime, 'installed.json'), `${JSON.stringify({ installedAt: new Date().toISOString(), node: process.execPath }, null, 2)}\n`, 'utf8')
  return 0
}

try {
  process.exit(await main())
} catch (error) {
  await log('install', `失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
}
