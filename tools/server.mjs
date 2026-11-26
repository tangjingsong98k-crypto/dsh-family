/**
 * DSH 进程的启停与登录链接。
 *
 * 家人电脑上 DSH 是一个后台进程：`agent.mjs` 每两分钟看它一眼，挂了就拉起来。
 * 启动参数固定成 `web --host 127.0.0.1 --port <端口> --no-open`，和主电脑一样的
 * 只监听回环——远程要看界面就走 SSH 隧道 / Tailscale，不把 Web 端口暴露到局域网。
 *
 * 启动后从日志里抓 `?token=...` 的登录链接，写成桌面能双击的 `.url` 快捷方式：
 * 不给这条链接，DSH 的 Web 只会回 401。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

import {
  PATHS,
  ensureDirs,
  listenersOf,
  probeDsh,
  processAlive,
  readJson,
  readText,
  sleep,
  stamp,
  stopPort,
  writeJson,
  writeText,
} from './common.mjs'

/**
 * 读自己记的 DSH 进程号（不是从端口猜的，避免把别人的进程当成自己的）。
 * @returns {Promise<number>} PID；没有就是 0
 */
async function ownPid() {
  const record = await readJson(PATHS.pidFile, {})
  const pid = Number(record.pid)
  return processAlive(pid) ? pid : 0
}

/**
 * 把登录链接写成 Windows 的 Internet 快捷方式（双击就打开浏览器）。
 * @param {string} url - 带 token 的地址
 * @returns {Promise<void>} 完成
 */
export async function writeShortcut(url) {
  await writeText(PATHS.loginUrl, `${url}\n`)
  const body = `[InternetShortcut]\r\nURL=${url}\r\nIconIndex=0\r\n`
  await writeText(path.join(PATHS.kit, '打开 DSH.url'), body)
}

/**
 * 服务器现在的状态。
 * @param {number} port - 端口
 * @returns {Promise<{ running: boolean, ours: boolean, http: number, pids: number[], url: string }>} 状态
 */
export async function serverStatus(port) {
  const http = await probeDsh(port)
  const pids = await listenersOf(port)
  const url = (await readText(PATHS.loginUrl)).trim()
  const pid = await ownPid()
  return { running: http === 200 || http === 401, ours: pid !== 0 && (pids.length === 0 || pids.includes(pid)), http, pids, url, pid }
}

/**
 * 停掉服务器。
 * @param {number} port - 端口
 * @returns {Promise<number[]>} 停掉的 PID
 */
export async function stopServer(port) {
  const pid = await ownPid()
  const killed = await stopPort(port)
  if (pid !== 0 && !killed.includes(pid)) {
    try {
      process.kill(pid)
    } catch {
      // 已经退了。
    }
  }
  await writeJson(PATHS.pidFile, { pid: 0, stoppedAt: new Date().toISOString() }).catch(() => {})
  return killed.length > 0 ? killed : (pid === 0 ? [] : [pid])
}

/**
 * 起服务器（已经在跑就直接返回现有链接）。
 *
 * @param {object} mirror - 配置（端口、host）
 * @param {object} [options] - `{ force }`：force 时先停再起
 * @returns {Promise<{ started: boolean, url: string, log: string }>} 结果
 */
export async function startServer(mirror, { force = false } = {}) {
  const port = Number(mirror.dsh.port)
  const host = typeof mirror.dsh.host === 'string' && mirror.dsh.host.trim() !== '' ? mirror.dsh.host.trim() : '127.0.0.1'
  await ensureDirs(PATHS.logs, PATHS.work, PATHS.home)

  const before = await serverStatus(port)
  if (before.running && before.ours && !force) {
    if (before.url !== '') return { started: false, url: before.url, log: '(已在运行)' }
    // 在跑但没有记录链接：从最近一份日志里再抓一次。
    const recovered = await recallUrlFromLogs()
    return { started: false, url: recovered, log: '(已在运行)' }
  }
  if (before.running && !before.ours) {
    // 端口上是别的 DSH（比如上次没清干净的进程）：先收掉，再起自己的。
    await stopServer(port)
    await sleep(1200)
  }
  if (force && before.pids.length > 0) await stopPort(port)
  // 端口有人占着但不像 DSH（比如上次崩溃留下的半死进程）：先清掉，否则新进程绑不上。
  if (!before.running && before.pids.length > 0) await stopPort(port)

  const logFile = path.join(PATHS.logs, `dsh-${stamp().replace(/[: ]/g, '-')}.log`)
  const handle = await fs.open(logFile, 'a')
  const args = [PATHS.installedBin, 'web', '--host', host, '--port', String(port), '--no-open']
  const child = spawn(process.execPath, args, {
    cwd: PATHS.work,
    env: { ...process.env, DSH_HOME: PATHS.home },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', handle.fd, handle.fd],
  })
  child.unref()
  await handle.close()
  await writeJson(PATHS.pidFile, { pid: child.pid, startedAt: new Date().toISOString(), port, log: logFile })

  let url = ''
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await sleep(750)
    const text = await readText(logFile)
    const match = text.match(/https?:\/\/[^\s]*\?token=[A-Za-z0-9_-]+/)
    if (match !== null) {
      url = match[0]
      break
    }
    const http = await probeDsh(port, 800)
    if (http !== 0 && url !== '') break
  }
  if (url === '') url = (await readText(PATHS.loginUrl)).trim()
  if (url !== '') await writeShortcut(url)
  return { started: true, url, log: logFile }
}

/**
 * 从历史日志里找回最近一条带 token 的地址。
 * @returns {Promise<string>} 链接或空串
 */
async function recallUrlFromLogs() {
  let files = []
  try {
    files = (await fs.readdir(PATHS.logs)).filter(name => name.startsWith('dsh-') && name.endsWith('.log'))
  } catch {
    return ''
  }
  files.sort().reverse()
  for (const name of files.slice(0, 5)) {
    const text = await readText(path.join(PATHS.logs, name))
    const match = text.match(/https?:\/\/[^\s]*\?token=[A-Za-z0-9_-]+/)
    if (match !== null) {
      await writeShortcut(match[0])
      return match[0]
    }
  }
  return ''
}
