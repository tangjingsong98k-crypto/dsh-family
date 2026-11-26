/**
 * 把账本 + 饮食快照算成一份「今天/本月/最近两周」的统计，并渲染成一张
 * 能直接双击打开的网页。
 *
 * 为什么还要一份 HTML：DSH 得先登录才看得到面板，家人想瞄一眼今天的数字时，
 * `data/stats/index.html` 双击就能看，离线也行（样式全部内联，没有外链）。
 *
 * 口径跟 dsh-balance 面板一致：账目按 `date` 归日，金额按分计算；饮食按
 * 「有记录的日子的日均」，吃的那天算一天。
 */

/**
 * 补零。
 * @param {number} value - 数字
 * @returns {string} 两位
 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * 本地日历日 `YYYY-MM-DD`。
 * @param {Date} date - 日期
 * @returns {string} 日期
 */
export function dayKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * 最近 N 天的日期（含今天），从旧到新。
 * @param {Date} now - 现在
 * @param {number} days - 天数
 * @returns {string[]} 日期
 */
function recentDays(now, days) {
  const list = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset)
    list.push(dayKey(date))
  }
  return list
}

/**
 * 金额换成整数分再算，避免 0.1 + 0.2。
 * @param {number} value - 元
 * @returns {number} 分
 */
function cents(value) {
  return Math.round(Number(value) * 100) || 0
}

/**
 * 分换回元。
 * @param {number} value - 分
 * @returns {number} 元
 */
function yuan(value) {
  return Math.round(value) / 100
}

/**
 * 汇总一批账目。
 * @param {Array<object>} entries - 账目
 * @returns {{ expense: number, income: number, net: number, count: number }} 合计（元）
 */
function totals(entries) {
  let expense = 0
  let income = 0
  for (const entry of entries) {
    if (entry.kind === 'income') income += cents(entry.amount)
    else expense += cents(entry.amount)
  }
  return { expense: yuan(expense), income: yuan(income), net: yuan(income - expense), count: entries.length }
}

/**
 * 算统计。
 * @param {object} input - `{ ledger, diet, dietQq, now, sourceHash }`
 * @returns {object} 统计
 */
export function buildStats({ ledger, diet, dietQq, now = new Date(), sourceHash = '' }) {
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : []
  const today = dayKey(now)
  const month = today.slice(0, 7)
  const inMonth = entries.filter(entry => typeof entry.date === 'string' && entry.date.startsWith(month))

  const categories = new Map()
  for (const entry of inMonth) {
    if (entry.kind === 'income') continue
    const key = typeof entry.category === 'string' && entry.category.trim() !== '' ? entry.category.trim() : '未分类'
    const bucket = categories.get(key) ?? { category: key, amount: 0, count: 0 }
    bucket.amount += cents(entry.amount)
    bucket.count += 1
    categories.set(key, bucket)
  }
  const categoryRows = [...categories.values()]
    .map(row => ({ ...row, amount: yuan(row.amount) }))
    .sort((left, right) => right.amount - left.amount)
    .slice(0, 8)

  const days = recentDays(now, 14)
  const ledgerDays = days.map((day) => {
    const dayEntries = entries.filter(entry => entry.date === day)
    const sum = totals(dayEntries)
    return { day, expense: sum.expense, income: sum.income }
  })

  const user = diet?.users !== null && typeof diet?.users === 'object' ? diet.users[dietQq] : undefined
  const dietDays = user !== null && typeof user === 'object' && user.days !== null && typeof user.days === 'object' ? user.days : {}
  const kcalOf = (day) => {
    const meals = Array.isArray(dietDays[day]?.meals) ? dietDays[day].meals : []
    let kcal = 0
    for (const meal of meals) kcal += Number(meal?.kcal) || 0
    return Math.round(kcal * 10) / 10
  }
  const dietDayRows = days.map(day => ({ day, kcal: kcalOf(day) }))
  const logged = Object.keys(dietDays).filter(day => dietDays[day]?.meals?.length > 0)
  const monthLogged = logged.filter(day => day.startsWith(month))
  const monthKcal = monthLogged.reduce((sum, day) => sum + kcalOf(day), 0)

  return {
    generatedAt: new Date().toISOString(),
    sourceHash,
    today,
    month,
    ledger: {
      count: entries.length,
      today: totals(entries.filter(entry => entry.date === today)),
      month: totals(inMonth),
      categories: categoryRows,
      recentDays: ledgerDays,
    },
    diet: {
      qq: dietQq,
      target: Number(user?.target) || 0,
      hasData: logged.length > 0,
      today: {
        kcal: kcalOf(today),
        meals: Array.isArray(dietDays[today]?.meals) ? dietDays[today].meals.length : 0,
      },
      month: {
        loggedDays: monthLogged.length,
        avg: monthLogged.length === 0 ? 0 : Math.round((monthKcal / monthLogged.length) * 10) / 10,
      },
      recentDays: dietDayRows,
      lastLoggedDay: logged.length === 0 ? '' : logged.sort().reverse()[0],
    },
    source: { ledger: 'workzone/balance/ledger.json', diet: 'astrbot_plugin_diet_log' },
  }
}

/**
 * 金额显示。
 * @param {number} value - 元
 * @returns {string} `1,234.50`
 */
function money(value) {
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * 转义 HTML。
 * @param {string} value - 文本
 * @returns {string} 转义结果
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]))
}

/**
 * 渲染成一张自包含的网页。
 * @param {object} stats - buildStats 的结果
 * @returns {string} HTML
 */
export function renderHtml(stats) {
  const rows = stats.ledger.recentDays.map((day, index) => {
    const diet = stats.diet.recentDays[index]
    return `<tr><td>${day.day}</td><td class="r">${day.expense === 0 ? '-' : money(day.expense)}</td>`
      + `<td class="r">${day.income === 0 ? '-' : money(day.income)}</td>`
      + `<td class="r">${diet.kcal === 0 ? '-' : diet.kcal.toFixed(0)}</td></tr>`
  }).join('\n')
  const categories = stats.ledger.categories.length === 0
    ? '<p class="empty">这个月还没有支出。</p>'
    : stats.ledger.categories.map(row => `<li><span>${escapeHtml(row.category)}</span>`
      + `<span class="r">¥${money(row.amount)} <em>${row.count} 笔</em></span></li>`).join('\n')
  const month = stats.ledger.month
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>家里这个月的账 · ${stats.month}</title>
<style>
  :root { color-scheme: light dark; --fg:#1f2328; --muted:#6b7280; --bg:#f7f7f8; --card:#fff; --line:#e5e7eb; --red:#c2410c; --green:#15803d; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e6edf3; --muted:#9aa4b2; --bg:#0d1117; --card:#161b22; --line:#30363d; --red:#f97316; --green:#4ade80; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--fg); font:15px/1.55 "Microsoft YaHei", "Segoe UI", system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; display: grid; gap: 16px; }
  h1 { font-size: 20px; margin: 0; }
  .sub { color: var(--muted); font-size: 13px; }
  .cards { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:12px; }
  .card { background: var(--card); border:1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .card h2 { font-size: 13px; font-weight: 600; color: var(--muted); margin: 0 0 6px; }
  .num { font-size: 24px; font-weight: 650; letter-spacing: .3px; }
  .num.red { color: var(--red); } .num.green { color: var(--green); }
  table { width:100%; border-collapse: collapse; background: var(--card); border:1px solid var(--line); border-radius: 12px; overflow: hidden; }
  th, td { padding: 8px 12px; border-bottom: 1px solid var(--line); text-align: left; font-variant-numeric: tabular-nums; }
  th { font-size: 12px; color: var(--muted); font-weight: 600; background: color-mix(in srgb, var(--card) 70%, var(--bg)); }
  tr:last-child td { border-bottom: 0; }
  .r { text-align: right; }
  ul { list-style:none; margin:0; padding:0; background: var(--card); border:1px solid var(--line); border-radius:12px; }
  li { display:flex; justify-content:space-between; padding: 9px 14px; border-bottom:1px solid var(--line); }
  li:last-child { border-bottom: 0; }
  li em { color: var(--muted); font-style: normal; font-size: 12px; margin-left: 6px; }
  .empty { color: var(--muted); margin:0; padding: 12px 14px; background: var(--card); border:1px solid var(--line); border-radius:12px; }
  footer { color: var(--muted); font-size: 12px; text-align:center; }
</style>
</head>
<body>
<main>
  <header>
    <h1>家里这个月的账</h1>
    <p class="sub">${stats.month} · 更新于 ${escapeHtml(new Date(stats.generatedAt).toLocaleString('zh-CN', { hour12: false }))} · 数据来自汐汐</p>
  </header>
  <section class="cards">
    <div class="card"><h2>今天支出</h2><div class="num red">¥${money(stats.ledger.today.expense)}</div></div>
    <div class="card"><h2>今天收入</h2><div class="num green">¥${money(stats.ledger.today.income)}</div></div>
    <div class="card"><h2>本月支出</h2><div class="num red">¥${money(month.expense)}</div></div>
    <div class="card"><h2>本月结余</h2><div class="num ${month.net < 0 ? 'red' : 'green'}">¥${money(month.net)}</div></div>
    <div class="card"><h2>今天摄入</h2><div class="num">${stats.diet.today.kcal.toFixed(0)} <span class="sub">/ ${stats.diet.target.toFixed(0)} kcal</span></div></div>
    <div class="card"><h2>本月日均摄入</h2><div class="num">${stats.diet.month.avg.toFixed(0)} <span class="sub">kcal · ${stats.diet.month.loggedDays} 天有记录</span></div></div>
  </section>
  <section>
    <h2 class="sub">最近 14 天</h2>
    <table>
      <thead><tr><th>日期</th><th class="r">支出</th><th class="r">收入</th><th class="r">摄入 kcal</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
    ${stats.diet.hasData ? '' : `<p class="empty">饮食这一列还是空的：QQ ${escapeHtml(stats.diet.qq)} 还没在汐汐那里记过饭。`}</p>
  </section>
  <section>
    <h2 class="sub">本月支出分类</h2>
    <ul>
${categories}
    </ul>
  </section>
  <footer>这张页面由主电脑每两分钟重新生成一次；要记账、记饮食，在 QQ 里找汐汐。</footer>
</main>
</body>
</html>
`
}
