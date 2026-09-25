import { db } from './db.js'
import { TYPES } from './weather.js'

// ===== 灾害损失申报与协作复核 =====
// 成员就恶劣天气造成的损失提交补偿申报；管理员/场主协作复核（不能复核自己的申报），
// 通过后在同一事务内联动发放金币 + 防灾物资，并由外层 mutate 包装推进农场版本、广播全农场。
// 约束：驳回（rejected 后可重新申报）、补证（need_evidence → 申报人补证 → 回到待复核）、
// 重复申报（同一成员 × 同一灾害事件 × 同一类别仅允许一条活跃申报，由部分唯一索引兜底）。

export const CATEGORIES = {
  crop: { name: '作物损失', icon: '🌾' },
  animal: { name: '动物损失', icon: '🐄' },
  facility: { name: '设施损失', icon: '🏚️' }
}

export const STATUS_LABELS = {
  pending: '待复核',
  need_evidence: '待补证',
  approved: '已通过',
  rejected: '已驳回'
}

// 补偿上限（单次申报/赔付）：防止误输入与恶意刷补偿
export const MAX_GOLD = 999
export const MAX_MAT = 99
const MAX_QTY = 99

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

const err = (msg, status = 400) => Object.assign(new Error(msg), { status })

function addInv(farmId, itemId, name, cat, n) {
  const row = q1('SELECT id, qty FROM inventory WHERE farm_id=? AND item_id=?', farmId, itemId)
  if (row) run('UPDATE inventory SET qty=qty+? WHERE id=?', n, row.id)
  else run('INSERT INTO inventory (farm_id,item_id,name,cat,qty) VALUES (?,?,?,?,?)', farmId, itemId, name, cat, n)
}

// 可申报的灾害事件：本农场 severity>0 的恶劣天气（最近的在前）
export function claimableEvents(farmId) {
  return q(`SELECT id, type, name, icon, severity, duration, abs_day, settled_days, done
            FROM weather_events WHERE farm_id=? AND severity>0
            ORDER BY abs_day DESC LIMIT 12`, farmId)
}

// 农场申报列表（待复核优先，其次待补证；关联天气事件信息用于展示）
export function listClaims(farmId) {
  return q(`SELECT c.*, e.type AS event_type, e.name AS event_name, e.icon AS event_icon,
                   e.severity AS event_severity, e.abs_day AS event_abs
            FROM disaster_claims c JOIN weather_events e ON e.id=c.event_id
            WHERE c.farm_id=?
            ORDER BY (c.status='pending') DESC, (c.status='need_evidence') DESC, c.id DESC
            LIMIT 40`, farmId)
}

// 提交申报（成员+）。重复申报：预检 + 部分唯一索引双保险（并发提交时索引兜底）
export function submitClaim({ farmId, userId, userName, eventId, category, detail, qty, gold, mat, currentAbs }) {
  const ev = q1('SELECT * FROM weather_events WHERE farm_id=? AND id=?', farmId, eventId)
  if (!ev) throw err('天气事件不存在', 404)
  if (!TYPES[ev.type]?.bad) throw err('只有恶劣天气（灾害事件）造成的损失才能申报')
  if (!CATEGORIES[category]) throw err('损失类别非法（crop/animal/facility）')
  const text = String(detail || '').trim().slice(0, 100)
  if (!text) throw err('请填写损失描述')
  const n = Math.max(1, Math.min(Math.floor(Number(qty) || 1), MAX_QTY))
  const g = Math.max(0, Math.min(Math.floor(Number(gold) || 0), MAX_GOLD))
  const m = Math.max(0, Math.min(Math.floor(Number(mat) || 0), MAX_MAT))
  if (g <= 0 && m <= 0) throw err('申请补偿不能全为 0（金币或物资至少一项）')

  db.exec('BEGIN IMMEDIATE')
  try {
    const dup = q1(`SELECT id FROM disaster_claims
                    WHERE farm_id=? AND event_id=? AND category=? AND created_by=?
                      AND status IN ('pending','need_evidence','approved')`,
      farmId, ev.id, category, userId)
    if (dup) throw err('同一灾害、同一类别你已有一条进行中的申报，请勿重复提交（被驳回后可重新申报）')
    let r
    try {
      r = run(`INSERT INTO disaster_claims
               (farm_id,event_id,category,detail,qty,claim_gold,claim_mat,created_by,created_name,created_abs,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        farmId, ev.id, category, text, n, g, m, userId, userName, currentAbs, Date.now())
    } catch (e) {
      // 并发下两条申报同时越过预检：唯一索引兜底，转成友好提示
      if (String(e.message).includes('idx_claims_active_dedup')) {
        throw err('同一灾害、同一类别你已有一条进行中的申报，请勿重复提交')
      }
      throw e
    }
    db.exec('COMMIT')
    return { ok: true, id: r.lastInsertRowid }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// 协作复核（管理员/场主）：approve 通过并发放补偿 / reject 驳回 / need_evidence 要求补证。
// 不能复核自己提交的申报（需另一位管理员或场主复核）；只有待复核（pending）的申报可处理。
export function reviewClaim({ farmId, userId, userName, id, action, gold, mat, note }) {
  if (!['approve', 'reject', 'need_evidence'].includes(action)) throw err('复核动作非法')
  const c = q1('SELECT * FROM disaster_claims WHERE farm_id=? AND id=?', farmId, id)
  if (!c) throw err('申报不存在', 404)
  if (c.status !== 'pending') {
    throw err(c.status === 'need_evidence' ? '该申报待申报人补证，暂不能复核' : '该申报已复核，不能重复处理')
  }
  if (c.created_by === userId) throw err('协作复核：不能审核自己提交的申报，请由其他管理员/场主处理', 403)
  const remark = String(note || '').trim().slice(0, 100)
  if (action === 'need_evidence' && !remark) throw err('要求补证时请说明需要补充的材料')

  if (action === 'approve') {
    // 赔付金额默认按申请额，复核人可下调/上调（受上限约束）；不能全为 0（应使用驳回）
    const g = gold == null ? c.claim_gold : Math.max(0, Math.min(Math.floor(Number(gold) || 0), MAX_GOLD))
    const m = mat == null ? c.claim_mat : Math.max(0, Math.min(Math.floor(Number(mat) || 0), MAX_MAT))
    if (g <= 0 && m <= 0) throw err('赔付不能全为 0（如需拒绝请使用驳回）')
    db.exec('BEGIN IMMEDIATE')
    try {
      // WHERE status='pending' 乐观占位：两名管理员同时复核时只有一人生效
      const r = run(`UPDATE disaster_claims
                     SET status='approved', awarded_gold=?, awarded_mat=?,
                         reviewed_by=?, reviewed_name=?, reviewed_at=?, review_note=?
                     WHERE id=? AND status='pending'`,
        g, m, userId, userName, Date.now(), remark, c.id)
      if (!r.changes) throw err('该申报刚被其他管理员处理了', 409)
      // 联动农场资产：金币入账 + 防灾物资入库（与状态更新同事务，失败整体回滚）
      if (g > 0) run('UPDATE player SET gold=gold+? WHERE farm_id=?', g, farmId)
      if (m > 0) addInv(farmId, 'disaster-kit', '防灾物资', 'material', m)
      db.exec('COMMIT')
      return { ok: true, status: 'approved', awardedGold: g, awardedMat: m }
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
      throw e
    }
  }

  const status = action === 'reject' ? 'rejected' : 'need_evidence'
  const r = run(`UPDATE disaster_claims
                 SET status=?, reviewed_by=?, reviewed_name=?, reviewed_at=?, review_note=?
                 WHERE id=? AND status='pending'`,
    status, userId, userName, Date.now(), remark, c.id)
  if (!r.changes) throw err('该申报刚被其他管理员处理了', 409)
  return { ok: true, status }
}

// 补证（仅申报人本人，且申报处于「待补证」）：追加证明材料后回到待复核队列
export function supplementClaim({ farmId, userId, id, evidence }) {
  const c = q1('SELECT * FROM disaster_claims WHERE farm_id=? AND id=?', farmId, id)
  if (!c) throw err('申报不存在', 404)
  if (c.created_by !== userId) throw err('只有申报人本人可以补证', 403)
  if (c.status !== 'need_evidence') throw err('该申报当前不需要补证')
  const text = String(evidence || '').trim().slice(0, 200)
  if (!text) throw err('请填写补证材料')
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
  const appended = (c.evidence ? c.evidence + '\n' : '') + `【补证 ${stamp}】${text}`
  const r = run(`UPDATE disaster_claims SET status='pending', evidence=? WHERE id=? AND status='need_evidence'`,
    appended, c.id)
  if (!r.changes) throw err('该申报状态已变化，请刷新后重试', 409)
  return { ok: true, status: 'pending' }
}
