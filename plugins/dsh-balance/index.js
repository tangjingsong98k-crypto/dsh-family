/**
 * dsh-balance —— 记账插件的 Host 半边。
 *
 * 三样东西：
 * 1. 账本存储：一个 JSON 文件（默认 `C:\custom\workzone\balance\ledger.json`）。
 *    读改写都排在同一把异步队列里，落盘走「临时文件 + rename」，写到一半断电也不会
 *    留下半个账本；文件坏了就明确报错，绝不默默覆盖。
 * 2. 面板接口：`POST /balance/<endpoint>`（load / save / remove / summary / info），
 *    body 是端点参数，回 `{ ok: true, value }` 或 `{ ok: false, error }`。
 *    鉴权交给 DSH 的 connection 服务（登录 cookie + Host/Origin 校验）；
 *    没有该服务的组合里只接受回环地址。
 * 3. 四个 Agent 工具：balance_add / balance_list / balance_edit / balance_summary。
 *    它们和面板调用的是同一个账本对象、同一套校验（操作只实现一次）。
 *
 * 约定：日期一律是本地日历日 `YYYY-MM-DD`；金额一律是「元」，落盘保留两位小数，
 * 求和时先换成整数「分」再算，避免 0.1 + 0.2 这类浮点误差。
 */

import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** 插件名（日志用；loader 行的 id 在 cordis.patch.yml 里）。 */
export const name = 'dsh-balance'

/** 必需服务：工具注册表。面板用的 HTTP 路由另在 apply 里等 webServer（见下）。 */
export const inject = ['tools']

/** 面板接口前缀（`POST /balance/<endpoint>`）。 */
export const CHANNEL = '/balance'

/** 请求体上限：面板一次只传一条账目/一个年份，给宽一点也不该超过这个数。 */
const MAX_BODY_BYTES = 256 * 1024

/** 默认账本目录：用户要求的 workzone/balance。可在 cordis.patch.yml 的 config.root 改。 */
const DEFAULT_ROOT = 'C:\\custom\\workzone\\balance'
/** 账本文件名：一个文件装全部账目，方便备份和手工查看。 */
const LEDGER_FILE = 'ledger.json'
/** 数据目录里的说明文件（只在它不存在时写一次，不覆盖用户内容）。 */
const DATA_README = 'README.md'

/** 饮食面板：汐汐的饮食库在 AstrBot 容器里，宿主通过 docker exec 调它的 CLI（避免跨挂载写 WAL）。 */
const DOCKER_BIN = process.env.DSH_BALANCE_DOCKER || 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
const DIET_CONTAINER = process.env.DSH_BALANCE_DIET_CONTAINER || 'astrbot'
const DIET_PLUGIN_DIR = '/AstrBot/data/plugins/astrbot_plugin_diet_log'
const DIET_QQ = process.env.DSH_BALANCE_DIET_QQ || '99132013'
const DIET_TIMEOUT_MS = 20000
/** DSH 的同步回合接口（xixi 桥）：重新估算时用它跑一遍 headless 会话。 */
const XIXI_SECRET_FILE = 'C:\\custom\\dsh\\mcp\\xixi\\ping.secret'
const XIXI_TURN_URL = 'http://127.0.0.1:3087/turn'
const DSH_TURN_TIMEOUT_MS = 90000

/**
 * 只读镜像模式的提示语。
 *
 * 家人电脑拿到的是主电脑同步过来的数据快照（`dietSnapshot` + 只读账本），
 * 面板照常能看，但任何写操作都会被这句话挡回去——真实记录只有 QQ 里的汐汐一份，
 * 两边都能写的话，下一次同步就会把家人刚记的东西覆盖掉。
 */
const READONLY_MESSAGE = '这是只读镜像：账本和饮食数据都从主电脑同步过来；要记账或改饮食，请在 QQ 里找汐汐。'

/** 收支两种类型。 */
const KINDS = ['expense', 'income']
/** 单笔金额上限（元）：挡住手滑多打几个零。 */
const MAX_AMOUNT = 1000000000
/** 分类、备注的长度上限。 */
const MAX_CATEGORY = 32
const MAX_NOTE = 200
/** list / summary 一次最多返回多少笔。 */
const LIST_DEFAULT_LIMIT = 200
const LIST_MAX_LIMIT = 1000
/** summary 里附带最近几个月的收支趋势。 */
const RECENT_MONTHS = 6

/** 记账默认分类建议（面板的快捷选项；账本里用哪个分类不受限制）。 */
const DEFAULT_CATEGORIES = {
  expense: ['餐饮', '交通', '购物', '日用', '住房', '水电', '通讯', '娱乐', '医疗', '教育', '人情', '其他'],
  income: ['工资', '奖金', '兼职', '理财', '红包', '报销', '其他收入'],
}

/** 日期格式：四位年-两位月-两位日。 */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
/** 月份格式：四位年-两位月。 */
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/

/**
 * 账本自身的业务错误：带一个稳定的 code，RPC 和工具都会把它原样往外传。
 */
export class BalanceError extends Error {
  /**
   * @param {string} code - 稳定错误码，例如 `balance/bad-amount`。
   * @param {string} message - 给人看的中文说明。
   */
  constructor(code, message) {
    super(message)
    this.name = 'BalanceError'
    this.code = code
  }
}

/**
 * 抛一个业务错误。
 * @param {string} code - 错误码
 * @param {string} message - 说明
 * @returns {never} 不会返回
 */
function fail(code, message) {
  throw new BalanceError(code, message)
}

// ---------------------------------------------------------------------------
// 日期
// ---------------------------------------------------------------------------

/**
 * 补零到两位。
 * @param {number} value - 数字
 * @returns {string} 两位字符串
 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * 判断一个字符串是不是真实存在的日历日（会挡住 2 月 30 日这种）。
 * @param {unknown} value - 候选值
 * @returns {boolean} 是否合法
 */
function isValidDate(value) {
  if (typeof value !== 'string') return false
  const matched = DATE_PATTERN.exec(value)
  if (matched === null) return false
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  if (year < 1900 || year > 2999 || month < 1 || month > 12 || day < 1) return false
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * 判断一个字符串是不是合法的月份。
 * @param {unknown} value - 候选值
 * @returns {boolean} 是否合法
 */
function isValidMonth(value) {
  if (typeof value !== 'string') return false
  const matched = MONTH_PATTERN.exec(value)
  if (matched === null) return false
  const year = Number(matched[1])
  const month = Number(matched[2])
  return year >= 1900 && year <= 2999 && month >= 1 && month <= 12
}

/**
 * 本地时区的今天（不是 UTC 的今天）。
 * @param {Date} [now] - 注入时间，测试用
 * @returns {string} `YYYY-MM-DD`
 */
function todayString(now = new Date()) {
  return `${String(now.getFullYear()).padStart(4, '0')}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

/**
 * 账本日期入参：缺省用今天，给了就必须是真日历日。
 * @param {unknown} value - 入参
 * @param {string} [fallback] - 缺省值
 * @returns {string} 合法日期
 */
function requireDate(value, fallback = todayString()) {
  if (value === undefined || value === null || value === '') return fallback
  if (!isValidDate(value)) {
    fail('balance/bad-date', `日期必须是真实存在的日历日，格式 YYYY-MM-DD（收到 ${JSON.stringify(value)}）。`)
  }
  return value
}

/**
 * 查询条件里的可选日期。
 * @param {unknown} value - 入参
 * @param {string} label - 出错时怎么称呼它
 * @returns {string|undefined} 合法日期或 undefined
 */
function optionalDate(value, label) {
  if (value === undefined || value === null || value === '') return undefined
  if (!isValidDate(value)) {
    fail('balance/bad-date', `${label} 必须是 YYYY-MM-DD 的真实日期（收到 ${JSON.stringify(value)}）。`)
  }
  return value
}

/**
 * 年份入参：缺省用今年。
 * @param {unknown} value - 入参
 * @returns {number} 年份
 */
function requireYear(value) {
  if (value === undefined || value === null || value === '') return new Date().getFullYear()
  const year = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof year !== 'number' || !Number.isInteger(year) || year < 1900 || year > 2999) {
    fail('balance/bad-year', `年份必须是 1900–2999 的整数（收到 ${JSON.stringify(value)}）。`)
  }
  return year
}

/**
 * 月份入参：缺省用本月。
 * @param {unknown} value - 入参
 * @returns {string} `YYYY-MM`
 */
function requireMonth(value) {
  if (value === undefined || value === null || value === '') {
    const today = todayString()
    return today.slice(0, 7)
  }
  if (!isValidMonth(value)) {
    fail('balance/bad-month', `月份格式必须是 YYYY-MM（收到 ${JSON.stringify(value)}）。`)
  }
  return value
}

/**
 * 一个月的日期闭区间。
 * @param {string} month - `YYYY-MM`
 * @returns {{ from: string, to: string }} 首日与末日
 */
function monthBounds(month) {
  const year = Number(month.slice(0, 4))
  const monthNumber = Number(month.slice(5, 7))
  const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${pad2(last)}` }
}

/**
 * 从某个月往前数 N 个月（含当月），按时间正序。
 * @param {string} month - `YYYY-MM`
 * @param {number} count - 几个月
 * @returns {string[]} `YYYY-MM` 列表
 */
function recentMonthList(month, count) {
  const year = Number(month.slice(0, 4))
  const monthNumber = Number(month.slice(5, 7))
  const list = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(year, monthNumber - 1 - offset, 1))
    list.push(`${String(date.getUTCFullYear()).padStart(4, '0')}-${pad2(date.getUTCMonth() + 1)}`)
  }
  return list
}

// ---------------------------------------------------------------------------
// 金额
// ---------------------------------------------------------------------------

/**
 * 元 → 四舍五入到分。
 * @param {number} value - 元
 * @returns {number} 两位小数
 */
function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * 元 → 整数分（求和用）。
 * @param {number} value - 元
 * @returns {number} 分
 */
function centsOf(value) {
  return Math.round(value * 100)
}

/**
 * 金额入参校验。
 * @param {unknown} value - 入参
 * @returns {number} 合法的正金额（元，两位小数）
 */
function requireAmount(value) {
  const amount = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    fail('balance/bad-amount', `金额必须是数字（单位：元），收到 ${JSON.stringify(value)}。`)
  }
  const rounded = round2(amount)
  if (rounded <= 0) fail('balance/bad-amount', '金额必须大于 0。')
  if (rounded > MAX_AMOUNT) fail('balance/bad-amount', `单笔金额不能超过 ${MAX_AMOUNT} 元。`)
  return rounded
}

/**
 * 收/支类型入参：缺省算支出，也认中文和 in/out。
 * @param {unknown} value - 入参
 * @returns {'expense'|'income'} 类型
 */
function requireKind(value) {
  if (value === undefined || value === null || value === '') return 'expense'
  const kind = String(value).trim().toLowerCase()
  if (kind === 'expense' || kind === 'out' || kind === '支出' || kind === '花费') return 'expense'
  if (kind === 'income' || kind === 'in' || kind === '收入') return 'income'
  fail('balance/bad-kind', `kind 只能是 expense（支出）或 income（收入），收到 ${JSON.stringify(value)}。`)
}

/**
 * 单行文本入参（分类/备注）：折叠空白、去首尾、限长。
 * @param {unknown} value - 入参
 * @param {number} max - 长度上限
 * @param {string} label - 字段名
 * @returns {string} 规整后的文本
 */
function requireText(value, max, label) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    fail(`balance/bad-${label}`, `${label} 必须是字符串，收到 ${JSON.stringify(value)}。`)
  }
  const text = value.replace(/\s+/gu, ' ').trim()
  if (text.length > max) fail(`balance/bad-${label}`, `${label} 最多 ${max} 个字符（收到 ${text.length} 个）。`)
  return text
}

/**
 * 历史备注（去重，按最近使用排前面）：给面板的备注输入做自动推荐。
 * @param {ReadonlyArray<object>} entries - 全部账目
 * @returns {string[]} 备注列表
 */
function notesOf(entries) {
  const latest = new Map()
  for (const entry of entries) {
    const note = typeof entry.note === 'string' ? entry.note.trim() : ''
    if (note === '') continue
    const at = String(entry.updatedAt ?? entry.createdAt ?? '')
    const previous = latest.get(note)
    if (previous === undefined || at > previous) latest.set(note, at)
  }
  return [...latest.entries()]
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .map(([note]) => note)
    .slice(0, 300)
}

/**
 * 一组成目的收入/支出/结余。
 * @param {ReadonlyArray<object>} entries - 账目
 * @returns {{ income: number, expense: number, net: number }} 三项合计（元）
 */
function totalsOf(entries) {
  let income = 0
  let expense = 0
  for (const entry of entries) {
    if (entry.kind === 'income') income += centsOf(entry.amount)
    else expense += centsOf(entry.amount)
  }
  return { income: income / 100, expense: expense / 100, net: (income - expense) / 100 }
}

/**
 * 按「类型 + 分类」汇总，金额从大到小。
 * @param {ReadonlyArray<object>} entries - 账目
 * @returns {Array<{ kind: string, category: string, amount: number, count: number }>} 汇总行
 */
function categoriesOf(entries) {
  const buckets = new Map()
  for (const entry of entries) {
    const category = entry.category === '' ? '' : entry.category
    const key = `${entry.kind}\u0000${category}`
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, { kind: entry.kind, category, amount: centsOf(entry.amount), count: 1 })
    else {
      bucket.amount += centsOf(entry.amount)
      bucket.count += 1
    }
  }
  return [...buckets.values()]
    .map(bucket => ({ ...bucket, amount: bucket.amount / 100 }))
    .sort((left, right) => right.amount - left.amount)
}

/**
 * 按天汇总（只列有账目的日子），日期正序。
 * @param {ReadonlyArray<object>} entries - 账目
 * @returns {Array<{ date: string, income: number, expense: number }>} 每天一行
 */
function daysOf(entries) {
  const buckets = new Map()
  for (const entry of entries) {
    const bucket = buckets.get(entry.date) ?? { date: entry.date, income: 0, expense: 0 }
    bucket[entry.kind] += centsOf(entry.amount)
    buckets.set(entry.date, bucket)
  }
  return [...buckets.values()]
    .map(bucket => ({ date: bucket.date, income: bucket.income / 100, expense: bucket.expense / 100 }))
    .sort((left, right) => left.date.localeCompare(right.date))
}

/** 日期升序（同一天按创建时间）。 */
function compareAscending(left, right) {
  return left.date.localeCompare(right.date) || left.createdAt.localeCompare(right.createdAt)
}

/** 日期降序（新账在前）。 */
function compareDescending(left, right) {
  return right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt)
}

// ---------------------------------------------------------------------------
// 账本存储
// ---------------------------------------------------------------------------

/** 数据目录说明文件的内容（首次建目录时写一份，帮用户看懂格式）。 */
const DATA_README_TEXT = `# 记账数据（dsh-balance）

- \`ledger.json\` —— 全部账目，一个文件；记账面板和 Agent 工具都直接读写它。
- 结构：\`{ "version": 1, "updatedAt": "...", "entries": [ ... ] }\`，
  每条账目是 \`{ id, date, kind, amount, category, note, createdAt, updatedAt }\`：
  - \`date\`：本地日历日 \`YYYY-MM-DD\`；
  - \`kind\`：\`expense\`（支出）或 \`income\`（收入）；
  - \`amount\`：金额，单位元，最多两位小数；
  - \`category\` / \`note\`：分类与备注，可以是空字符串。
- 手工编辑也可以：改完保存，下次打开面板或让 Agent 查账就会读到新内容。
  格式写坏（比如少了逗号、日期写成 2026-2-30）时插件会明确报错并指出是第几条，
  不会清空或覆盖你的文件。
- 备份：直接复制 ledger.json 即可；插件的写入是「临时文件 + 改名」的原子替换，
  不会留下写了一半的文件。
`

/**
 * 建一个账本对象。
 * @param {object} [rawConfig] - 插件行配置（`root` 可改账本目录）
 * @returns {object} 账本 API
 */
export function createLedger(rawConfig = {}) {
  const settings = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
  const configured = typeof settings.root === 'string' ? settings.root.trim() : ''
  const root = path.resolve(configured === '' ? DEFAULT_ROOT : configured)
  const file = path.join(root, LEDGER_FILE)
  /** 只读镜像（家人电脑）：面板和工具都能看，但 save/remove 直接给一句人话。 */
  const readOnly = settings.readOnly === true
  /** 写操作串行队列：读改写不会互相踩。 */
  let queue = Promise.resolve()
  /** README 是否已经确认过（每个进程只查一次）。 */
  let readmeReady = false

  /**
   * 排队执行一个可能写盘的任务。
   * @param {() => Promise<any>} task - 任务
   * @returns {Promise<any>} 任务结果
   */
  function exclusive(task) {
    const run = queue.then(task, task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * 读账本；文件不存在就是空账本，文件坏了就报错（不覆盖）。
   * @returns {Promise<{ version: number, entries: Array<object> }>} 账本内容
   */
  async function read() {
    let text
    try {
      text = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        return { version: 1, entries: [] }
      }
      fail('balance/read-failed', `读账本失败：${file}（${error instanceof Error ? error.message : String(error)}）`)
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      fail('balance/corrupt', `账本不是合法 JSON：${file}（${error instanceof Error ? error.message : String(error)}）。文件没动，请修好或改成空账本 {"version":1,"entries":[]} 后重试。`)
    }
    const rawEntries = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === 'object' ? parsed.entries : undefined
    if (!Array.isArray(rawEntries)) {
      fail('balance/corrupt', `账本缺少 entries 数组：${file}。文件没动，请修好后再试。`)
    }
    return { version: 1, entries: rawEntries.map((entry, index) => validateStored(entry, index, file)) }
  }

  /**
   * 校验文件里已有的账目（手工改坏了要指出是第几条）。
   * @param {unknown} entry - 原始条目
   * @param {number} index - 下标
   * @param {string} filePath - 文件路径（报错里带上）
   * @returns {object} 规整后的条目
   */
  function validateStored(entry, index, filePath) {
    const where = `${filePath} 第 ${index + 1} 条`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail('balance/corrupt', `${where}不是对象。`)
    const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : undefined
    if (id === undefined) fail('balance/corrupt', `${where}缺少 id。`)
    if (!isValidDate(entry.date)) fail('balance/corrupt', `${where}的 date 不是真实日期：${JSON.stringify(entry.date)}。`)
    const kind = requireKind(entry.kind)
    const amount = requireAmount(entry.amount)
    const createdAt = typeof entry.createdAt === 'string' && entry.createdAt !== '' ? entry.createdAt : new Date(0).toISOString()
    const updatedAt = typeof entry.updatedAt === 'string' && entry.updatedAt !== '' ? entry.updatedAt : createdAt
    return {
      id,
      date: entry.date,
      kind,
      amount,
      category: requireText(entry.category, MAX_CATEGORY, 'category'),
      note: requireText(entry.note, MAX_NOTE, 'note'),
      createdAt,
      updatedAt,
    }
  }

  /**
   * 原子写账本：先写临时文件再改名，读的人只会看到旧版本或新版本。
   * @param {Array<object>} entries - 全部账目
   * @returns {Promise<void>} 写完
   */
  async function write(entries) {
    await fs.mkdir(root, { recursive: true })
    if (!readmeReady) {
      readmeReady = true
      await writeReadme()
    }
    const payload = `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries }, null, 2)}\n`
    const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
    try {
      await fs.writeFile(temp, payload, 'utf8')
      await fs.rename(temp, file)
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {})
      fail('balance/write-failed', `写账本失败：${file}（${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  /**
   * 数据目录里放一份格式说明；已有 README.md 就不动。
   * @returns {Promise<void>} 完成
   */
  async function writeReadme() {
    const readmePath = path.join(root, DATA_README)
    try {
      await fs.access(readmePath)
      return
    } catch {
      // 不存在才写：不覆盖用户自己的说明。
    }
    await fs.writeFile(readmePath, DATA_README_TEXT, 'utf8')
  }

  /**
   * 读全部账目（读不需要排队：rename 是原子的）。
   * @returns {Promise<Array<object>>} 账目
   */
  async function readAll() {
    return (await read()).entries
  }

  /**
   * 造一个不会撞的 id。
   * @param {ReadonlyArray<object>} entries - 现有账目
   * @returns {string} 新 id
   */
  function newId(entries) {
    const used = new Set(entries.map(entry => entry.id))
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const id = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      if (!used.has(id)) return id
    }
    return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
  }

  /**
   * 把一次入参套到已有账目上（只改给了的字段）。
   * @param {object} base - 已有账目
   * @param {object} input - 入参
   * @returns {object} 新账目（未写盘）
   */
  function applyInput(base, input) {
    const next = { ...base }
    if (input.date !== undefined && input.date !== null) next.date = requireDate(input.date, base.date)
    if (input.kind !== undefined && input.kind !== null) next.kind = requireKind(input.kind)
    if (input.amount !== undefined && input.amount !== null) next.amount = requireAmount(input.amount)
    if (input.category !== undefined && input.category !== null) next.category = requireText(input.category, MAX_CATEGORY, 'category')
    if (input.note !== undefined && input.note !== null) next.note = requireText(input.note, MAX_NOTE, 'note')
    return next
  }

  /**
   * 读某一年（面板首屏用）：整年的账目 + 今天的日期 + 数据文件路径。
   * @param {unknown} rawYear - 年份
   * @returns {Promise<object>} 一年数据
   */
  async function loadYear(rawYear) {
    const year = requireYear(rawYear)
    const from = `${year}-01-01`
    const to = `${year}-12-31`
    const all = await readAll()
    const entries = all.filter(entry => entry.date >= from && entry.date <= to).sort(compareAscending)
    return {
      year,
      today: todayString(),
      from,
      to,
      file,
      root,
      entries,
      notes: notesOf(all),
      totals: totalsOf(entries),
      defaults: DEFAULT_CATEGORIES,
    }
  }

  /**
   * 新增或更新一条账目（有 id 就是更新）。
   * @param {object} rawInput - 账目字段
   * @returns {Promise<object>} 写好的账目
   */
  async function save(rawInput) {
    if (readOnly) fail('balance/readonly', READONLY_MESSAGE)
    if (rawInput === null || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
      fail('balance/bad-entry', '账目必须是一个对象。')
    }
    const input = rawInput
    const id = typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : undefined
    return exclusive(async () => {
      const data = await read()
      const now = new Date().toISOString()
      if (id === undefined) {
        const entry = {
          id: newId(data.entries),
          date: requireDate(input.date),
          kind: requireKind(input.kind),
          amount: requireAmount(input.amount),
          category: requireText(input.category, MAX_CATEGORY, 'category'),
          note: requireText(input.note, MAX_NOTE, 'note'),
          createdAt: now,
          updatedAt: now,
        }
        data.entries.push(entry)
        await write(data.entries)
        return entry
      }
      const index = data.entries.findIndex(entry => entry.id === id)
      if (index === -1) fail('balance/not-found', `没有 id 为 ${id} 的账目。`)
      const updated = { ...applyInput(data.entries[index], input), updatedAt: now }
      data.entries[index] = updated
      await write(data.entries)
      return updated
    })
  }

  /**
   * 删一条账目。
   * @param {unknown} rawId - 账目 id
   * @returns {Promise<object>} 被删掉的账目
   */
  async function remove(rawId) {
    if (readOnly) fail('balance/readonly', READONLY_MESSAGE)
    const id = typeof rawId === 'string' ? rawId.trim() : ''
    if (id === '') fail('balance/bad-id', '缺少账目 id。')
    return exclusive(async () => {
      const data = await read()
      const index = data.entries.findIndex(entry => entry.id === id)
      if (index === -1) fail('balance/not-found', `没有 id 为 ${id} 的账目。`)
      const [removed] = data.entries.splice(index, 1)
      await write(data.entries)
      return removed
    })
  }

  /**
   * 按日期区间 / 类型查账（新账在前）。
   * @param {object} [query] - `{ from, to, kind, limit }`
   * @returns {Promise<object>} 查询结果（含全量合计）
   */
  async function list(query = {}) {
    const input = query !== null && typeof query === 'object' ? query : {}
    const from = optionalDate(input.from, 'from')
    const to = optionalDate(input.to, 'to')
    const kind = input.kind === undefined || input.kind === null || input.kind === '' ? undefined : requireKind(input.kind)
    let limit = LIST_DEFAULT_LIMIT
    if (input.limit !== undefined && input.limit !== null && input.limit !== '') {
      const parsed = typeof input.limit === 'string' ? Number(input.limit.trim()) : input.limit
      if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 1) {
        fail('balance/bad-limit', `limit 必须是正整数（收到 ${JSON.stringify(input.limit)}）。`)
      }
      limit = Math.min(parsed, LIST_MAX_LIMIT)
    }
    if (from !== undefined && to !== undefined && from > to) fail('balance/bad-range', `日期区间反了：from ${from} 晚于 to ${to}。`)
    const matched = (await readAll())
      .filter(entry => (from === undefined || entry.date >= from)
        && (to === undefined || entry.date <= to)
        && (kind === undefined || entry.kind === kind))
      .sort(compareDescending)
    return {
      from: from ?? null,
      to: to ?? null,
      kind: kind ?? null,
      count: matched.length,
      limit,
      totals: totalsOf(matched),
      entries: matched.slice(0, limit),
      file,
    }
  }

  /**
   * 某个月的收支汇总：合计、按分类、按天，外加最近几个月的趋势。
   * @param {object} [query] - `{ month, recent }`
   * @returns {Promise<object>} 汇总
   */
  async function summary(query = {}) {
    const input = query !== null && typeof query === 'object' ? query : {}
    const month = requireMonth(input.month)
    const { from, to } = monthBounds(month)
    const all = await readAll()
    const inMonth = all.filter(entry => entry.date >= from && entry.date <= to)
    const trends = recentMonthList(month, RECENT_MONTHS).map((key) => {
      const bounds = monthBounds(key)
      const slice = all.filter(entry => entry.date >= bounds.from && entry.date <= bounds.to)
      const totals = totalsOf(slice)
      return { month: key, income: totals.income, expense: totals.expense, net: totals.net }
    })
    return {
      month,
      from,
      to,
      count: inMonth.length,
      totals: totalsOf(inMonth),
      categories: categoriesOf(inMonth),
      days: daysOf(inMonth),
      recent: trends,
      file,
    }
  }

  /**
   * 账本基本信息（面板脚注/排障用）。
   * @returns {Promise<object>} `{ root, file, count, today }`
   */
  async function info() {
    const entries = await readAll()
    return { root, file, count: entries.length, today: todayString() }
  }

  return { root, file, loadYear, save, remove, list, summary, info }
}

// ---------------------------------------------------------------------------
// 面板接口（/balance）
// ---------------------------------------------------------------------------

/**
 * 从错误里取一个稳定的 code。
 * @param {unknown} error - 捕获到的值
 * @returns {string} 错误码
 */
function codeOf(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'balance/internal'
}

/**
 * 从错误里取一句人话。
 * @param {unknown} error - 捕获到的值
 * @returns {string} 说明
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 调容器里的饮食 CLI（`scripts/panel_api.py`）：stdin 送 JSON，stdout 收 `{ ok, value }`。
 *
 * 为什么绕 docker：diet.db 是容器内 AstrBot 的 WAL 库，宿主直接写会把它的
 * -wal/-shm 弄坏（11-24 实测过一次，容器重启才恢复）。读也走这里，只有一条路。
 *
 * @param {object} command - 命令与参数
 * @returns {Promise<any>} 命令结果
 */
function runDiet(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      DOCKER_BIN,
      ['exec', '-i', '-w', DIET_PLUGIN_DIR, DIET_CONTAINER, 'python', 'scripts/panel_api.py'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(Object.assign(new Error('饮食服务超时（容器没响应）。'), { code: 'balance/diet-timeout' }))
    }, DIET_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8') })
    child.on('error', (failure) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(Object.assign(new Error(`调不动 docker：${failure.message}`), { code: 'balance/diet-docker' }))
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let data
      try {
        data = JSON.parse(out.trim())
      } catch {
        reject(Object.assign(new Error(err.trim() || '饮食服务返回了无法识别的内容。'), { code: 'balance/diet' }))
        return
      }
      if (data === null || typeof data !== 'object' || data.ok !== true) {
        const message = data && typeof data.error === 'string' ? data.error : '饮食服务调用失败。'
        reject(Object.assign(new Error(message), { code: 'balance/diet' }))
        return
      }
      resolve(data.value)
    })
    child.stdin.end(Buffer.from(JSON.stringify(command), 'utf8'))
  })
}

/**
 * 跑配置里的同步命令（例如 `node .../publish.mjs` 或 `node .../sync-now.mjs`）。
 *
 * 面板上的「同步」按钮和「立刻提交」都走这里：命令是 profile 配置写死的，
 * 浏览器只能触发、不能传命令，避免把面板接口变成任意命令执行。
 *
 * @param {string} command - 完整命令行
 * @returns {Promise<{ code: number, output: string }>} 结果
 */
function runSyncCommand(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        // 已经退了。
      }
      reject(Object.assign(new Error('同步命令超时（4 分钟）。'), { code: 'balance/sync-timeout' }))
    }, 240000)
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8') })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(Object.assign(new Error(`跑不动同步命令：${error.message}`), { code: 'balance/sync-spawn' }))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const text = `${out}${err}`.trim()
      resolve({ code: code ?? -1, output: text.length > 4000 ? text.slice(-4000) : text })
    })
  })
}

/**
 * 建一个「同步」入口：命令来自 profile 配置（`syncCommand`），没配就是没开。
 * @param {object} [rawConfig] - 插件行配置
 * @returns {{ command: string, run: () => Promise<{ code: number, output: string }> }} 同步能力
 */
export function createSyncAccess(rawConfig = {}) {
  const settings = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
  const command = typeof settings.syncCommand === 'string' ? settings.syncCommand.trim() : ''
  return {
    command,
    run: () => (command === ''
      ? Promise.reject(Object.assign(new Error('这台设备没配同步命令（profile 里的 syncCommand）。'), { code: 'balance/sync-off' }))
      : runSyncCommand(command)),
  }
}

/**
 * 建一个饮食数据源：主电脑走 docker（容器里的 panel_api.py），
 * 家人电脑走主电脑发布过来的 JSON 快照（只读）。
 *
 * 为什么要有快照模式：家人电脑上没有 AstrBot 容器，`docker exec` 必然失败；
 * 发布器把 `diet.db` 导成 `diet.json`，快照里的字段和容器接口返回的形状一一对应，
 * 面板代码一行都不用改。
 *
 * @param {object} [rawConfig] - 插件行配置（`dietSnapshot` 打开快照模式，`dietQq` 选看谁）
 * @returns {{ mode: string, qq: string, readOnly: boolean, snapshotPath?: string, call: (command: object) => Promise<any> }} 数据源
 */
export function createDietAccess(rawConfig = {}) {
  const settings = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
  const snapshot = typeof settings.dietSnapshot === 'string' ? settings.dietSnapshot.trim() : ''
  const qq = typeof settings.dietQq === 'string' && settings.dietQq.trim() !== '' ? settings.dietQq.trim() : DIET_QQ
  if (snapshot === '') {
    return {
      mode: 'docker',
      qq,
      readOnly: false,
      call: runDiet,
      /** 容器里有资料或有记录的人，面板拿来画切换器。 */
      listUsers: async () => {
        const value = await runDiet({ cmd: 'users' })
        return Array.isArray(value?.users) ? value.users : []
      },
    }
  }
  const snapshotPath = path.resolve(snapshot)
  return {
    mode: 'snapshot',
    qq,
    readOnly: true,
    snapshotPath,
    call: command => readDietSnapshot(
      snapshotPath,
      command !== null && typeof command === 'object' && typeof command.qq === 'string' && command.qq.trim() !== ''
        ? command.qq.trim()
        : qq,
      command,
    ),
    listUsers: () => readSnapshotUsers(snapshotPath),
  }
}

/**
 * 读快照里的用户列表（快照模式下没有容器，切换器只能列快照里的人）。
 * @param {string} snapshotPath - 快照路径
 * @returns {Promise<Array<{ qq: string, nickname: string, target: number, days: number }>>} 用户
 */
export async function readSnapshotUsers(snapshotPath) {
  const doc = await readDietSnapshotFile(snapshotPath)
  const users = doc.users !== null && typeof doc.users === 'object' ? doc.users : {}
  return Object.keys(users).map((qq) => {
    const user = users[qq] !== null && typeof users[qq] === 'object' ? users[qq] : {}
    const days = user.days !== null && typeof user.days === 'object' ? Object.keys(user.days) : []
    return {
      qq,
      nickname: typeof user.nickname === 'string' ? user.nickname : '',
      target: Number(user.target) || 0,
      days: days.length,
    }
  })
}

/**
 * 四舍五入到一位小数（和容器里 panel_api.py 的口径一致）。
 * @param {number} value - 数值
 * @returns {number} 保留一位小数的值
 */
function round1(value) {
  return Math.round(Number(value) * 10) / 10
}

/**
 * 读一份饮食快照（发布器写的 `diet.json`）。
 * @param {string} file - 快照路径
 * @returns {Promise<object>} 快照文档
 */
async function readDietSnapshotFile(file) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    fail('balance/diet-snapshot', `读饮食快照失败：${file}（${error instanceof Error ? error.message : String(error)}）`)
  }
  let doc
  try {
    doc = JSON.parse(text)
  } catch (error) {
    fail('balance/diet-snapshot', `饮食快照不是合法 JSON：${file}（${error instanceof Error ? error.message : String(error)}）`)
  }
  if (doc === null || typeof doc !== 'object' || doc.users === null || typeof doc.users !== 'object') {
    fail('balance/diet-snapshot', `饮食快照缺少 users 对象：${file}`)
  }
  return doc
}

/**
 * 某一天的快照数据（形状与 panel_api.py 的 `day` 一致）。
 * @param {string} qq - QQ 号
 * @param {string} day - `YYYY-MM-DD`
 * @param {object} days - 快照里的 days 表
 * @param {number} target - 每日目标 kcal
 * @param {object} profile - 用户资料
 * @returns {object} day payload
 */
function dayFromSnapshot(qq, day, days, target, profile) {
  const meals = snapshotMeals(days, day)
  return {
    day,
    qq,
    meals,
    total: mealsTotals(meals),
    target: round1(target),
    profile: {
      goal: typeof profile.goal === 'string' ? profile.goal : 'maintain',
      weight_kg: Number(profile.weight_kg) || 0,
    },
  }
}

/**
 * 取某一天的餐次数组（快照里没有就是空数组）。
 * @param {object} days - 快照里的 days 表
 * @param {string} day - `YYYY-MM-DD`
 * @returns {Array<object>} 餐次
 */
function snapshotMeals(days, day) {
  const entry = days[day]
  if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.meals)) return []
  return entry.meals
}

/**
 * 把一天的餐次加起来（kcal / 蛋白质 / 脂肪 / 碳水）。
 * @param {Array<object>} meals - 餐次
 * @returns {{ kcal: number, protein: number, fat: number, carb: number }} 合计
 */
function mealsTotals(meals) {
  const total = { kcal: 0, protein: 0, fat: 0, carb: 0 }
  for (const meal of meals) {
    for (const key of Object.keys(total)) total[key] += Number(meal?.[key]) || 0
  }
  for (const key of Object.keys(total)) total[key] = round1(total[key])
  return total
}

/**
 * 一个月的摄入汇总（形状与 panel_api.py 的 `month` 一致）。
 * @param {string} qq - QQ 号
 * @param {number} target - 每日目标 kcal
 * @param {object} days - 快照里的 days 表
 * @param {number} year - 年
 * @param {number} month - 月（1-12）
 * @returns {object} month payload
 */
function monthFromSnapshot(qq, target, days, year, month) {
  const prefix = `${year}-${pad2(month)}`
  const map = {}
  let total = 0
  for (const day of Object.keys(days)) {
    if (!day.startsWith(prefix)) continue
    const kcal = mealsTotals(snapshotMeals(days, day)).kcal
    map[day] = kcal
    total += kcal
  }
  const logged = Object.keys(map).length
  return {
    year,
    month,
    days: map,
    total: round1(total),
    logged_days: logged,
    avg: logged === 0 ? 0 : round1(total / logged),
    target: round1(target),
  }
}

/**
 * 一年的摄入汇总（形状与 panel_api.py 的 `year` 一致）。
 * @param {string} qq - QQ 号
 * @param {number} target - 每日目标 kcal
 * @param {object} days - 快照里的 days 表
 * @param {number} year - 年
 * @returns {object} year payload
 */
function yearFromSnapshot(qq, target, days, year) {
  const buckets = {}
  for (const day of Object.keys(days)) {
    if (!day.startsWith(`${year}-`)) continue
    const month = Number(day.slice(5, 7))
    const bucket = buckets[month] ?? { total: 0, days: 0 }
    bucket.total += mealsTotals(snapshotMeals(days, day)).kcal
    bucket.days += 1
    buckets[month] = bucket
  }
  const months = []
  for (let month = 1; month <= 12; month += 1) {
    const bucket = buckets[month] ?? { total: 0, days: 0 }
    months.push({
      month,
      total: round1(bucket.total),
      logged_days: bucket.days,
      avg: bucket.days === 0 ? 0 : round1(bucket.total / bucket.days),
    })
  }
  return { year, months, target: round1(target) }
}

/**
 * 从快照回答面板的饮食查询；写操作一律拒绝。
 * @param {string} snapshotPath - 快照路径
 * @param {string} qq - 选中的 QQ
 * @param {object} command - `{ cmd, day?, year?, month? }`
 * @returns {Promise<object>} 与容器接口同形的结果
 */
export async function readDietSnapshot(snapshotPath, qq, command) {
  const cmd = command !== null && typeof command === 'object' ? String(command.cmd ?? '') : ''
  if (cmd !== 'day' && cmd !== 'month' && cmd !== 'year') fail('balance/diet-readonly', READONLY_MESSAGE)
  const doc = await readDietSnapshotFile(snapshotPath)
  const user = doc.users[qq] !== null && typeof doc.users[qq] === 'object' ? doc.users[qq] : null
  const days = user !== null && user.days !== null && typeof user.days === 'object' ? user.days : {}
  const target = user !== null && Number.isFinite(Number(user.target)) ? Number(user.target) : 0
  const profile = user !== null && user.profile !== null && typeof user.profile === 'object' ? user.profile : {}
  if (cmd === 'day') return dayFromSnapshot(qq, String(command.day ?? ''), days, target, profile)
  if (cmd === 'month') return monthFromSnapshot(qq, target, days, Number(command.year), Number(command.month))
  return yearFromSnapshot(qq, target, days, Number(command.year))
}

/**
 * 默认数据源：主电脑直连容器（保持原有行为）。
 * @type {{ mode: string, qq: string, readOnly: boolean, call: (command: object) => Promise<any> }}
 */
const DOCKER_DIET = {
  mode: 'docker',
  qq: DIET_QQ,
  readOnly: false,
  call: runDiet,
  listUsers: async () => {
    const value = await runDiet({ cmd: 'users' })
    return Array.isArray(value?.users) ? value.users : []
  },
}

/**
 * 把一句话交给 DSH 的同步回合接口（xixi 桥），等它的完整回答。
 * @param {string} text - 要交给 DSH 的指令
 * @returns {Promise<string>} 回答文本
 */
async function dshTurn(text) {
  const secret = (await fs.readFile(XIXI_SECRET_FILE, 'utf8')).trim()
  const body = Buffer.from(JSON.stringify({ text }), 'utf8')
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  const response = await fetch(XIXI_TURN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-xixi-signature': signature },
    body,
    signal: AbortSignal.timeout(DSH_TURN_TIMEOUT_MS),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || typeof data.reply !== 'string') {
    throw new Error(typeof data.error === 'string' ? data.error : `DSH HTTP ${response.status}`)
  }
  return data.reply
}

/**
 * 从 DSH 的回复里抠出 `{"items":[...]}`（允许前后有闲话或代码块）。
 * @param {string} reply - DSH 回答
 * @returns {Array<{ name: string, grams: number, kcal: number, protein: number, fat: number, carb: number }>} 食物项
 */
function parseDshItems(reply) {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let doc
  try {
    doc = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return []
  }
  const items = Array.isArray(doc.items) ? doc.items : []
  return items
    .filter(item => item !== null && typeof item === 'object' && typeof item.name === 'string' && Number(item.grams) > 0)
    .map(item => ({
      name: item.name,
      grams: Number(item.grams),
      kcal: Number(item.kcal) || 0,
      protein: Number(item.protein) || 0,
      fat: Number(item.fat) || 0,
      carb: Number(item.carb) || 0,
    }))
}

/**
 * 重新估算一餐：先按成分表逐项重算；还有库外项时，交 DSH 拆一遍再整体替换。
 * @param {number} mealId - 餐 id
 * @returns {Promise<object>} 重算结果
 */
async function reestimateMeal(mealId) {
  const base = await runDiet({ cmd: 'reestimate', meal_id: mealId })
  const meal = base && base.meal
  if (!meal || !Array.isArray(base.unmatched) || base.unmatched.length === 0) return base
  if (!meal.raw_text) return { ...base, dsh: 'skipped' }
  const prompt = [
    `用本机食物成分表重新估算这一餐：${meal.raw_text}`,
    '先把食物清单写成一行 UTF-8 存到 C:\\Users\\99132\\AppData\\Local\\Temp\\xixi-reestimate.txt，',
    '再运行 node C:\\custom\\dsh\\mcp\\xixi\\tools\\diet-estimate.mjs --file C:\\Users\\99132\\AppData\\Local\\Temp\\xixi-reestimate.txt；',
    '成品菜要拆成食材（含主食/面皮/油）再算。',
    '最后只输出一个 JSON：{"items":[{"name":"米饭","grams":250,"kcal":290,"protein":5.2,"fat":0.6,"carb":51.8}]}',
    '不要解释、不要代码块。',
  ].join('')
  try {
    const reply = await dshTurn(prompt)
    const items = parseDshItems(reply)
    if (items.length === 0) return { ...base, dsh: 'unparsed' }
    const replaced = await runDiet({ cmd: 'replace_items', meal_id: mealId, items })
    return { ...replaced, dsh: 'ok' }
  } catch {
    return { ...base, dsh: 'failed' }
  }
}

/**
 * 把账本方法包成面板接口的处理器（端点 → 账本方法）。
 * @param {object} ledger - createLedger 的返回值
 * @param {string} endpoint - 端点名（`load`/`save`/`remove`/`summary`/`info`/`diet-*`）
 * @param {unknown} payload - 端点参数
 * @param {object} [diet] - 饮食数据源（createDietAccess 的返回值；省略即主电脑的 docker 直连）
 * @returns {Promise<{ ok: true, value: any } | { ok: false, error: { code: string, message: string, details: object } }>} 结果
 */
export async function handleRpc(ledger, endpoint, payload, diet = DOCKER_DIET, sync = { command: '', run: () => Promise.reject(new Error('sync')) }) {
  const input = payload !== null && typeof payload === 'object' ? payload : {}
  const dietOf = diet !== null && typeof diet === 'object' && typeof diet.call === 'function' ? diet : DOCKER_DIET
  /**
   * 只读镜像挡住饮食写操作（快照里没有写的能力）。
   * @returns {void}
   */
  const requireDietWritable = () => {
    if (dietOf.readOnly) fail('balance/diet-readonly', READONLY_MESSAGE)
  }
  /**
   * 这次请求看谁：面板可以用 `qq` 临时指定（用户切换器），没给就用配置里的默认。
   * @param {unknown} value - 请求里的 qq
   * @returns {string} QQ
   */
  const pickQq = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : dietOf.qq)
  try {
    switch (endpoint) {
      case 'load':
        return { ok: true, value: await ledger.loadYear(input.year) }
      case 'save':
        return { ok: true, value: await ledger.save(input.entry === undefined ? input : input.entry) }
      case 'remove':
        return { ok: true, value: await ledger.remove(input.id) }
      case 'summary':
        return { ok: true, value: await ledger.summary(input) }
      case 'info':
        return { ok: true, value: await ledger.info() }
      case 'diet-users':
        return {
          ok: true,
          value: {
            users: typeof dietOf.listUsers === 'function' ? await dietOf.listUsers() : [],
            current: dietOf.qq,
          },
        }
      case 'sync-now': {
        if (sync === null || typeof sync !== 'object' || typeof sync.run !== 'function' || (sync.command ?? '') === '') {
          fail('balance/sync-off', '这台设备没配同步命令（profile 里的 syncCommand）。')
        }
        const outcome = await sync.run()
        return { ok: true, value: { code: outcome.code, ok: outcome.code === 0, output: outcome.output } }
      }
      case 'diet-load':
        return { ok: true, value: await dietOf.call({ cmd: 'day', qq: pickQq(input.qq), day: input.day }) }
      case 'diet-month':
        return { ok: true, value: await dietOf.call({ cmd: 'month', qq: pickQq(input.qq), year: input.year, month: input.month }) }
      case 'diet-year':
        return { ok: true, value: await dietOf.call({ cmd: 'year', qq: pickQq(input.qq), year: input.year }) }
      case 'diet-update-item':
        requireDietWritable()
        return { ok: true, value: await dietOf.call({ cmd: 'update_item', item_id: input.itemId, grams: input.grams }) }
      case 'diet-delete-item':
        requireDietWritable()
        return { ok: true, value: await dietOf.call({ cmd: 'delete_item', item_id: input.itemId }) }
      case 'diet-add-item':
        requireDietWritable()
        return { ok: true, value: await dietOf.call({ cmd: 'add_item', meal_id: input.mealId, name: input.name, grams: input.grams }) }
      case 'diet-delete-meal':
        requireDietWritable()
        return { ok: true, value: await dietOf.call({ cmd: 'delete_meal', meal_id: input.mealId }) }
      case 'diet-add-meal':
        requireDietWritable()
        return {
          ok: true,
          value: await dietOf.call({
            cmd: 'add_meal',
            qq: pickQq(input.qq),
            day: input.day,
            meal_type: input.mealType,
            name: input.name,
            grams: input.grams,
            raw_text: input.rawText,
          }),
        }
      case 'diet-reestimate':
        requireDietWritable()
        return { ok: true, value: await reestimateMeal(input.mealId) }
      default:
        return {
          ok: false,
          error: { code: 'balance/unknown-endpoint', message: `未知的 /balance 端点：${String(endpoint)}`, details: {} },
        }
    }
  } catch (error) {
    return { ok: false, error: { code: codeOf(error), message: messageOf(error), details: {} } }
  }
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应
 * @param {number} status - 状态码
 * @param {unknown} payload - 负载
 * @returns {void}
 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * 读一个受限的 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req - 请求
 * @returns {Promise<Record<string, unknown>>} 解析后的对象
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      req.resume()
      fail('balance/payload-too-large', `请求体超过 ${MAX_BODY_BYTES} 字节。`)
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks, size).toString('utf8').trim()
  if (text === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('balance/bad-json', '请求体不是合法 JSON。')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('balance/bad-json', '请求体必须是 JSON 对象。')
  }
  return parsed
}

/**
 * 鉴权：有 connection 服务就用它的登录 cookie + Host/Origin 校验；
 * 没有该服务的组合里只接受回环地址（与库里的本地面板插件同一个口径）。
 * @param {any} ctx - 插件上下文
 * @param {import('node:http').IncomingMessage} req - 请求
 * @param {import('node:http').ServerResponse} res - 响应
 * @returns {boolean} 已经拒绝时为 true
 */
function rejected(ctx, req, res) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  if (connection !== undefined && connection !== null && typeof connection.requestRejection === 'function') {
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }
  const remote = String(req.socket?.remoteAddress ?? '')
  if (/^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/.test(remote)) return false
  res.statusCode = 403
  res.end()
  return true
}

/**
 * 处理一条面板请求：`POST /balance/<endpoint>`。
 * @param {any} ctx - 插件上下文（鉴权用）
 * @param {object} ledger - 账本
 * @param {import('node:http').IncomingMessage} req - 请求
 * @param {import('node:http').ServerResponse} res - 响应
 * @param {object} [diet] - 饮食数据源（省略即 docker 直连）
 * @returns {Promise<void>} 完成
 */
export async function handleHttp(ctx, ledger, req, res, diet) {
  if (rejected(ctx, req, res)) return
  const url = new URL(String(req.url ?? '/'), 'http://localhost')
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: { code: 'balance/method', message: '面板接口只接受 POST。', details: {} } })
    return
  }
  const endpoint = url.pathname.startsWith(`${CHANNEL}/`) ? url.pathname.slice(CHANNEL.length + 1) : ''
  if (endpoint === '' || endpoint.includes('/')) {
    sendJson(res, 404, { ok: false, error: { code: 'balance/unknown-endpoint', message: `未知的 /balance 端点：${endpoint}`, details: {} } })
    return
  }
  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 200, { ok: false, error: { code: codeOf(error), message: messageOf(error), details: {} } })
    return
  }
  sendJson(res, 200, await handleRpc(ledger, endpoint, payload, diet))
}

// ---------------------------------------------------------------------------
// Agent 工具
// ---------------------------------------------------------------------------

/**
 * 工具输出统一：宽松对象 schema + 自己排版成一段文字。
 * @param {(value: any) => string} render - 把结果排成人读的文字
 * @returns {{ schema: object, render: (args: any, value: any) => Array<object> }} 工具 output
 */
const output = render => ({
  schema: { type: 'object', additionalProperties: true },
  render: (args, value) => [{ type: 'text', text: render(value) }],
})

/**
 * 收/支的中文名。
 * @param {string} kind - `expense` / `income`
 * @returns {string} 中文
 */
function kindLabel(kind) {
  return kind === 'income' ? '收入' : '支出'
}

/**
 * 金额显示（两位小数，带千分位）。
 * @param {number} value - 元
 * @returns {string} 例如 `1,234.50`
 */
function money(value) {
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * 一条账目的文字行。
 * @param {object} entry - 账目
 * @returns {string} 例如 `2026-11-20 支出 ¥25.50 餐饮 午饭  #id`
 */
function entryLine(entry) {
  const parts = [`${entry.date} ${kindLabel(entry.kind)} ¥${money(entry.amount)}`]
  if (entry.category !== '') parts.push(entry.category)
  if (entry.note !== '') parts.push(entry.note)
  return `${parts.join(' ')}  #${entry.id}`
}

/**
 * 注册四个记账工具（和面板共用同一个账本对象）。
 * @param {any} ctx - 插件上下文
 * @param {object} ledger - 账本
 * @returns {void}
 */
function registerTools(ctx, ledger) {
  ctx.effect(() => ctx.tools.register({
    name: 'balance_add',
    description: '记一笔账（支出或收入）。日期省略时用今天（服务器本地时区）；金额单位是元。'
      + '用户说「今天午饭 25」「记一笔工资 8000」这类话时直接调用，不要反问。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        amount: { type: 'number', description: '金额，单位元，必须大于 0，最多两位小数。' },
        date: { type: 'string', description: '账目日期 YYYY-MM-DD；省略用今天。' },
        kind: { type: 'string', enum: KINDS, description: 'expense=支出（默认），income=收入。' },
        category: { type: 'string', description: '分类，例如 餐饮 / 交通 / 购物 / 工资；省略则留空。' },
        note: { type: 'string', description: '备注，例如 午饭、地铁、打车。' },
      },
      required: ['amount'],
    },
    output: output(value => `已记账：${entryLine(value.entry)}\n账本：${value.file}`),
    async execute(args) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const entry = await ledger.save({
        date: input.date,
        kind: input.kind,
        amount: input.amount,
        category: input.category,
        note: input.note,
      })
      return { entry, file: ledger.file }
    },
  }), 'dsh-balance: tool balance_add')

  ctx.effect(() => ctx.tools.register({
    name: 'balance_list',
    description: '查账：按日期区间和类型翻账目（新账在前），同时返回区间内的收入、支出、结余合计。'
      + '用户问「这个月花了多少」「上周记了什么」时用它；只要汇总不要明细就用 balance_summary。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string', description: '起始日期 YYYY-MM-DD（含当天）。' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD（含当天）。' },
        kind: { type: 'string', enum: KINDS, description: '只看支出或只看收入；省略为全部。' },
        limit: { type: 'integer', description: `最多返回几笔明细，默认 ${LIST_DEFAULT_LIMIT}，上限 ${LIST_MAX_LIMIT}。` },
      },
    },
    output: output((value) => {
      const range = value.from === null && value.to === null
        ? '全部账目'
        : `${value.from ?? '最早'} ~ ${value.to ?? '最新'}`
      const head = `${range}：收入 ¥${money(value.totals.income)}，支出 ¥${money(value.totals.expense)}，`
        + `结余 ¥${money(value.totals.net)}（${value.count} 笔）`
      if (value.entries.length === 0) return `${head}\n（没有符合条件的账目）`
      const more = value.count > value.entries.length ? `\n……只显示最近 ${value.entries.length} 笔，可用 from/to 缩小范围。` : ''
      return `${head}\n${value.entries.map(entryLine).join('\n')}${more}`
    }),
    async execute(args) {
      const input = args !== null && typeof args === 'object' ? args : {}
      return await ledger.list(input)
    },
  }), 'dsh-balance: tool balance_list')

  ctx.effect(() => ctx.tools.register({
    name: 'balance_edit',
    description: '改或删一条已记录的账：先用 balance_list 拿到 id，再说明改哪个字段；'
      + 'action=delete 时只认 id。用户说「刚才那笔记错了，改成 30」「把那条删掉」时用它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '账目 id（balance_list / balance_add 返回的 #后面的那串）。' },
        action: { type: 'string', enum: ['update', 'delete'], description: 'update=改字段，delete=删除。' },
        date: { type: 'string', description: '新日期 YYYY-MM-DD。' },
        kind: { type: 'string', enum: KINDS, description: '新的类型。' },
        amount: { type: 'number', description: '新金额（元）。' },
        category: { type: 'string', description: '新分类。' },
        note: { type: 'string', description: '新备注。' },
      },
      required: ['id', 'action'],
    },
    output: output(value => (value.deleted === true
      ? `已删除：${entryLine(value.entry)}`
      : `已更新：${entryLine(value.entry)}`)),
    async execute(args) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const action = typeof input.action === 'string' ? input.action.trim().toLowerCase() : ''
      if (action === 'delete') {
        const entry = await ledger.remove(input.id)
        return { deleted: true, entry, file: ledger.file }
      }
      if (action !== 'update') fail('balance/bad-action', 'action 只能是 update 或 delete。')
      const entry = await ledger.save({
        id: input.id,
        date: input.date,
        kind: input.kind,
        amount: input.amount,
        category: input.category,
        note: input.note,
      })
      return { deleted: false, entry, file: ledger.file }
    },
  }), 'dsh-balance: tool balance_edit')

  ctx.effect(() => ctx.tools.register({
    name: 'balance_summary',
    description: '某个月的收支汇总：收入/支出/结余、按分类、按天，外加最近 6 个月的趋势。'
      + '用户问「这个月花了多少」「钱都花哪了」「最近几个月怎么样」时用它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        month: { type: 'string', description: '月份 YYYY-MM；省略用本月。' },
      },
    },
    output: output((value) => {
      const head = `${value.month}：收入 ¥${money(value.totals.income)}，支出 ¥${money(value.totals.expense)}，`
        + `结余 ¥${money(value.totals.net)}（${value.count} 笔）`
      if (value.count === 0) return `${head}\n（这个月还没有账目）`
      const expense = value.categories.filter(row => row.kind === 'expense').slice(0, 8)
      const income = value.categories.filter(row => row.kind === 'income').slice(0, 5)
      const lines = [head]
      if (expense.length > 0) {
        lines.push('支出分类：')
        for (const row of expense) lines.push(`  ${row.category === '' ? '未分类' : row.category} ¥${money(row.amount)}（${row.count} 笔）`)
      }
      if (income.length > 0) {
        lines.push('收入分类：')
        for (const row of income) lines.push(`  ${row.category === '' ? '未分类' : row.category} ¥${money(row.amount)}（${row.count} 笔）`)
      }
      lines.push('最近几个月：')
      for (const row of value.recent) {
        lines.push(`  ${row.month} 收入 ¥${money(row.income)} / 支出 ¥${money(row.expense)} / 结余 ¥${money(row.net)}`)
      }
      return lines.join('\n')
    }),
    async execute(args) {
      const input = args !== null && typeof args === 'object' ? args : {}
      return await ledger.summary({ month: input.month })
    },
  }), 'dsh-balance: tool balance_summary')
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * 插件入口：建账本、注册工具，并在 webServer 出现后挂上 `/balance` 面板接口。
 * @param {any} ctx - 插件上下文
 * @param {object} [config] - 插件行配置（`root` 改账本目录）
 * @returns {void}
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  const ledger = createLedger(settings)
  const diet = createDietAccess(settings)
  registerTools(ctx, ledger)
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: CHANNEL,
      handler: (req, res) => handleHttp(ctx, ledger, req, res, diet),
    }), `dsh-balance: HTTP API ${CHANNEL}`)
  })
}

/** 测试缝：Node 侧自测脚本直接用这些纯函数与账本工厂。 */
export const internals = {
  createLedger,
  createDietAccess,
  readDietSnapshot,
  readSnapshotUsers,
  dayFromSnapshot,
  monthFromSnapshot,
  yearFromSnapshot,
  handleRpc,
  handleHttp,
  isValidDate,
  isValidMonth,
  todayString,
  monthBounds,
  recentMonthList,
  totalsOf,
  categoriesOf,
  daysOf,
  requireAmount,
  requireDate,
  requireKind,
  DEFAULT_ROOT,
  LEDGER_FILE,
  DEFAULT_CATEGORIES,
  MAX_CATEGORY,
  MAX_NOTE,
  MAX_BODY_BYTES,
}
