/**
 * 安全网：让一个「不会用电脑」的朋友的 DSH 永远能打开。
 *
 * 三件事：
 *  1. 每次成功启动后把 profile 的三个文件存成「上次好使的快照」（runtime/last-good/）；
 *  2. 改了版本/插件之后，起服务并真的等它应答；超时就自动回滚到快照、再起一次；
 *  3. 连快照都起不来（例如 DSH 自己是坏的）就进「安全模式」：只用 base + web-app
 *     两个官方 bundle 起一个干净界面，保证人能看到东西，再由主电脑远程修。
 *
 * 回滚之后会写一个 hold：同一个「期望配置」不再反复重试，直到主电脑下一次改
 * mirror.json（指纹变了）才重新尝试。这样不会出现「每两分钟重启一次」的循环。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  PATHS,
  ensureDirs,
  installedDshVersion,
  isoNow,
  log,
  npmCliPath,
  probeDsh,
  readJson,
  readText,
  run,
  sleep,
  writeJson,
  writeText,
} from './common.mjs'

/** 回滚快照里要带的文件（node_modules 不拷，回滚时用 pnpm 重装）。 */
const PROFILE_FILES = ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']

/** 安全模式的最小 profile：只有官方两个 bundle。 */
const SAFE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/**
 * profile 目录。
 * @param {string} name - profile 名
 * @returns {string} 目录
 */
export function profileDir(name) {
  return path.join(PATHS.home, 'profiles', name)
}

/**
 * 期望配置的指纹：manifest + 补丁层。变了就说明主电脑换了东西。
 * @param {string} manifestText - profile package.json
 * @param {string} patchText - cordis.patch.yml
 * @returns {string} 指纹
 */
export function configFingerprint(manifestText, patchText) {
  let hash = 0
  const text = `${manifestText}\n${patchText}`
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 读 hold（回滚后暂停应用）。
 * @returns {Promise<{ cleared?: boolean, fingerprint?: string, at?: string, reason?: string } | null>} hold
 */
export function readHold() {
  return readJson(PATHS.hold, null)
}

/**
 * 写 hold。
 * @param {object} value - 内容
 * @returns {Promise<void>} 完成
 */
export function writeHold(value) {
  return writeJson(PATHS.hold, value)
}

/**
 * 读安全状态。
 * @returns {Promise<{ mode?: string, lastGoodAt?: string, version?: string, reason?: string }>} 状态
 */
export async function readSafety() {
  return readJson(PATHS.safety, {})
}

/**
 * 合并写安全状态。
 * @param {object} patch - 字段
 * @returns {Promise<object>} 写后的状态
 */
export async function writeSafety(patch) {
  const current = await readSafety()
  const next = { ...current, ...patch }
  await writeJson(PATHS.safety, next)
  return next
}

/**
 * 读启动失败计数。
 * @returns {Promise<{ count: number, at?: string }>} 计数
 */
export async function readFailures() {
  return readJson(PATHS.failures, { count: 0 })
}

/**
 * 写启动失败计数。
 * @param {number} count - 次数
 * @returns {Promise<void>} 完成
 */
export function writeFailures(count) {
  return writeJson(PATHS.failures, { count, at: isoNow() })
}

/**
 * 把当前 profile 存成「上次好使」的快照。
 * @param {object} options - `{ profileName }`
 * @returns {Promise<void>} 完成
 */
export async function saveLastGood({ profileName }) {
  const source = profileDir(profileName)
  await ensureDirs(PATHS.lastGood)
  let copied = 0
  for (const name of PROFILE_FILES) {
    const text = await readText(path.join(source, name))
    if (text === '') continue
    await writeText(path.join(PATHS.lastGood, name), text)
    copied += 1
  }
  const version = await installedDshVersion()
  await writeJson(path.join(PATHS.lastGood, 'meta.json'), {
    savedAt: isoNow(),
    dshVersion: version,
    profileName,
    files: copied,
  })
  await writeSafety({ lastGoodAt: isoNow(), version, mode: 'normal' })
  await writeFailures(0)
}

/**
 * 装一个指定版本的 DSH（回滚时用）。
 * @param {string} version - 版本
 * @returns {Promise<boolean>} 成功与否
 */
async function installVersion(version) {
  if (version === '') return false
  const current = await installedDshVersion()
  if (current === version) return true
  await writeJson(path.join(PATHS.app, 'package.json'), {
    name: 'dsh-family-app',
    private: true,
    version: '0.0.0',
    dependencies: { '@deepseek-ai/dsh': version },
  })
  await log('safety', `回滚 DSH ${current || '(空)'} -> ${version}`)
  const result = await run(process.execPath, [
    npmCliPath(), 'install', '--save-exact', '--no-audit', '--no-fund', '--loglevel=error',
    '--fetch-timeout=60000', '--fetch-retries=2', '--registry=https://registry.npmmirror.com',
  ], { cwd: PATHS.app, timeoutMs: 10 * 60 * 1000 })
  return result.code === 0 && (await installedDshVersion()) === version
}

/**
 * 装 profile 依赖（改了 package.json 之后必须跑）。
 * @param {string} profileName - profile 名
 * @param {object} mirror - 配置（读端口等）
 * @returns {Promise<boolean>} 成功与否
 */
export async function installProfileDeps(profileName) {
  const result = await run(process.execPath, [
    PATHS.installedBin, 'plugin', '--profile', profileName, 'install',
  ], {
    cwd: PATHS.app,
    env: { ...process.env, DSH_HOME: PATHS.home },
    timeoutMs: 10 * 60 * 1000,
  })
  if (result.code !== 0) {
    await log('safety', `pnpm install 失败：${(result.stderr || result.stdout).slice(-800)}`)
    return false
  }
  return true
}

/**
 * 回滚到上次好使的快照。
 * @param {object} options - `{ profileName }`
 * @returns {Promise<{ ok: boolean, version?: string, reason?: string }>} 结果
 */
export async function restoreLastGood({ profileName }) {
  const meta = await readJson(path.join(PATHS.lastGood, 'meta.json'), null)
  if (meta === null) return { ok: false, reason: '还没有「上次好使」的快照' }
  let restored = 0
  for (const name of PROFILE_FILES) {
    const text = await readText(path.join(PATHS.lastGood, name))
    if (text === '') continue
    await writeText(path.join(profileDir(profileName), name), text)
    restored += 1
  }
  if (restored === 0) return { ok: false, reason: '快照是空的' }
  const versionOk = await installVersion(String(meta.dshVersion ?? ''))
  const depsOk = await installProfileDeps(profileName)
  return {
    ok: versionOk && depsOk,
    version: String(meta.dshVersion ?? ''),
    reason: versionOk ? (depsOk ? '' : '依赖回滚失败') : '版本回滚失败',
  }
}

/**
 * 进安全模式：只用官方两个 bundle 起一个干净界面。
 * @param {object} options - `{ profileName }`
 * @returns {Promise<boolean>} 成功与否
 */
export async function enterSafeMode({ profileName }) {
  const dir = profileDir(profileName)
  await ensureDirs(dir)
  await writeText(path.join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${profileName}`,
    private: true,
    dsh: { profile: { bundles: SAFE_BUNDLES } },
  }, null, 2)}\n`)
  await writeText(path.join(dir, 'cordis.yml'), '# 安全模式：由 family-kit 生成\n[]\n')
  await writeText(path.join(dir, 'cordis.patch.yml'), '# 安全模式：不加载任何第三方插件\n[]\n')
  await writeText(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  const ok = await installProfileDeps(profileName)
  await writeSafety({ mode: 'safe', reason: '连续启动失败，已切到安全模式', at: isoNow() })
  await log('safety', ok ? '已进入安全模式（只剩官方 bundle）' : '安全模式装配失败')
  return ok
}

/**
 * 把安全模式标记清掉（下一次收敛按 mirror.json 重新装回来）。
 * @returns {Promise<void>} 完成
 */
export function markNormal() {
  return writeSafety({ mode: 'normal', reason: '', at: isoNow() })
}

/**
 * 起服务之后等它真的应答。
 * @param {number} port - 端口
 * @param {number} timeoutSec - 最多等几秒
 * @returns {Promise<boolean>} 是否应答
 */
export async function waitBoot(port, timeoutSec) {
  const deadline = Date.now() + Math.max(10, Number(timeoutSec) || 75) * 1000
  while (Date.now() < deadline) {
    const http = await probeDsh(port, 1500)
    if (http === 200 || http === 401) return true
    await sleep(1500)
  }
  return false
}

/**
 * 快照目录是否存在（状态里给主电脑看）。
 * @returns {Promise<boolean>} 有没有
 */
export async function hasLastGood() {
  try {
    await fs.access(path.join(PATHS.lastGood, 'meta.json'))
    return true
  } catch {
    return false
  }
}
