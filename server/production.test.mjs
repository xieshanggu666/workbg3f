// 临时集成测试：协作排产（排产人/原料占用/取消退料/队列重排/分批入库/按需减量/防重复）
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

// 占用汇总：abs=2 时 j1 已完工 1 批（2 基础麦转为成品待入库，不再占原料）
// → 基础麦占用 20-2=18，j4 锁 2 品种麦
const reserved = P.reservedStock(2, FID).reduce((m, x) => (m[x.itemId] = x.qty, m), {})
assert(reserved['crop-5'] === 18 && reserved['crop-v1000'] === 2, `占用汇总按物品合并（完工批次占用转成品：基础18/品种2）得到 ${JSON.stringify(reserved)}`)

// listJobs 带排产人与投料明细
const j1v = P.listJobs(2, FID).find((x) => x.id === j1.id)
assert(j1v.creator?.name === '阿强', '工单动态状态含排产人')
// j1 完工 1 批后仍锁 2 批投料（4 个基础麦），可入库 1 批成品
assert((j1v.occupiedItems || []).some((it) => it.itemId === 'crop-5' && it.qty === 4), '完工批次投料释放：工单剩余占用明细为 4 基础麦')
assert(j1v.collectableBatches === 1 && j1v.collectedBatches === 0, '完工批次随时可入库（可领1/已领0）')

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

// ===== 8) 完工批次随时入库（运行中工单分批领，防重复入库）=====
// 全新排产 4 批面粉（耗基础麦 8）；先补货
run(`INSERT INTO inventory (farm_id,item_id,name,cat,qty) VALUES (7,'crop-5','小麦','crop',20)
     ON CONFLICT(farm_id,item_id) DO UPDATE SET qty=qty+excluded.qty`)
const jc = P.enqueueJob({ recipeId: 'flour', qty: 4, millLevel: 5, currentAbs: 12, farmId: FID, userId: 2, userName: '阿强' })
const flourBase = q1(`SELECT qty FROM inventory WHERE farm_id=7 AND item_id='flour'`)?.qty || 0
P.settleProduction(13, FID) // 第13天：完工 1 批，第 2 批加工中
let jcView = P.listJobs(13, FID).find((x) => x.id === jc.id)
assert(jcView.doneBatches === 1 && jcView.collectableBatches === 1 && jcView.status === 'running', '运行中工单有 1 批可分批入库')
assert((q1(`SELECT qty FROM inventory WHERE farm_id=7 AND item_id='flour'`)?.qty || 0) === flourBase, '入库前面粉不增加')
const got1 = P.collectJobs(13, FID, jc.id)
assert(got1.picked[0].qty === 1, '分批入库：先领 1 个面粉')
assert((q1(`SELECT qty FROM inventory WHERE farm_id=7 AND item_id='flour'`)?.qty || 0) === flourBase + 1, '面粉已入库 1 个')
jcView = P.listJobs(13, FID).find((x) => x.id === jc.id)
assert(jcView.collectableBatches === 0 && jcView.collectedBatches === 1 && jcView.status === 'running', '领完后工单仍在队列继续加工，已领计数=1')
// 无新完工批次时重复入库被拒（防多人/多端连点重复入库）
let dupCollect = null
try { P.collectJobs(13, FID, jc.id) } catch (e) { dupCollect = e }
assert(dupCollect?.status === 400, '没有新完工批次时重复入库被拒')
assert((q1(`SELECT qty FROM inventory WHERE farm_id=7 AND item_id='flour'`)?.qty || 0) === flourBase + 1, '重复入库未多发成品')
// 推进到全部完工（第16天 4 批全完），再领剩余 3 批，工单出队
P.settleProduction(16, FID)
const got2 = P.collectJobs(16, FID, jc.id)
assert(got2.picked[0].qty === 3, `剩余 3 批一次入库（得到 ${got2.picked[0]?.qty}）`)
assert((q1(`SELECT qty FROM inventory WHERE farm_id=7 AND item_id='flour'`)?.qty || 0) === flourBase + 4, '面粉累计入库 4 个')
assert(q1('SELECT status, collected FROM production_jobs WHERE id=?', jc.id).status === 'collected'
  && P.listJobs(16, FID).every((x) => x.id !== jc.id), '全部领完状态=collected 且工单出队')

// ===== 9) 未开工批次按需减量（实际品种退料 + 联动排期/占用/容量）=====
run(`INSERT INTO inventory (farm_id,item_id,name,cat,qty) VALUES (7,'crop-5','小麦','crop',20)
     ON CONFLICT(farm_id,item_id) DO UPDATE SET qty=qty+excluded.qty`)
// 一张 1 批的工单先占住机器当天，让 jr 处于排队未开工状态
const jhold = P.enqueueJob({ recipeId: 'flour', qty: 1, millLevel: 5, currentAbs: 17, farmId: FID, userId: 3, userName: '阿珍' })
const jr = P.enqueueJob({ recipeId: 'flour', qty: 4, millLevel: 5, currentAbs: 17, farmId: FID, userId: 3, userName: '阿珍' })
const jrView0 = P.listJobs(17, FID).find((x) => x.id === jr.id)
assert(jrView0.start > 17, 'jr 排在占机工单之后，尚未开工')
const jrFinishBefore = jrView0.finish
assert(jrView0.reducibleBatches === 4, '未开工工单 4 批全部可减量')
// 权限：阿强不能减量阿珍的工单
let reducePerm = null
try { P.reduceJob({ id: jr.id, n: 1, currentAbs: 17, farmId: FID, userId: 2, role: 'member' }) } catch (e) { reducePerm = e }
assert(reducePerm?.status === 403, '成员不能减量他人排产的工单')
// 阿珍裁掉 2 批：退回 4 基础麦，qty 4→2，排期缩短、后续工单提前
const wheatBefore = q1(`SELECT qty FROM inventory WHERE farm_id=7 AND item_id='crop-5'`)?.qty || 0
const reduced = P.reduceJob({ id: jr.id, n: 2, currentAbs: 17, farmId: FID, userId: 3, role: 'member' })
assert(reduced.cutBatches === 2 && reduced.qty === 2
  && reduced.refunds[0]?.itemId === 'crop-5' && reduced.refunds[0].qty === 4, '减量 2 批退回 4 个基础麦（按登记实际投料）')
assert((q1(`SELECT qty FROM inventory WHERE farm_id=7 AND item_id='crop-5'`)?.qty || 0) === wheatBefore + 4, '退回原料回到库存')
assert(q1('SELECT qty FROM production_jobs WHERE id=?', jr.id).qty === 2, '工单批次数落库为 2')
const jrFinishAfter = P.listJobs(17, FID).find((x) => x.id === jr.id).finish
assert(jrFinishAfter < jrFinishBefore, `减量缩短机器占用，工单完工提前（${jrFinishBefore}→${jrFinishAfter}），后续排期随 replay 提前`)
// 占用汇总同步释放（jr 只剩 2 批 = 4 麦；jhold 占 2 麦）
const reservedMap = P.reservedStock(17, FID).reduce((m, x) => (m[x.itemId] = x.qty, m), {})
assert(reservedMap['crop-5'] === 6, `减量后原料占用联动释放（jhold2+jr4=6，得到 ${reservedMap['crop-5']}）`)
// 推进 1 天后 jhold 完工、jr 首批正在加工：加工中那批不可减，只能裁最后 1 批未开工批次
P.settleProduction(18, FID)
const jrAt18 = P.listJobs(18, FID).find((x) => x.id === jr.id)
assert(jrAt18.startedBatches === 1 && jrAt18.reducibleBatches === 1, '首批加工中不可减，剩余未开工 1 批可减')
const reduced2 = P.reduceJob({ id: jr.id, n: 99, currentAbs: 18, farmId: FID, userId: 3, role: 'member' })
assert(reduced2.cutBatches === 1 && reduced2.qty === 1, '减量自动收缩到剩余未开工批次（裁 1 留 1）')
// 再减：最后 1 批正在加工，不能减量
let reduceMid = null
try { P.reduceJob({ id: jr.id, n: 1, currentAbs: 18, farmId: FID, userId: 3, role: 'member' }) } catch (e) { reduceMid = e }
assert(reduceMid?.status === 400, '加工中批次不能减量（只能取消或等完工入库）')

// ===== 10) 已完工批次不能减量（只能入库）=====
// jhold 已在第18天完工：可减量为 0，减量被拒；可入库
let reduceDone = null
try { P.reduceJob({ id: jhold.id, n: 1, currentAbs: 18, farmId: FID, userId: 3, role: 'member' }) } catch (e) { reduceDone = e }
assert(reduceDone?.status === 400, '已完工批次不能减量')
P.collectJobs(18, FID, jhold.id)

// ===== 11) 品种麦投料工单减量：按实际品种退回，不退成基础作物 =====
run(`INSERT INTO inventory (farm_id,item_id,name,cat,qty) VALUES (7,'crop-v1000','抗旱小麦','crop',10)
     ON CONFLICT(farm_id,item_id) DO UPDATE SET qty=qty+excluded.qty`)
// 基础麦不足时排产会吃品种麦：先把基础麦清零并占位 1 天
run(`UPDATE inventory SET qty=0 WHERE farm_id=7 AND item_id='crop-5'`)
run('DELETE FROM inventory WHERE farm_id=7 AND qty<=0')
const jv = P.enqueueJob({ recipeId: 'flour', qty: 3, millLevel: 5, currentAbs: 19, farmId: FID, userId: 2, userName: '阿强' })
const vBefore = q1(`SELECT qty FROM inventory WHERE farm_id=7 AND item_id='crop-v1000'`).qty
const redV = P.reduceJob({ id: jv.id, n: 2, currentAbs: 19, farmId: FID, userId: 2, role: 'member' })
assert(redV.refunds.every((it) => it.itemId === 'crop-v1000') && redV.refunds[0].qty === 4,
  `品种投料减量按实际品种退回 4 个品种麦（得到 ${JSON.stringify(redV.refunds)}）`)
assert(q1(`SELECT qty FROM inventory WHERE farm_id=7 AND item_id='crop-v1000'`).qty === vBefore + 4, '品种麦退回库存，未统一退成基础作物')

db.close()
rmSync(tmp, { recursive: true, force: true })
console.log(failures ? `\n${failures} 个断言失败` : '\n全部通过 🎉')
process.exit(failures ? 1 : 0)
