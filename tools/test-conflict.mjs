import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { pullSafe } from './conflict.mjs'

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}
function ledger(entries) {
  return `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries }, null, 2)}\n`
}

async function scenario({ codeConflict }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-conflict-'))
  const remote = path.join(root, 'remote.git')
  const a = path.join(root, 'a')
  const b = path.join(root, 'b')
  sh(root, ['init', '--bare', '-q', remote])
  sh(root, ['clone', '-q', remote, 'a'])
  sh(root, ['clone', '-q', remote, 'b'])
  for (const dir of [a, b]) {
    sh(dir, ['config', 'user.name', 't'])
    sh(dir, ['config', 'user.email', 't@t'])
    sh(dir, ['checkout', '-q', '-b', 'main'])
  }
  write(path.join(a, 'data/balance/ledger.json'), ledger([
    { id: 'a', date: '2026-11-01', kind: 'expense', amount: 10, category: 'x', note: '', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' },
    { id: 'b', date: '2026-11-02', kind: 'expense', amount: 20, category: 'x', note: '', createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z' },
  ]))
  write(path.join(a, 'tools/x.mjs'), 'export const v = 1\n')
  sh(a, ['add', '-A'])
  sh(a, ['commit', '-qm', 'base'])
  sh(a, ['push', '-q', 'origin', 'main'])
  sh(b, ['pull', '-q', 'origin', 'main'])

  write(path.join(b, 'data/balance/ledger.json'), ledger([
    { id: 'a', date: '2026-11-01', kind: 'expense', amount: 15, category: 'x', note: 'remote', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' },
    { id: 'b', date: '2026-11-02', kind: 'expense', amount: 20, category: 'x', note: '', createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z' },
    { id: 'd', date: '2026-11-03', kind: 'expense', amount: 30, category: 'y', note: '', createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z' },
  ]))
  if (codeConflict) write(path.join(b, 'tools/x.mjs'), 'export const v = 2\n')
  sh(b, ['add', '-A'])
  sh(b, ['commit', '-qm', 'remote changes'])
  sh(b, ['push', '-q', 'origin', 'main'])

  write(path.join(a, 'data/balance/ledger.json'), ledger([
    { id: 'a', date: '2026-11-01', kind: 'expense', amount: 12, category: 'x', note: 'local', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z' },
    { id: 'b', date: '2026-11-02', kind: 'expense', amount: 20, category: 'x', note: '', createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z' },
    { id: 'c', date: '2026-11-04', kind: 'expense', amount: 40, category: 'z', note: '', createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z' },
  ]))
  if (codeConflict) write(path.join(a, 'tools/x.mjs'), 'export const v = 3\n')
  sh(a, ['add', '-A'])
  sh(a, ['commit', '-qm', 'local changes'])

  const result = await pullSafe({ branch: 'main', cwd: a })
  const doc = JSON.parse(fs.readFileSync(path.join(a, 'data/balance/ledger.json'), 'utf8'))
  const status = sh(a, ['status', '--porcelain']).trim()
  const log = sh(a, ['log', '--oneline', '-3']).trim().split('\n')
  fs.rmSync(root, { recursive: true, force: true })
  return { result, doc, status, log, a }
}

const clean = await scenario({ codeConflict: false })
console.log('data-only result', JSON.stringify(clean.result))
console.log('  entries', clean.doc.entries.map(entry => `${entry.id}:${entry.amount}`).join(', '))
console.log('  status', JSON.stringify(clean.status), 'log', clean.log.join(' | '))

const dirty = await scenario({ codeConflict: true })
console.log('code-conflict result', JSON.stringify(dirty.result))
console.log('  status', JSON.stringify(dirty.status), 'log', dirty.log.join(' | '))
