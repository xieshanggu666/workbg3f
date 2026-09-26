// 临时集成测试：协作排产（排产人/原料占用/取消退料/队列重排）
// 用临时工作目录复制 server 模块，db.js 会在该目录创建独立 farm.db
import { mkdirSync, cpSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const tmp = path.join(root, '.tmp-prod-test')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
for (const f of ['db.js', 'production.js']) cpSync(path.join(root, f), path.join(tmp, f))

const { db } = await import(pathToFileURL(path.join(tmp, 'db.js')).href)
const P = await import(pathToFileURL(path.join(tmp, 'production.js')).href)

let failures = 0
const assert = (cond, msg) => {
  if (!cond) { failures++; console.error('❌', msg) }
  else console.log('✅', msg)
}
const run = (sql, ...p) => db.prepare(sql).run(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)

// ===== 准备农场 7 与初始数据 =====
const FID = 7
const now = Date.now()
run(`INSERT INTO farms (id,name,owner_id,version,created_at) VALUES (?,?,?,0,?)`, FID, '测试农场', 1, now)
for (const [id, role] of [[1, 'owner'], [2, 'member'], [3, 'member']]) {
  run(`INSERT INTO farm_members (farm_id,user_id,role,status,joined_at) VALUES (?,?,?,'active',?)`, FID, id, role, now)
}
run(`INSERT INTO player (farm_id,name,gold,season,day,abs_day) VALUES (7,'p',9999,0,1,1)`)
run(`INSERT INTO buildings (farm_id,id,name,level,x,y,desc) VALUES (7,2,'加工坊',5,0,0,'')`)
// 小麦 20 个；同本源杂交品种（id=1000）6 个。面粉配方每批耗麦 2、耗时 1 天
run(`INSERT INTO inventory (farm_id,item_id,name,cat,qty) VALUES (7,'crop-5','小麦','crop',20)`)
run(`INSERT INTO crop_varieties (id,farm_id,base_id,name,sprite,season,days,price,seed_price,traits,sig,parent_a,parent_b,gen,created_abs)
     VALUES (1000,7,5,'抗旱小麦','🌾',0,5,10,5,'[]','s1','base:5','base:5',1,1)`)
run(`INSERT INTO inventory (farm_id,item_id,name,cat,qty) VALUES (7,'crop-v1000','抗旱小麦','crop',6)`)

// 迁移校验：新列存在
const cols = db.prepare('PRAGMA table_info(production_jobs)').all().map((c) => c.name)
assert(['seq', 'created_by', 'created_name'].every((c) => cols.includes(c)), 'production_jobs 含 seq/created_by/created_name')

// ===== 1) 排产：阿强(2) 面粉 3 批（耗基础麦6）；阿珍(3) 面粉 6 批（耗基础麦12）=====
const j1 = P.enqueueJob({ recipeId: 'flour', qty: 3, millLevel: 5, currentAbs: 1, farmId: FID, userId: 2, userName: '阿强' })
assert(q1(`SELECT qty FROM inventory WHERE farm_id=7 AND item_id='crop-5'`).qty === 14, '排产扣基础小麦 6 个（20→14）')
assert(q1('SELECT created_by, seq FROM production_jobs WHERE id=?', j1.id).created_by === 2, '记录排产人=阿强')
const j2 = P.enqueueJob({ recipeId: 'flour', qty: 6, millLevel: 5, currentAbs: 1, farmId: FID, userId: 3, userName: '阿珍' })
assert(q1(`SELECT qty FROM inventory WHERE farm_id=7 AND item_id='crop-5'`).qty === 2, '再排6批扣基础麦12（14→2），品种麦未动')

// 在 abs=2 追加两张等待工单：j3 吃掉剩余基础麦2，j4 只能吃品种麦2（验证跨品种占用/退料）
const j3 = P.enqueueJob({ recipeId: 'flour', qty: 1, millLevel: 5, currentAbs: 2, farmId: FID, userId: 3, userName: '阿珍' })
const j4 = P.enqueueJob({ recipeId: 'flour', qty: 1, millLevel: 5, currentAbs: 2, farmId: FID, userId: 2, userName: '阿强' })
assert(!q1('SELECT 1 FROM inventory WHERE farm_id=7 AND item_id=?', 'crop-5'), '基础小麦耗尽后空行删除')
assert(q1('SELECT qty FROM inventory WHERE farm_id=7 AND item_id=?', 'crop-v1000').qty === 4, 'j4 投料扣品种小麦 2（6→4）')

// 容量校验：Lv5 容量 12 批，已占 11，再排应失败
let capErr = null
try { P.enqueueJob({ recipeId: 'flour', qty: 5, millLevel: 5, currentAbs: 2, farmId: FID, userId: 2, userName: '阿强' }) } catch (e) { capErr = e }
assert(capErr?.status === 400, '超出队列容量被拒')

// 占用汇总：j1+j2+j3 共20基础麦，j4 锁2品种麦
const reserved = P.reservedStock(2, FID).reduce((m, x) => (m[x.itemId] = x.qty, m), {})
assert(reserved['crop-5'] === 20 && reserved['crop-v1000'] === 2, `占用汇总按物品合并（基础20/品种2）得到 ${JSON.stringify(reserved)}`)

// listJobs 带排产人与投料明细
const j1v = P.listJobs(2, FID).find((x) => x.id === j1.id)
assert(j1v.creator?.name === '阿强', '工单动态状态含排产人')
assert((j1v.occupiedItems || []).some((it) => it.itemId === 'crop-5' && it.qty === 6), '工单带投料占用明细')

// ===== 2) 推进到第2天：j1 首批完工；j2 起手在 j1 之后（start=4）=====
P.settleProduction(2, FID)
const jobs2 = P.listJobs(2, FID)
assert(jobs2.find((x) => x.id === j1.id).doneBatches === 1, 'j1 第2天完工 1 批')
assert(jobs2.find((x) => x.id === j2.id).start === 4, `j2 串行排在 j1 之后 start=4`)

// ===== 3) 队列重排：j2 已上机器链且 j1 已开工；j4 在等待区上移只能与相邻等待单 j3 交换 =====
let reErr = null
try { P.reorderJob({ id: j2.id, dir: -1, currentAbs: 2, farmId: FID }) } catch (e) { reErr = e }
assert(reErr?.status === 400, 'j2 相邻是已开工的 j1，不能越过重排')
const rr = P.reorderJob({ id: j4.id, dir: -1, currentAbs: 2, farmId: FID })
assert(rr.withId === j3.id, 'j4 与前一张等待工单 j3 交换')
const order = P.listJobs(2, FID).filter((x) => x.status === 'running').map((x) => x.id)
assert(order.indexOf(j4.id) < order.indexOf(j3.id), '重排后 j4 排在 j3 前面')
assert(P.listJobs(2, FID).find((x) => x.id === j4.id).start >= 2, '重排后工单不会排到过去')
let dirErr = null
try { P.reorderJob({ id: j4.id, dir: 0, currentAbs: 2, farmId: FID }) } catch (e) { dirErr = e }
assert(dirErr?.status === 400, '非法重排方向被拒')
// j4 已在等待区最前（前面是 j2 等待中）→ 再上移与 j2 交换是允许的（两张都未开工）
P.reorderJob({ id: j4.id, dir: -1, currentAbs: 2, farmId: FID })

// ===== 4) 取消退料：阿珍第3天取消 j2（此时尚未轮到开工），6批全退基础麦 =====
const bStartBefore = P.listJobs(3, FID).find((x) => x.id === j2.id).start
const cancel = P.cancelJob({ id: j2.id, currentAbs: 3, farmId: FID, userId: 3, role: 'member' })
const back = cancel.refunds.reduce((m, x) => (m[x.itemId] = x.qty, m), {})
assert(cancel.refundBatches === 6 && (back['crop-5'] || 0) === 12, `未开工整单原样退基础麦12（得到 ${JSON.stringify(back)}）`)
assert(q1('SELECT qty FROM inventory WHERE farm_id=7 AND item_id=?', 'crop-5')?.qty === 12, '基础小麦退回库存')
// 取消让出机器：后续工单自动提前
const j4StartAfter = P.listJobs(3, FID).find((x) => x.id === j4.id).start
assert(j4StartAfter < bStartBefore, `取消 j2 后 j4 提前（${bStartBefore}→${j4StartAfter}）`)

// 权限：阿强(2)不能取消阿珍(3)的 j3
let permErr = null
try { P.cancelJob({ id: j3.id, currentAbs: 3, farmId: FID, userId: 2, role: 'member' }) } catch (e) { permErr = e }
assert(permErr?.status === 403, '成员不能取消他人排产的工单')
// 场主可取消任意工单；j3 未开工，退 2 基础麦
const adminCancel = P.cancelJob({ id: j3.id, currentAbs: 3, farmId: FID, userId: 1, role: 'owner' })
assert((adminCancel.refunds[0]?.itemId) === 'crop-5' && adminCancel.refunds[0].qty === 2, '场主取消成员工单并按登记退料')
let twice = null
try { P.cancelJob({ id: j3.id, currentAbs: 3, farmId: FID, userId: 1, role: 'owner' }) } catch (e) { twice = e }
assert(twice?.status === 400, '已取消工单不能重复取消')

// 已开工工单不能重排（j1 第3天正在加工）
let movedErr = null
try { P.reorderJob({ id: j1.id, dir: 1, currentAbs: 3, farmId: FID }) } catch (e) { movedErr = e }
assert(movedErr?.status === 400, '已开工工单不能重排')

// ===== 5) 跨天结算 + 一键入库：剩余 j1(3批) 与 j4(1批，品种麦投料) =====
P.settleProduction(10, FID)
const remain = P.listJobs(10, FID).filter((x) => x.status === 'running')
assert(remain.every((x) => x.computedStatus === 'done'), '第10天剩余在制工单全部完工')
const collected = P.collectJobs(10, FID)
const flour = collected.picked.find((p) => p.name === '面粉')
assert(flour?.qty === 3, `完工入库面粉 3 个（j1 三批 + j4 当天排产当天开工一批；实际 ${flour?.qty}）`)

// ===== 6) 旧工单（created_by 为空）任何成员可管理；随后取消让出机器 =====
run(`INSERT INTO inventory (farm_id,item_id,name,cat,qty) VALUES (7,'crop-5','小麦','crop',10)
     ON CONFLICT(farm_id,item_id) DO UPDATE SET qty=qty+excluded.qty`)
// 先用场主工单独占机器 1 天，让公共旧工单处于「已排产未开工」状态
const busy = P.enqueueJob({ recipeId: 'flour', qty: 1, millLevel: 5, currentAbs: 10, farmId: FID, userId: 1, userName: '场主' })
const old = P.enqueueJob({ recipeId: 'flour', qty: 1, millLevel: 5, currentAbs: 10, farmId: FID })
run('UPDATE production_jobs SET created_by=NULL, created_name=NULL WHERE id=?', old.id)
assert(P.canManageJob(q1('SELECT * FROM production_jobs WHERE id=?', old.id), 999, 'member') === true, '无排产人的旧工单视为公共，成员可管理')
const oldCancel = P.cancelJob({ id: old.id, currentAbs: 10, farmId: FID, userId: 999, role: 'member' })
assert(oldCancel.refundBatches === 1, '公共旧工单未开工取消时成员也可退料')
// 清掉两张辅助单（含已取消单，它们仍参与机器时间线重放），保证下一步独占队列
run('DELETE FROM production_jobs WHERE id IN (?,?)', busy.id, old.id)

// ===== 7) 部分开工时取消：只退尾部未开工批次，加工中批次作废 =====
// 此时队列已空闲：3 批工单 abs=10 排产当天开工；推进到第11天第1批完工、第2批加工中
const jp = P.enqueueJob({ recipeId: 'flour', qty: 3, millLevel: 5, currentAbs: 10, farmId: FID, userId: 2, userName: '阿强' })
P.settleProduction(11, FID) // 第11天：第1批完工、第2批加工中
const part = P.cancelJob({ id: jp.id, currentAbs: 11, farmId: FID, userId: 2, role: 'member' })
assert(part.refundBatches === 1 && (part.refunds[0]?.qty) === 2 && part.finishedBatches === 1,
  `部分开工取消：退尾部1批原料、保留1批成品（得到退${part.refundBatches}批/成品${part.finishedBatches}批）`)
const partial = P.collectJobs(11, FID, jp.id)
assert(partial.picked[0]?.qty === 1, '取消单的已完工批次仍可入库 1 个面粉')

// ===== 8) 完工批次随时入库：在制工单按差额部分入库，重复入库被拒 =====
// （此时库存：基础麦18 / 品种麦4 / 面粉5）
const j5 = P.enqueueJob({ recipeId: 'flour', qty: 4, millLevel: 5, currentAbs: 11, farmId: FID, userId: 2, userName: '阿强' })
P.settleProduction(12, FID) // j5 第1批完工，其余在制
const c1 = P.collectJobs(12, FID, j5.id)
assert(c1.picked[0]?.qty === 1, '在制工单第12天先入库 1 批完工成品')
let dupErr = null
try { P.collectJobs(12, FID, j5.id) } catch (e) { dupErr = e }
assert(dupErr?.status === 400, '同批成品重复入库被拒（无新增完工批次）')
assert(q1(`SELECT qty FROM inventory WHERE farm_id=7 AND item_id='flour'`).qty === 6, '面粉库存只增加一次（5→6），不重复发放')
const j5v = P.listJobs(12, FID).find((x) => x.id === j5.id)
assert(j5v.collectedBatches === 1 && j5v.pendingBatches === 0 && j5v.computedStatus === 'running',
  '部分入库后工单仍在制，记录已入库 1 批')
assert(j5v.reducibleBatches === 2, '第12天 j5 已开工2批，可减量 2 批')
P.settleProduction(13, FID)
assert(P.listJobs(13, FID).find((x) => x.id === j5.id).pendingBatches === 1, '第13天又有 1 批完工待入库')

// ===== 9) 未开工批次按需减量：按登记品种退料，占用与后续排期联动 =====
// 阿珍排 7 批：基础麦10 + 品种麦4 全部投料（批次5/6 为品种麦投料）
const j6 = P.enqueueJob({ recipeId: 'flour', qty: 7, millLevel: 5, currentAbs: 13, farmId: FID, userId: 3, userName: '阿珍' })
assert(!q1('SELECT 1 FROM inventory WHERE farm_id=7 AND item_id=?', 'crop-5'), 'j6 投料耗尽基础小麦')
const resBefore = P.reservedStock(13, FID).reduce((m, x) => (m[x.itemId] = x.qty, m), {})
assert(resBefore['crop-5'] === 18 && resBefore['crop-v1000'] === 4, `减量前占用 基础18/品种4（得到 ${JSON.stringify(resBefore)}）`)
// 减 3 批：退尾部批次5/6（品种麦）+批次4（基础麦）
const red1 = P.reduceJob({ id: j6.id, reduce: 3, currentAbs: 13, farmId: FID, userId: 3, role: 'member' })
const red1m = red1.refunds.reduce((m, x) => (m[x.itemId] = x.qty, m), {})
assert(red1.reduced === 3 && red1m['crop-v1000'] === 4 && red1m['crop-5'] === 2,
  `减量按登记品种原样退料（品种4+基础2，得到 ${JSON.stringify(red1m)}）`)
assert(q1('SELECT qty FROM inventory WHERE farm_id=7 AND item_id=?', 'crop-v1000').qty === 4, '品种小麦退回库存')
const resAfter = P.reservedStock(13, FID).reduce((m, x) => (m[x.itemId] = x.qty, m), {})
assert(resAfter['crop-5'] === 16 && !resAfter['crop-v1000'], `减量后库存占用联动下降（得到 ${JSON.stringify(resAfter)}）`)
assert(JSON.parse(q1('SELECT inputs FROM production_jobs WHERE id=?', j6.id).inputs).length === 4, 'inputs 同步裁剪为 4 批')
// 后续工单排期联动：j7 接在 j6 后，j6 再减 2 批后 j7 提前
const j7 = P.enqueueJob({ recipeId: 'flour', qty: 1, millLevel: 5, currentAbs: 13, farmId: FID, userId: 1, userName: '场主' })
const j7StartBefore = P.listJobs(13, FID).find((x) => x.id === j7.id).start
let permErr2 = null
try { P.reduceJob({ id: j6.id, reduce: 2, currentAbs: 13, farmId: FID, userId: 2, role: 'member' }) } catch (e) { permErr2 = e }
assert(permErr2?.status === 403, '成员不能减量他人排产的工单')
const red2 = P.reduceJob({ id: j6.id, reduce: 2, currentAbs: 13, farmId: FID, userId: 1, role: 'owner' })
assert(red2.remainQty === 2 && red2.refunds[0]?.qty === 4, '场主可减量成员工单，再退 2 批基础麦')
const j7StartAfter = P.listJobs(13, FID).find((x) => x.id === j7.id).start
assert(j7StartAfter < j7StartBefore, `j6 减量后 j7 排期提前（${j7StartBefore}→${j7StartAfter}）`)
assert(P.listJobs(13, FID).find((x) => x.id === j6.id).reducibleBatches === 2, 'j6 未开工，剩余 2 批均可减')

// ===== 10) 旧工单兼容：无投料登记（inputs=NULL）减量/取消回退配方原料退料 =====
const legacy = P.enqueueJob({ recipeId: 'flour', qty: 3, millLevel: 5, currentAbs: 13, farmId: FID, userId: 2, userName: '阿强' })
run('UPDATE production_jobs SET inputs=NULL WHERE id=?', legacy.id) // 模拟升级前旧工单
const legRed = P.reduceJob({ id: legacy.id, reduce: 1, currentAbs: 13, farmId: FID, userId: 2, role: 'member' })
assert(legRed.refunds.length === 1 && legRed.refunds[0].itemId === 'crop-5' && legRed.refunds[0].qty === 2,
  '旧工单减量回退按配方原料（小麦×2）退料')
const legCancel = P.cancelJob({ id: legacy.id, currentAbs: 13, farmId: FID, userId: 2, role: 'member' })
assert(legCancel.refundBatches === 2 && legCancel.refunds[0].itemId === 'crop-5', '旧工单取消剩余批次仍按配方退料')

// ===== 11) 减到 0 = 取消；已结束工单不可减；完工工单全量入库后出队 =====
const j8 = P.enqueueJob({ recipeId: 'flour', qty: 2, millLevel: 5, currentAbs: 13, farmId: FID, userId: 2, userName: '阿强' })
const red0 = P.reduceJob({ id: j8.id, reduce: 5, currentAbs: 13, farmId: FID, userId: 2, role: 'member' })
assert(red0.reduced === 2 && red0.remainQty === 0, '减量超过未开工批次数时收缩为全减')
assert(q1('SELECT status FROM production_jobs WHERE id=?', j8.id).status === 'canceled', '减到 0 批等同取消')
assert(!P.listJobs(13, FID).some((x) => x.id === j8.id), '全减工单直接出队')
P.settleProduction(15, FID) // j5 全部完工
let fullErr = null
try { P.reduceJob({ id: j5.id, reduce: 1, currentAbs: 15, farmId: FID, userId: 2, role: 'member' }) } catch (e) { fullErr = e }
assert(fullErr?.status === 400, '全部批次已完工/已开工的工单不可减量')
const c2 = P.collectJobs(15, FID, j5.id)
assert(c2.picked[0]?.qty === 3, 'j5 剩余 3 批完工后一次入库（累计 4 批）')
assert(!P.listJobs(15, FID).some((x) => x.id === j5.id), '全部入库后工单出队')
assert(q1(`SELECT qty FROM inventory WHERE farm_id=7 AND item_id='flour'`).qty === 9, '面粉累计入库 9 个（j1×3+j4×1+jp×1+j5×4）')
// 一键入库收尾：j6（2批）+ j7（1批）
P.settleProduction(30, FID)
const cAll = P.collectJobs(30, FID)
assert(cAll.picked.reduce((s, p) => s + p.qty, 0) === 3, '一键入库领走全部待入库批次（2+1）')
assert(P.listJobs(30, FID).length === 0, '全部工单入库后队列清空')

db.close()
rmSync(tmp, { recursive: true, force: true })
console.log(failures ? `\n${failures} 个断言失败` : '\n全部通过 🎉')
process.exit(failures ? 1 : 0)
