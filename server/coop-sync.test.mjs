// 集成测试：共营操作（邀请/加入/角色/转让/退出）的实时广播同步
// 复制 server 模块到临时目录并真实启动服务，验证：
//  1) 共营写操作成功后向农场全体在线连接广播 mutation 事件（action 区分操作类型）
//  2) 广播携带单调递增的农场版本号（多端据此对齐，避免权限与成员状态滞后）
//  3) 响应中带回新版本号，调用方可即时对齐
import { mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const tmp = path.join(root, '.tmp-coop-sync-test')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
for (const f of readdirSync(root).filter((f) => f.endsWith('.js'))) cpSync(path.join(root, f), path.join(tmp, f))

const PORT = 4110
const BASE = `http://localhost:${PORT}`

let failures = 0
const assert = (cond, msg) => {
  if (!cond) { failures++; console.error('❌', msg) }
  else console.log('✅', msg)
}

// ===== 启动被测服务（独立临时目录，独立 farm.db）=====
const child = spawn(process.execPath, ['index.js'], { cwd: tmp })
await new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error('服务启动超时')), 10000)
  child.stdout.on('data', (d) => {
    if (String(d).includes('API running')) { clearTimeout(to); resolve() }
  })
  child.stderr.on('data', (d) => process.stderr.write(d))
})

const api = async (path, { token, farmId, method = 'GET', body, clientId } = {}) => {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['X-Auth-Token'] = token
  if (farmId) headers['X-Farm-Id'] = String(farmId)
  if (clientId) headers['X-Client-Id'] = clientId
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, data: await r.json().catch(() => ({})) }
}

// 极简 SSE 客户端：解析 data: 行，支持按条件等待事件
function connectSSE(url) {
  const events = []
  const waiters = []
  const ctrl = new AbortController()
  fetch(url, { signal: ctrl.signal }).then(async (r) => {
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const line = raw.split('\n').find((l) => l.startsWith('data: '))
        if (!line) continue
        const data = JSON.parse(line.slice(6))
        events.push(data)
        for (const w of [...waiters]) {
          if (w.pred(data)) {
            clearTimeout(w.timer)
            waiters.splice(waiters.indexOf(w), 1)
            w.resolve(data)
          }
        }
      }
    }
  }).catch(() => { /* 主动关闭 */ })
  const waitFor = (pred, ms = 5000) => new Promise((resolve, reject) => {
    const hit = events.find(pred)
    if (hit) return resolve(hit)
    const w = {
      pred, resolve,
      timer: setTimeout(() => reject(new Error('等待 SSE 事件超时')), ms)
    }
    waiters.push(w)
  })
  return { events, waitFor, close: () => ctrl.abort() }
}

try {
  // ===== 准备：甲注册并自动认领 farm 1 成为场主；乙注册 =====
  const a = (await api('/api/register', { method: 'POST', body: { name: '场主甲' } })).data
  const b = (await api('/api/register', { method: 'POST', body: { name: '成员乙' } })).data
  assert(!!a.token && !!b.token, '甲乙注册成功')
  await api('/api/me', { token: a.token }) // 首个 /me 自动认领旧存档
  const meA = (await api('/api/me', { token: a.token })).data
  assert(meA.farms.some((f) => f.id === 1 && f.role === 'owner'), '甲自动认领 farm 1 成为场主')

  // 甲生成邀请码；甲乙分别建立 SSE 连接（等 hello 确保连接已注册）
  const inv = (await api('/api/coop/invites', {
    token: a.token, farmId: 1, method: 'POST', body: { role: 'member', maxUses: 5 }
  })).data
  assert(!!inv.invite?.code, '邀请码创建成功')
  assert(typeof inv.version === 'number', '创建邀请码响应携带新版本号')
  const sseA = connectSSE(`${BASE}/api/events?farmId=1&token=${encodeURIComponent(a.token)}`)
  await sseA.waitFor((d) => d.type === 'hello')

  // ===== 1) 乙凭邀请码加入 → 甲收到 coop/join 广播 =====
  const join = (await api('/api/coop/join', { token: b.token, method: 'POST', body: { code: inv.invite.code } })).data
  assert(join.ok && typeof join.version === 'number', '加入响应携带新版本号')
  const evJoin = await sseA.waitFor((d) => d.type === 'mutation' && d.action === 'coop/join')
  assert(evJoin.by?.id === b.user.id, '甲实时收到「新成员加入」广播且携带加入者身份')
  assert(evJoin.version === join.version, '广播版本号与响应版本号一致')

  // 乙加入后建立自己的 SSE 连接
  const sseB = connectSSE(`${BASE}/api/events?farmId=1&token=${encodeURIComponent(b.token)}`)
  await sseB.waitFor((d) => d.type === 'hello')

  // ===== 2) 邀请码创建/撤销 → 其他在线成员收到广播 =====
  const inv2 = (await api('/api/coop/invites', {
    token: a.token, farmId: 1, method: 'POST', body: { role: 'admin', maxUses: 1 }
  })).data
  await sseB.waitFor((d) => d.type === 'mutation' && d.action === 'coop/invite')
  assert(true, '乙实时收到「邀请码创建」广播')
  await api('/api/coop/invites/revoke', {
    token: a.token, farmId: 1, method: 'POST', body: { code: inv2.invite.code }
  })
  await sseB.waitFor((d) => d.type === 'mutation' && d.action === 'coop/inviteRevoke')
  assert(true, '乙实时收到「邀请码撤销」广播')

  // ===== 3) 场主调整成员角色 → 被调整人实时收到（权限边界变化）=====
  const roleRes = (await api('/api/coop/members/role', {
    token: a.token, farmId: 1, method: 'POST', body: { userId: b.user.id, role: 'admin' }
  })).data
  assert(roleRes.ok && typeof roleRes.version === 'number', '角色调整响应携带新版本号')
  const evRole = await sseB.waitFor((d) => d.type === 'mutation' && d.action === 'coop/role')
  assert(evRole.by?.id === a.user.id, '乙实时收到「成员角色调整」广播')

  // ===== 4) 场主转让 → 原场主与其他成员实时收到 =====
  const trRes = (await api('/api/coop/transfer', {
    token: a.token, farmId: 1, method: 'POST', body: { userId: b.user.id }
  })).data
  assert(trRes.ok && typeof trRes.version === 'number', '转让响应携带新版本号')
  await sseA.waitFor((d) => d.type === 'mutation' && d.action === 'coop/transfer')
  assert(true, '甲（原场主）实时收到「场主转让」广播')

  // ===== 5) 成员退出 → 其他在线成员实时收到 =====
  const lvRes = (await api('/api/coop/leave', { token: a.token, farmId: 1, method: 'POST' })).data
  assert(lvRes.ok && typeof lvRes.version === 'number', '退出响应携带新版本号')
  await sseB.waitFor((d) => d.type === 'mutation' && d.action === 'coop/leave')
  assert(true, '乙实时收到「成员退出」广播')

  // ===== 6) 广播版本号单调递增（多端对齐不发生回退）=====
  const versions = sseB.events.filter((d) => d.type === 'mutation').map((d) => d.version)
  assert(versions.length >= 4, `乙收到全部共营广播（实际 ${versions.length} 条）`)
  assert(versions.every((v, i) => i === 0 || v > versions[i - 1]), '广播版本号严格单调递增')

  // 退出后甲不再是成员：农场详情接口拒绝访问（权限状态已生效）
  const denied = await api('/api/coop/farms/1', { token: a.token, farmId: 1 })
  assert(denied.status === 403, '退出后甲立即失去成员访问权限')

  sseA.close()
  sseB.close()
} catch (e) {
  failures++
  console.error('❌ 测试执行异常：', e.message)
}

child.kill()
rmSync(tmp, { recursive: true, force: true })
console.log(failures ? `\n${failures} 个断言失败` : '\n全部通过 🎉')
process.exit(failures ? 1 : 0)
