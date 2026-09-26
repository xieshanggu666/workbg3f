import { db } from './db.js'

// ===== 配方表（以服务端为准，前端仅做展示）=====
// days：每批耗时（游戏天）；needLv：加工坊等级要求
// baseCrop：本源基础作物 id；设置后该配方可消耗任意同本源的杂交品种作物（贯通新品种加工）
export const RECIPES = [
  {
    id: 'flour', name: '面粉', icon: '🍞',
    from: 'crop-5', fromName: '小麦', fromIcon: '🌾', fromCat: 'crop',
    baseCrop: 5,
    consume: 2, result: 'flour', resultName: '面粉', resultCat: 'material',
    gain: 1, days: 1, needLv: 1
  },
  {
    id: 'juice', name: '番茄汁', icon: '🧃',
    from: 'crop-2', fromName: '番茄', fromIcon: '🍅', fromCat: 'crop',
    baseCrop: 2,
    consume: 2, result: 'juice', resultName: '番茄汁', resultCat: 'product',
    gain: 1, days: 1, needLv: 1
  },
  {
    id: 'cheese', name: '奶酪', icon: '🧀',
    from: 'p-cow', fromName: '牛奶', fromIcon: '🥛', fromCat: 'product',
    consume: 2, result: 'cheese', resultName: '奶酪', resultCat: 'product',
    gain: 1, days: 2, needLv: 1
  },
  {
    id: 'bread', name: '面包', icon: '🥖',
    from: 'flour', fromName: '面粉', fromIcon: '🍞', fromCat: 'material',
    consume: 2, result: 'bread', resultName: '面包', resultCat: 'product',
    gain: 1, days: 2, needLv: 2
  },
  {
    id: 'wool', name: '毛线', icon: '🧵',
    from: 'p-sheep', fromName: '羊毛', fromIcon: '🧶', fromCat: 'product',
    consume: 1, result: 'wool', resultName: '毛线', resultCat: 'product',
    gain: 1, days: 1, needLv: 3
  },
  {
    id: 'popcorn', name: '烤玉米', icon: '🍿',
    from: 'crop-3', fromName: '玉米', fromIcon: '🌽', fromCat: 'crop',
    baseCrop: 3,
    consume: 2, result: 'popcorn', resultName: '烤玉米', resultCat: 'product',
    gain: 1, days: 1, needLv: 4
  },
  {
    id: 'pickle', name: '泡菜', icon: '🥬',
    from: 'crop-6', fromName: '白菜', fromIcon: '🥬', fromCat: 'crop',
    baseCrop: 6,
    consume: 3, result: 'pickle', resultName: '泡菜', resultCat: 'product',
    gain: 2, days: 2, needLv: 5
  }
]

export function getRecipe(id) {
  return RECIPES.find((r) => r.id === id) || null
}

// 队列容量：加工坊等级越高，同时排队的批次越多
export function capacity(millLevel = 1) {
  return 2 + millLevel * 2
}

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// 农场内库存与工单操作
function stockOf(farmId, itemId) {
  return q1('SELECT qty FROM inventory WHERE farm_id=? AND item_id=?', farmId, itemId)?.qty || 0
}
// 配方原料可用量：设置了 baseCrop 的配方，本源基础作物与同本源杂交品种作物合并计算
function recipeStock(farmId, r) {
  if (!r.baseCrop) return stockOf(farmId, r.from)
  let total = stockOf(farmId, 'crop-' + r.baseCrop)
  for (const v of q('SELECT id FROM crop_varieties WHERE farm_id=? AND base_id=?', farmId, r.baseCrop)) {
    total += stockOf(farmId, 'crop-v' + v.id)
  }
  return total
}
// 按本源扣减原料：先消耗基础作物，再按品种代数从低到高（优先普通品种）
// 返回实际扣减明细 [{itemId,name,cat,qty}]（杂交品种可能是基础作物也可能是杂交作物，取消退料必须原样退回）
function consumeCropByBase(farmId, baseId, need) {
  let remain = need
  const taken = []
  // 从指定库存行扣 n 个并登记实际来源
  const take = (invId, itemId, name, cat, qty) => {
    const n = Math.min(remain, qty)
    if (n <= 0) return
    run('UPDATE inventory SET qty=qty-? WHERE id=?', n, invId)
    taken.push({ itemId, name, cat, qty: n })
    remain -= n
  }
  const base = q1('SELECT * FROM inventory WHERE farm_id=? AND item_id=?', farmId, 'crop-' + baseId)
  if (base) take(base.id, 'crop-' + baseId, base.name, base.cat, base.qty)
  if (remain > 0) {
    const vars = q(`SELECT i.id AS inv_id, i.item_id, i.name, i.cat, i.qty
                    FROM inventory i
                    JOIN crop_varieties v ON i.item_id = 'crop-v' || v.id
                    WHERE v.farm_id=? AND v.base_id=? AND i.qty>0 ORDER BY v.gen ASC, v.id ASC`, farmId, baseId)
    for (const s of vars) {
      if (remain <= 0) break
      take(s.inv_id, s.item_id, s.name, s.cat, s.qty)
    }
  }
  cleanEmpty(farmId)
  return { taken, got: need - remain }
}
// 扣减单一原料（非杂交贯通配方），返回实际扣减明细
function consumeItem(farmId, itemId, need) {
  const row = q1('SELECT * FROM inventory WHERE farm_id=? AND item_id=?', farmId, itemId)
  const n = Math.min(need, row?.qty || 0)
  if (n <= 0) return { taken: [], got: 0 }
  run('UPDATE inventory SET qty=qty-? WHERE id=?', n, row.id)
  cleanEmpty(farmId)
  return { taken: [{ itemId, name: row.name, cat: row.cat, qty: n }], got: n }
}
// 把按消耗顺序排列的扣减明细按每批 consume 个切分，登记到每一批
// （取消时按批次退还：机器先开的批次先投料，故未开工的尾部批次要原样拿回自己的投料）
function splitIntoBatches(taken, perBatch, batches) {
  const flat = []
  for (const t of taken) for (let i = 0; i < t.qty; i++) flat.push(t)
  const result = []
  for (let b = 0; b < batches; b++) {
    const map = new Map()
    for (const t of flat.slice(b * perBatch, (b + 1) * perBatch)) {
      const cur = map.get(t.itemId)
      if (cur) cur.qty += 1
      else map.set(t.itemId, { itemId: t.itemId, name: t.name, cat: t.cat, qty: 1 })
    }
    result.push([...map.values()])
  }
  return result
}
function addInv(farmId, itemId, name, cat, n) {
  const row = q1('SELECT id, qty FROM inventory WHERE farm_id=? AND item_id=?', farmId, itemId)
  if (row) run('UPDATE inventory SET qty=qty+? WHERE id=?', n, row.id)
  else run('INSERT INTO inventory (farm_id,item_id,name,cat,qty) VALUES (?,?,?,?,?)', farmId, itemId, name, cat, n)
}
function cleanEmpty(farmId) {
  run('DELETE FROM inventory WHERE farm_id=? AND qty<=0', farmId)
}

// 截至 absAbs 时，某工单已完工的批次数（取消后不再增加）
function finishedBatchesAt(j, atAbs) {
  const stop = j.cancel_abs == null ? Infinity : j.cancel_abs
  const eff = Math.min(atAbs, stop)
  return Math.min(j.qty, Math.max(0, Math.floor((eff - j.start) / j.days)))
}

// 截至 absAbs 时，某工单已开工的批次数（正在加工中的批次也算开工，原料不可退）
function startedBatchesAt(j, atAbs) {
  const stop = j.cancel_abs == null ? Infinity : j.cancel_abs
  const eff = Math.min(atAbs, stop)
  return Math.min(j.qty, Math.max(0, Math.floor((eff - j.start) / j.days) + 1))
}

// 队列重放：加工坊只有一台机器，按工单创建顺序串行加工，算出每个工单
//   start  —— 首批开工绝对日（当天 00:00 即可开工）
//   finish —— 全部批次完工的绝对日（用于预估还剩几天）
// 取消的工单在 cancel_abs 立刻让出机器，后续工单自动提前；
// 尚未开工就被取消的工单从未占用机器，游标不得回退（否则后续工单会排到过去、提前产出）。
function replay(jobs) {
  let cursor = 0
  for (const j of jobs) {
    const start = Math.max(cursor, j.enqueue_abs)
    j.start = start
    const stop = j.cancel_abs == null ? Infinity : j.cancel_abs
    let finish = start
    for (let b = 0; b < j.qty; b++) {
      const bEnd = start + (b + 1) * j.days
      if (bEnd > stop) break
      finish = bEnd
    }
    if (j.cancel_abs == null) {
      j.finish = finish
      cursor = finish
    } else if (start < stop) {
      // 取消时已有批次开工（可能正加工到一半）：机器一直占用到取消时刻才让出
      j.finish = stop
      cursor = stop
    } else {
      // 取消时还没轮到开工：这张工单没碰过机器，游标保持不动
      j.finish = start
    }
  }
  return jobs
}

// 该农场全部工单重放（含已取消/已入库——它们历史上占用过机器时间，影响后续工单排期）
// 多人协作下队列顺序以 seq 为准（可重排），不再等于 id 顺序
function allJobs(farmId) {
  return replay(q('SELECT * FROM production_jobs WHERE farm_id=? ORDER BY seq, id', farmId))
}

// 解析排产时逐批登记的实际投料 JSON：[[{itemId,name,cat,qty},...], ...每批]
function parseInputs(inputs) {
  if (!inputs) return []
  try {
    const arr = JSON.parse(inputs)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}
// 合并同物品条目
function mergeItems(items) {
  const m = new Map()
  for (const it of items) {
    const cur = m.get(it.itemId)
    if (cur) cur.qty += it.qty
    else m.set(it.itemId, { ...it })
  }
  return [...m.values()].filter((it) => it.qty > 0)
}
// 工单全部批次投料（原料占用展示用）；旧工单无登记时回退配方原料
function jobInputs(j) {
  const items = []
  for (const batch of parseInputs(j.inputs)) for (const it of batch || []) items.push(it)
  if (items.length === 0 && j.consume > 0) {
    items.push({ itemId: j.from_id, name: j.from_name, cat: j.from_cat, qty: j.consume * j.qty })
  }
  return mergeItems(items)
}
// 前 cutoff 批（已完工/已开工）的投料合并明细
// 旧工单 inputs 为 NULL 时按配方原料 × 批数回退（兼容历史工单）
function batchInputs(j, cutoff) {
  const items = []
  const batches = parseInputs(j.inputs)
  if (batches.length) {
    for (const batch of batches.slice(0, cutoff)) for (const it of batch || []) items.push(it)
  } else if (j.consume > 0) {
    items.push({ itemId: j.from_id, name: j.from_name, cat: j.from_cat, qty: j.consume * cutoff })
  }
  return mergeItems(items)
}
// 取消时按批次序号退还的原料（未开工尾部批次），返回合并明细
function refundableItems(j, startedBatches) {
  let items = []
  const batches = parseInputs(j.inputs)
  if (batches.length) {
    for (const batch of batches.slice(startedBatches, j.qty)) for (const it of batch || []) items.push(it)
  } else if (j.consume > 0) {
    const refundBatches = Math.max(0, j.qty - startedBatches)
    items = [{ itemId: j.from_id, name: j.from_name, cat: j.from_cat, qty: j.consume * refundBatches }]
  }
  return mergeItems(items)
}
// 按需减量时退还的原料：裁掉尾部 n 批（调用方保证这些批次均未开工）
function reduceRefundItems(j, reduceBatches) {
  const keep = j.qty - reduceBatches
  let items = []
  const batches = parseInputs(j.inputs)
  if (batches.length) {
    for (const batch of batches.slice(keep, j.qty)) for (const it of batch || []) items.push(it)
  } else if (j.consume > 0) {
    items = [{ itemId: j.from_id, name: j.from_name, cat: j.from_cat, qty: j.consume * reduceBatches }]
  }
  return mergeItems(items)
}

// 当前在队（未全部领走）的工单 + 动态状态
export function listJobs(currentAbs, farmId) {
  const jobs = []
  for (const j of allJobs(farmId)) {
    const collected = Math.max(0, j.collected || 0)
    j.collectedBatches = collected
    j.doneBatches = finishedBatchesAt(j, currentAbs)
    // 已取消：可入库成品在取消时定格（取消后的跨天结算不再给它产出）
    const availableBatches = j.status === 'canceled' ? j.finished : j.doneBatches
    // 可随时入库：已完工但尚未领走的批次（运行中工单也能分批领）
    j.collectableBatches = Math.max(0, availableBatches - collected)
    // 成品已全部领走的工单直接出队：取消单/历史 collected 单无可领即走；
    // 运行单须全部完工且领净（仍在加工的运行单即便暂无可领也要留在队列里）
    if (j.collectableBatches === 0 &&
        (j.status === 'canceled' || j.status === 'collected' ||
         (j.status === 'running' && j.doneBatches >= j.qty))) continue
    j.startedBatches = j.status === 'canceled'
      ? startedBatchesAt(j, j.cancel_abs)
      : startedBatchesAt(j, currentAbs)
    // 取消时实际退料的批次数 = 取消时点尚未开工的批次
    j.refundedBatches = j.status === 'canceled' ? Math.max(0, j.qty - j.startedBatches) : 0
    // 仍占队列/机器的批次：未完工（含加工中、排队中）；已完工批次等入库，不再占机器
    j.waitingBatches = j.status === 'running' ? j.qty - j.doneBatches : 0
    // 未开工批次：可按需减量的那部分
    j.reducibleBatches = j.status === 'running'
      ? Math.max(0, j.qty - startedBatchesAt(j, currentAbs)) : 0
    j.computedStatus = j.status === 'running'
      ? (j.doneBatches >= j.qty ? 'done' : 'running')
      : j.status
    j.remainDays = j.computedStatus === 'running'
      ? Math.max(0, j.finish - currentAbs)
      : 0
    // 协作信息：排产人
    j.creator = j.created_by ? { id: j.created_by, name: j.created_name || '' } : null
    // 在制工单仍锁着的原料 = 尚未完工批次的投料（已完工批次已变成待入库成品，不再占原料）
    j.occupiedItems = j.status === 'running' ? unfinishedInputs(j) : []
    // 当前若取消可退（未开工批次）明细
    j.refundableItems = j.status === 'running' ? refundableItems(j, j.startedBatches) : []
    j.refundedItems = j.status === 'canceled' && j.refundedBatches > 0
      ? refundableItems(j, j.startedBatches) : []
    jobs.push(j)
  }
  return jobs
}

// 在制工单尚未完工批次的投料（这些批次还占着原料）；
// 已完工批次已转为成品待入库。未完工批次 = 尾部 (qty-done) 批，
// 其投料 = 总投料 − 前 done 批投料（旧工单 inputs 为 NULL 时按配方原料回退）。
function unfinishedInputs(j) {
  const doneMap = new Map(batchInputs(j, j.doneBatches).map((it) => [it.itemId, it.qty]))
  const items = []
  for (const it of jobInputs(j)) {
    const qty = it.qty - (doneMap.get(it.itemId) || 0)
    if (qty > 0) items.push({ ...it, qty })
  }
  return items
}

// 当前队列里被在制工单占用（已投料、尚未变成成品）的原料汇总，按物品合并
// 供库存页展示「可用 / 被工单占用」——排产扣料后剩余库存即空闲可用量
export function reservedStock(currentAbs, farmId) {
  const m = new Map()
  for (const j of listJobs(currentAbs, farmId)) {
    if (j.status !== 'running') continue
    for (const it of unfinishedInputs(j)) {
      const cur = m.get(it.itemId)
      if (cur) cur.qty += it.qty
      else m.set(it.itemId, { ...it })
    }
  }
  return [...m.values()]
}

// 在队批次占用（用于容量限制，已取消/已全部完工的工单不再占坑）
export function queuedBatches(currentAbs, farmId) {
  return listJobs(currentAbs, farmId)
    .filter((j) => j.computedStatus === 'running')
    .reduce((s, j) => s + j.waitingBatches, 0)
}

// 推进游戏天时结算：把跨天完工的批次落库（幂等：finished 只增不减），
// 返回完工日志。toAbs 为结算后的绝对日。
// 注意：本函数在 advanceDay 的事务内调用，不再另开事务。
export function settleProduction(toAbs, farmId) {
  const logs = []
  for (const j of allJobs(farmId)) {
    if (j.status !== 'running') continue
    const done = finishedBatchesAt(j, toAbs)
    if (done > j.finished) {
      const add = done - j.finished
      const status = done >= j.qty ? 'done' : 'running'
      run('UPDATE production_jobs SET finished=?, status=? WHERE id=?', done, status, j.id)
      logs.push(`✅ ${j.recipe_name} 新完工 ${add} 批（共 ${done}/${j.qty}），可去加工坊入库`)
    }
  }
  return logs
}

// 批量排产：一个配方一次下 n 批；原料当场全部扣走
// 多成员协作：记录排产人，新工单排到队列尾部（seq 递增）
export function enqueueJob({ recipeId, qty, millLevel, currentAbs, farmId, userId, userName }) {
  const r = getRecipe(recipeId)
  if (!r) throw Object.assign(new Error('配方不存在'), { status: 404 })
  const n = Math.max(1, Math.min(Math.floor(Number(qty) || 1), 99))
  if (millLevel < r.needLv) throw Object.assign(new Error('加工坊等级不足'), { status: 400 })
  const used = queuedBatches(currentAbs, farmId)
  if (used + n > capacity(millLevel)) {
    throw Object.assign(new Error(`队列已满（${used}/${capacity(millLevel)} 批），等工单完工或取消一些再排产`), { status: 400 })
  }
  const need = r.consume * n
  if (recipeStock(farmId, r) < need) throw Object.assign(new Error(`原料不足：需要 ${r.fromName} ×${need}`), { status: 400 })
  db.exec('BEGIN IMMEDIATE')
  try {
    const { taken, got } = r.baseCrop
      ? consumeCropByBase(farmId, r.baseCrop, need)
      : consumeItem(farmId, r.from, need)
    if (got < need) throw Object.assign(new Error(`原料不足：需要 ${r.fromName} ×${need}`), { status: 400 })
    // 按批次登记实际投料来源（基础作物/杂交品种逐项记录），取消未开工批次时原样退回
    const inputs = JSON.stringify(splitIntoBatches(taken, r.consume, n))
    // seq 接在队尾（含历史已结束工单，保证严格递增、不与重排后的顺序冲突）
    const nextSeq = (q1('SELECT MAX(seq) s FROM production_jobs WHERE farm_id=?', farmId)?.s || 0) + 1
    const res = run(
      `INSERT INTO production_jobs
       (farm_id,recipe_id,recipe_name,result_id,result_name,result_cat,from_id,from_name,from_cat,
        consume,gain,days,qty,finished,enqueue_abs,inputs,seq,created_by,created_name,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,'running')`,
      farmId, r.id, r.name, r.result, r.resultName, r.resultCat,
      r.from, r.fromName, r.fromCat, r.consume, r.gain, r.days, n, currentAbs, inputs,
      nextSeq, userId || null, userName || null
    )
    db.exec('COMMIT')
    return { ok: true, id: res.lastInsertRowid }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// 协作权限：只能管理自己排产的在制工单；管理员/场主可管理任意工单；
// 升级前无排产人记录的旧工单视为公共工单，任何成员可管理
export function canManageJob(j, userId, role) {
  if (role === 'owner' || role === 'admin') return true
  return !j.created_by || j.created_by === userId
}

// 取消工单：退还尚未开工批次的原料；已开工（含加工中）批次不退料，
// 已完工批次保留成品待入库，加工中批次随取消作废。
// 退料按排产时逐批登记的实际投料（可能含杂交品种作物）原样退回，
// 而不是统一退成配方本源基础作物；旧工单无登记时回退按配方原料退。
// 防多人重复：状态/排期/退料全部在 IMMEDIATE 事务内重读计算，
// 已取消/已减量的批次不会二次退料。
export function cancelJob({ id, currentAbs, farmId, userId, role }) {
  const j0 = q1('SELECT * FROM production_jobs WHERE farm_id=? AND id=?', farmId, id)
  if (!j0) throw Object.assign(new Error('工单不存在'), { status: 404 })
  if (j0.status !== 'running') throw Object.assign(new Error('该工单已结束，无法取消'), { status: 400 })
  if (!canManageJob(j0, userId, role)) {
    throw Object.assign(new Error('只能取消自己排产的工单（管理员可取消任意工单）'), { status: 403 })
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    // 事务内重读：并发下另一成员可能已取消/减量，以落库状态为准
    const j = q1('SELECT * FROM production_jobs WHERE farm_id=? AND id=?', farmId, id)
    if (j.status !== 'running') throw Object.assign(new Error('该工单已结束，无法取消'), { status: 400 })
    const cur = replay(q('SELECT * FROM production_jobs WHERE farm_id=? ORDER BY seq, id', farmId)
      .map((x) => ({ ...x }))).find((x) => x.id === id)
    const finishedBatches = finishedBatchesAt(cur, currentAbs)
    // 正在加工的批次已投入原料、尚未产出，取消即作废；只退还没开工的批次
    const startedBatches = startedBatchesAt(cur, currentAbs)
    const refundBatches = Math.max(0, j.qty - startedBatches)
    const refunds = refundableItems(j, startedBatches)
    run('UPDATE production_jobs SET status=\'canceled\', cancel_abs=?, finished=? WHERE id=?',
      currentAbs, finishedBatches, id)
    for (const it of refunds) addInv(farmId, it.itemId, it.name, it.cat, it.qty)
    db.exec('COMMIT')
    return { ok: true, refundBatches, finishedBatches, refunds }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// 按需减量：运行中工单裁掉尾部 n 批「尚未开工」的批次，按实际投料原样退料。
// 已完工/加工中的批次不能减；减量后批次数变小，replay 自动缩短占用机器时间，
// 后续排队工单随之提前、队列容量与原料占用同步释放。
// 与取消共用同一套防多人重复机制（事务内重读状态 + 只退未落库批次的料）。
export function reduceJob({ id, n, currentAbs, farmId, userId, role }) {
  const cut = Math.max(1, Math.floor(Number(n) || 0))
  if (cut <= 0) throw Object.assign(new Error('减量批次数非法'), { status: 400 })
  const j0 = q1('SELECT * FROM production_jobs WHERE farm_id=? AND id=?', farmId, id)
  if (!j0) throw Object.assign(new Error('工单不存在'), { status: 404 })
  if (j0.status !== 'running') throw Object.assign(new Error('该工单已结束，无法减量'), { status: 400 })
  if (!canManageJob(j0, userId, role)) {
    throw Object.assign(new Error('只能调整自己排产的工单（管理员可调整任意工单）'), { status: 403 })
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    const j = q1('SELECT * FROM production_jobs WHERE farm_id=? AND id=?', farmId, id)
    if (j.status !== 'running') throw Object.assign(new Error('该工单已结束，无法减量'), { status: 400 })
    const cur = replay(q('SELECT * FROM production_jobs WHERE farm_id=? ORDER BY seq, id', farmId)
      .map((x) => ({ ...x }))).find((x) => x.id === id)
    const done = finishedBatchesAt(cur, currentAbs)
    // 加工中批次（startedBatchesAt 含当前正在做的那批）不可减；只能裁未开工尾部批次
    const reducible = Math.max(0, j.qty - startedBatchesAt(cur, currentAbs))
    const realCut = Math.min(cut, reducible)
    if (realCut <= 0) {
      throw Object.assign(new Error('已开工的批次不能减量，请等完工入库或取消工单'), { status: 400 })
    }
    const newQty = j.qty - realCut
    const refunds = reduceRefundItems(j, realCut)
    // 裁掉尾部批次：qty 与逐批投料登记同步截断（否则占用/再减量/再取消仍按旧批数算料）
    const keptInputs = parseInputs(j.inputs).slice(0, newQty)
    run('UPDATE production_jobs SET qty=?, inputs=? WHERE farm_id=? AND id=?',
      newQty, j.inputs ? JSON.stringify(keptInputs) : null, farmId, id)
    for (const it of refunds) addInv(farmId, it.itemId, it.name, it.cat, it.qty)
    // 重算减量后后续工单的排期信息仅用于响应预览
    const after = replay(q('SELECT * FROM production_jobs WHERE farm_id=? ORDER BY seq, id', farmId)
      .map((x) => ({ ...x }))).find((x) => x.id === id)
    db.exec('COMMIT')
    return {
      ok: true, qty: newQty, cutBatches: realCut, doneBatches: done,
      refunds, finish: after.finish
    }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// 队列重排：把指定未开工工单与相邻工单交换顺序（dir=-1 提前 / +1 延后）。
// 已开工/已完工/已取消的工单钉死在时间线上不能移动；只在「排队等待中」工单
// 组成的连续序列内交换 seq（交换后机器排期由 replay 重算，机器不会倒回过去）。
export function reorderJob({ id, dir, currentAbs, farmId }) {
  const d = Number(dir)
  if (d !== -1 && d !== 1) throw Object.assign(new Error('重排方向非法'), { status: 400 })
  const jobs = replay(q('SELECT * FROM production_jobs WHERE farm_id=? ORDER BY seq, id', farmId)
    .map((x) => ({ ...x })))
  const j = jobs.find((x) => x.id === Number(id))
  if (!j || j.status === 'collected') throw Object.assign(new Error('工单不存在'), { status: 404 })
  if (j.status !== 'running') throw Object.assign(new Error('已结束的工单不能重排'), { status: 400 })
  // 首批已开工（机器正在做或已产出过）则排期已生效，不能移动
  if (j.start <= currentAbs) throw Object.assign(new Error('已开工的工单不能重排，只能取消'), { status: 400 })

  // 可移动集合：仍在队、running 且首批尚未开工
  const movable = jobs.filter((x) => x.status === 'running' && x.start > currentAbs)
  const idx = movable.findIndex((x) => x.id === j.id)
  const swap = movable[idx + d]
  if (!swap) {
    throw Object.assign(new Error(d < 0 ? '已经排在最前面了' : '已经排在最后面了'), { status: 400 })
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    // 只交换这两张工单的 seq，其余工单不动
    run('UPDATE production_jobs SET seq=? WHERE farm_id=? AND id=?', swap.seq, farmId, j.id)
    run('UPDATE production_jobs SET seq=? WHERE farm_id=? AND id=?', j.seq, farmId, swap.id)
    db.exec('COMMIT')
    return { ok: true, id: j.id, dir: d, withId: swap.id }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// 完工入库：领取指定工单「已完工但尚未领走」的批次成品；不传 id 则一键领取全部待入库批次。
// 运行中工单也可随时分批入库（领完已完工批次后继续加工剩余批次）；
// 已取消工单只领取消时定格的成品；全部批次领完后状态置 collected 出队。
// 防多人重复：collected 计数只增不减，入库量 = finished − collected，
// 状态/计数在 IMMEDIATE 事务内重读更新，多端连点不会重复发成品。
export function collectJobs(currentAbs, farmId, id = null) {
  const targetId = id == null ? null : Number(id)
  db.exec('BEGIN IMMEDIATE')
  try {
    // 事务内重读候选工单（并发下另一成员可能刚领过/取消过，以落库状态为准）
    const rows = targetId != null
      ? q('SELECT * FROM production_jobs WHERE farm_id=? AND id=?', farmId, targetId)
      : q("SELECT * FROM production_jobs WHERE farm_id=? AND status!='collected' ORDER BY seq, id", farmId)
    if (!rows.length) throw Object.assign(new Error('工单不存在'), { status: 404 })

    // 排期在事务内重放，完工批次数与取消定格值均按最新落库状态计算
    const byId = new Map(
      replay(q('SELECT * FROM production_jobs WHERE farm_id=? ORDER BY seq, id', farmId)
        .map((x) => ({ ...x }))).map((j) => [j.id, j])
    )

    const picked = []
    for (const j0 of rows) {
      const j = j0.status === 'canceled' || j0.status === 'collected'
        ? j0
        : byId.get(j0.id) || j0
      const available = j0.status === 'canceled' ? j0.finished : finishedBatchesAt(j, currentAbs)
      const already = Math.max(0, j0.collected || 0)
      const batches = Math.max(0, available - already)
      if (batches <= 0) {
        if (targetId != null) {
          throw Object.assign(new Error('该工单暂无新完工批次可入库'), { status: 400 })
        }
        continue
      }
      addInv(farmId, j0.result_id, j0.result_name, j0.result_cat, j0.gain * batches)
      const newCollected = already + batches
      // 可领批次已领净：运行单全部完工或取消单 → collected 出队；运行中工单领完仍在队列继续加工
      const fullyDone = j0.status === 'canceled' || available >= j0.qty
      run('UPDATE production_jobs SET collected=?, status=? WHERE id=?',
        newCollected, fullyDone ? 'collected' : 'running', j0.id)
      picked.push({ id: j0.id, name: j0.result_name, qty: j0.gain * batches })
    }
    if (!picked.length) throw Object.assign(new Error('没有可入库的成品'), { status: 400 })
    db.exec('COMMIT')
    return { ok: true, picked }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}
