/**
 * 工具与接口自测：用仓库里**已经构建好的** `@deepseek-ai/dsh-tools` 校验本插件的四个工具定义
 * 是否落在 DSH 强制的 JSON Schema 子集里，并把 execute / render / 面板 HTTP 接口真的跑一遍。
 *
 * 运行：node test/tools.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { BalanceError, apply } from '../index.js'

const TOOLS_LIB = pathToFileURL('C:/custom/dsh/deepseek-harness/deepseek-harness/packages/core/tools/lib/index.js').href
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(TOOLS_LIB)

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-balance-tools-'))
const tools = new Map()
let route = null
let passed = 0

/**
 * 跑一条断言并计数。
 * @param {string} label - 用例名
 * @param {() => Promise<void>|void} body - 用例
 * @returns {Promise<void>} 完成
 */
async function check(label, body) {
  await body()
  passed += 1
  console.log(`  ok  ${label}`)
}

/**
 * 假请求。
 * @param {{ method?: string, url?: string, body?: string, remote?: string }} [init] - 参数
 * @returns {object} 假 IncomingMessage
 */
function fakeRequest(init = {}) {
  const body = init.body ?? ''
  return {
    method: init.method ?? 'POST',
    url: init.url ?? '/balance/load',
    headers: {},
    socket: { remoteAddress: init.remote ?? '127.0.0.1' },
    resume() {},
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body, 'utf8')
    },
  }
}

/**
 * 假响应。
 * @returns {object} 假 ServerResponse
 */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
    },
  }
}

/** 假的 connection 服务：默认放行（等价于已登录的浏览器）。 */
let connectionStub = { requestRejection: () => undefined }

/**
 * 打一次面板接口。
 * @param {object} init - 请求参数
 * @param {{ requestRejection?: Function }} [connection] - 假的 connection 服务
 * @returns {Promise<{ status: number, json: any, contentType: string }>} 响应
 */
async function callApi(init, connection = { requestRejection: () => undefined }) {
  const res = fakeResponse()
  connectionStub = connection
  try {
    await route.handler(fakeRequest(init), res)
  } finally {
    connectionStub = { requestRejection: () => undefined }
  }
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { status: res.statusCode, json, contentType: res.headers['content-type'] }
}

/** 假的插件上下文：记录注册、跑真正的 effect/inject 回调。 */
const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get(name) {
    return name === 'connection' ? connectionStub : undefined
  },
  inject(names, callback) {
    assert.deepEqual(names, ['webServer'], 'apply 应该只等 webServer 服务')
    callback({
      effect(fn) {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      webServer: {
        register(definition) {
          route = definition
          return () => {}
        },
      },
    })
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => {}
    },
  },
}

apply(ctx, { root })

console.log('dsh-balance / tools + api')

try {
  await check('registers exactly the four documented tools', () => {
    assert.deepEqual([...tools.keys()].sort(), ['balance_add', 'balance_edit', 'balance_list', 'balance_summary'])
    for (const definition of tools.values()) {
      assert.equal(typeof definition.description, 'string')
      assert.ok(definition.description.length > 20, `${definition.name} 应有可读的描述`)
      assert.equal(typeof definition.execute, 'function')
    }
  })

  await check('every parameter schema is in the enforced JSON Schema subset', () => {
    for (const definition of tools.values()) {
      assertSupportedJsonSchema(definition.parameters)
      assert.equal(definition.parameters.type, 'object')
      const properties = definition.parameters.properties ?? {}
      for (const [name, node] of Object.entries(properties)) {
        assert.equal(typeof node.description, 'string', `${definition.name}.${name} 应有描述`)
        assert.ok(node.description.length > 0)
      }
      for (const name of definition.parameters.required ?? []) {
        assert.ok(Object.hasOwn(properties, name), `${definition.name} 的 required "${name}" 必须在 properties 里`)
      }
    }
    assert.deepEqual(tools.get('balance_add').parameters.required, ['amount'])
    assert.deepEqual(tools.get('balance_add').parameters.properties.kind.enum, ['expense', 'income'])
    assert.deepEqual(tools.get('balance_edit').parameters.required, ['id', 'action'])
    assert.deepEqual(tools.get('balance_edit').parameters.properties.action.enum, ['update', 'delete'])
    assert.equal(tools.get('balance_list').parameters.properties.limit.type, 'integer')
  })

  await check('every output schema is supported and declared', () => {
    for (const definition of tools.values()) {
      assert.ok(definition.output !== undefined, `${definition.name} 必须声明 output`)
      assertSupportedJsonSchema(definition.output.schema)
      assert.equal(typeof definition.output.render, 'function')
    }
  })

  await check('balance_add writes an entry and returns a renderable value', async () => {
    const definition = tools.get('balance_add')
    const value = await definition.execute({ date: '2026-11-20', amount: 25.5, category: '餐饮', note: '午饭' }, {})
    assert.deepEqual(validateJsonSchemaValue(definition.output.schema, value), [])
    assert.match(value.entry.id, /^b[0-9a-z]+$/)
    assert.equal(value.entry.date, '2026-11-20')
    assert.equal(value.entry.amount, 25.5)
    assert.equal(value.file, path.join(root, 'ledger.json'))
    const blocks = definition.output.render({}, value)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /已记账/)
    assert.match(blocks[0].text, /¥25\.50/)
    assert.match(blocks[0].text, /餐饮/)
    assert.match(blocks[0].text, new RegExp(value.entry.id))
  })

  await check('balance_add rejects bad amounts through the shared validator', async () => {
    const definition = tools.get('balance_add')
    await assert.rejects(definition.execute({ amount: 0 }, {}), (error) => {
      assert.ok(error instanceof BalanceError)
      assert.equal(error.code, 'balance/bad-amount')
      return true
    })
  })

  await check('balance_list totals a range and renders rows', async () => {
    await tools.get('balance_add').execute({ date: '2026-11-21', amount: 100, kind: 'income', category: '红包' }, {})
    const definition = tools.get('balance_list')
    const value = await definition.execute({ from: '2026-11-01', to: '2026-11-30' }, {})
    assert.deepEqual(validateJsonSchemaValue(definition.output.schema, value), [])
    assert.equal(value.count, 2)
    assert.deepEqual(value.totals, { income: 100, expense: 25.5, net: 74.5 })
    assert.equal(value.entries[0].date, '2026-11-21', '新账在前')
    const text = definition.output.render({}, value)[0].text
    assert.match(text, /2026-11-01 ~ 2026-11-30/)
    assert.match(text, /收入 ¥100\.00/)
    assert.match(text, /支出 ¥25\.50/)
    assert.match(text, /#b/)
  })

  await check('balance_edit updates and deletes by id', async () => {
    const added = await tools.get('balance_add').execute({ date: '2026-11-22', amount: 8, note: '咖啡' }, {})
    const definition = tools.get('balance_edit')
    const updated = await definition.execute({ id: added.entry.id, action: 'update', amount: 12.5 }, {})
    assert.deepEqual(validateJsonSchemaValue(definition.output.schema, updated), [])
    assert.equal(updated.deleted, false)
    assert.equal(updated.entry.amount, 12.5)
    assert.equal(updated.entry.note, '咖啡', '没给的字段保持原样')
    assert.match(definition.output.render({}, updated)[0].text, /已更新/)

    const deleted = await definition.execute({ id: added.entry.id, action: 'delete' }, {})
    assert.equal(deleted.deleted, true)
    assert.match(definition.output.render({}, deleted)[0].text, /已删除/)
    await assert.rejects(definition.execute({ id: added.entry.id, action: 'delete' }, {}), (error) => {
      assert.equal(error.code, 'balance/not-found')
      return true
    })
    await assert.rejects(definition.execute({ id: 'x', action: 'rename' }, {}), (error) => {
      assert.equal(error.code, 'balance/bad-action')
      return true
    })
  })

  await check('balance_summary reports totals, categories and the recent trend', async () => {
    const definition = tools.get('balance_summary')
    const value = await definition.execute({ month: '2026-11' }, {})
    assert.deepEqual(validateJsonSchemaValue(definition.output.schema, value), [])
    assert.equal(value.month, '2026-11')
    assert.equal(value.recent.length, 6)
    assert.equal(value.recent.at(-1).month, '2026-11')
    const text = definition.output.render({}, value)[0].text
    assert.match(text, /2026-11：收入/)
    assert.match(text, /支出分类/)
    assert.match(text, /最近几个月/)
  })

  await check('registers one POST prefix route at /balance', () => {
    assert.ok(route !== null, '没有注册 HTTP 路由')
    assert.equal(route.kind, 'prefix')
    assert.equal(route.path, '/balance')
    assert.equal(typeof route.handler, 'function')
  })

  await check('the panel API answers every endpoint over POST JSON', async () => {
    const loaded = await callApi({ url: '/balance/load', body: JSON.stringify({ year: 2026 }) })
    assert.equal(loaded.status, 200)
    assert.match(loaded.contentType, /application\/json/)
    assert.equal(loaded.json.ok, true)
    assert.equal(loaded.json.value.year, 2026)
    assert.ok(loaded.json.value.entries.length >= 2)

    const saved = await callApi({ url: '/balance/save', body: JSON.stringify({ entry: { date: '2026-11-23', amount: 4.4, note: '面包' } }) })
    assert.equal(saved.json.ok, true)
    assert.equal(saved.json.value.date, '2026-11-23')

    const removed = await callApi({ url: '/balance/remove', body: JSON.stringify({ id: saved.json.value.id }) })
    assert.equal(removed.json.ok, true)

    const summary = await callApi({ url: '/balance/summary', body: JSON.stringify({ month: '2026-11' }) })
    assert.equal(summary.json.ok, true)
    assert.equal(summary.json.value.month, '2026-11')

    const info = await callApi({ url: '/balance/info', body: '{}' })
    assert.equal(info.json.ok, true)
    assert.equal(info.json.value.file, path.join(root, 'ledger.json'))
  })

  await check('the panel API reports business failures inside a 200 envelope', async () => {
    const failure = await callApi({ url: '/balance/save', body: JSON.stringify({ entry: { amount: -1 } }) })
    assert.equal(failure.status, 200)
    assert.equal(failure.json.ok, false)
    assert.equal(failure.json.error.code, 'balance/bad-amount')
    assert.deepEqual(failure.json.error.details, {})

    const unknown = await callApi({ url: '/balance/explode', body: '{}' })
    assert.equal(unknown.json.ok, false)
    assert.equal(unknown.json.error.code, 'balance/unknown-endpoint')

    const badJson = await callApi({ url: '/balance/save', body: '{ not json' })
    assert.equal(badJson.json.ok, false)
    assert.equal(badJson.json.error.code, 'balance/bad-json')

    const missing = await callApi({ url: '/balance', body: '{}' })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'balance/unknown-endpoint')

    const wrongMethod = await callApi({ method: 'GET', url: '/balance/load' })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.json.error.code, 'balance/method')
  })

  await check('the panel API refuses an unauthenticated browser request', async () => {
    const unauthorized = await callApi({ url: '/balance/load', body: '{}' }, { requestRejection: () => 401 })
    assert.equal(unauthorized.status, 401)
    assert.equal(unauthorized.json, null)
  })

  await check('the ledger file on disk is the documented shape', async () => {
    const text = await fs.readFile(path.join(root, 'ledger.json'), 'utf8')
    const parsed = JSON.parse(text)
    assert.equal(parsed.version, 1)
    assert.equal(typeof parsed.updatedAt, 'string')
    assert.ok(Array.isArray(parsed.entries))
    for (const entry of parsed.entries) {
      assert.deepEqual(Object.keys(entry).sort(), ['amount', 'category', 'createdAt', 'date', 'id', 'kind', 'note', 'updatedAt'])
      assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/)
      assert.ok(entry.kind === 'expense' || entry.kind === 'income')
      assert.equal(Math.round(entry.amount * 100) / 100, entry.amount)
    }
  })
} finally {
  if (path.basename(root).startsWith('dsh-balance-tools-') && root.startsWith(os.tmpdir())) {
    await fs.rm(root, { recursive: true, force: true })
  }
}

console.log(`\n${passed} checks passed`)
