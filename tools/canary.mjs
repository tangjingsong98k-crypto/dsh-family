/**
 * 金丝雀：把「要装到正在用的那份上」的东西，先装进一个完全独立的第二实例。
 *
 * 第二实例有自己的 `runtime/canary/app`（独立 node_modules）、`runtime/canary/home`
 * （独立 DSH_HOME）和另一个端口，和正在服务的实例没有任何共享文件。流程：
 *
 *   1. npm 装目标版本到 canary/app；
 *   2. 按同一份 mirror.json 生成 profile（同样的插件、同样的补丁层）；
 *   3. pnpm 装依赖；
 *   4. `--dump-config` 看配置能不能组合出来（插件有没有挂上、有没有 cannot resolve）；
 *   5. 起一次 `web`，等它真的应答（200/401）；
 *   6. 收掉进程。
 *
 * 任何一步失败 → 返回 `ok:false`，主实例一个字节都没动。agent 会把这次计划冻结
 * （同一个配置不再重试），状态里写明失败在哪一步。
 *
 * 为什么不做成「同一份安装里的两个 profile」：DSH 的插件是装进 profile 的
 * node_modules 的，坏插件会改坏共享的依赖树；只有独立安装 + 独立 home 才是真的隔离。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  PATHS,
  ensureDirs,
  installedVersionAt,
  isoNow,
  listenersOf,
  log,
  probeDsh,
  readJson,
  readText,
  run,
  sleep,
  stopPort,
  writeJson,
  writeText,
} from './common.mjs'
import { installDsh, installProfileDeps, profileManifest, renderPatch } from './apply.mjs'

/**
 * 金丝雀各个目录。
 * @returns {{ root: string, app: string, home: string, work: string, logs: string }} 目录
 */
export function canaryPaths() {
  return {
    root: PATHS.canary,
    app: path.join(PATHS.canary, 'app'),
    home: path.join(PATHS.canary, 'home'),
    work: path.join(PATHS.canary, 'work'),
    logs: path.join(PATHS.canary, 'logs'),
  }
}

/**
 * 找一个空闲端口（默认在用端口 +1，被占就往后挪）。
 * @param {object} mirror - 配置
 * @returns {Promise<number>} 端口
 */
async function pickPort(mirror) {
  const base = Number(mirror.canary?.port) || Number(mirror.dsh.port) + 1
  for (let port = base; port < base + 20; port += 1) {
    const listeners = await listenersOf(port)
    if (listeners.length === 0) return port
  }
  return base
}

/**
 * 写金丝雀实例的 profile（和主实例同一份清单与补丁层）。
 * @param {object} mirror - 配置
 * @param {object} paths - canaryPaths()
 * @param {string} dietQq - 这台设备看的 QQ
 * @returns {Promise<string>} profile 目录
 */
async function writeCanaryProfile(mirror, paths, dietQq) {
  const profileDir = path.join(paths.home, 'profiles', mirror.profile.name)
  await ensureDirs(profileDir)
  const manifest = profileManifest(mirror)
  const template = await readText(PATHS.profileTemplate)
  if (template === '') throw new Error(`缺少补丁模板：${PATHS.profileTemplate}`)
  await writeText(path.join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeText(path.join(profileDir, 'cordis.yml'), '# dsh profile root — 金丝雀副本\n[]\n')
  await writeText(path.join(profileDir, 'cordis.patch.yml'), renderPatch(template, mirror, dietQq))
  await writeText(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  return profileDir
}

/**
 * 从一段 stderr 里挑出真正的错误行（去掉栈帧和 Node 版本尾巴）。
 * @param {string} text - 原始输出
 * @returns {string} 一两行说明
 */
function detailOf(text) {
  const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const useful = lines.filter(line => !line.startsWith('at ')
    && !line.startsWith('Node.js ')
    && !line.startsWith('code:')
    && line !== '}'
    && line !== '^')
  return (useful.length > 0 ? useful.slice(0, 2) : lines.slice(0, 2)).join(' | ')
}

/**
 * 跑一次金丝雀检查。
 * @param {object} mirror - 配置
 * @returns {Promise<object>} `{ ok, version, stage, error, ms, port, http, at }`
 */
export async function canaryCheck(mirror) {
  const startedAt = Date.now()
  const paths = canaryPaths()
  await ensureDirs(paths.app, paths.home, paths.work, paths.logs, path.join(paths.home, 'profiles'))
  const result = {
    at: isoNow(),
    version: mirror.dsh.version,
    ok: false,
    stage: '',
    error: '',
    ms: 0,
    port: 0,
    http: 0,
  }
  try {
    const current = await installedVersionAt(paths.app)
    if (current !== mirror.dsh.version) {
      result.stage = 'install-version'
      await log('canary', `装 DSH ${mirror.dsh.version} 到金丝雀实例（当前 ${current || '空'}）`)
      if (!(await installDsh(mirror, current, paths.app))) throw new Error(`金丝雀装不上 DSH ${mirror.dsh.version}`)
    }

    const local = await readJson(PATHS.localConfig, {})
    const dietQq = typeof local.dietQq === 'string' && local.dietQq.trim() !== ''
      ? local.dietQq.trim()
      : String(mirror.data.dietQq)
    result.stage = 'install-profile'
    await writeCanaryProfile(mirror, paths, dietQq)
    if (!(await installProfileDeps(mirror.profile.name, { appDir: paths.app, homeDir: paths.home }))) {
      throw new Error('金丝雀的 profile 依赖装不上')
    }

    const bin = path.join(paths.app, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    result.stage = 'dump-config'
    const dump = await run(process.execPath, [bin, '--profile', mirror.profile.name, '--dump-config'], {
      cwd: paths.app,
      env: { ...process.env, DSH_HOME: paths.home },
      timeoutMs: 180000,
    })
    if (dump.code !== 0) {
      const detail = detailOf(dump.stderr || dump.stdout)
      throw new Error(`金丝雀 --dump-config 失败：${detail}`)
    }
    const combined = `${dump.stdout}\n${dump.stderr}`
    if (/cannot resolve/i.test(combined)) throw new Error('金丝雀配置里有 cannot resolve')
    if (mirror.plugins.some(plugin => plugin.enabled === true && plugin.name === '@local/dsh-balance') && !/dsh-balance/.test(dump.stdout)) {
      throw new Error('金丝雀配置里没有 dsh-balance，插件没挂上')
    }

    result.stage = 'boot'
    const port = await pickPort(mirror)
    result.port = port
    if ((await listenersOf(port)).length > 0) await stopPort(port)
    const logFile = path.join(paths.logs, `canary-${Date.now()}.log`)
    const handle = await fs.open(logFile, 'a')
    const child = spawn(process.execPath, [
      bin, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open',
    ], {
      cwd: paths.work,
      env: { ...process.env, DSH_HOME: paths.home },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', handle.fd, handle.fd],
    })
    child.unref()
    await handle.close()

    const timeoutSec = Number(mirror.canary?.timeoutSec) || 120
    const deadline = Date.now() + timeoutSec * 1000
    let http = 0
    while (Date.now() < deadline) {
      http = await probeDsh(port, 1500)
      if (http === 200 || http === 401) break
      await sleep(1500)
    }
    if (http !== 200 && http !== 401) {
      const text = await readText(logFile)
      throw new Error(`金丝雀起不来（HTTP ${http}）：${text.trim().split(/\r?\n/).slice(-3).join(' | ')}`)
    }
    result.http = http
    result.ok = true
    result.stage = 'done'
    await log('canary', `通过：DSH ${mirror.dsh.version}，端口 ${port}，耗时 ${Date.now() - startedAt}ms`)
    return result
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    await log('canary', `失败（${result.stage}）：${result.error}`)
    return result
  } finally {
    result.ms = Date.now() - startedAt
    if (result.port > 0) await stopPort(result.port).catch(() => {})
    await writeJson(PATHS.canaryResult, result)
  }
}

// 直接运行：`node tools/canary.mjs`
const isMain = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const mirror = await readJson(PATHS.mirror)
  const result = await canaryCheck(mirror)
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}
