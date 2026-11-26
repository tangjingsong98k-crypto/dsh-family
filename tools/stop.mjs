/**
 * 停掉 DSH（家人电脑上一般用不到，远程排障时用）。
 */

import { loadMirror } from './common.mjs'
import { stopServer } from './server.mjs'

const mirror = await loadMirror()
const pids = await stopServer(Number(mirror.dsh.port))
console.log(pids.length === 0 ? '端口上本来就没有进程。' : `已停止：${pids.join(', ')}`)
