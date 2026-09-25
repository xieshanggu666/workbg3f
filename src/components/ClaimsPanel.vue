<template>
  <div class="page claims-page">
    <!-- 左：提交申报 -->
    <div class="pcol card">
      <h4>🌪️ 灾损申报</h4>
      <div class="queue-stat">
        恶劣天气造成损失时在此申报补偿
        <span class="tag">管理员复核通过后自动发放金币/物资</span>
      </div>

      <label class="f-label">灾害事件</label>
      <select v-model="form.eventId" class="f-select">
        <option value="">— 选择造成损失的灾害 —</option>
        <option v-for="e in store.claimEvents" :key="e.id" :value="e.id">
          {{ e.icon }} {{ e.name }} {{ '⚠'.repeat(e.severity) }} · 第{{ e.abs_day }}天{{ e.done ? '（已结束）' : '（进行中）' }}
        </option>
      </select>
      <div v-if="!store.claimEvents.length" class="none">近期没有灾害天气，无需申报</div>

      <label class="f-label">损失类别</label>
      <div class="cat-pick">
        <button v-for="(c, key) in store.claimCategories" :key="key"
                :class="{active: form.category === key}" @click="form.category = key">
          {{ c.icon }} {{ c.name }}
        </button>
      </div>

      <label class="f-label">损失描述</label>
      <textarea v-model.trim="form.detail" class="f-text" rows="2" maxlength="100"
                placeholder="例：暴雨冲毁 3 块地的番茄，畜棚进水…"></textarea>

      <div class="f-grid">
        <div>
          <label class="f-label">受灾数量</label>
          <input v-model.number="form.qty" type="number" min="1" max="99" class="f-input" />
        </div>
        <div>
          <label class="f-label">申请金币 🪙</label>
          <input v-model.number="form.gold" type="number" min="0" max="999" class="f-input" />
        </div>
        <div>
          <label class="f-label">申请物资 🧱</label>
          <input v-model.number="form.mat" type="number" min="0" max="99" class="f-input" />
        </div>
      </div>

      <button class="wide start" :disabled="!canSubmit" @click="doSubmit">📮 提交申报</button>
      <p class="hint">
        同一灾害、同一类别每人只能有一条进行中的申报（驳回后可重新申报）；
        申报需由<b>其他</b>管理员/场主协作复核，不能自报自审。
      </p>
    </div>

    <!-- 右：申报记录 / 复核 -->
    <div class="pcol card">
      <h4>📋 申报记录
        <span class="lvl" v-if="pendingCount">待复核 {{ pendingCount }}</span>
      </h4>
      <div v-if="!store.claims.length" class="none">还没有申报记录</div>

      <div v-for="c in store.claims" :key="c.id" class="claim" :class="c.status">
        <div class="c-head">
          <span class="c-cat">{{ catOf(c.category).icon }}</span>
          <div class="c-title">
            <b>{{ catOf(c.category).name }} ×{{ c.qty }}
              <span class="c-state" :class="c.status">{{ stateLabel(c.status) }}</span>
              <span class="creator">
                👤{{ c.created_name }}
                <i class="live-dot" :class="{on: store.onlineUserIds.has(c.created_by)}"></i>
              </span>
              <span v-if="c.created_by === store.user?.id" class="tag mine">我的</span>
            </b>
            <span class="tag">{{ c.event_icon }} {{ c.event_name }} · 第{{ c.event_abs }}天</span>
            <span class="tag req">申请 🪙{{ c.claim_gold }} + 物资×{{ c.claim_mat }}</span>
          </div>
        </div>
        <p class="c-detail">{{ c.detail }}</p>
        <p class="c-evidence" v-if="c.evidence">
          <span v-for="(line, i) in c.evidence.split('\n')" :key="i">📎 {{ line }}<br /></span>
        </p>

        <!-- 复核结果 -->
        <p class="c-review approved" v-if="c.status === 'approved'">
          ✅ {{ c.reviewed_name }} 复核通过，实赔 🪙{{ c.awarded_gold }} + 物资×{{ c.awarded_mat }}
          <template v-if="c.review_note">：{{ c.review_note }}</template>
        </p>
        <p class="c-review rejected" v-else-if="c.status === 'rejected'">
          ⛔ {{ c.reviewed_name }} 驳回<template v-if="c.review_note">：{{ c.review_note }}</template>
          （可修改后重新申报）
        </p>
        <p class="c-review need" v-else-if="c.status === 'need_evidence'">
          📎 {{ c.reviewed_name }} 要求补证：{{ c.review_note }}
        </p>

        <!-- 管理员复核区：待复核 && 不是自己的申报 -->
        <div class="review-box" v-if="c.status === 'pending' && store.canManage && c.created_by !== store.user?.id">
          <div class="r-row">
            <input v-model="reviewForms[c.id].note" class="f-input" placeholder="复核意见（驳回/补证时填写）" maxlength="100" />
          </div>
          <div class="r-row">
            <label>实赔 🪙<input v-model.number="reviewForms[c.id].gold" type="number" min="0" max="999" class="f-input sm" /></label>
            <label>物资 🧱<input v-model.number="reviewForms[c.id].mat" type="number" min="0" max="99" class="f-input sm" /></label>
            <button class="mini green" @click="doReview(c, 'approve')">✔ 通过</button>
            <button class="mini warn" @click="doReview(c, 'need_evidence')">📎 补证</button>
            <button class="mini danger" @click="doReview(c, 'reject')">✖ 驳回</button>
          </div>
        </div>
        <p class="c-review self" v-else-if="c.status === 'pending' && store.canManage">
          ⏳ 等待其他管理员/场主复核（不能审核自己的申报）
        </p>

        <!-- 申报人补证区 -->
        <div class="review-box" v-if="c.status === 'need_evidence' && c.created_by === store.user?.id">
          <div class="r-row">
            <input v-model="evidenceForms[c.id]" class="f-input" placeholder="补充证明材料（如损失明细、现场情况）" maxlength="200" />
            <button class="mini green" :disabled="!(evidenceForms[c.id] || '').trim()" @click="doSupplement(c)">📮 提交补证</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, computed, watch } from 'vue'
import { useGameStore } from '@/store/game'
const store = useGameStore()

const form = reactive({ eventId: '', category: 'crop', detail: '', qty: 1, gold: 50, mat: 0 })
const reviewForms = reactive({})
const evidenceForms = reactive({})

// 每条待复核申报预填实赔金额（默认按申请额，复核人可调整）
watch(() => store.claims, (list) => {
  for (const c of list) {
    if (!reviewForms[c.id]) reviewForms[c.id] = { note: '', gold: c.claim_gold, mat: c.claim_mat }
  }
}, { immediate: true })

const pendingCount = computed(() => store.claims.filter((c) => c.status === 'pending').length)
const canSubmit = computed(() =>
  store.can('claimSubmit') && form.eventId && form.category &&
  form.detail.trim() && (Number(form.gold) > 0 || Number(form.mat) > 0)
)

function catOf(key) {
  return store.claimCategories[key] || { name: key, icon: '📦' }
}
function stateLabel(s) {
  return { pending: '待复核', need_evidence: '待补证', approved: '已通过', rejected: '已驳回' }[s] || s
}

async function doSubmit() {
  const r = await store.submitClaim({
    eventId: Number(form.eventId), category: form.category,
    detail: form.detail, qty: form.qty, gold: form.gold, mat: form.mat
  })
  if (r) { form.detail = ''; form.qty = 1 }
}
async function doReview(c, action) {
  const f = reviewForms[c.id]
  await store.reviewClaim(c.id, action, { note: f.note, gold: f.gold, mat: f.mat })
}
async function doSupplement(c) {
  const text = (evidenceForms[c.id] || '').trim()
  if (!text) return
  const r = await store.supplementClaim(c.id, text)
  if (r) evidenceForms[c.id] = ''
}
</script>

<style scoped>
.page { display:grid;grid-template-columns:1fr 1.2fr;gap:16px; }
@media(max-width:760px){ .page{grid-template-columns:1fr;} }
.pcol { display:flex;flex-direction:column;gap:2px; }
.card { background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px; }
h4 { margin:0 0 8px;color:#fff;display:flex;gap:8px;align-items:center; }
.lvl { font-size:11px;color:#ffd54f; }
.queue-stat{font-size:12px;color:#aebadd;margin-bottom:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.tag { font-size:10px;color:#6f84ab;background:#16263f;padding:2px 6px;border-radius:4px; }
.tag.mine{color:#a5d6a7;background:#1b3a21;}
.tag.req{color:#ffd54f;background:#2d2814;}
.none { color:#5b6f94;text-align:center;padding:14px;font-size:12px; }
.hint { color:#5b6f94;font-size:10px;margin:8px 0 0;line-height:1.6; }
.hint b{color:#8ba2c8;}
.f-label{display:block;font-size:11px;color:#8ba2c8;margin:8px 0 4px;}
.f-select,.f-input,.f-text{background:#0c1730;border:1px solid rgba(120,160,220,0.25);border-radius:7px;color:#dbe4f3;padding:7px 9px;font-size:12px;width:100%;font-family:inherit;}
.f-text{resize:vertical;}
.f-input.sm{width:64px;padding:4px 6px;margin-left:4px;}
.f-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;}
.cat-pick{display:flex;gap:6px;}
.cat-pick button{flex:1;background:#16263f;border:1px solid rgba(120,160,220,0.2);color:#aebadd;border-radius:8px;padding:8px 4px;font-size:12px;cursor:pointer;}
.cat-pick button.active{background:linear-gradient(135deg,#1d3f8f,#2962ff);color:#fff;border-color:transparent;}
.wide { width:100%;margin-top:12px;background:#16263f;border:1px solid rgba(255,213,79,0.3);color:#ffd54f;border-radius:9px;padding:10px;font-size:13px;cursor:pointer; }
.wide.start{background:linear-gradient(135deg,#e65100,#f57c00);color:#fff;border:none;font-weight:600;}
.wide:disabled{background:#2a3a5e;color:#6f84ab;cursor:not-allowed;border:none;}
/* 申报记录 */
.claim{padding:10px 0;border-bottom:1px dashed rgba(120,160,220,0.1);}
.claim:last-child{border-bottom:none;}
.claim.rejected{opacity:.62;}
.c-head{display:flex;gap:8px;align-items:flex-start;}
.c-cat{font-size:20px;}
.c-title{flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:4px;align-items:center;}
.c-title b{color:#e8eefb;font-size:13px;width:100%;display:flex;align-items:center;flex-wrap:wrap;}
.c-state{font-size:10px;font-weight:400;margin-left:6px;padding:2px 6px;border-radius:4px;}
.c-state.pending{color:#90caf9;background:#122a47;}
.c-state.need_evidence{color:#ffcc80;background:#3a2a12;}
.c-state.approved{color:#a5d6a7;background:#1b3a21;}
.c-state.rejected{color:#8ba2c8;background:#23304a;}
.creator{font-size:10px;font-weight:400;color:#8ba2c8;margin-left:8px;white-space:nowrap;}
.live-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#4a5a78;margin-left:3px;vertical-align:middle;}
.live-dot.on{background:#66bb6a;box-shadow:0 0 4px #66bb6a;}
.c-detail{color:#c6d2e6;font-size:12px;margin:6px 0 2px;}
.c-evidence{color:#ce93d8;font-size:11px;margin:4px 0 2px;line-height:1.6;}
.c-review{font-size:11px;margin:6px 0 0;}
.c-review.approved{color:#a5d6a7;}
.c-review.rejected{color:#ef9a9a;}
.c-review.need{color:#ffcc80;}
.c-review.self{color:#6f84ab;}
.review-box{background:#0c1730;border:1px solid rgba(120,160,220,0.15);border-radius:8px;padding:8px;margin-top:8px;display:flex;flex-direction:column;gap:6px;}
.r-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
.r-row label{font-size:11px;color:#8ba2c8;display:flex;align-items:center;}
.mini { background:#2962ff;border:none;color:#fff;border-radius:7px;padding:6px 10px;font-size:12px;cursor:pointer; }
.mini.green { background:#43a047; }
.mini.warn { background:#ef6c00; }
.mini.danger { background:#c62828; }
.mini:disabled{background:#2a3a5e;color:#6f84ab;cursor:not-allowed;}
</style>
