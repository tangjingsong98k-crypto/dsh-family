/**
 * 把 `mirror.json` 落到这台机器上：DSH 版本、profile 的依赖与补丁层。
 *
 * 幂等：内容没变就什么都不做（只做几个文件比对），变了的项会打印出来。
 * `agent.mjs` 每次收敛都会跑它；`install.mjs` 首次安装也跑它。
 *
 * 用法：
 *   node tools/apply.mjs            # 应用
 *   node tools/apply.mjs --check    # 只报告要不要动，不动手
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  KIT_ROOT,
  PATHS,
  ensureDirs,
  installedDshVersion,
  loadMirror,
  log,
  readJson,
  readText,
  run,
  treeHash,
  writeJson,
  writeText,
} from './common.mjs'
import { renderLocalStats } from './render-stats.mjs'

/**
 * 读一个文件的文本，不存在返回空串。
 * @param {string} file - 路径
 * @returns {Promise<string>} 文本
 */
async function textOf(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * npm 的可执行入口：用当前 node 自带的 npm-cli.js，避免 `.cmd` 的 shell 问题。
 * @returns {string} npm-cli.js 路径
 */
function npmCli() {
  return path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

/**
 * 装指定版本的 DSH 到 `runtime/app`。
 *
 * npm 在国内网络下偶尔会卡在一个没有超时的 fetch 上（实测挂过十几分钟），
 * 所以这里做两件事：给每次请求加超时和重试；镜像源失败就自动退回官方源。
 *
 * @param {object} mirror - 配置
 * @param {string} current - 已安装版本（空串表示没装）
 * @returns {Promise<boolean>} 是否装上
 */
async function installDsh(mirror, current) {
  await ensureDirs(PATHS.app)
  await writeJson(path.join(PATHS.app, 'package.json'), {
    name: 'dsh-family-app',
    private: true,
    version: '0.0.0',
    dependencies: { '@deepseek-ai/dsh': mirror.dsh.version },
  })
  const local = await readJson(PATHS.localConfig, {})
  const configured = typeof local.npmRegistry === 'string' && local.npmRegistry.trim() !== ''
    ? local.npmRegistry.trim()
    : typeof mirror.dsh.npmRegistry === 'string' ? mirror.dsh.npmRegistry.trim() : ''
  const registries = []
  if (configured !== '') registries.push(configured)
  if (!registries.includes('https://registry.npmmirror.com')) registries.push('https://registry.npmmirror.com')
  if (!registries.includes('https://registry.npmjs.org')) registries.push('https://registry.npmjs.org')

  const baseArgs = [
    npmCli(), 'install', '--save-exact', '--no-audit', '--no-fund', '--loglevel=error',
    '--fetch-timeout=60000', '--fetch-retries=3', '--fetch-retry-mintimeout=2000',
    '--fetch-retry-maxtimeout=20000', '--maxsockets=8',
  ]
  await log('apply', `安装 DSH ${current === '' ? '(无)' : current} -> ${mirror.dsh.version}（npm，可能要几分钟）`)
  for (const registry of registries) {
    await log('apply', `  registry: ${registry}`)
    const result = await run(process.execPath, [...baseArgs, `--registry=${registry}`], {
      cwd: PATHS.app,
      timeoutMs: 10 * 60 * 1000,
      // 这台机器上 IPv6 通一半：npm 会连上一堆 IPv6 socket 然后停在原地不动。
      // 强制 DNS 先给 IPv4，实测能把「卡十分钟」变回「一两分钟」。
      env: { ...process.env, NODE_OPTIONS: withIpv4First(process.env.NODE_OPTIONS) },
    })
    const installed = await installedDshVersion()
    if (result.code === 0 && installed === mirror.dsh.version) return true
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-4).join(' | ')
    await log('apply', `  失败（exit ${result.code}，装在 ${installed || '空'}）：${detail}`)
  }
  return false
}

/**
 * 把 `--dns-result-order=ipv4first` 并进已有的 NODE_OPTIONS。
 * @param {string|undefined} current - 现有值
 * @returns {string} 合并后的值
 */
function withIpv4First(current) {
  const flag = '--dns-result-order=ipv4first'
  const text = typeof current === 'string' ? current.trim() : ''
  return text === '' || text.includes(flag) ? (text === '' ? flag : text) : `${text} ${flag}`
}

/**
 * 生成 profile 的 `package.json` 内容。
 * @param {object} mirror - 配置
 * @returns {object} 清单
 */
function profileManifest(mirror) {
  const dependencies = {}
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  for (const plugin of mirror.plugins) {
    if (plugin.enabled !== true) continue
    dependencies[plugin.name] = plugin.spec
    if (plugin.bundle !== false) bundles.push(plugin.name)
  }
  return {
    name: `dsh-profile-${mirror.profile.name}`,
    private: true,
    dependencies,
    dsh: { profile: { bundles, patchReload: 'live' } },
  }
}

/**
 * 渲染补丁层：模板里的占位符换成真实路径与配置值。
 * @param {string} template - 模板文本
 * @param {object} mirror - 配置
 * @param {string} dietQq - 这台设备该看谁的饮食（设备本地配置优先）
 * @returns {string} 渲染结果
 */
function renderPatch(template, mirror, dietQq) {
  const kit = KIT_ROOT.replace(/\\/g, '/')
  const data = PATHS.data.replace(/\\/g, '/')
  return template
    .split('{{KIT}}').join(kit)
    .split('{{DATA}}').join(data)
    .split('{{DIET_QQ}}').join(String(dietQq))
    .split('{{KEEP_DAYS}}').join(String(mirror.data.keepDays))
}

/**
 * 应用一次。
 * @param {object} options - `{ check }`
 * @returns {Promise<{ changed: boolean, versionChanged: boolean, reasons: string[] }>} 结果
 */
export async function apply({ check = false } = {}) {
  const mirror = await loadMirror()
  const reasons = []
  let versionChanged = false

  await ensureDirs(PATHS.runtime, PATHS.home, PATHS.work, PATHS.logs, PATHS.data, PATHS.status, PATHS.ops)

  const currentVersion = await installedDshVersion()
  if (currentVersion !== mirror.dsh.version) {
    reasons.push(`DSH ${currentVersion || '(未装)'} -> ${mirror.dsh.version}`)
    versionChanged = true
    if (!check) {
      const ok = await installDsh(mirror, currentVersion)
      if (!ok) throw new Error(`DSH ${mirror.dsh.version} 安装失败，见 logs/apply.log`)
    }
  }

  const profileDir = path.join(PATHS.home, 'profiles', mirror.profile.name)
  await ensureDirs(profileDir)
  const manifest = profileManifest(mirror)
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  const manifestFile = path.join(profileDir, 'package.json')
  const manifestBefore = await textOf(manifestFile)
  if (manifestBefore !== manifestText) {
    reasons.push('profile 依赖/插件清单有变化')
    if (!check) await writeText(manifestFile, manifestText)
  }

  const rootCordis = path.join(profileDir, 'cordis.yml')
  if ((await textOf(rootCordis)).trim() === '') {
    if (!check) await writeText(rootCordis, '# dsh profile root — 由 family-kit 管理，补丁写在 cordis.patch.yml\n[]\n')
  }

  // pnpm 的解析方式必须和 DSH 官方 profile 一致：hoisted 才能让 bundle 正常
  // 解析到自己声明的 peer；autoInstallPeers 关掉，避免悄悄装一堆没声明的包。
  const workspaceFile = path.join(profileDir, 'pnpm-workspace.yaml')
  const workspaceText = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
  if ((await textOf(workspaceFile)) !== workspaceText) {
    if (!check) await writeText(workspaceFile, workspaceText)
  }

  const template = await readText(PATHS.profileTemplate)
  if (template === '') throw new Error(`缺少补丁模板：${PATHS.profileTemplate}`)
  // 每台设备看谁的饮食是「设备本地」的事：config.local.json 的 dietQq 优先，
  // 没配才用仓库里的全局默认（mirror.json.data.dietQq）。
  const local = await readJson(PATHS.localConfig, {})
  const dietQq = typeof local.dietQq === 'string' && local.dietQq.trim() !== ''
    ? local.dietQq.trim()
    : String(mirror.data.dietQq)
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const patchText = renderPatch(template, mirror, dietQq)
  const patchBefore = await textOf(patchFile)
  if (patchBefore !== patchText) {
    reasons.push('cordis.patch.yml 有变化')
    if (!check) await writeText(patchFile, patchText)
  }

  if (!check) {
    // 设备自己的统计页：用本地快照 + 本地账本，按这台设备选的 QQ 算一遍。
    await renderLocalStats({ dietQq })
    const page = path.join(PATHS.data, 'stats', 'local.html')
    const url = pathToFileURL(page).href
    await writeText(path.join(PATHS.kit, '打开统计.url'), `[InternetShortcut]\r\nURL=${url}\r\n`)
  }

  const pluginHash = await treeHash(PATHS.plugins)
  const state = await readJson(PATHS.state, {})
  if (state.pluginHash !== undefined && state.pluginHash !== pluginHash) {
    reasons.push('插件源码有变化')
  }

  const needsInstall = !check && (manifestBefore !== manifestText
    || !(await pathExists(path.join(profileDir, 'node_modules'))))
  if (needsInstall && manifestBefore === manifestText) reasons.push('profile 依赖首次安装')

  if (needsInstall) {
    await log('apply', 'pnpm 安装 profile 依赖（首次或清单变化时）')
    const result = await run(process.execPath, [
      PATHS.installedBin,
      'plugin',
      '--profile',
      mirror.profile.name,
      'install',
    ], {
      cwd: PATHS.app,
      env: {
        ...process.env,
        DSH_HOME: PATHS.home,
        NODE_OPTIONS: withIpv4First(process.env.NODE_OPTIONS),
      },
      timeoutMs: 20 * 60 * 1000,
    })
    if (result.code !== 0) {
      await log('apply', `pnpm install 失败（exit ${result.code}）：${(result.stderr || result.stdout).slice(-1500)}`)
      throw new Error('profile 依赖安装失败，见 logs/apply.log')
    }
  }

  if (!check) {
    await writeJson(PATHS.state, {
      appliedAt: new Date().toISOString(),
      dshVersion: mirror.dsh.version,
      dietQq,
      manifestHash: await treeHash(profileDir),
      pluginHash,
      pluginCount: mirror.plugins.filter(plugin => plugin.enabled === true).length,
    })
  }

  return { changed: reasons.length > 0, versionChanged, reasons }
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

// 直接运行：`node tools/apply.mjs [--check]`
const isMain = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const check = process.argv.includes('--check')
  try {
    const result = await apply({ check })
    const prefix = check ? '[check] ' : ''
    if (!result.changed) await log('apply', `${prefix}已经是最新，无需改动`)
    else await log('apply', `${prefix}需要改动：${result.reasons.join('；')}`)
    process.exit(0)
  } catch (error) {
    await log('apply', `失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
