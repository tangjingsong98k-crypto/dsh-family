/**
 * 在前台起点 DSH（家人电脑上双击 `start.cmd` 就是跑它）。
 *
 * 已经在跑就只打印现在的登录链接；没跑就拉起来，等它打印 token，再写一份
 * 双击可用的 `打开 DSH.url`。`--open` 会顺手打开浏览器。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadMirror, parseArgs, winPath, PATHS } from './common.mjs'
import { startServer } from './server.mjs'

const { flags } = parseArgs(process.argv.slice(2))
const mirror = await loadMirror()
const result = await startServer(mirror)
console.log('')
console.log(`DSH 目录 : ${winPath(PATHS.kit)}`)
console.log(`端口     : ${mirror.dsh.port}`)
console.log(`登录链接 : ${result.url === '' ? '(没抓到，看看 logs 里的 dsh-*.log)' : result.url}`)
console.log(`快捷方式 : ${winPath(path.join(PATHS.kit, '打开 DSH.url'))}`)
console.log('')

if (flags.open === true && result.url !== '') {
  const { spawn } = await import('node:child_process')
  spawn('cmd.exe', ['/c', 'start', '', result.url], { detached: true, windowsHide: true, stdio: 'ignore' }).unref()
}
