// 临时集成测试：灾害损失申报与协作复核（提交/重复申报约束/复核联动资产/驳回重报/补证流转）
// 用临时工作目录复制 server 模块，db.js 会在该目录创建独立 farm.db
import { mkdirSync, cpSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const tmp = path.join(root, '.tmp-claims-test')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
for (const f of ['db.js', 'weather.js', 'claims.js']) cpSync(path.join(root, f), path.join(tmp, f))

const { db } = await import(pathToFileURL(path.join(tmp, 'db.js')).href)
const C = await import(pathToFileURL(path.join(tmp, 'claims.js')).href)

let failures = 0
const assert = (cond, msg) => {
  if (!cond) { failures++; console.error('❌', msg) }
  else console.log('✅', msg)
}
const run = (sql, ...p) => db.prepare(sql).run(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)

// ===== 准备农场 9：场主(1)、管理员(2)、成员(3)；一场暴雨灾害 + 一天晴天 =====
const FID = 9
const now = Date.now()
run(`INSERT INTO farms (id,name,owner_id,version,created_at) VALUES (?,?,?,0,?)`, FID, '灾损测试农场', 1, now)
for (const [id, role] of [[1, 'owner'], [2, 'admin'], [3, 'member']]) {
  run(`INSERT INTO farm_members (farm_id,user_id,role,status,joined_at) VALUES (?,?,?,'active',?)`, FID, id, role, now)
}
run(`INSERT INTO player (farm_id,name,gold,season,day,abs_day) VALUES (9,'p',1000,1,5,33)`)
run(`INSERT INTO weather_events (id,farm_id,season,day,abs_day,type,name,icon,duration,severity,done)
     VALUES (1,9,1,3,31,'storm','暴雨','⛈️',2,2,1)`)
run(`INSERT INTO weather_events (id,farm_id,season,day,abs_day,type,name,icon,duration,severity,done)
     VALUES (2,9,1,4,32,'sunny','晴天','☀️',1,0,1)`)

// 迁移校验：表与重复申报约束索引存在
const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_claims_active_dedup'`).get()
assert(!!idx, 'disaster_claims 含活跃申报部分唯一索引（重复申报约束）')

// ===== 1) 可申报事件：只有灾害天气（晴天 severity=0 不可申报）=====
const evts = C.claimableEvents(FID)
assert(evts.length === 1 && evts[0].type === 'storm', '可申报事件只含灾害天气')

// ===== 2) 成员提交申报 + 重复申报约束 =====
const base = { farmId: FID, eventId: 1, category: 'crop', detail: '暴雨冲毁 3 块番茄地', qty: 3, gold: 60, mat: 2, currentAbs: 33 }
const c1 = C.submitClaim({ ...base, userId: 3, userName: '阿珍' })
assert(c1.id > 0, '成员提交作物损失申报成功')
let dup = null
try { C.submitClaim({ ...base, userId: 3, userName: '阿珍' }) } catch (e) { dup = e }
assert(dup?.status === 400 && /重复/.test(dup.message), '同一成员+事件+类别重复申报被拒')
// 换类别 / 换成员：不冲突
const c2 = C.submitClaim({ ...base, category: 'animal', detail: '鸡舍进水', userId: 3, userName: '阿珍' })
const c3 = C.submitClaim({ ...base, userId: 2, userName: '管理员甲' })
assert(c2.id > 0 && c3.id > 0, '换类别/换成员可正常申报')
// 晴天事件 / 非法类别 / 空描述 / 零补偿：全部拒绝
for (const [patch, label] of [
  [{ eventId: 2 }, '晴天不可申报'],
  [{ category: 'house' }, '非法类别被拒'],
  [{ detail: '  ' }, '空描述被拒'],
  [{ gold: 0, mat: 0 }, '零补偿被拒']
]) {
  let e = null
  try { C.submitClaim({ ...base, ...patch, userId: 1, userName: '场主' }) } catch (x) { e = x }
  assert(e?.status === 400 || e?.status === 404, label)
}
// 补偿上限：申请 5000 金被钳制到 999
const capped = C.submitClaim({ ...base, category: 'facility', detail: '水渠被冲垮', gold: 5000, mat: 500, userId: 3, userName: '阿珍' })
assert(q1('SELECT claim_gold g, claim_mat m FROM disaster_claims WHERE id=?', capped.id).g === 999, '申请补偿按上限钳制（🪙999/物资99）')

// ===== 3) 协作复核：不能自审；通过后联动金币 + 物资 =====
let self = null
try { C.reviewClaim({ farmId: FID, userId: 2, userName: '管理员甲', id: c3.id, action: 'approve' }) } catch (e) { self = e }
assert(self?.status === 403, '管理员不能复核自己的申报（协作复核）')
const goldBefore = q1('SELECT gold FROM player WHERE farm_id=?', FID).gold
const ok = C.reviewClaim({ farmId: FID, userId: 2, userName: '管理员甲', id: c1.id, action: 'approve', gold: 50, mat: 2, note: '情况属实，酌情赔付' })
assert(ok.status === 'approved' && ok.awardedGold === 50 && ok.awardedMat === 2, '复核通过并调整赔付额')
assert(q1('SELECT gold FROM player WHERE farm_id=?', FID).gold === goldBefore + 50, '通过后金币入账（联动农场资产）')
assert(q1(`SELECT qty FROM inventory WHERE farm_id=? AND item_id='disaster-kit'`, FID).qty === 2, '通过后防灾物资入库')
assert(q1('SELECT status, awarded_gold FROM disaster_claims WHERE id=?', c1.id).status === 'approved', '申报状态落库为已通过')
let again = null
try { C.reviewClaim({ farmId: FID, userId: 1, userName: '场主', id: c1.id, action: 'approve' }) } catch (e) { again = e }
assert(again?.status === 400, '已通过的申报不能重复复核（防重复赔付）')
let zero = null
try { C.reviewClaim({ farmId: FID, userId: 1, userName: '场主', id: c2.id, action: 'approve', gold: 0, mat: 0 }) } catch (e) { zero = e }
assert(zero?.status === 400, '赔付全为 0 的通过被拒（应使用驳回）')

// ===== 4) 驳回 → 释放槽位可重新申报 =====
const rej = C.reviewClaim({ farmId: FID, userId: 1, userName: '场主', id: c3.id, action: 'reject', note: '损失与天气无关' })
assert(rej.status === 'rejected', '驳回成功')
const refile = C.submitClaim({ ...base, userId: 2, userName: '管理员甲', detail: '补充说明后重新申报' })
assert(refile.id > 0, '驳回后同一成员+事件+类别可重新申报')

// ===== 5) 补证流转：要求补证 → 申报人补证 → 回到待复核 =====
let noNote = null
try { C.reviewClaim({ farmId: FID, userId: 1, userName: '场主', id: c2.id, action: 'need_evidence' }) } catch (e) { noNote = e }
assert(noNote?.status === 400, '要求补证必须说明所需材料')
C.reviewClaim({ farmId: FID, userId: 1, userName: '场主', id: c2.id, action: 'need_evidence', note: '请提供受损动物数量证明' })
assert(q1('SELECT status FROM disaster_claims WHERE id=?', c2.id).status === 'need_evidence', '状态流转为待补证')
let notMine = null
try { C.supplementClaim({ farmId: FID, userId: 1, id: c2.id, evidence: '代交材料' }) } catch (e) { notMine = e }
assert(notMine?.status === 403, '非申报人不能补证')
let wrongState = null
try { C.supplementClaim({ farmId: FID, userId: 2, id: refile.id, evidence: '未到补证环节' }) } catch (e) { wrongState = e }
assert(wrongState?.status === 400, '非待补证状态不能补证')
const sup = C.supplementClaim({ farmId: FID, userId: 3, id: c2.id, evidence: '死亡母鸡 2 只，已拍照留存' })
assert(sup.status === 'pending', '补证后回到待复核')
assert(q1('SELECT evidence FROM disaster_claims WHERE id=?', c2.id).evidence.includes('死亡母鸡 2 只'), '补证材料已留痕')
let blocked = null
try { C.reviewClaim({ farmId: FID, userId: 1, userName: '场主', id: capped.id, action: 'reject' }) } catch (e) { blocked = e }
assert(blocked === null, '待复核的申报可正常驳回')
// 补证完成后场主复核通过（默认按申请额赔付）
const ok2 = C.reviewClaim({ farmId: FID, userId: 1, userName: '场主', id: c2.id, action: 'approve' })
assert(ok2.awardedGold === 60 && ok2.awardedMat === 2, '不传赔付额时默认按申请额赔付')

// ===== 6) 列表：待复核优先，关联事件信息 =====
const list = C.listClaims(FID)
assert(list[0].status === 'pending', '待复核申报排在最前')
assert(list.every((x) => x.event_name && x.event_icon), '列表关联天气事件名称/图标')

db.close()
rmSync(tmp, { recursive: true, force: true })
console.log(failures ? `\n${failures} 个断言失败` : '\n全部通过 🎉')
process.exit(failures ? 1 : 0)
