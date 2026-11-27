/**
 * 手动「同步」：生活面板上的按钮调它，立刻拉一次远端（带冲突自救）。
 *
 * 和 agent 每轮做的是同一件事，只是不等下一个周期。输出一行 JSON 给面板显示。
 */

import { loadMirror, log } from './common.mjs'
import { pullSafe } from './conflict.mjs'

const mirror = await loadMirror()
const branch = mirror.git?.branch ?? 'main'
const result = await pullSafe({ branch })
await log('sync-now', result.ok ? 'ok' : `failed: ${result.note} ${result.unresolved.join(', ')}`)
console.log(JSON.stringify({
  ok: result.ok,
  note: result.note,
  resolved: result.resolved,
  unresolved: result.unresolved,
  at: new Date().toISOString(),
}))
process.exit(result.ok ? 0 : 1)
