/**
 * 家人电脑套件（dsh-family-kit）的公共工具。
 *
 * 这一套脚本同时活在两台机器上：
 *  - 主电脑：`publish.mjs` 往外发数据与插件，`fam.mjs` 是远程运维台；
 *  - 家人电脑：`install.mjs` 装一次，之后 `agent.mjs` 每两分钟收敛一次。
 *
 * 所有路径都从本文件的位置推出来，所以整套目录搬到哪台机器、哪个盘都能跑；
 * 只有 `mirror.json` 里的 `{{KIT}}` 占位符会在装配时换成真实路径。
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

/** 套件根目录（`tools/` 的上一层）。 */
export const KIT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 全家的固定路径：两台机器一模一样，远程排查时不用问「你那边在哪」。 */
export const PATHS = {
  kit: KIT_ROOT,
  mirror: path.join(KIT_ROOT, 'mirror.json'),
  localConfig: path.join(KIT_ROOT, 'config.local.json'),
  publisher: path.join(KIT_ROOT, 'publisher.json'),
  runtime: path.join(KIT_ROOT, 'runtime'),
  app: path.join(KIT_ROOT, 'runtime', 'app'),
  home: path.join(KIT_ROOT, 'runtime', 'home'),
  work: path.join(KIT_ROOT, 'runtime', 'work'),
  state: path.join(KIT_ROOT, 'runtime', 'state.json'),
  lastGood: path.join(KIT_ROOT, 'runtime', 'last-good'),
  hold: path.join(KIT_ROOT, 'runtime', 'hold.json'),
  safety: path.join(KIT_ROOT, 'runtime', 'safety.json'),
  failures: path.join(KIT_ROOT, 'runtime', 'boot-failures.json'),
  loginUrl: path.join(KIT_ROOT, 'runtime', 'login-url.txt'),
  pidFile: path.join(KIT_ROOT, 'runtime', 'dsh.pid'),
  nodePath: path.join(KIT_ROOT, 'runtime', 'node-path.txt'),
  logs: path.join(KIT_ROOT, 'logs'),
  data: path.join(KIT_ROOT, 'data'),
  plugins: path.join(KIT_ROOT, 'plugins'),
  profileTemplate: path.join(KIT_ROOT, 'profile', 'cordis.patch.yml.tpl'),
  status: path.join(KIT_ROOT, 'status'),
  ops: path.join(KIT_ROOT, 'ops'),
  tools: path.join(KIT_ROOT, 'tools'),
  installedBin: path.join(KIT_ROOT, 'runtime', 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  installedPackage: path.join(KIT_ROOT, 'runtime', 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
}

/**
 * 补零。
 * @param {number} value - 数字
 * @returns {string} 两位
 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * 本地时间戳 `YYYY-MM-DD HH:MM:SS`（日志用，跟人看到的钟一致）。
 * @returns {string} 时间戳
 */
export function stamp() {
  const now = new Date()
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
    + ` ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
}

/**
 * ISO 时间戳。
 * @returns {string} ISO 字符串
 */
export function isoNow() {
  return new Date().toISOString()
}

/**
 * 建目录（存在就算了）。
 * @param {...string} dirs - 目录
 * @returns {Promise<void>} 完成
 */
export async function ensureDirs(...dirs) {
  for (const dir of dirs) await fs.mkdir(dir, { recursive: true })
}

/**
 * 读 JSON；文件不在就返回兜底值，解析失败抛错（不静默吞坏文件）。
 * @param {string} file - 路径
 * @param {any} [fallback] - 文件不存在时的兜底
 * @returns {Promise<any>} 内容
 */
export async function readJson(file, fallback = undefined) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT' && fallback !== undefined) return fallback
    throw error
  }
  // Windows 记事本会给 UTF-8 加 BOM，JSON.parse 不认；这里统一剥掉。
  return JSON.parse(text.replace(/^\uFEFF/, ''))
}

/**
 * 写 JSON：先写临时文件再改名，读的人不会看到写了一半的文件。
 * @param {string} file - 路径
 * @param {any} value - 内容
 * @returns {Promise<void>} 完成
 */
export async function writeJson(file, value) {
  await ensureDirs(path.dirname(file))
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(temp, file)
}

/**
 * 写文本（同样是临时文件 + 改名）。
 * @param {string} file - 路径
 * @param {string} text - 内容
 * @returns {Promise<void>} 完成
 */
export async function writeText(file, text) {
  await ensureDirs(path.dirname(file))
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, text, 'utf8')
  await fs.rename(temp, file)
}

/**
 * 读文本；不存在返回空串。
 * @param {string} file - 路径
 * @returns {Promise<string>} 内容
 */
export async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 带时间戳往控制台和日志文件写一行。
 * @param {string} scope - 日志名（agent / publish / install / fam）
 * @param {string} message - 内容
 * @returns {Promise<void>} 完成
 */
export async function log(scope, message) {
  const line = `[${stamp()}] ${message}`
  console.log(line)
  const file = path.join(PATHS.logs, `${scope}.log`)
  try {
    await ensureDirs(PATHS.logs)
    let size = 0
    try {
      size = (await fs.stat(file)).size
    } catch {
      size = 0
    }
    if (size > 2 * 1024 * 1024) await fs.rename(file, `${file}.1`).catch(() => {})
    await fs.appendFile(file, `${line}\n`, 'utf8')
  } catch {
    // 日志写不了不能拖垮主流程。
  }
}

/**
 * 跑一个子进程并收全输出。
 * @param {string} command - 可执行文件
 * @param {string[]} args - 参数
 * @param {object} [options] - `{ cwd, env, timeoutMs, input }`
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>} 结果
 */
export function run(command, args, options = {}) {
  const { cwd = KIT_ROOT, env = process.env, timeoutMs = 600000, input } = options
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try {
        child.kill()
      } catch {
        // 已经退了。
      }
      resolve({ code: -1, stdout, stderr: `${stderr}\n[timeout ${timeoutMs}ms]` })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/**
 * git 是否可用。
 * @returns {Promise<boolean>} 可用与否
 */
export async function gitAvailable() {
  const result = await run('git', ['--version'], { timeoutMs: 15000 })
  return result.code === 0
}

/**
 * 在本套件目录里跑一条 git 命令。
 * @param {string[]} args - git 参数
 * @param {object} [options] - 透传给 run
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>} 结果
 */
export function git(args, options = {}) {
  return run('git', args, {
    ...options,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
      ...(options.env ?? {}),
    },
  })
}

/**
 * 读 `mirror.json` 并把 `{{KIT}}` 换成真实路径（正斜杠，pnpm 认）。
 * @returns {Promise<object>} 配置
 */
export async function loadMirror() {
  const mirror = await readJson(PATHS.mirror)
  const kit = KIT_ROOT.replace(/\\/g, '/')
  const expand = value => typeof value === 'string' ? value.split('{{KIT}}').join(kit) : value
  mirror.plugins = (Array.isArray(mirror.plugins) ? mirror.plugins : []).map(plugin => ({
    ...plugin,
    spec: expand(plugin.spec),
  }))
  return mirror
}

/**
 * 家人电脑的本地配置（git 忽略）：远端地址、API key 之类不能进仓库的东西。
 * @returns {Promise<object>} 配置
 */
export function loadLocalConfig() {
  return readJson(PATHS.localConfig, {})
}

/**
 * 合并写本地配置。
 * @param {object} patch - 要合并的字段
 * @returns {Promise<object>} 合并后的配置
 */
export async function saveLocalConfig(patch) {
  const current = await loadLocalConfig()
  const next = { ...current, ...patch }
  await writeJson(PATHS.localConfig, next)
  return next
}

/**
 * 当前仓库的远端地址（优先 local config，其次 mirror.json，最后 .git/config）。
 * @param {object} [mirror] - 已加载的 mirror
 * @returns {Promise<string>} 远端；没有就是空串
 */
export async function resolveRemote(mirror) {
  const local = await loadLocalConfig()
  if (typeof local.remote === 'string' && local.remote.trim() !== '') return local.remote.trim()
  if (mirror !== undefined && typeof mirror.git?.remote === 'string' && mirror.git.remote.trim() !== '') return mirror.git.remote.trim()
  const result = await git(['remote', 'get-url', 'origin'])
  if (result.code === 0 && result.stdout.trim() !== '') return result.stdout.trim()
  return ''
}

/**
 * 读已安装的 DSH 版本；没装返回空串。
 * @returns {Promise<string>} 版本
 */
export async function installedDshVersion() {
  try {
    const pkg = await readJson(PATHS.installedPackage)
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/**
 * 递归算出目录内容指纹（名字 + 大小 + 修改时间），用来判断插件源码有没有变。
 * @param {string} dir - 目录
 * @returns {Promise<string>} 指纹
 */
export async function treeHash(dir) {
  const hash = crypto.createHash('sha1')
  /**
   * 递归走一层。
   * @param {string} current - 当前目录
   * @returns {Promise<void>} 完成
   */
  async function walk(current) {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        hash.update(`d:${path.relative(dir, full)}\n`)
        await walk(full)
        continue
      }
      try {
        const stat = await fs.stat(full)
        hash.update(`f:${path.relative(dir, full)}:${stat.size}:${stat.mtimeMs}\n`)
      } catch {
        // 正在被改的文件跳过。
      }
    }
  }
  await walk(dir)
  return hash.digest('hex')
}

/**
 * 探一下端口上是不是 DSH 在应答。
 * @param {number} port - 端口
 * @param {number} [timeoutMs] - 超时
 * @returns {Promise<number>} HTTP 状态码；连不上返回 0
 */
export async function probeDsh(port, timeoutMs = 2500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) })
    return response.status
  } catch {
    return 0
  }
}

/**
 * 端口监听者的 PID 列表（Windows netstat 兜底，不依赖 PowerShell）。
 * @param {number} port - 端口
 * @returns {Promise<number[]>} PID
 */
export async function listenersOf(port) {
  const result = await run('netstat', ['-ano'], { timeoutMs: 20000 })
  const pids = new Set()
  for (const line of result.stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5) continue
    if (parts[0] !== 'TCP') continue
    if (parts[3] !== 'LISTENING') continue
    const address = parts[1]
    if (!address.endsWith(`:${port}`)) continue
    const pid = Number(parts[4])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

/**
 * 停掉占着端口的进程（先礼后兵：taskkill /T）。
 * @param {number} port - 端口
 * @returns {Promise<number[]>} 停掉的 PID
 */
export async function stopPort(port) {
  const pids = await listenersOf(port)
  for (const pid of pids) {
    await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 20000 })
  }
  return pids
}

/**
 * 主机名（状态文件名用）。
 * @returns {string} 主机名，非法字符换成横线
 */
export function hostName() {
  return (os.hostname() || 'family-pc').replace(/[^A-Za-z0-9._-]/g, '-')
}

/**
 * 解析参数：`--key value` 和 `--flag`。
 * @param {string[]} argv - 原始参数
 * @returns {{ _: string[], flags: Record<string, string|boolean> }} 解析结果
 */
export function parseArgs(argv) {
  const rest = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        index += 1
      } else {
        flags[key] = true
      }
    } else {
      rest.push(token)
    }
  }
  return { _: rest, flags }
}

/**
 * 把路径写成 Windows 反斜杠形式（给人看的输出用）。
 * @param {string} value - 路径
 * @returns {string} 反斜杠路径
 */
export function winPath(value) {
  return value.replace(/\//g, '\\')
}

/**
 * 进程还在不在。
 * @param {number} pid - PID
 * @returns {boolean} 在不在
 */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error !== null && typeof error === 'object' && error.code === 'EPERM'
  }
}

/**
 * 当前 node 自带的 npm-cli.js（不依赖 PATH 上的 npm.cmd）。
 * @returns {string} 路径
 */
export function npmCliPath() {
  return path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

/**
 * 等一会儿。
 * @param {number} ms - 毫秒
 * @returns {Promise<void>} 完成
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 文件是否存在。
 * @param {string} file - 路径
 * @returns {boolean} 存在与否
 */
export function exists(file) {
  return existsSync(file)
}
