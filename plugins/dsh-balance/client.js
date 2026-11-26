/**
 * dsh-balance —— 记账插件的浏览器半边。
 *
 * 注册三样东西：
 * 1. 右侧栏页签类型 `balance` + 面板本体（月历 → 点一天 → 当天账目增删改 + 收支图表）；
 * 2. 右栏空状态（guide）里的一张「记账」卡片，点开同一个面板；
 * 3. 会话标题栏右侧一个小按钮，点开同一个面板。
 *
 * 和 Host 只有一条通道：`POST /balance/<endpoint>`（load / save / remove），
 * 鉴权由 DSH 的 connection 服务负责（登录 cookie + Host/Origin 校验）。
 * 面板里所有数字都是从账本现算的，不缓存第二份数据。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-balance',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** 文案命名空间。 */
    const NS = 'balance'
    /** 右栏页签类型（openTab 用这个名字）。 */
    const TAB_KIND = 'balance'
    /** 实现 id（右栏 `sidebar.right.pane.tab` 的 key 用这个）。 */
    const TAB_ID = '@local/dsh-balance'
    /** Host 侧 RPC 通道名（与 index.js 的 CHANNEL 一致）。 */
    const CHANNEL = '/balance'
    /** 分类下拉框的实例序号（同页面可能挂多个面板）。 */

    // -----------------------------------------------------------------------
    // 文案（中文为主，英文兜底；t 由 locale 槽位注入）
    // -----------------------------------------------------------------------

    const zh = {
      'tab.title': '生活',
      'guide.title': '生活',
      'guide.description': '收支 + 饮食两个子模块：按日历记账、看摄入',
      'open.title': '打开生活面板',
      'panel.title': '生活',
      'module.label': '子模块',
      'module.money': '收支',
      'module.diet': '饮食',
      'month.prev': '上个月',
      'month.next': '下个月',
      'month.today': '今天',
      'month.label': '{year}年{month}月',
      'weekday.mon': '一',
      'weekday.tue': '二',
      'weekday.wed': '三',
      'weekday.thu': '四',
      'weekday.fri': '五',
      'weekday.sat': '六',
      'weekday.sun': '日',
      'day.label': '{month}月{day}日 {weekday}',
      'day.count': '{count} 笔',
      'day.total': '支出 ¥{expense} · 收入 ¥{income}',
      'day.empty': '这天还没有账目，下面直接记一笔。',
      'summary.income': '收入',
      'summary.expense': '支出',
      'summary.net': '结余',
      'form.kind': '收支类型',
      'form.expense': '支出',
      'form.income': '收入',
      'form.date': '日期',
      'form.amount': '金额',
      'form.amountPlaceholder': '0.00',
      'form.category': '分类',
      'form.categoryPlaceholder': '餐饮、交通……',
      'form.note': '备注',
      'form.notePlaceholder': '午饭、地铁……',
      'form.add': '记下',
      'form.save': '保存',
      'form.cancel': '取消',
      'form.editing': '正在编辑 {date} 的{kind}：¥{amount}',
      'form.needAmount': '请填一个大于 0 的金额。',
      'form.uncategorized': '未分类',
      'entry.edit': '编辑',
      'entry.delete': '删除',
      'entry.confirm': '确认删除',
      'entry.cancel': '取消',
      'chart.monthly': '月度收支',
      'chart.category': '支出分类',
      'chart.detail': '按备注看详情',
      'chart.detailClose': '收起详情',
      'chart.noteGroups': '按备注分组（本月支出前 20）',
      'chart.noteGroupsEmpty': '本月没有可分组的有备注支出。',
      'chart.noNote': '未备注',
      'chart.groupCount': '{count} 笔',
      'chart.noteFilter': '按备注关键词筛选',
      'chart.noteFilterPlaceholder': '输入关键词，如 外卖',
      'chart.noteFilterClear': '清除',
      'chart.noteFilterEmpty': '没有备注包含「{keyword}」的支出。',
      'chart.noteFilterTitle': '含「{keyword}」的支出',
      'chart.daily': '本月逐日',
      'chart.dailyAria': '本月每天收支图：{count} 天有账目',
      'chart.dailyEmpty': '本月还没有账目。',
      'chart.mode': '图表口径',
      'chart.mode.money': '收支',
      'chart.mode.kcal': '卡路里',
      'chart.monthlyKcal': '月度摄入（日均）',
      'chart.dailyKcal': '本月逐日摄入',
      'chart.kcalLegend': '摄入',
      'chart.kcalAvg': '日均摄入',
      'chart.kcalTarget': '目标 {target} kcal',
      'chart.kcalDays': '记录 {days} 天',
      'chart.kcalYearAria': '全年日均 {avg} kcal，记录 {days} 天',
      'chart.kcalYearCaption': '全年日均 {avg} kcal · 记录 {days} 天 · 目标 {target} kcal',
      'chart.dailyKcalAria': '本月每天摄入图：{count} 天有记录',
      'chart.dailyKcalEmpty': '本月还没有饮食记录。',
      'chart.kcalOver': '超目标',
      'chart.kcalLoadFailed': '读取饮食数据失败',
      'chart.other': '其他',
      'chart.empty': '这个月还没有账目。',
      'chart.year': '全年：收入 ¥{income} · 支出 ¥{expense}',
      'chart.max': '最高 ¥{value}',
      'status.loading': '正在读账本……',
      'status.reload': '刷新',
      'status.retry': '重试',
      'status.readFailed': '读账本失败',
      'status.saveFailed': '操作失败',
      'status.saved': '已记下 {date}：{kind} ¥{amount}',
      'status.deleted': '已删除 {date} 的{kind}：¥{amount}',
      'status.uncertain': '这条账目已经不存在了，点刷新看看最新账本。',
      'file.hint': '数据文件',
      'diet.title': '当天饮食',
      'diet.total': '{kcal} / {target} kcal',
      'diet.empty': '这天还没有饮食记录。',
      'diet.refresh': '刷新',
      'diet.reestimate': '重算',
      'diet.reestimate.dsh': '已用 DSH 重新估算：{count} 项。',
      'diet.reestimate.done': '重算完成：{changed} 项按成分表更新，{unmatched} 项库外保持原样。',
      'diet.removeMeal': '删餐',
      'diet.removeMeal.confirm': '确认删除整餐？',
      'diet.edit': '改克数',
      'diet.save': '保存',
      'diet.cancel': '取消',
      'diet.delete': '删',
      'diet.addItem': '加食物',
      'diet.addItem.name': '食物名',
      'diet.addItem.grams': '克数',
      'diet.addItem.submit': '添加',
      'diet.addMeal': '记一餐',
      'diet.addMeal.type': '餐次',
      'diet.addMeal.submit': '记下',
      'diet.loading': '正在读饮食记录……',
      'diet.error': '读饮食记录失败',
      'diet.needName': '请填食物名。',
      'diet.needGrams': '请填一个大于 0 的克数。',
      'diet.saved': '已更新饮食记录。',
      'diet.deleted': '已删除这条饮食记录。',
    }

    const en = {
      'tab.title': 'Life',
      'guide.title': 'Life',
      'guide.description': 'Money and meals in one panel: calendar-based bookkeeping and intake charts',
      'open.title': 'Open the life panel',
      'panel.title': 'Life',
      'module.label': 'Sections',
      'module.money': 'Money',
      'module.diet': 'Meals',
      'month.prev': 'Previous month',
      'month.next': 'Next month',
      'month.today': 'Today',
      'month.label': '{month}/{year}',
      'weekday.mon': 'Mon',
      'weekday.tue': 'Tue',
      'weekday.wed': 'Wed',
      'weekday.thu': 'Thu',
      'weekday.fri': 'Fri',
      'weekday.sat': 'Sat',
      'weekday.sun': 'Sun',
      'day.label': '{weekday} {month}/{day}',
      'day.count': '{count} entries',
      'day.total': 'Expense ¥{expense} · Income ¥{income}',
      'day.empty': 'No entries on this day. Add one below.',
      'summary.income': 'Income',
      'summary.expense': 'Expense',
      'summary.net': 'Balance',
      'form.kind': 'Type',
      'form.expense': 'Expense',
      'form.income': 'Income',
      'form.date': 'Date',
      'form.amount': 'Amount',
      'form.amountPlaceholder': '0.00',
      'form.category': 'Category',
      'form.categoryPlaceholder': 'Food, transit…',
      'form.note': 'Note',
      'form.notePlaceholder': 'Lunch, subway…',
      'form.add': 'Add',
      'form.save': 'Save',
      'form.cancel': 'Cancel',
      'form.editing': 'Editing {kind} on {date}: ¥{amount}',
      'form.needAmount': 'Enter an amount greater than 0.',
      'form.uncategorized': 'Uncategorized',
      'entry.edit': 'Edit',
      'entry.delete': 'Delete',
      'entry.confirm': 'Delete',
      'entry.cancel': 'Cancel',
      'chart.monthly': 'Monthly income and expense',
      'chart.category': 'Expense by category',
      'chart.detail': 'Details by note',
      'chart.detailClose': 'Hide details',
      'chart.noteGroups': 'Grouped by note (top 20 expenses this month)',
      'chart.noteGroupsEmpty': 'No noted expenses to group this month.',
      'chart.noNote': 'No note',
      'chart.groupCount': '{count} entries',
      'chart.noteFilter': 'Filter by note keyword',
      'chart.noteFilterPlaceholder': 'Keyword, e.g. delivery',
      'chart.noteFilterClear': 'Clear',
      'chart.noteFilterEmpty': 'No noted expenses contain “{keyword}”.',
      'chart.noteFilterTitle': 'Expenses containing “{keyword}”',
      'chart.daily': 'This month, day by day',
      'chart.dailyAria': 'Daily income and expense this month: {count} days with entries',
      'chart.dailyEmpty': 'No entries this month.',
      'chart.mode': 'Chart metric',
      'chart.mode.money': 'Money',
      'chart.mode.kcal': 'Calories',
      'chart.monthlyKcal': 'Monthly intake (daily avg)',
      'chart.dailyKcal': 'Daily intake this month',
      'chart.kcalLegend': 'Intake',
      'chart.kcalAvg': 'Daily avg intake',
      'chart.kcalTarget': 'Target {target} kcal',
      'chart.kcalDays': '{days} day(s) logged',
      'chart.kcalYearAria': 'Year daily avg {avg} kcal, {days} day(s) logged',
      'chart.kcalYearCaption': 'Year daily avg {avg} kcal · {days} day(s) logged · target {target} kcal',
      'chart.dailyKcalAria': 'Daily intake chart: {count} day(s) logged',
      'chart.dailyKcalEmpty': 'No meals logged this month.',
      'chart.kcalOver': 'Over target',
      'chart.kcalLoadFailed': 'Failed to read meal data',
      'chart.other': 'Other',
      'chart.empty': 'No entries this month.',
      'chart.year': 'Year: income ¥{income} · expense ¥{expense}',
      'chart.max': 'Peak ¥{value}',
      'status.loading': 'Reading the ledger…',
      'status.reload': 'Refresh',
      'status.retry': 'Retry',
      'status.readFailed': 'Could not read the ledger',
      'status.saveFailed': 'Action failed',
      'status.saved': 'Saved {kind} ¥{amount} on {date}',
      'status.deleted': 'Deleted {kind} ¥{amount} on {date}',
      'status.uncertain': 'That entry no longer exists. Refresh to see the latest ledger.',
      'file.hint': 'Data file',
      'diet.title': 'Meals today',
      'diet.total': '{kcal} / {target} kcal',
      'diet.empty': 'No meals recorded for this day.',
      'diet.refresh': 'Refresh',
      'diet.reestimate': 'Recalculate',
      'diet.reestimate.dsh': 'Recalculated with DSH: {count} item(s).',
      'diet.reestimate.done': 'Recalculated: {changed} item(s) refreshed from the food table, {unmatched} left as-is.',
      'diet.removeMeal': 'Delete meal',
      'diet.removeMeal.confirm': 'Delete this whole meal?',
      'diet.edit': 'Edit grams',
      'diet.save': 'Save',
      'diet.cancel': 'Cancel',
      'diet.delete': 'Delete',
      'diet.addItem': 'Add food',
      'diet.addItem.name': 'Food',
      'diet.addItem.grams': 'Grams',
      'diet.addItem.submit': 'Add',
      'diet.addMeal': 'Add a meal',
      'diet.addMeal.type': 'Meal',
      'diet.addMeal.submit': 'Save meal',
      'diet.loading': 'Reading meals…',
      'diet.error': 'Failed to read meals',
      'diet.needName': 'Enter a food name.',
      'diet.needGrams': 'Enter grams greater than 0.',
      'diet.saved': 'Meal log updated.',
      'diet.deleted': 'Meal entry deleted.',
    }

    // -----------------------------------------------------------------------
    // 纯函数：日期、金额、汇总（自测脚本也直接用这些）
    // -----------------------------------------------------------------------

    /**
     * 补零到两位。
     * @param {number} value - 数字
     * @returns {string} 两位字符串
     */
    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /**
     * 拼一个日期字符串。
     * @param {number} year - 年
     * @param {number} month - 月（1–12）
     * @param {number} day - 日
     * @returns {string} `YYYY-MM-DD`
     */
    function dateOf(year, month, day) {
      return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`
    }

    /**
     * 拆日期字符串。
     * @param {string} date - `YYYY-MM-DD`
     * @returns {{ year: number, month: number, day: number }} 三段
     */
    function partsOf(date) {
      return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) }
    }

    /**
     * 某月有几天。
     * @param {number} year - 年
     * @param {number} month - 月
     * @returns {number} 天数
     */
    function daysInMonth(year, month) {
      return new Date(year, month, 0).getDate()
    }

    /**
     * 某天是周几，周一算 0。
     * @param {string} date - `YYYY-MM-DD`
     * @returns {number} 0–6
     */
    function weekdayIndex(date) {
      const parts = partsOf(date)
      return (new Date(parts.year, parts.month - 1, parts.day).getDay() + 6) % 7
    }

    /**
     * 月份加减。
     * @param {{ year: number, month: number }} view - 当前年月
     * @param {number} delta - 加减几个月
     * @returns {{ year: number, month: number }} 新年月
     */
    function shiftMonth(view, delta) {
      const index = view.year * 12 + (view.month - 1) + delta
      return { year: Math.floor(index / 12), month: (index % 12 + 12) % 12 + 1 }
    }

    /**
     * 一个月的日历格子：固定 6 行 × 7 列，含前后补位的日期。
     * @param {number} year - 年
     * @param {number} month - 月
     * @returns {Array<{ date: string, day: number, outside: boolean }>} 42 个格子
     */
    function buildMonthGrid(year, month) {
      const lead = weekdayIndex(dateOf(year, month, 1))
      const total = daysInMonth(year, month)
      const cells = []
      for (let index = 0; index < 42; index += 1) {
        const offset = index - lead
        const date = new Date(year, month - 1, 1 + offset)
        const cellDate = dateOf(date.getFullYear(), date.getMonth() + 1, date.getDate())
        cells.push({ date: cellDate, day: date.getDate(), outside: date.getMonth() + 1 !== month || date.getFullYear() !== year })
      }
      return cells
    }

    /**
     * 日期加减天数（跨月、跨年都对）。
     * @param {string} date - `YYYY-MM-DD`
     * @param {number} delta - 加减几天
     * @returns {string} 新日期
     */
    function shiftDate(date, delta) {
      const parts = partsOf(date)
      const next = new Date(parts.year, parts.month - 1, parts.day + delta)
      return dateOf(next.getFullYear(), next.getMonth() + 1, next.getDate())
    }

    /**
     * 分 → 元，四舍五入到分。
     * @param {number} cents - 分
     * @returns {number} 元
     */
    function yuan(cents) {
      return Math.round(cents) / 100
    }

    /**
     * 金额显示：两位小数 + 千分位。
     * @param {number} value - 元
     * @returns {string} 例如 `1,234.50`
     */
    function money(value) {
      return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }

    /**
     * 日历格子里的小额：三位数以上只留整数，免得撑破格子。
     * @param {number} cents - 分
     * @returns {string} 例如 `-25.5`、`-1235`
     */
    function compact(cents) {
      const value = yuan(cents)
      if (Math.abs(value) >= 100) return String(Math.round(value))
      return String(Math.round(value * 100) / 100)
    }

    /**
     * 元 → 分（求和/比例都走整数分）。
     * @param {number} value - 元
     * @returns {number} 分
     */
    function centsOf(value) {
      return Math.round(Number(value) * 100)
    }

    /**
     * 按天汇总一组账目（只含有账目的日子）。
     * @param {ReadonlyArray<object>} entries - 账目
     * @returns {Map<string, { income: number, expense: number, count: number }>} 日期 → 分
     */
    function byDay(entries) {
      const map = new Map()
      for (const entry of entries) {
        const cell = map.get(entry.date) ?? { income: 0, expense: 0, count: 0 }
        cell[entry.kind] += centsOf(entry.amount)
        cell.count += 1
        map.set(entry.date, cell)
      }
      return map
    }

    /**
     * 某个月的合计。
     * @param {ReadonlyArray<object>} entries - 整年账目
     * @param {number} year - 年
     * @param {number} month - 月
     * @returns {{ income: number, expense: number, net: number, count: number }} 分
     */
    function monthTotals(entries, year, month) {
      const prefix = `${String(year).padStart(4, '0')}-${pad2(month)}`
      let income = 0
      let expense = 0
      let count = 0
      for (const entry of entries) {
        if (entry.date.slice(0, 7) !== prefix) continue
        count += 1
        if (entry.kind === 'income') income += centsOf(entry.amount)
        else expense += centsOf(entry.amount)
      }
      return { income, expense, net: income - expense, count }
    }

    /**
     * 12 个月的收支序列（柱状图用）。
     * @param {ReadonlyArray<object>} entries - 整年账目
     * @param {number} year - 年
     * @returns {Array<{ month: number, income: number, expense: number }>} 分
     */
    function monthlySeries(entries, year) {
      const series = []
      for (let month = 1; month <= 12; month += 1) {
        const totals = monthTotals(entries, year, month)
        series.push({ month, income: totals.income, expense: totals.expense })
      }
      return series
    }

    /**
     * 某月某类别的分类汇总（金额从大到小，含占比）。
     * @param {ReadonlyArray<object>} entries - 整年账目
     * @param {number} year - 年
     * @param {number} month - 月
     * @param {string} kind - `expense` / `income`
     * @returns {Array<{ key: string, label: string|null, cents: number, count: number, share: number }>} 分类行
     */
    function categoryRows(entries, year, month, kind) {
      const prefix = `${String(year).padStart(4, '0')}-${pad2(month)}`
      const buckets = new Map()
      for (const entry of entries) {
        if (entry.kind !== kind || entry.date.slice(0, 7) !== prefix) continue
        const label = entry.category === '' ? null : entry.category
        const key = label === null ? '\u0000uncategorized' : `c:${label}`
        const bucket = buckets.get(key) ?? { key, label, cents: 0, count: 0 }
        bucket.cents += centsOf(entry.amount)
        bucket.count += 1
        buckets.set(key, bucket)
      }
      const rows = [...buckets.values()].sort((left, right) => right.cents - left.cents)
      const total = rows.reduce((sum, row) => sum + row.cents, 0)
      return rows.map(row => ({ ...row, share: total === 0 ? 0 : row.cents / total }))
    }

    /**
     * 某月的支出账目。
     * @param {ReadonlyArray<object>} entries - 账目
     * @param {number} year - 年
     * @param {number} month - 月
     * @returns {Array<object>} 支出
     */
    function monthExpenses(entries, year, month) {
      const prefix = `${String(year).padStart(4, '0')}-${pad2(month)}`
      return entries.filter(entry => entry.kind === 'expense' && entry.date.slice(0, 7) === prefix)
    }

    /**
     * 本月支出按备注分组：短备注吸收包含它的长备注（「外卖」吸收「外卖咖喱猪排饭」），
     * 按金额从大到小取前 limit 组；没有备注的归到「未备注」。
     * @param {ReadonlyArray<object>} entries - 账目
     * @param {number} year - 年
     * @param {number} month - 月
     * @param {number} limit - 最多几组
     * @returns {Array<{ label: string, cents: number, count: number, entries: Array<object> }>} 分组
     */
    function noteGroups(entries, year, month, limit = 20) {
      const expenses = monthExpenses(entries, year, month)
      if (expenses.length === 0) return []
      const notes = [...new Set(expenses.map(entry => String(entry.note ?? '').trim()).filter(note => note !== ''))]
        .sort((a, b) => a.length - b.length)
      // 同前缀出现两次以上就抽成关键词（「外卖华莱士」「外卖香河肉饼」→「外卖」）
      const prefixCount = new Map()
      for (const note of notes) {
        if (note.length < 2) continue
        const key = note.slice(0, 2)
        prefixCount.set(key, (prefixCount.get(key) ?? 0) + 1)
      }
      const labels = [...prefixCount.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
        .map(([key]) => key)
      for (const note of notes) {
        if (note.length < 2) {
          if (!labels.includes(note)) labels.push(note)
          continue
        }
        if (!labels.some(label => label.length >= 2 && note.includes(label))) labels.push(note)
      }
      const buckets = new Map()
      for (const label of labels) buckets.set(label, { label, cents: 0, count: 0, entries: [] })
      const noNote = { label: '', cents: 0, count: 0, entries: [] }
      for (const entry of expenses) {
        const note = String(entry.note ?? '').trim()
        let bucket
        if (note === '') {
          bucket = noNote
        } else {
          let assigned = ''
          for (const label of labels) {
            if (label.length < 2) continue
            if (note.includes(label) && (assigned === '' || label.length < assigned.length)) assigned = label
          }
          if (assigned === '') assigned = note
          bucket = buckets.get(assigned)
          if (bucket === undefined) {
            bucket = { label: note, cents: 0, count: 0, entries: [] }
            buckets.set(note, bucket)
          }
        }
        bucket.cents += centsOf(entry.amount)
        bucket.count += 1
        bucket.entries.push(entry)
      }
      const groups = [...buckets.values(), noNote].filter(group => group.count > 0)
      for (const group of groups) {
        group.entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      }
      groups.sort((a, b) => b.cents - a.cents || b.count - a.count)
      return groups.slice(0, limit)
    }

    /**
     * 分类行只留前 N 条，其余并成「其他」。
     * @param {ReadonlyArray<object>} rows - categoryRows 的结果
     * @param {number} limit - 最多几条（含「其他」）
     * @returns {Array<object>} 截断后的行
     */
    function topRows(rows, limit) {
      if (rows.length <= limit) return rows
      const head = rows.slice(0, limit - 1)
      const rest = rows.slice(limit - 1)
      const cents = rest.reduce((sum, row) => sum + row.cents, 0)
      const count = rest.reduce((sum, row) => sum + row.count, 0)
      return [...head, { key: '\u0000other', label: null, other: true, cents, count, share: cents / (cents + head.reduce((sum, row) => sum + row.cents, 0)) }]
    }

    /**
     * 某个月每一天的收支：没有账目的日子补零，方便画逐日柱和列清单。
     * @param {ReadonlyArray<object>} entries - 整年账目
     * @param {number} year - 年
     * @param {number} month - 月
     * @returns {Array<{ date: string, day: number, weekday: number, income: number, expense: number, net: number, count: number }>} 每天的合计（分）
     */
    function monthDays(entries, year, month) {
      const map = byDay(entries)
      const total = daysInMonth(year, month)
      const days = []
      for (let day = 1; day <= total; day += 1) {
        const date = dateOf(year, month, day)
        const bucket = map.get(date)
        const income = bucket === undefined ? 0 : bucket.income
        const expense = bucket === undefined ? 0 : bucket.expense
        days.push({
          date,
          day,
          weekday: weekdayIndex(date),
          income,
          expense,
          net: income - expense,
          count: bucket === undefined ? 0 : bucket.count,
        })
      }
      return days
    }

    /**
     * 备注相似度：完全相同 100，包含次之，再按共同字比例兜底。
     * @param {string} note - 历史备注
     * @param {string} query - 当前输入
     * @returns {number} 0~100
     */
    function noteSimilarity(note, query) {
      const n = String(note ?? '').toLowerCase()
      const q = String(query ?? '').trim().toLowerCase()
      if (q === '') return 1
      if (n === q) return 100
      if (n.startsWith(q)) return 90
      if (n.includes(q)) return 80
      if (q.includes(n)) return 70
      const chars = new Set(q.replace(/\s+/g, ''))
      if (chars.size === 0) return 0
      let hit = 0
      for (const ch of chars) if (n.includes(ch)) hit += 1
      const ratio = hit / chars.size
      return ratio >= 0.5 ? 40 + Math.round(ratio * 20) : 0
    }

    /**
     * 从历史备注里挑和当前输入最像的几条（输入为空时给最近的几条）。
     * @param {ReadonlyArray<string>} notes - 历史备注
     * @param {string} query - 当前输入
     * @param {number} limit - 最多几条
     * @returns {string[]} 推荐备注
     */
    function similarNotes(notes, query, limit = 6) {
      const q = String(query ?? '').trim()
      const seen = new Set()
      if (q === '') {
        const ordered = []
        for (const raw of notes) {
          const note = String(raw ?? '').trim()
          if (note === '' || seen.has(note)) continue
          seen.add(note)
          ordered.push(note)
          if (ordered.length >= limit) break
        }
        return ordered
      }
      const scored = []
      for (const raw of notes) {
        const note = String(raw ?? '').trim()
        if (note === '' || seen.has(note)) continue
        seen.add(note)
        const score = noteSimilarity(note, q)
        if (score <= 0) continue
        scored.push({ note, score })
      }
      scored.sort((a, b) => (b.score - a.score) || (a.note.length - b.note.length))
      return scored.slice(0, limit).map(row => row.note)
    }

    /**
     * 把错误变成一句话。
     * @param {unknown} error - 捕获到的值
     * @returns {string} 文字
     */
    function textOf(error) {
      if (error instanceof Error && typeof error.message === 'string' && error.message !== '') return error.message
      if (typeof error === 'string' && error !== '') return error
      return String(error)
    }

    /**
     * 面板里给人看的错误文案：把「找不到某条 id」这类内部细节换成能行动的话。
     * @param {unknown} error - 捕获到的值
     * @param {Function} t - 翻译
     * @returns {string} 文案
     */
    function readableError(error, t) {
      if (error !== null && typeof error === 'object' && error.code === 'balance/not-found') return t('status.uncertain')
      return textOf(error)
    }

    /**
     * 周几的短名。
     * @param {number} index - 0（周一）–6（周日）
     * @param {Function} t - 翻译
     * @returns {string} 例如 `五`
     */
    function weekdayLabel(index, t) {
      return t(['weekday.mon', 'weekday.tue', 'weekday.wed', 'weekday.thu', 'weekday.fri', 'weekday.sat', 'weekday.sun'][index] ?? 'weekday.mon')
    }

    /**
     * 「11月20日 周五」这样的日子标题。
     * @param {string} date - `YYYY-MM-DD`
     * @param {Function} t - 翻译
     * @returns {string} 标题
     */
    function dayTitle(date, t) {
      const parts = partsOf(date)
      return t('day.label', { month: parts.month, day: parts.day, weekday: weekdayLabel(weekdayIndex(date), t) })
    }

    /**
     * 「2026年11月」这样的月份标题。
     * @param {number} year - 年
     * @param {number} month - 月
     * @param {Function} t - 翻译
     * @returns {string} 标题
     */
    function monthTitle(year, month, t) {
      return t('month.label', { year, month })
    }

    /**
     * 金额带符号。
     * @param {object} entry - 账目
     * @returns {string} 例如 `-25.50`
     */
    function signedAmount(entry) {
      return `${entry.kind === 'income' ? '+' : '-'}${money(entry.amount)}`
    }

    /**
     * 页脚那一行文字：读盘中 → 上一步的结果 → 数据文件路径。
     * @param {{ busy: boolean, notice: string, file: string }} state - 面板状态
     * @param {Function} t - 翻译
     * @returns {string} 文字
     */
    function footerText(state, t) {
      if (state.busy) return t('status.loading')
      if (state.notice !== '') return state.notice
      return `${t('file.hint')}：${state.file}`
    }

    // -----------------------------------------------------------------------
    // 图标与样式
    // -----------------------------------------------------------------------

    /**
     * 记账图标：日历 + 中间一枚硬币。
     * @param {number} size - 边长
     * @returns {object} React 元素
     */
    function balanceIcon(size) {
      return h('svg', {
        className: 'bal-svg', width: size, height: size, viewBox: '0 0 24 24',
        fill: 'none', 'aria-hidden': true, focusable: 'false',
      },
      h('rect', { x: 3.2, y: 5.2, width: 17.6, height: 15.6, rx: 3.4, stroke: 'currentColor', strokeWidth: 1.5 }),
      h('path', { d: 'M7.6 3.4v3.4M16.4 3.4v3.4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      h('path', { d: 'M3.2 9.4h17.6', stroke: 'currentColor', strokeWidth: 1.5 }),
      h('circle', { cx: 12, cy: 14.8, r: 2.3, fill: 'currentColor', opacity: 0.85 }))
    }

    /**
     * 右栏 guide 卡片用的图标组件。
     * @param {{ size?: number }} props - 图标属性
     * @returns {object} React 元素
     */
    function BalanceGlyph(props) {
      return balanceIcon(props !== null && typeof props === 'object' && typeof props.size === 'number' ? props.size : 16)
    }

    /** 面板与按钮的样式（只用主题变量；随组件挂载/卸载）。 */
    const CSS = `
.bal-root{display:flex;flex-direction:column;height:100%;min-height:0;container-type:inline-size;color:var(--dsw-alias-label-primary);font:inherit}
.bal-head{flex:none;display:flex;flex-direction:column;gap:8px;padding:12px 12px 8px}
.bal-title-row{display:flex;align-items:center;gap:8px;min-width:0}
.bal-title{flex:none;font-size:13px;font-weight:600;line-height:20px}
.bal-month-nav{display:flex;align-items:center;gap:2px;margin-left:auto;min-width:0}
.bal-nav-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:1;cursor:pointer}
.bal-nav-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bal-month-label{min-width:74px;text-align:center;font-size:12px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.bal-today{flex:none;height:24px;margin-left:4px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
.bal-today:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bal-summary{display:flex;flex-wrap:wrap;gap:6px}
.bal-chip{display:inline-flex;align-items:baseline;gap:4px;padding:3px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.bal-chip b{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.bal-chip[data-tone='net'][data-negative] b{color:var(--dsw-alias-state-error-primary)}
.bal-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:10px;padding:0 12px 12px}
.bal-card{border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:10px;box-sizing:border-box}
.bal-weekdays{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:2px;margin-bottom:4px}
.bal-weekday{text-align:center;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.bal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:2px}
.bal-day{display:flex;flex-direction:column;align-items:stretch;gap:0;min-height:48px;padding:3px 4px;border:.5px solid transparent;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;overflow:hidden}
.bal-day:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bal-day[data-out]{opacity:.38}
.bal-day[data-today]{border-color:var(--dsw-alias-brand-primary)}
.bal-day[data-selected]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-selected)}
.bal-daynum{font-size:11px;line-height:14px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.bal-day[data-selected] .bal-daynum{font-weight:600;color:var(--dsw-alias-label-primary)}
.bal-day[data-today] .bal-daynum{font-weight:600;color:var(--dsw-alias-label-primary)}
.bal-amt{font-size:11px;line-height:14px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bal-day[data-selected] .bal-amt{color:var(--dsw-alias-label-primary)}
.bal-day-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:4px}
.bal-day-title{font-size:13px;font-weight:600;line-height:20px}
.bal-day-count{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.bal-day-totals{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;margin-bottom:6px}
.bal-empty{margin:8px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.bal-entry-list{display:flex;flex-direction:column;gap:1px;margin:0 0 8px;padding:0;list-style:none}
.bal-entry{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:8px}
.bal-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bal-entry-main{flex:1;min-width:0;display:flex;flex-direction:column}
.bal-entry-cat{font-size:12px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bal-entry-note{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bal-entry-amt{flex:none;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.bal-entry-actions{flex:none;display:flex;align-items:center;gap:4px}
.bal-link{display:inline-flex;align-items:center;min-height:24px;padding:0 6px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;border-radius:6px}
.bal-link:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.bal-link[data-danger]{color:var(--dsw-alias-state-error-primary)}
.bal-link:disabled{opacity:.5;cursor:default}
.bal-editing{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:0 0 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.bal-form{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l1)}
.bal-kind{display:inline-flex;align-self:flex-start;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.bal-kind button{height:22px;padding:0 10px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
.bal-kind button[data-active]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600}
.bal-fields{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.bal-field{display:flex;flex-direction:column;gap:2px;min-width:0}
.bal-field>span{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.bal-field input{height:26px;min-width:0;padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.bal-field input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.bal-field-wide{grid-column:1 / -1}
.bal-note-wrap{position:relative;display:block}
.bal-note-wrap>input{width:100%}
.bal-note-menu{position:absolute;left:0;right:0;top:calc(100% + 2px);z-index:30;margin:0;padding:2px;list-style:none;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);max-height:168px;overflow:auto}
.bal-note-option{padding:4px 6px;border-radius:6px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bal-note-option[data-active],.bal-note-option:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bal-form-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}
.bal-primary{height:26px;padding:0 12px;border:none;border-radius:7px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:12px;cursor:pointer}
.bal-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.bal-primary:disabled{opacity:.5;cursor:default}
.bal-ghost{height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.bal-ghost:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bal-problem{margin:0;font-size:11px;line-height:15px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.bal-chart-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.bal-chart-title{font-size:12px;font-weight:600;line-height:18px}
.bal-legend{display:flex;align-items:center;gap:8px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.bal-legend i{display:inline-block;width:7px;height:7px;margin-right:3px;border-radius:2px}
.bal-legend i[data-kind='income']{background:var(--dsw-alias-state-success-primary)}
.bal-legend i[data-kind='expense']{background:var(--dsw-alias-state-error-primary)}
.bal-legend i[data-kind='kcal']{background:var(--dsw-alias-brand-primary)}
.bal-bar[data-kind='kcal']{background:var(--dsw-alias-brand-primary)}
.bal-bar[data-kind='kcal'][data-over]{background:var(--dsw-alias-state-error-primary)}
.bal-daycol-bar[data-kind='kcal']{background:var(--dsw-alias-brand-primary)}
.bal-daycol-bar[data-kind='kcal'][data-over]{background:var(--dsw-alias-state-error-primary)}
.bal-modules{display:flex;align-self:flex-start;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.bal-modules button{font:inherit;font-size:11px;line-height:18px;padding:2px 10px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.bal-modules button[data-active]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600}
.bal-modules button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.bal-bars{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:2px}
.bal-bar-group{display:flex;flex-direction:column;gap:2px;min-width:0;border-radius:4px}
.bal-bar-group[data-current]{background:var(--dsw-alias-bg-layer-2)}
.bal-bar-stack{display:flex;align-items:flex-end;gap:1px;height:104px}
.bal-bar{flex:1;min-height:0;border-radius:2px 2px 0 0}
.bal-bar[data-kind='income']{background:var(--dsw-alias-state-success-primary)}
.bal-bar[data-kind='expense']{background:var(--dsw-alias-state-error-primary)}
.bal-bar-label{text-align:center;font-size:10px;line-height:13px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.bal-bar-group[data-current] .bal-bar-label{color:var(--dsw-alias-label-primary);font-weight:600}
.bal-cat-rows{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}
.bal-cat-row{display:grid;grid-template-columns:minmax(0,72px) minmax(0,1fr) 70px 32px;align-items:center;gap:6px;font-size:11px;line-height:16px}
.bal-cat-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.bal-cat-track{height:6px;border-radius:3px;background:var(--dsw-alias-border-l1);overflow:hidden}
.bal-cat-fill{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-state-error-primary)}
.bal-cat-amount{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.bal-cat-share{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.bal-note-groups{margin-top:8px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l1)}
.bal-note-groups-title{margin:0 0 4px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.bal-note-filter{display:flex;gap:6px;align-items:center;margin:0 0 6px}
.bal-note-filter input{flex:1;min-width:0;height:26px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px}
.bal-note-filter input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.bal-note-group{border-bottom:.5px solid var(--dsw-alias-border-l1)}
.bal-note-group-head{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;width:100%;padding:4px 0;border:none;background:transparent;color:inherit;font:inherit;font-size:11px;line-height:18px;text-align:left;cursor:pointer}
.bal-note-group-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.bal-note-group-count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.bal-note-group-amount{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.bal-note-group-list{list-style:none;margin:0 0 4px;padding:0 0 0 8px;display:flex;flex-direction:column;gap:2px}
.bal-note-group-row{display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:6px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.bal-note-group-note{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bal-note-group-amt{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.bal-daycols{display:grid;gap:1px;align-items:stretch}
.bal-daycol{display:flex;flex-direction:column;height:96px;min-width:0;border-radius:4px}
.bal-daycol[data-selected]{background:var(--dsw-alias-interactive-bg-active)}
.bal-daycol[data-today]{box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}
.bal-daycol-up{display:flex;align-items:flex-end;height:46px}
.bal-daycol-down{display:flex;align-items:flex-start;height:46px;margin-top:4px;border-top:1px solid var(--dsw-alias-border-l1)}
.bal-daycol-bar{display:block;width:100%;border-radius:2px 2px 0 0;background:var(--dsw-alias-state-success-primary)}
.bal-daycol-down .bal-daycol-bar{border-radius:0 0 2px 2px;background:var(--dsw-alias-state-error-primary)}
.bal-card-daily[data-mode='kcal'] .bal-daycol-up{height:92px}
.bal-card-daily[data-mode='kcal'] .bal-daycol-down{display:none}
.bal-dayticks{display:grid;gap:1px;margin-top:2px}
.bal-daytick{text-align:center;font-size:10px;line-height:13px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.bal-dailylist{display:flex;flex-direction:column;gap:1px;max-height:216px;margin:8px 0 0;padding:0;overflow:auto;overscroll-behavior:contain;list-style:none}
.bal-dailyrow{display:grid;grid-template-columns:22px 24px minmax(0,1fr) minmax(0,1fr) 34px;align-items:center;gap:6px;width:100%;min-height:26px;padding:0 4px;border:none;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:11px;line-height:16px;text-align:left;cursor:pointer;font-variant-numeric:tabular-nums}
.bal-dailyrow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bal-dailyrow[data-selected]{background:var(--dsw-alias-interactive-bg-active)}
.bal-dailyday{font-weight:600;color:var(--dsw-alias-label-primary)}
.bal-dailyweek{color:var(--dsw-alias-label-tertiary)}
.bal-dailyamt{text-align:right;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bal-dailycount{text-align:right;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.bal-foot{flex:none;display:flex;align-items:center;gap:8px;padding:6px 12px 8px;border-top:.5px solid var(--dsw-alias-border-l1)}
.bal-file{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.bal-file[data-tone='ok']{color:var(--dsw-alias-label-secondary)}
.bal-state{padding:16px 12px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.bal-state p{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.bal-state p[data-error]{color:var(--dsw-alias-state-error-primary)}
.bal-diet-head{display:flex;align-items:center;gap:8px;padding:2px 0 6px}
.bal-diet-title{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary)}
.bal-diet-total{margin-left:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.bal-diet-empty{margin:0;padding:8px 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.bal-diet-notice{margin:0 0 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-business-primary)}
.bal-diet-meals{display:flex;flex-direction:column;gap:8px}
.bal-diet-meal{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 8px}
.bal-diet-mealhead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;line-height:18px}
.bal-diet-type{font-weight:600;color:var(--dsw-alias-label-primary)}
.bal-diet-clock{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.bal-diet-mealkcal{margin-left:auto;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.bal-diet-items{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:2px}
.bal-diet-item{display:grid;grid-template-columns:minmax(0,1fr) 48px 62px minmax(84px,auto) auto auto;align-items:center;gap:6px;font-size:11px;line-height:18px}
.bal-diet-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.bal-diet-grams,.bal-diet-kcal,.bal-diet-macros{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);text-align:right;white-space:nowrap}
.bal-diet-add{display:flex;gap:6px;margin-top:6px}
.bal-diet-newmeal{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:10px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l1)}
.bal-diet-input{font:inherit;font-size:11px;line-height:18px;padding:3px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);min-width:0}
.bal-diet-input-num{width:64px}
.bal-diet-btn{font:inherit;font-size:11px;line-height:18px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}
.bal-diet-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bal-danger{color:var(--dsw-alias-state-error-primary)}
.bal-diet-editgroup{grid-column:5 / span 2;display:flex;align-items:center;gap:4px;justify-content:flex-end}
.bal-open-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.bal-open-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.bal-svg{display:block;pointer-events:none}
.bal-root button:focus-visible,.bal-open-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
@container (min-width: 720px){
.bal-body{display:grid;grid-template-columns:minmax(0,1fr) 320px;align-content:start;align-items:start}
.bal-body[data-module='diet']{display:grid;grid-template-columns:minmax(300px,360px) minmax(0,1fr);grid-template-rows:auto auto;align-items:stretch;gap:10px}
.bal-body[data-module='diet'] .bal-card-calendar{grid-column:1;grid-row:1;height:100%;display:flex;flex-direction:column;justify-content:center}
.bal-body[data-module='diet'] .bal-card-diet{grid-column:2;grid-row:2;height:100%;min-width:0}
.bal-body[data-module='diet'] .bal-card-monthly{grid-column:1;grid-row:2;height:100%;display:flex;flex-direction:column;justify-content:center}
.bal-body[data-module='diet'] .bal-card-daily{grid-column:2;grid-row:1;height:100%;display:flex;flex-direction:column;min-width:0}
.bal-body[data-module='diet'] .bal-card-daily .bal-dailylist{flex:1 1 auto;min-height:120px;overflow:auto}
.bal-card-calendar{grid-column:1;grid-row:1}
.bal-card-diet{grid-column:1;grid-row:2}
.bal-card-daily{grid-column:1;grid-row:3}
.bal-card-monthly{grid-column:1;grid-row:4}
.bal-card-category{grid-column:1;grid-row:5}
.bal-card-day{grid-column:2;grid-row:1 / span 5}
}
`

    // -----------------------------------------------------------------------
    // 小组件
    // -----------------------------------------------------------------------

    /**
     * 收支类型切换。
     * @param {{ kind: string, onChange: Function, t: Function }} props - 属性
     * @returns {object} React 元素
     */
    function KindSwitch(props) {
      const { kind, onChange, t } = props
      return h('div', { className: 'bal-kind', role: 'group', 'aria-label': t('form.kind') },
        h('button', {
          type: 'button', 'data-active': kind === 'expense' ? '' : undefined,
          'aria-pressed': kind === 'expense', onClick: () => { onChange('expense') },
        }, t('form.expense')),
        h('button', {
          type: 'button', 'data-active': kind === 'income' ? '' : undefined,
          'aria-pressed': kind === 'income', onClick: () => { onChange('income') },
        }, t('form.income')))
    }

    /**
     * 月度收支柱状图（纯 CSS 柱，文字不会被缩放）。
     * @param {{ entries: ReadonlyArray<object>, year: number, month: number, t: Function }} props - 属性
     * @returns {object} React 元素
     */
    function MonthlyBars(props) {
      const { entries, year, month, t } = props
      const series = useMemo(() => monthlySeries(entries, year), [entries, year])
      const totals = useMemo(() => monthTotals(entries, year, month), [entries, year, month])
      const yearTotals = useMemo(() => {
        let income = 0
        let expense = 0
        for (const row of series) {
          income += row.income
          expense += row.expense
        }
        return { income: yuan(income), expense: yuan(expense) }
      }, [series])
      const peak = useMemo(() => Math.max(1, ...series.map(row => Math.max(row.income, row.expense))), [series])
      return h('section', { className: 'bal-card bal-card-monthly', 'aria-label': t('chart.monthly') },
        h('div', { className: 'bal-chart-head' },
          h('h3', { className: 'bal-chart-title' }, t('chart.monthly')),
          h('span', { className: 'bal-legend' },
            h('span', null, h('i', { 'data-kind': 'income' }), t('summary.income')),
            h('span', null, h('i', { 'data-kind': 'expense' }), t('summary.expense')))),
        h('div', { className: 'bal-bars', role: 'group', 'aria-label': t('chart.year', { income: money(yearTotals.income), expense: money(yearTotals.expense) }) },
          series.map(row => h('div', {
            key: row.month, className: 'bal-bar-group',
            'data-current': row.month === month ? '' : undefined,
            'aria-label': `${row.month}: ${t('summary.income')} ¥${money(yuan(row.income))}, ${t('summary.expense')} ¥${money(yuan(row.expense))}`,
          },
          h('div', { className: 'bal-bar-stack' },
            h('span', {
              className: 'bal-bar', 'data-kind': 'income',
              style: { height: `${Math.round((row.income / peak) * 100)}%` },
              title: `${row.month} · ${t('summary.income')} ¥${money(yuan(row.income))}`,
            }),
            h('span', {
              className: 'bal-bar', 'data-kind': 'expense',
              style: { height: `${Math.round((row.expense / peak) * 100)}%` },
              title: `${row.month} · ${t('summary.expense')} ¥${money(yuan(row.expense))}`,
            })),
          h('span', { className: 'bal-bar-label' }, String(row.month))))),
        h('p', { className: 'bal-day-totals', style: { margin: '6px 0 0' } },
          t('chart.year', { income: money(yearTotals.income), expense: money(yearTotals.expense) }),
          totals.count === 0 ? '' : ` · ${t('chart.max', { value: money(yuan(peak)) })}`))
    }

    /**
     * 分类占比（横条）。
     * @param {{ rows: ReadonlyArray<object>, t: Function }} props - 属性
     * @returns {object} React 元素
     */
    function CategoryBars(props) {
      const { rows, entries = [], year, month, t } = props
      const [open, setOpen] = useState(false)
      const [expanded, setExpanded] = useState('')
      const [filter, setFilter] = useState('')
      const visible = useMemo(() => topRows(rows, 8), [rows])
      const expenses = useMemo(() => monthExpenses(entries, year, month), [entries, year, month])
      const groups = useMemo(() => noteGroups(entries, year, month, 20), [entries, year, month])
      const needle = filter.trim()
      const needleLower = needle.toLowerCase()
      const matched = useMemo(() => {
        if (needle === '') return null
        const items = expenses.filter(entry => String(entry.note ?? '').toLowerCase().includes(needleLower))
        items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
        return {
          label: needle,
          cents: items.reduce((sum, entry) => sum + centsOf(entry.amount), 0),
          count: items.length,
          entries: items,
        }
      }, [expenses, needle, needleLower])

      const groupBlock = (group, forcedOpen) => {
        const key = group.label === '' ? '\u0000none' : group.label
        const active = forcedOpen || expanded === key
        return h('div', { key, className: 'bal-note-group' },
          h('button', {
            type: 'button', className: 'bal-note-group-head', 'aria-expanded': active,
            onClick: () => { if (!forcedOpen) setExpanded(active ? '' : key) },
          },
          h('span', { className: 'bal-note-group-label' }, group.label === '' ? t('chart.noNote') : group.label),
          h('span', { className: 'bal-note-group-count' }, t('chart.groupCount', { count: String(group.count) })),
          h('span', { className: 'bal-note-group-amount' }, `¥${money(yuan(group.cents))}`)),
          active
            ? h('ul', { className: 'bal-note-group-list' },
              group.entries.map(entry => h('li', { key: entry.id, className: 'bal-note-group-row' },
                h('span', null, entry.date.slice(5)),
                h('span', { className: 'bal-note-group-note' }, entry.note || entry.category || t('form.uncategorized')),
                h('span', { className: 'bal-note-group-amt' }, `¥${money(yuan(centsOf(entry.amount)))}`))))
            : null)
      }

      return h('section', { className: 'bal-card bal-card-category', 'aria-label': t('chart.category') },
        h('div', { className: 'bal-chart-head' },
          h('h3', { className: 'bal-chart-title' }, t('chart.category')),
          h('button', {
            type: 'button', className: 'bal-link', 'aria-expanded': open,
            onClick: () => { setOpen(previous => !previous); setExpanded('') },
          }, open ? t('chart.detailClose') : t('chart.detail'))),
        visible.length === 0
          ? h('p', { className: 'bal-empty' }, t('chart.empty'))
          : h('ul', { className: 'bal-cat-rows' },
            visible.map(row => h('li', { key: row.key, className: 'bal-cat-row' },
              h('span', { className: 'bal-cat-name' }, row.other === true ? t('chart.other') : row.label === null ? t('form.uncategorized') : row.label),
              h('span', { className: 'bal-cat-track' },
                h('span', { className: 'bal-cat-fill', style: { width: `${Math.max(2, Math.round(row.share * 100))}%` } })),
              h('span', { className: 'bal-cat-amount' }, `¥${money(yuan(row.cents))}`),
              h('span', { className: 'bal-cat-share' }, `${Math.round(row.share * 100)}%`)))),
        open
          ? h('div', { className: 'bal-note-groups' },
            h('div', { className: 'bal-note-filter' },
              h('input', {
                type: 'text', value: filter, maxLength: 30,
                placeholder: t('chart.noteFilterPlaceholder'),
                'aria-label': t('chart.noteFilter'),
                onChange: (event) => { setFilter(event.target.value); setExpanded('') },
              }),
              needle === ''
                ? null
                : h('button', {
                  type: 'button', className: 'bal-link',
                  onClick: () => { setFilter(''); setExpanded('') },
                }, t('chart.noteFilterClear'))),
            needle !== ''
              ? (matched.count === 0
                ? h('p', { className: 'bal-empty' }, t('chart.noteFilterEmpty', { keyword: needle }))
                : h('div', null,
                  h('p', { className: 'bal-note-groups-title' }, t('chart.noteFilterTitle', { keyword: needle })),
                  groupBlock(matched, true)))
              : (groups.length === 0
                ? h('p', { className: 'bal-empty' }, t('chart.noteGroupsEmpty'))
                : h('div', null,
                  h('p', { className: 'bal-note-groups-title' }, t('chart.noteGroups')),
                  groups.map(group => groupBlock(group, false)))))
          : null)
    }

    /**
     * 本月逐日：每天一根收支柱（收入向上、支出向下），下面列有账目的日子（点一行跳到那天）。
     * @param {{ t: Function, days: ReadonlyArray<object>, selected: string, today: string, onPick: Function }} props - 属性
     * @returns {object} React 元素
     */
    function DailyBreakdown(props) {
      const { t, days, selected, today, onPick } = props
      const peak = useMemo(() => Math.max(1, ...days.map(day => Math.max(day.income, day.expense))), [days])
      const active = useMemo(() => days.filter(day => day.count > 0), [days])
      const columns = Math.max(1, days.length)
      const height = cents => (cents === 0 ? 0 : Math.max(2, Math.round((cents / peak) * 100)))
      return h('section', { className: 'bal-card bal-card-daily', 'aria-label': t('chart.daily') },
        h('div', { className: 'bal-chart-head' },
          h('h3', { className: 'bal-chart-title' }, t('chart.daily')),
          h('span', { className: 'bal-legend' },
            h('span', null, h('i', { 'data-kind': 'income' }), t('summary.income')),
            h('span', null, h('i', { 'data-kind': 'expense' }), t('summary.expense')))),
        h('div', {
          className: 'bal-daycols',
          style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` },
          role: 'img',
          'aria-label': t('chart.dailyAria', { count: active.length }),
        },
        days.map(day => h('span', {
          key: day.date,
          className: 'bal-daycol',
          'data-selected': day.date === selected ? '' : undefined,
          'data-today': day.date === today ? '' : undefined,
          title: `${dayTitle(day.date, t)} · ${t('summary.expense')} ¥${money(yuan(day.expense))} · ${t('summary.income')} ¥${money(yuan(day.income))}`,
        },
        h('span', { className: 'bal-daycol-up' },
          h('span', { className: 'bal-daycol-bar', style: { height: `${height(day.income)}%` } })),
        h('span', { className: 'bal-daycol-down' },
          h('span', { className: 'bal-daycol-bar', style: { height: `${height(day.expense)}%` } }))))),
        h('div', {
          className: 'bal-dayticks',
          'aria-hidden': true,
          style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` },
        }, days.map(day => h('span', { key: day.date, className: 'bal-daytick' },
          day.day === 1 || day.day % 5 === 0 || day.day === days.length ? String(day.day) : ''))),
        active.length === 0
          ? h('p', { className: 'bal-empty' }, t('chart.dailyEmpty'))
          : h('ul', { className: 'bal-dailylist' },
            active.map(day => h('li', { key: day.date },
              h('button', {
                type: 'button',
                className: 'bal-dailyrow',
                'data-selected': day.date === selected ? '' : undefined,
                'aria-label': `${dayTitle(day.date, t)}，${t('day.total', { expense: money(yuan(day.expense)), income: money(yuan(day.income)) })}，${t('day.count', { count: day.count })}`,
                onClick: () => { onPick(day.date) },
              },
              h('span', { className: 'bal-dailyday' }, pad2(day.day)),
              h('span', { className: 'bal-dailyweek' }, weekdayLabel(day.weekday, t)),
              h('span', { className: 'bal-dailyamt' }, day.expense === 0 ? '' : `-${money(yuan(day.expense))}`),
              h('span', { className: 'bal-dailyamt' }, day.income === 0 ? '' : `+${money(yuan(day.income))}`),
              h('span', { className: 'bal-dailycount' }, t('day.count', { count: day.count })))))))
    }

    /**
     * 月度摄入柱状图：每月一根「日均 kcal」柱，超过目标标红。
     * @param {{ t: Function, year: number, month: number, kcalData: object|null }} props - 属性
     * @returns {object} React 元素
     */
    function KcalMonthlyBars(props) {
      const { t, year, month, kcalData } = props
      const months = kcalData !== null && kcalData !== undefined && Array.isArray(kcalData.months) ? kcalData.months : []
      const target = kcalData !== null && kcalData !== undefined ? Number(kcalData.target) || 0 : 0
      let total = 0
      let logged = 0
      for (const row of months) {
        total += Number(row.total) || 0
        logged += Number(row.logged_days) || 0
      }
      const avg = logged > 0 ? total / logged : 0
      const peak = Math.max(1, target, ...months.map(row => Number(row.avg) || 0))
      return h('section', { className: 'bal-card bal-card-monthly', 'aria-label': t('chart.monthlyKcal') },
        h('div', { className: 'bal-chart-head' },
          h('h3', { className: 'bal-chart-title' }, t('chart.monthlyKcal')),
          h('span', { className: 'bal-legend' },
            h('span', null, h('i', { 'data-kind': 'kcal' }), t('chart.kcalAvg')),
            h('span', null, t('chart.kcalTarget', { target: String(Math.round(target)) })))),
        h('div', { className: 'bal-bars', role: 'group', 'aria-label': t('chart.kcalYearAria', { avg: String(Math.round(avg)), days: String(logged) }) },
          months.map(row => {
            const value = Number(row.avg) || 0
            return h('div', {
              key: row.month, className: 'bal-bar-group',
              'data-current': row.month === month ? '' : undefined,
              'aria-label': `${row.month}: ${t('chart.kcalAvg')} ${Math.round(value)} kcal，${t('chart.kcalDays', { days: String(row.logged_days) })}`,
            },
            h('div', { className: 'bal-bar-stack' },
              h('span', {
                className: 'bal-bar', 'data-kind': 'kcal',
                'data-over': target > 0 && value > target ? '' : undefined,
                style: { height: `${Math.round((value / peak) * 100)}%` },
                title: `${row.month} · ${t('chart.kcalAvg')} ${Math.round(value)} kcal`,
              })),
            h('span', { className: 'bal-bar-label' }, String(row.month)))
          })),
        h('p', { className: 'bal-day-totals', style: { margin: '6px 0 0' } },
          t('chart.kcalYearCaption', {
            avg: String(Math.round(avg)),
            days: String(logged),
            target: String(Math.round(target)),
          })))
    }

    /**
     * 本月逐日摄入：每天一根 kcal 柱，超过目标标红；下面列出有记录的日子。
     * @param {{ t: Function, days: ReadonlyArray<object>, selected: string, today: string, onPick: Function, kcalData: object|null }} props - 属性
     * @returns {object} React 元素
     */
    function KcalDaily(props) {
      const { t, days, selected, today, onPick, kcalData } = props
      const map = kcalData !== null && kcalData !== undefined && kcalData.days !== null && typeof kcalData.days === 'object' ? kcalData.days : {}
      const target = kcalData !== null && kcalData !== undefined ? Number(kcalData.target) || 0 : 0
      const valueOf = date => Number(map[date]) || 0
      const peak = Math.max(1, target, ...days.map(day => valueOf(day.date)))
      const columns = Math.max(1, days.length)
      const active = days.filter(day => valueOf(day.date) > 0)
      const height = value => (value === 0 ? 0 : Math.max(2, Math.round((value / peak) * 100)))
      return h('section', { className: 'bal-card bal-card-daily', 'data-mode': 'kcal', 'aria-label': t('chart.dailyKcal') },
        h('div', { className: 'bal-chart-head' },
          h('h3', { className: 'bal-chart-title' }, t('chart.dailyKcal')),
          h('span', { className: 'bal-legend' },
            h('span', null, h('i', { 'data-kind': 'kcal' }), t('chart.kcalLegend')),
            h('span', null, t('chart.kcalTarget', { target: String(Math.round(target)) })))),
        h('div', {
          className: 'bal-daycols',
          style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` },
          role: 'img',
          'aria-label': t('chart.dailyKcalAria', { count: String(active.length) }),
        },
        days.map(day => {
          const value = valueOf(day.date)
          return h('span', {
            key: day.date,
            className: 'bal-daycol',
            'data-selected': day.date === selected ? '' : undefined,
            'data-today': day.date === today ? '' : undefined,
            title: `${dayTitle(day.date, t)} · ${t('chart.kcalLegend')} ${Math.round(value)} kcal`,
          },
          h('span', { className: 'bal-daycol-up' },
            h('span', {
              className: 'bal-daycol-bar', 'data-kind': 'kcal',
              'data-over': target > 0 && value > target ? '' : undefined,
              style: { height: `${height(value)}%` },
            })),
          h('span', { className: 'bal-daycol-down' }))
        })),
        h('div', {
          className: 'bal-dayticks',
          'aria-hidden': true,
          style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` },
        }, days.map(day => h('span', { key: day.date, className: 'bal-daytick' },
          day.day === 1 || day.day % 5 === 0 || day.day === days.length ? String(day.day) : ''))),
        active.length === 0
          ? h('p', { className: 'bal-empty' }, t('chart.dailyKcalEmpty'))
          : h('ul', { className: 'bal-dailylist' },
            active.map(day => {
              const value = valueOf(day.date)
              return h('li', { key: day.date },
                h('button', {
                  type: 'button',
                  className: 'bal-dailyrow',
                  'data-selected': day.date === selected ? '' : undefined,
                  'aria-label': `${dayTitle(day.date, t)}，${t('chart.kcalLegend')} ${Math.round(value)} kcal`,
                  onClick: () => { onPick(day.date) },
                },
                h('span', { className: 'bal-dailyday' }, pad2(day.day)),
                h('span', { className: 'bal-dailyweek' }, weekdayLabel(day.weekday, t)),
                h('span', { className: 'bal-dailyamt' }, `${Math.round(value)} kcal`),
                h('span', { className: 'bal-dailyamt' }, target > 0 && value > target ? t('chart.kcalOver') : ''),
                h('span', { className: 'bal-dailycount' }, '')))
            })))
    }

    /**
     * 备注输入 + 历史备注推荐下拉（相似度排序，键盘可选）。
     * @param {{ t: Function, value: string, notes: ReadonlyArray<string>, onChange: Function }} props - 属性
     * @returns {object} React 元素
     */
    function NoteField(props) {
      const { t, value, notes = [], onChange, placeholder, label, maxLength = 200 } = props
      const placeholderText = placeholder === undefined ? t('form.notePlaceholder') : placeholder
      const ariaLabel = label === undefined ? t('form.note') : label
      const [open, setOpen] = useState(false)
      const [active, setActive] = useState(-1)
      const wrapRef = useRef(null)
      const suggestions = useMemo(() => similarNotes(Array.isArray(notes) ? notes : [], value, 6), [notes, value])

      useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined
        const onPointerDown = (event) => {
          const wrap = wrapRef.current
          if (wrap !== null && wrap !== undefined && !wrap.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        return () => document.removeEventListener('mousedown', onPointerDown)
      }, [open])

      const choose = (note) => {
        onChange(note)
        setOpen(false)
        setActive(-1)
      }

      return h('div', { className: 'bal-note-wrap', ref: wrapRef },
        h('input', {
          type: 'text', value, maxLength,
          placeholder: placeholderText,
          'aria-label': ariaLabel,
          role: 'combobox', 'aria-expanded': open, 'aria-autocomplete': 'list',
          onFocus: () => { setOpen(true); setActive(-1) },
          onChange: (event) => { onChange(event.target.value); setOpen(true); setActive(-1) },
          onKeyDown: (event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              if (!open) setOpen(true)
              setActive(previous => Math.min(suggestions.length - 1, previous + 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive(previous => Math.max(-1, previous - 1))
            } else if (event.key === 'Enter') {
              if (open && active >= 0 && active < suggestions.length) {
                event.preventDefault()
                choose(suggestions[active])
              }
            } else if (event.key === 'Escape') {
              setOpen(false)
              setActive(-1)
            }
          },
        }),
        open && suggestions.length > 0
          ? h('ul', { className: 'bal-note-menu', role: 'listbox', 'aria-label': ariaLabel },
            suggestions.map((note, index) => h('li', {
              key: note, role: 'option', 'aria-selected': index === active,
              className: 'bal-note-option', 'data-active': index === active ? '' : undefined,
              onMouseDown: (event) => { event.preventDefault() },
              onClick: (event) => { event.preventDefault(); event.stopPropagation(); choose(note) },
              onMouseEnter: () => { setActive(index) },
            }, note)))
          : null)
    }

    /**
     * 某一天的账目 + 记一笔表单。
     * @param {object} props - 属性
     * @returns {object} React 元素
     */
    function DayPanel(props) {
      const {
        t, date, entries, form, busy, problem, pendingDelete, categories, cardRef, notes,
        onFormChange, onSubmit, onCancelEdit, onStartEdit, onAskDelete, onDelete, onCancelDelete,
      } = props
      let income = 0
      let expense = 0
      for (const entry of entries) {
        if (entry.kind === 'income') income += centsOf(entry.amount)
        else expense += centsOf(entry.amount)
      }
      return h('section', { ref: cardRef, className: 'bal-card bal-card-day', 'aria-label': dayTitle(date, t) },
        h('div', { className: 'bal-day-head' },
          h('h3', { className: 'bal-day-title' }, dayTitle(date, t)),
          h('span', { className: 'bal-day-count' }, t('day.count', { count: entries.length }))),
        h('div', { className: 'bal-day-totals' }, t('day.total', { expense: money(yuan(expense)), income: money(yuan(income)) })),
        entries.length === 0
          ? h('p', { className: 'bal-empty' }, t('day.empty'))
          : h('ul', { className: 'bal-entry-list' },
            entries.map((entry) => {
              const name = `${entry.category === '' ? t('form.uncategorized') : entry.category} ${signedAmount(entry)}`
              return h('li', { key: entry.id, className: 'bal-entry' },
                h('div', { className: 'bal-entry-main' },
                  h('span', { className: 'bal-entry-cat' }, entry.category === '' ? t('form.uncategorized') : entry.category),
                  entry.note === '' ? null : h('span', { className: 'bal-entry-note' }, entry.note)),
                h('span', { className: 'bal-entry-amt' }, signedAmount(entry)),
                h('div', { className: 'bal-entry-actions' },
                  pendingDelete === entry.id
                    ? h(React.Fragment, null,
                      h('button', {
                        type: 'button', className: 'bal-link', 'data-danger': '',
                        'aria-label': `${t('entry.confirm')} ${name}`,
                        onClick: () => { onDelete(entry.id) }, disabled: busy,
                      }, t('entry.confirm')),
                      h('button', { type: 'button', className: 'bal-link', onClick: onCancelDelete }, t('entry.cancel')))
                    : h(React.Fragment, null,
                      h('button', {
                        type: 'button', className: 'bal-link',
                        'aria-label': `${t('entry.edit')} ${name}`,
                        onClick: () => { onStartEdit(entry) },
                      }, t('entry.edit')),
                      h('button', {
                        type: 'button', className: 'bal-link', 'data-danger': '',
                        'aria-label': `${t('entry.delete')} ${name}`,
                        onClick: () => { onAskDelete(entry.id) },
                      }, t('entry.delete')))))
            })),
        form.id === ''
          ? null
          : h('p', { className: 'bal-editing', role: 'status' },
            t('form.editing', {
              date: dayTitle(form.date, t),
              kind: form.kind === 'income' ? t('form.income') : t('form.expense'),
              amount: form.amount === '' ? '0.00' : form.amount,
            })),
        h('form', { className: 'bal-form', onSubmit },
          h(KindSwitch, { kind: form.kind, onChange: value => { onFormChange({ kind: value }) }, t }),
          h('div', { className: 'bal-fields' },
            h('label', { className: 'bal-field' },
              h('span', null, t('form.amount')),
              h('input', {
                type: 'number', inputMode: 'decimal', step: '0.01', min: '0.01', required: true,
                value: form.amount, placeholder: t('form.amountPlaceholder'),
                onChange: event => { onFormChange({ amount: event.target.value }) },
              })),
            h('label', { className: 'bal-field' },
              h('span', null, t('form.date')),
              h('input', {
                type: 'date', value: form.date, required: true,
                onChange: event => { onFormChange({ date: event.target.value }) },
              })),
            h('label', { className: 'bal-field bal-field-wide' },
              h('span', null, t('form.category')),
              h(NoteField, {
                t, value: form.category, notes: categories, maxLength: 32,
                placeholder: t('form.categoryPlaceholder'), label: t('form.category'),
                onChange: value => { onFormChange({ category: value }) },
              })),
            h('label', { className: 'bal-field bal-field-wide' },
              h('span', null, t('form.note')),
              h(NoteField, {
                t, value: form.note, notes,
                onChange: value => { onFormChange({ note: value }) },
              }))),
          h('div', { className: 'bal-form-foot' },
            h('button', { type: 'submit', className: 'bal-primary', disabled: busy },
              form.id === '' ? t('form.add') : t('form.save')),
            form.id === '' ? null : h('button', { type: 'button', className: 'bal-ghost', onClick: onCancelEdit }, t('form.cancel')),
            problem === '' ? null : h('p', { className: 'bal-problem', role: 'alert' }, problem))))
    }

    /**
     * 面板本体：月历 + 当天账目 + 图表。
     * @param {{ t: Function, balance: object }} props - 属性（t 来自 locale 槽位，balance 来自 inject）
     * @returns {object} React 元素
     */
    // -----------------------------------------------------------------------
    // 当天饮食卡片（读汐汐的 diet.db；写操作走容器里的 panel_api.py）
    // -----------------------------------------------------------------------

    /** 餐次选项（与汐汐的饮食库一致）。 */
    const MEAL_TYPES = ['早餐', '午餐', '晚餐', '夜宵', '加餐']

    /**
     * 当天饮食：按餐列出食物、克数和热量，可改克数、删食物、加食物、整餐重算。
     * @param {{ t: Function, balance: object, date: string }} props - 属性
     * @returns {object} React 元素
     */
    function DietCard(props) {
      const { t, balance, date, onDietChange } = props
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [editing, setEditing] = useState({ id: '', grams: '' })
      const [adding, setAdding] = useState({})
      const [newMeal, setNewMeal] = useState({ type: '加餐', name: '', grams: '' })
      const [confirmMeal, setConfirmMeal] = useState('')
      const ticket = useRef(0)

      const load = useCallback(async (quiet) => {
        if (date === '') return
        ticket.current += 1
        const current = ticket.current
        if (!quiet) setBusy(true)
        try {
          const next = await balance.dietLoad(date)
          if (current !== ticket.current) return
          setData(next)
          setError('')
        } catch (failure) {
          if (current !== ticket.current) return
          setError(readableError(failure, t))
        } finally {
          if (current === ticket.current && !quiet) setBusy(false)
        }
      }, [balance, date, t])

      useEffect(() => { void load(false) }, [load])

      // 汐汐那边随时可能改库：面板开着时每 30 秒静默同步一次。
      useEffect(() => {
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(() => { void load(true) }, 30000)
        return () => clearInterval(timer)
      }, [load])

      const run = useCallback(async (action, message) => {
        setBusy(true)
        setNotice('')
        setError('')
        try {
          const result = await action()
          setNotice(typeof message === 'function' ? message(result) : message)
          await load(true)
          if (typeof onDietChange === 'function') onDietChange()
        } catch (failure) {
          setError(readableError(failure, t))
        } finally {
          setBusy(false)
        }
      }, [load, onDietChange, t])

      const needGrams = useCallback((value) => {
        const grams = Number(value)
        if (!Number.isFinite(grams) || grams <= 0) {
          setError(t('diet.needGrams'))
          return null
        }
        return grams
      }, [t])

      const saveItem = useCallback(() => {
        const grams = needGrams(editing.grams)
        if (grams === null) return
        void run(
          () => balance.dietUpdateItem(Number(editing.id), grams),
          t('diet.saved'),
        ).then(() => setEditing({ id: '', grams: '' }))
      }, [balance, editing, needGrams, run, t])

      const deleteItem = useCallback((itemId) => {
        void run(() => balance.dietDeleteItem(itemId), t('diet.deleted'))
      }, [balance, run, t])

      const addItem = useCallback((mealId) => {
        const draft = adding[mealId] ?? { name: '', grams: '' }
        const name = String(draft.name ?? '').trim()
        if (name === '') {
          setError(t('diet.needName'))
          return
        }
        const grams = needGrams(draft.grams)
        if (grams === null) return
        void run(
          () => balance.dietAddItem(mealId, name, grams),
          t('diet.saved'),
        ).then(() => setAdding(previous => ({ ...previous, [mealId]: { name: '', grams: '' } })))
      }, [adding, balance, needGrams, run, t])

      const deleteMeal = useCallback((mealId) => {
        void run(() => balance.dietDeleteMeal(mealId), t('diet.deleted'))
          .then(() => setConfirmMeal(''))
      }, [balance, run, t])

      const reestimate = useCallback((mealId) => {
        void run(
          () => balance.dietReestimate(mealId),
          result => (result.dsh === 'ok'
            ? t('diet.reestimate.dsh', { count: Number(result.inserted) || 0 })
            : t('diet.reestimate.done', {
              changed: Array.isArray(result.changed) ? result.changed.length : 0,
              unmatched: Array.isArray(result.unmatched) ? result.unmatched.length : 0,
            })),
        )
      }, [balance, run, t])

      const submitMeal = useCallback(() => {
        const name = String(newMeal.name ?? '').trim()
        if (name === '') {
          setError(t('diet.needName'))
          return
        }
        const grams = needGrams(newMeal.grams)
        if (grams === null) return
        void run(
          () => balance.dietAddMeal(date, newMeal.type, name, grams),
          t('diet.saved'),
        ).then(() => setNewMeal({ type: newMeal.type, name: '', grams: '' }))
      }, [balance, date, needGrams, newMeal, run, t])

      const setDraft = useCallback((mealId, patch) => {
        setAdding(previous => ({
          ...previous,
          [mealId]: { name: '', grams: '', ...(previous[mealId] ?? {}), ...patch },
        }))
      }, [])

      const itemRow = (item) => {
        const isEditing = editing.id === String(item.id)
        return h('li', { key: item.id, className: 'bal-diet-item' },
          h('span', { className: 'bal-diet-name', title: item.name }, item.name),
          h('span', { className: 'bal-diet-grams' }, `${Math.round(Number(item.grams) || 0)}g`),
          h('span', { className: 'bal-diet-kcal' }, `${Math.round(Number(item.kcal) || 0)} kcal`),
          h('span', { className: 'bal-diet-macros' },
            `P${Math.round(Number(item.protein) || 0)} F${Math.round(Number(item.fat) || 0)} C${Math.round(Number(item.carb) || 0)}`),
          isEditing
            ? h('span', { className: 'bal-diet-editgroup' },
              h('input', {
                className: 'bal-diet-input bal-diet-input-num',
                type: 'number', min: '1', step: '1',
                'aria-label': t('diet.edit'),
                value: editing.grams,
                onChange: event => setEditing({ id: editing.id, grams: event.target.value }),
                onKeyDown: event => { if (event.key === 'Enter') saveItem() },
              }),
              h('button', { type: 'button', className: 'bal-link', disabled: busy, onClick: saveItem }, t('diet.save')),
              h('button', { type: 'button', className: 'bal-link', onClick: () => setEditing({ id: '', grams: '' }) }, t('diet.cancel')))
            : h(React.Fragment, null,
              h('button', {
                type: 'button', className: 'bal-link',
                onClick: () => { setEditing({ id: String(item.id), grams: String(Math.round(Number(item.grams) || 0)) }); setError('') },
              }, t('diet.edit')),
              h('button', { type: 'button', className: 'bal-link bal-danger', disabled: busy, onClick: () => deleteItem(Number(item.id)) }, t('diet.delete'))))
      }

      const addRow = (mealId) => {
        const draft = adding[mealId] ?? { name: '', grams: '' }
        return h('div', { className: 'bal-diet-add' },
          h('input', {
            className: 'bal-diet-input', type: 'text',
            placeholder: t('diet.addItem.name'), 'aria-label': t('diet.addItem.name'),
            value: draft.name,
            onChange: event => setDraft(mealId, { name: event.target.value }),
          }),
          h('input', {
            className: 'bal-diet-input bal-diet-input-num', type: 'number', min: '1', step: '1',
            placeholder: t('diet.addItem.grams'), 'aria-label': t('diet.addItem.grams'),
            value: draft.grams,
            onChange: event => setDraft(mealId, { grams: event.target.value }),
            onKeyDown: event => { if (event.key === 'Enter') addItem(mealId) },
          }),
          h('button', { type: 'button', className: 'bal-diet-btn', disabled: busy, onClick: () => addItem(mealId) }, t('diet.addItem.submit')))
      }

      const mealBlock = (meal) => h('div', { key: meal.id, className: 'bal-diet-meal' },
        h('div', { className: 'bal-diet-mealhead' },
          h('b', { className: 'bal-diet-type' }, meal.meal_type || '一餐'),
          h('span', { className: 'bal-diet-clock' }, meal.clock || ''),
          h('span', { className: 'bal-diet-mealkcal' }, `${Math.round(Number(meal.kcal) || 0)} kcal`),
          h('button', { type: 'button', className: 'bal-link', disabled: busy, onClick: () => reestimate(Number(meal.id)) }, t('diet.reestimate')),
          confirmMeal === String(meal.id)
            ? h(React.Fragment, null,
              h('button', { type: 'button', className: 'bal-link bal-danger', disabled: busy, onClick: () => deleteMeal(Number(meal.id)) }, t('diet.removeMeal.confirm')),
              h('button', { type: 'button', className: 'bal-link', onClick: () => setConfirmMeal('') }, t('diet.cancel')))
            : h('button', { type: 'button', className: 'bal-link', disabled: busy, onClick: () => setConfirmMeal(String(meal.id)) }, t('diet.removeMeal'))),
        h('ul', { className: 'bal-diet-items' }, (meal.items ?? []).map(itemRow)),
        addRow(Number(meal.id)))

      return h('section', { className: 'bal-card bal-card-diet', 'aria-label': t('diet.title') },
        h('div', { className: 'bal-diet-head' },
          h('span', { className: 'bal-diet-title' }, t('diet.title')),
          data === null ? null : h('span', { className: 'bal-diet-total' },
            t('diet.total', { kcal: Math.round(Number(data.total.kcal) || 0), target: Math.round(Number(data.target) || 0) })),
          h('button', { type: 'button', className: 'bal-link', disabled: busy, onClick: () => { setNotice(''); void load(false) } }, t('diet.refresh'))),
        error === '' ? null : h('p', { className: 'bal-problem', role: 'alert' }, `${t('diet.error')}：${error}`),
        notice === '' ? null : h('p', { className: 'bal-diet-notice', role: 'status' }, notice),
        data === null
          ? h('p', { className: 'bal-diet-empty' }, busy ? t('diet.loading') : t('diet.empty'))
          : (data.meals.length === 0
            ? h('p', { className: 'bal-diet-empty' }, t('diet.empty'))
            : h('div', { className: 'bal-diet-meals' }, data.meals.map(mealBlock))),
        h('div', { className: 'bal-diet-newmeal' },
          h('span', { className: 'bal-diet-title' }, t('diet.addMeal')),
          h('select', {
            className: 'bal-diet-input', 'aria-label': t('diet.addMeal.type'),
            value: newMeal.type,
            onChange: event => setNewMeal(previous => ({ ...previous, type: event.target.value })),
          }, MEAL_TYPES.map(type => h('option', { key: type, value: type }, type))),
          h('input', {
            className: 'bal-diet-input', type: 'text',
            placeholder: t('diet.addItem.name'), 'aria-label': t('diet.addItem.name'),
            value: newMeal.name,
            onChange: event => setNewMeal(previous => ({ ...previous, name: event.target.value })),
          }),
          h('input', {
            className: 'bal-diet-input bal-diet-input-num', type: 'number', min: '1', step: '1',
            placeholder: t('diet.addItem.grams'), 'aria-label': t('diet.addItem.grams'),
            value: newMeal.grams,
            onChange: event => setNewMeal(previous => ({ ...previous, grams: event.target.value })),
            onKeyDown: event => { if (event.key === 'Enter') submitMeal() },
          }),
          h('button', { type: 'button', className: 'bal-diet-btn', disabled: busy, onClick: submitMeal }, t('diet.addMeal.submit'))))
    }

    function BalanceBody(props) {
      const t = props.t
      const balance = props.balance
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(true)
      const [year, setYear] = useState(null)
      const [month, setMonth] = useState(null)
      const [selected, setSelected] = useState('')
      const [form, setForm] = useState({ id: '', date: '', kind: 'expense', amount: '', category: '', note: '' })
      const [problem, setProblem] = useState('')
      const [pendingDelete, setPendingDelete] = useState('')
      const [module, setModule] = useState('money')
      const [dietRevision, setDietRevision] = useState(0)
      const [kcalMonth, setKcalMonth] = useState(null)
      const [kcalYear, setKcalYear] = useState(null)
      const [chartError, setChartError] = useState('')
      const [chartRetry, setChartRetry] = useState(0)
      const [notice, setNotice] = useState('')
      const ticket = useRef(0)
      const gridRef = useRef(null)
      const dayCardRef = useRef(null)

      /**
       * 读某一年（成功返回 true；失败只把原因放进 error，调用方自行决定要不要改视图）。
       * @param {number|undefined} targetYear - 年份；省略用服务器当年
       * @returns {Promise<boolean>} 是否成功
       */
      const load = useCallback(async (targetYear) => {
        ticket.current += 1
        const current = ticket.current
        setBusy(true)
        try {
          const next = await balance.load(targetYear === undefined || targetYear === null ? undefined : targetYear)
          if (current !== ticket.current) return false
          setData(next)
          setYear(next.year)
          setError('')
          setMonth(previous => (previous === null ? Number(next.today.slice(5, 7)) : previous))
          setSelected(previous => {
            if (previous === '') return next.today
            if (previous.slice(0, 4) !== String(next.year)) return next.today
            return previous
          })
          return true
        } catch (failure) {
          if (current !== ticket.current) return false
          setError(readableError(failure, t))
          return false
        } finally {
          if (current === ticket.current) setBusy(false)
        }
      }, [balance, t])

      useEffect(() => { void load(undefined) }, [load])

      // 切到卡路里口径时，读这个月和这一年的摄入数据（图表用）。
      useEffect(() => {
        if (module !== 'diet' || year === null || month === null) return undefined
        let cancelled = false
        setChartError('')
        void (async () => {
          try {
            const [monthData, yearData] = await Promise.all([
              balance.dietMonth(year, month),
              balance.dietYear(year),
            ])
            if (!cancelled) {
              setKcalMonth(monthData)
              setKcalYear(yearData)
            }
          } catch (failure) {
            if (!cancelled) setChartError(readableError(failure, t))
          }
        })()
        return () => { cancelled = true }
      }, [module, chartRetry, dietRevision, year, month, balance, t])

      // 选中的日子变了：没在编辑时，表单日期跟着走。
      useEffect(() => {
        if (selected === '') return
        setForm(previous => (previous.id === '' && previous.date !== selected ? { ...previous, date: selected } : previous))
      }, [selected])

      /**
       * 把键盘焦点放到某一天（换月后格位会被复用，所以按 data-date 找）。
       * @param {string} date - `YYYY-MM-DD`
       * @returns {void}
       */
      const focusDay = useCallback((date) => {
        if (typeof requestAnimationFrame !== 'function') return
        requestAnimationFrame(() => {
          const grid = gridRef.current
          if (grid === null || grid === undefined || typeof grid.querySelector !== 'function') return
          const node = grid.querySelector(`[data-date="${date}"]`)
          if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
        })
      }, [])

      const today = data === null ? '' : data.today
      const noteOptions = data === null || !Array.isArray(data.notes) ? [] : data.notes
      const entries = data === null ? [] : data.entries
      const dayMap = useMemo(() => byDay(entries), [entries])
      const monthSum = useMemo(
        () => (year === null || month === null ? { income: 0, expense: 0, net: 0, count: 0 } : monthTotals(entries, year, month)),
        [entries, year, month],
      )
      const rows = useMemo(
        () => (year === null || month === null ? [] : categoryRows(entries, year, month, 'expense')),
        [entries, year, month],
      )
      const days = useMemo(
        () => (year === null || month === null ? [] : monthDays(entries, year, month)),
        [entries, year, month],
      )
      const dayEntries = useMemo(() => entries.filter(entry => entry.date === selected), [entries, selected])
      const categories = useMemo(() => {
        const defaults = data === null || data.defaults === undefined ? [] : data.defaults[form.kind] ?? []
        const used = []
        for (const entry of entries) {
          if (entry.kind === form.kind && entry.category !== '' && !defaults.includes(entry.category) && !used.includes(entry.category)) used.push(entry.category)
        }
        return [...defaults, ...used]
      }, [data, entries, form.kind])

      /**
       * 换月（跨年时先读新年份，读失败就不改视图，避免标题和格子对不上）。
       * @param {number} targetYear - 目标年
       * @param {number} targetMonth - 目标月
       * @param {string} [targetDate] - 换完后要选中的日子
       * @returns {Promise<void>} 完成
       */
      const goMonth = useCallback(async (targetYear, targetMonth, targetDate) => {
        setPendingDelete('')
        setProblem('')
        setNotice('')
        if (targetYear !== year) {
          const ok = await load(targetYear)
          if (!ok) return
        }
        setMonth(targetMonth)
        const prefix = `${String(targetYear).padStart(4, '0')}-${pad2(targetMonth)}`
        setSelected((previous) => {
          if (targetDate !== undefined) return targetDate
          if (previous.slice(0, 7) === prefix) return previous
          return dateOf(targetYear, targetMonth, 1)
        })
        if (targetDate !== undefined) focusDay(targetDate)
      }, [year, load, focusDay])

      const goToday = useCallback(() => {
        if (today === '') return
        const parts = partsOf(today)
        void goMonth(parts.year, parts.month, today)
      }, [today, goMonth])

      // 点日历上的某一天（含前后补位的日子）：换个年份就重新拉那一年。
      const pickDay = useCallback((date) => {
        setPendingDelete('')
        setProblem('')
        setNotice('')
        const parts = partsOf(date)
        if (parts.year !== year || parts.month !== month) {
          void goMonth(parts.year, parts.month, date)
        } else {
          setSelected(date)
        }
        // 单栏时当天面板在日历下面，可能不在视口里：把它带到眼前（已经可见就不动）。
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            const card = dayCardRef.current
            if (card !== null && card !== undefined && typeof card.scrollIntoView === 'function') {
              card.scrollIntoView({ block: 'nearest' })
            }
          })
        }
      }, [year, month, goMonth])

      /**
       * 日历的方向键：左右一天、上下七天、Home/End 月初月末。
       * @param {KeyboardEvent} event - 键盘事件
       * @param {string} date - 当前格子的日期
       * @returns {void}
       */
      const onDayKey = useCallback((event, date) => {
        let next = ''
        if (event.key === 'ArrowLeft') next = shiftDate(date, -1)
        else if (event.key === 'ArrowRight') next = shiftDate(date, 1)
        else if (event.key === 'ArrowUp') next = shiftDate(date, -7)
        else if (event.key === 'ArrowDown') next = shiftDate(date, 7)
        else if (event.key === 'Home') next = dateOf(year, month, 1)
        else if (event.key === 'End') next = dateOf(year, month, daysInMonth(year, month))
        else return
        event.preventDefault()
        pickDay(next)
      }, [year, month, pickDay])

      const submit = useCallback(async (event) => {
        event.preventDefault()
        if (busy) return
        const amount = Number(form.amount)
        if (!Number.isFinite(amount) || amount <= 0) {
          setProblem(t('form.needAmount'))
          return
        }
        setBusy(true)
        setProblem('')
        try {
          const entry = await balance.save({
            id: form.id === '' ? undefined : form.id,
            date: form.date,
            kind: form.kind,
            amount,
            category: form.category.trim(),
            note: form.note.trim(),
          })
          const parts = partsOf(entry.date)
          setMonth(parts.month)
          setSelected(entry.date)
          const reloaded = await load(parts.year)
          setForm({ id: '', date: entry.date, kind: form.kind, amount: '', category: form.category, note: '' })
          setPendingDelete('')
          if (reloaded) {
            setNotice(t('status.saved', {
              date: dayTitle(entry.date, t),
              kind: form.kind === 'income' ? t('form.income') : t('form.expense'),
              amount: money(entry.amount),
            }))
          }
        } catch (failure) {
          setProblem(readableError(failure, t))
        } finally {
          setBusy(false)
        }
      }, [balance, busy, form, load, t])

      const removeEntry = useCallback(async (id) => {
        setBusy(true)
        setProblem('')
        try {
          const removed = await balance.remove(id)
          setPendingDelete('')
          if (form.id === id) setForm({ id: '', date: selected, kind: form.kind, amount: '', category: '', note: '' })
          const reloaded = await load(year)
          if (reloaded && removed !== null && typeof removed === 'object') {
            setNotice(t('status.deleted', {
              date: dayTitle(removed.date, t),
              kind: removed.kind === 'income' ? t('form.income') : t('form.expense'),
              amount: money(removed.amount),
            }))
          }
        } catch (failure) {
          setProblem(readableError(failure, t))
        } finally {
          setBusy(false)
        }
      }, [balance, form.id, form.kind, load, selected, t, year])

      const onFormChange = useCallback((patch) => {
        setForm(previous => ({ ...previous, ...patch }))
      }, [])

      const startEdit = useCallback((entry) => {
        setForm({
          id: entry.id, date: entry.date, kind: entry.kind,
          amount: String(entry.amount), category: entry.category, note: entry.note,
        })
        setSelected(entry.date)
        setProblem('')
        setPendingDelete('')
        setNotice('')
      }, [])

      const cancelEdit = useCallback(() => {
        setForm({ id: '', date: selected, kind: 'expense', amount: '', category: '', note: '' })
        setProblem('')
        setNotice('')
      }, [selected])

      if (data === null) {
        return h('div', { className: 'bal-root', role: 'region', 'aria-label': t('panel.title') },
          h('style', null, CSS),
          h('div', { className: 'bal-state' },
            h('p', { 'data-error': error === '' ? undefined : '' },
              error === '' ? t('status.loading') : `${t('status.readFailed')}：${error}`),
            error === '' ? null : h('button', { type: 'button', className: 'bal-ghost', onClick: () => { void load(undefined) } }, t('status.retry'))))
      }

      const grid = buildMonthGrid(year, month)
      const weekdayNames = [0, 1, 2, 3, 4, 5, 6].map(index => weekdayLabel(index, t))

      const calendarCard = h('section', { className: 'bal-card bal-card-calendar', 'aria-label': t('month.label', { year, month }) },
        h('div', { className: 'bal-weekdays' }, weekdayNames.map((name, index) => h('span', { key: index, className: 'bal-weekday' }, name))),
        h('div', { ref: gridRef, className: 'bal-grid', role: 'group' },
          grid.map((cell, index) => {
            const bucket = dayMap.get(cell.date)
            const dayLabel = dayTitle(cell.date, t)
            const dayKcal = module === 'diet' && kcalMonth !== null && kcalMonth.days !== undefined
              ? Number(kcalMonth.days[cell.date]) || 0
              : 0
            const aria = module === 'diet'
              ? (dayKcal > 0 ? `${dayLabel}，${Math.round(dayKcal)} kcal` : dayLabel)
              : (bucket === undefined
                ? dayLabel
                : `${dayLabel}，${t('day.total', { expense: money(yuan(bucket.expense)), income: money(yuan(bucket.income)) })}`)
            const isToday = cell.date === today
            return h('button', {
              key: index, type: 'button', className: 'bal-day',
              'data-date': cell.date,
              'data-out': cell.outside ? '' : undefined,
              'data-today': isToday ? '' : undefined,
              'data-selected': cell.date === selected ? '' : undefined,
              'aria-current': isToday ? 'date' : undefined,
              'aria-pressed': cell.date === selected,
              'aria-label': aria,
              tabIndex: cell.date === selected ? 0 : -1,
              onClick: () => { pickDay(cell.date) },
              onKeyDown: event => { onDayKey(event, cell.date) },
            },
            h('span', { className: 'bal-daynum' }, String(cell.day)),
            module === 'diet'
              ? (dayKcal > 0 ? h('span', { className: 'bal-amt', title: `${Math.round(dayKcal)} kcal` }, String(Math.round(dayKcal))) : null)
              : h(React.Fragment, null,
                bucket === undefined || bucket.expense === 0 ? null : h('span', { className: 'bal-amt', title: `¥${money(yuan(bucket.expense))}` }, `-${compact(bucket.expense)}`),
                bucket === undefined || bucket.income === 0 ? null : h('span', { className: 'bal-amt', title: `+¥${money(yuan(bucket.income))}` }, `+${compact(bucket.income)}`)))
          })))

      return h('div', { className: 'bal-root', role: 'region', 'aria-label': t('panel.title') },
        h('style', null, CSS),
        h('header', { className: 'bal-head' },
          h('div', { className: 'bal-title-row' },
            h('span', { className: 'bal-title' }, t('panel.title')),
            h('div', { className: 'bal-month-nav' },
              h('button', { type: 'button', className: 'bal-nav-btn', 'aria-label': t('month.prev'), disabled: busy, onClick: () => { const next = shiftMonth({ year, month }, -1); void goMonth(next.year, next.month) } }, '\u2039'),
              h('span', { className: 'bal-month-label', 'aria-live': 'polite' }, monthTitle(year, month, t)),
              h('button', { type: 'button', className: 'bal-nav-btn', 'aria-label': t('month.next'), disabled: busy, onClick: () => { const next = shiftMonth({ year, month }, 1); void goMonth(next.year, next.month) } }, '\u203a'),
              h('button', { type: 'button', className: 'bal-today', disabled: busy, onClick: goToday }, t('month.today')))),
          h('div', { className: 'bal-modules', role: 'tablist', 'aria-label': t('module.label') },
            h('button', {
              type: 'button', role: 'tab', 'aria-selected': module === 'money',
              'data-active': module === 'money' ? '' : undefined,
              onClick: () => { setModule('money') },
            }, t('module.money')),
            h('button', {
              type: 'button', role: 'tab', 'aria-selected': module === 'diet',
              'data-active': module === 'diet' ? '' : undefined,
              onClick: () => { setModule('diet') },
            }, t('module.diet'))),
          module === 'money'
            ? h('div', { className: 'bal-summary' },
              h('span', { className: 'bal-chip' }, t('summary.income'), h('b', null, `¥${money(yuan(monthSum.income))}`)),
              h('span', { className: 'bal-chip' }, t('summary.expense'), h('b', null, `¥${money(yuan(monthSum.expense))}`)),
              h('span', { className: 'bal-chip', 'data-tone': 'net', 'data-negative': monthSum.net < 0 ? '' : undefined }, t('summary.net'), h('b', null, `¥${money(yuan(monthSum.net))}`)))
            : null,
          module === 'diet' && chartError !== ''
            ? h('p', { className: 'bal-problem', role: 'alert' },
              `${t('chart.kcalLoadFailed')}：${chartError} `,
              h('button', {
                type: 'button', className: 'bal-link',
                onClick: () => { setChartRetry(previous => previous + 1) },
              }, t('status.retry')))
            : null,
          // 已经有数据之后的读取失败也要说话：否则「刷新没反应」「换年显示了错的月份」都无从判断。
          error === ''
            ? null
            : h('p', { className: 'bal-problem', role: 'alert' },
              `${t('status.readFailed')}：${error} `,
              h('button', { type: 'button', className: 'bal-link', onClick: () => { setNotice(''); void load(year) } }, t('status.retry')))),
        h('div', { className: 'bal-body', 'data-module': module },
          calendarCard,
          module === 'money'
            ? h(DayPanel, {
              t, date: selected, entries: dayEntries, form, busy, problem, pendingDelete, categories, notes: noteOptions,
              cardRef: dayCardRef,
              onFormChange, onSubmit: submit, onCancelEdit: cancelEdit, onStartEdit: startEdit,
              onAskDelete: id => { setPendingDelete(id); setProblem('') },
              onDelete: id => { void removeEntry(id) },
              onCancelDelete: () => { setPendingDelete('') },
            })
            : h(DietCard, {
              t, balance, date: selected,
              onDietChange: () => { setDietRevision(previous => previous + 1) },
            }),
          module === 'money'
            ? h(DailyBreakdown, { t, days, selected, today, onPick: pickDay })
            : h(KcalDaily, { t, days, selected, today, onPick: pickDay, kcalData: kcalMonth }),
          module === 'money'
            ? h(MonthlyBars, { entries, year, month, t })
            : h(KcalMonthlyBars, { t, year, month, kcalData: kcalYear }),
          module === 'money' ? h(CategoryBars, { rows, entries, year, month, t }) : null),
        h('footer', { className: 'bal-foot' },
          h('span', {
            className: 'bal-file',
            role: 'status',
            title: data.file,
            'data-tone': notice === '' ? undefined : 'ok',
          }, footerText({ busy, notice, file: data.file }, t)),
          h('button', { type: 'button', className: 'bal-link', disabled: busy, onClick: () => { setNotice(''); void load(year) } }, t('status.reload'))))
    }

    /**
     * 会话标题栏右侧的入口按钮。
     * @param {{ t: Function, open: Function }} props - 属性
     * @returns {object} React 元素
     */
    function BalanceOpenButton(props) {
      const { t, open } = props
      return h(React.Fragment, null,
        h('style', null, CSS),
        h('button', {
          type: 'button', className: 'bal-open-btn',
          title: t('open.title'), 'aria-label': t('open.title'),
          onClick: () => { open() },
        }, balanceIcon(16)))
    }

    // -----------------------------------------------------------------------
    // 与 Host 的接口
    // -----------------------------------------------------------------------

    /**
     * 造一个走 `/balance` 面板接口的账本客户端。
     * @returns {{ load: Function, save: Function, remove: Function }} 账本 API
     */
    function createApi() {
      /**
       * 调一个端点：`POST balance/<endpoint>`，body 是参数。
       * 失败抛带 code 的 Error。
       * @param {string} endpoint - 端点
       * @param {object} payload - 参数
       * @returns {Promise<any>} 结果值
       */
      async function call(endpoint, payload) {
        const response = await fetch(`${CHANNEL}/${endpoint}`.slice(1), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload === undefined ? {} : payload),
        })
        if (!response.ok) {
          const error = new Error(response.status === 401
            ? '生活服务未授权：请刷新页面重新登录后再试。'
            : `生活服务返回 HTTP ${response.status}。`)
          error.code = `balance/http-${response.status}`
          throw error
        }
        const result = await response.json()
        if (result === null || typeof result !== 'object') throw new Error('生活服务返回了无法识别的内容。')
        if (result.ok === false) {
          const failure = result.error !== null && typeof result.error === 'object' ? result.error : {}
          const error = new Error(typeof failure.message === 'string' && failure.message !== '' ? failure.message : '生活服务调用失败。')
          error.code = typeof failure.code === 'string' ? failure.code : 'balance/internal'
          throw error
        }
        return result.value
      }
      return {
        load: year => call('load', year === undefined || year === null ? {} : { year }),
        save: entry => call('save', { entry }),
        remove: id => call('remove', { id }),
        dietLoad: day => call('diet-load', { day }),
        dietMonth: (year, month) => call('diet-month', { year, month }),
        dietYear: year => call('diet-year', { year }),
        dietUpdateItem: (itemId, grams) => call('diet-update-item', { itemId, grams }),
        dietDeleteItem: itemId => call('diet-delete-item', { itemId }),
        dietAddItem: (mealId, name, grams) => call('diet-add-item', { mealId, name, grams }),
        dietDeleteMeal: mealId => call('diet-delete-meal', { mealId }),
        dietAddMeal: (day, mealType, name, grams) => call('diet-add-meal', { day, mealType, name, grams }),
        dietReestimate: mealId => call('diet-reestimate', { mealId }),
      }
    }

    // -----------------------------------------------------------------------
    // 注册
    // -----------------------------------------------------------------------

    /**
     * 客户端插件入口：文案、页签类型、面板本体、标题栏入口。
     * @param {object} ctx - 客户端上下文
     * @returns {void}
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-balance: dictionaries')
      const t = ctx.locale.bind(NS)
      const api = createApi()

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        title: () => t('tab.title'),
        guide: [{
          id: 'balance',
          order: 20,
          title: () => t('guide.title'),
          description: () => t('guide.description'),
          icon: BalanceGlyph,
        }],
      }), 'dsh-balance: sidebar tab type')

      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        locale: NS,
        inject: () => ({ balance: api }),
      }, BalanceBody))

      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'balance',
        order: -3,
        locale: NS,
        inject: () => ({
          open: () => { ctx.sidebarRight.openTab(TAB_KIND) },
        }),
      }, BalanceOpenButton))
    }

    // 测试缝：Node 侧自测脚本（test/client.test.mjs）用这些纯函数和组件做无浏览器渲染。
    window.__dshBalanceInternals = {
      NS,
      TAB_ID,
      TAB_KIND,
      CHANNEL,
      zh,
      en,
      pad2,
      dateOf,
      partsOf,
      daysInMonth,
      weekdayIndex,
      shiftMonth,
      shiftDate,
      buildMonthGrid,
      money,
      compact,
      signedAmount,
      footerText,
      byDay,
      monthTotals,
      monthlySeries,
      monthDays,
      categoryRows,
      topRows,
      BalanceBody,
      DietCard,
      NoteField,
      similarNotes,
      noteSimilarity,
      noteGroups,
      KcalDaily,
      KcalMonthlyBars,
      BalanceOpenButton,
      DayPanel,
      DailyBreakdown,
      MonthlyBars,
      CategoryBars,
      KindSwitch,
      balanceIcon,
      apply,
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply,
    }
  },
})
