<script setup lang="ts">
/**
 * `/occupancy` 容量账本 —— 按营地与入住日扣除两成应急余量。
 * 同一批次重复提交幂等；旧窗口携带旧版本保存时保留表单并要求重新确认。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useSiteStore } from '@/stores/siteStore'
import { useUiStore } from '@/stores/uiStore'
import { useOccupancyStore } from '@/stores/occupancyStore'
import { OccupancyConflictError } from '@/utils/occupancy'
import {
  OCCUPANCY_STATUS_LABELS,
  OCCUPANCY_STATUS_TYPES,
  availableTents,
  reservedTents,
  type OccupancyStatus,
  type OccupancyVersions
} from '@/types/occupancy'
import { formatDate, formatDateTime, todayIso } from '@/utils/format'

const router = useRouter()
const siteStore = useSiteStore()
const uiStore = useUiStore()
const occupancyStore = useOccupancyStore()

const form = reactive({
  campName: '',
  stayDate: todayIso(),
  batchNo: '',
  tentCount: 1,
  contact: '',
  note: ''
})
const formVersions = ref<OccupancyVersions | null>(null)
const submitting = ref(false)
const holding = ref(false)
const conflictText = ref('')
const ledgerCamp = ref('')
const ledgerDate = ref(todayIso())

const camps = computed(() => siteStore.camps)

function captureVersions(campName = form.campName): void {
  formVersions.value = campName ? occupancyStore.versionOf(campName) : null
  conflictText.value = ''
}

watch(
  () => form.campName,
  (campName) => captureVersions(campName)
)

const formSummary = computed(() =>
  form.campName && form.stayDate ? occupancyStore.summaryOf(form.campName, form.stayDate) : null
)
const formCapacity = computed(() => {
  const sites = siteStore.list.filter(
    (s) => s.campName === form.campName && (typeof s.id !== 'number' || !uiStore.isVetoed(s.id))
  )
  return sites.reduce((sum, s) => sum + s.tentCapacity, 0)
})
const formRemaining = computed(() => formSummary.value?.remaining ?? availableTents(formCapacity.value))

function validate(): boolean {
  if (!form.campName) {
    ElMessage.warning('请选择营地')
    return false
  }
  if (!form.stayDate) {
    ElMessage.warning('请选择入住日期')
    return false
  }
  if (!form.batchNo.trim()) {
    ElMessage.warning('请填写分队/批次号')
    return false
  }
  if (form.tentCount <= 0) {
    ElMessage.warning('帐篷数必须大于 0')
    return false
  }
  return true
}

function payload() {
  return {
    campName: form.campName,
    stayDate: form.stayDate,
    batchNo: form.batchNo,
    tentCount: Number(form.tentCount),
    contact: form.contact,
    note: form.note
  }
}

async function submit(): Promise<void> {
  if (!validate()) return
  submitting.value = true
  try {
    const result = await occupancyStore.submit(payload(), formVersions.value)
    ElMessage.success(result.message)
    if (!result.duplicated) {
      form.batchNo = ''
      form.tentCount = 1
      form.note = ''
    }
    captureVersions()
  } catch (err) {
    if (err instanceof OccupancyConflictError) {
      formVersions.value = err.versions
      conflictText.value = `${err.message}。表单内容已保留，请核对最新剩余名额后重新提交。`
      ElMessage.warning('营地容量已变化，请重新确认')
    } else {
      ElMessage.error(err instanceof Error ? err.message : String(err))
    }
  } finally {
    submitting.value = false
  }
}

async function hold(): Promise<void> {
  if (!validate()) return
  holding.value = true
  try {
    const result = await occupancyStore.hold(payload(), formVersions.value)
    ElMessage.success(result.message)
    captureVersions()
  } catch (err) {
    if (err instanceof OccupancyConflictError) {
      formVersions.value = err.versions
      conflictText.value = `${err.message}。临时预占未生效，表单内容已保留，请重新确认。`
      ElMessage.warning('营地容量已变化，请重新确认')
    } else {
      ElMessage.error(err instanceof Error ? err.message : String(err))
    }
  } finally {
    holding.value = false
  }
}

const ledgerRows = computed(() =>
  occupancyStore.activeBatches
    .filter((b) => (!ledgerCamp.value || b.campName === ledgerCamp.value))
    .filter((b) => (!ledgerDate.value || b.stayDate === ledgerDate.value))
)

const ledgerSummary = computed(() =>
  ledgerCamp.value && ledgerDate.value
    ? occupancyStore.summaryOf(ledgerCamp.value, ledgerDate.value)
    : null
)

const summaries = computed(() => Array.from(occupancyStore.summaryMap.values()))

async function confirmRow(id: number | undefined): Promise<void> {
  if (typeof id !== 'number') return
  await occupancyStore.confirm(id)
  ElMessage.success('预占已确认')
}

async function reconfirmRow(id: number | undefined): Promise<void> {
  if (typeof id !== 'number') return
  try {
    await occupancyStore.reconfirm(id)
    ElMessage.success('已按最新容量重新计算')
  } catch (err) {
    if (err instanceof OccupancyConflictError) ElMessage.warning(err.message)
    else ElMessage.error(err instanceof Error ? err.message : String(err))
  }
}

async function releaseRow(id: number | undefined): Promise<void> {
  if (typeof id !== 'number') return
  await occupancyStore.release(id)
  ElMessage.success('名额已释放')
}

function useRowForForm(row: {
  campName: string
  stayDate: string
  batchNo: string
  tentCount: number
  contact: string
  note: string
}): void {
  Object.assign(form, {
    campName: row.campName,
    stayDate: row.stayDate,
    batchNo: row.batchNo,
    tentCount: row.tentCount,
    contact: row.contact,
    note: row.note
  })
  ledgerCamp.value = row.campName
  ledgerDate.value = row.stayDate
  captureVersions(row.campName)
}

function statusTag(status: OccupancyStatus): 'primary' | 'success' | 'warning' | 'info' | 'danger' {
  return OCCUPANCY_STATUS_TYPES[status]
}
function statusLabel(status: OccupancyStatus): string {
  return OCCUPANCY_STATUS_LABELS[status]
}

function countdown(row: { status: OccupancyStatus; expiresAt: string | null }): string {
  if (row.status !== 'held' || !row.expiresAt) return '—'
  const left = Date.parse(row.expiresAt) - occupancyStore.clock
  return left > 0 ? `${Math.ceil(left / 1000)} 秒` : '释放中'
}

const stats = computed(() => ({
  active: occupancyStore.totalActive,
  pending: occupancyStore.totalPending,
  queued: occupancyStore.activeBatches.filter((b) => b.status === 'queued').length,
  held: occupancyStore.activeBatches.filter((b) => b.status === 'held').length
}))
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__title">
        <h1>入住容量账本</h1>
        <p>
          按「营地 + 入住日」扣除两成应急余量后确认名额；容量不足自动排队。
          同一批次重复提交只生效一次，待确认批次不挤占剩余名额，也不进入名次和地图。
        </p>
      </div>
      <div class="page-actions">
        <el-button @click="router.push('/')">返回名次表</el-button>
        <el-button @click="router.push('/map')">看地图</el-button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-card__label">活动批次</div>
        <div class="stat-card__value">{{ stats.active }}</div>
        <div class="stat-card__extra">含确认、预占、排队与待确认</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">待确认</div>
        <div class="stat-card__value" :style="{ color: stats.pending ? '#92400e' : undefined }">
          {{ stats.pending }}
        </div>
        <div class="stat-card__extra">不占用名额</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">排队批次</div>
        <div class="stat-card__value" :style="{ color: stats.queued ? '#b45309' : undefined }">
          {{ stats.queued }}
        </div>
        <div class="stat-card__extra">有释放后自动递补</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">临时预占</div>
        <div class="stat-card__value">{{ stats.held }}</div>
        <div class="stat-card__extra">90 秒心跳，失联自动释放</div>
      </div>
    </div>

    <section class="panel register-panel">
      <div class="panel__head">
        <h2>分队入住登记</h2>
        <span class="weight-note">
          登记版本：
          <template v-if="formVersions">
            容量 v{{ formVersions.capacityVersion }} / 因子 v{{ formVersions.factorVersion }} / 否决
            v{{ formVersions.vetoVersion }}
          </template>
          <template v-else>选择营地后锁定</template>
        </span>
      </div>

      <el-alert
        v-if="conflictText"
        type="warning"
        show-icon
        :closable="true"
        :title="conflictText"
        @close="conflictText = ''"
      />

      <el-form label-width="112px" @submit.prevent>
        <div class="form-grid">
          <el-form-item label="营地">
            <el-select v-model="form.campName" filterable placeholder="选择营地" style="width: 100%">
              <el-option v-for="c in camps" :key="c" :label="c" :value="c" />
            </el-select>
          </el-form-item>
          <el-form-item label="入住日期">
            <el-date-picker
              v-model="form.stayDate"
              type="date"
              value-format="YYYY-MM-DD"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="分队/批次号">
            <el-input v-model="form.batchNo" placeholder="如 三队-02、20261004-A" />
          </el-form-item>
          <el-form-item label="帐篷数">
            <el-input-number v-model="form.tentCount" :min="1" :max="200" style="width: 100%" />
          </el-form-item>
          <el-form-item label="负责人">
            <el-input v-model="form.contact" placeholder="值班室联系人" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="form.note" placeholder="可填写到达时间等" />
          </el-form-item>
        </div>

        <div class="capacity-strip">
          <span>总容量 <strong>{{ formCapacity }}</strong> 顶</span>
          <span>应急余量 <strong>{{ reservedTents(formCapacity) }}</strong> 顶（20%）</span>
          <span>可登记容量 <strong>{{ availableTents(formCapacity) }}</strong> 顶</span>
          <span>当前剩余 <strong :class="{ danger: formRemaining < 0 }">{{ formRemaining }}</strong> 顶</span>
          <span v-if="formSummary">
            已确认 {{ formSummary.confirmedTents }} · 预占 {{ formSummary.heldTents }} · 排队
            {{ formSummary.queuedBatches }} 批 · 待确认 {{ formSummary.pendingBatches }} 批
          </span>
        </div>

        <el-form-item>
          <el-button type="primary" :loading="submitting" @click="submit">确认登记</el-button>
          <el-button :loading="holding" @click="hold">临时预占 90 秒</el-button>
          <span class="weight-note">重复提交同一营地、日期、批次号不会重复占名额。</span>
        </el-form-item>
      </el-form>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>按日期查账</h2>
        <div class="filters">
          <el-select v-model="ledgerCamp" clearable placeholder="全部营地" style="width: 190px">
            <el-option v-for="c in camps" :key="c" :label="c" :value="c" />
          </el-select>
          <el-date-picker
            v-model="ledgerDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="入住日期"
            style="width: 170px"
          />
        </div>
      </div>

      <div v-if="ledgerSummary" class="ledger-summary">
        <span>营地：<strong>{{ ledgerSummary.campName }}</strong></span>
        <span>{{ formatDate(ledgerSummary.stayDate) }}</span>
        <span>总容量 {{ ledgerSummary.capacity }}</span>
        <span>应急余量 {{ ledgerSummary.reserved }}</span>
        <span>可用 {{ ledgerSummary.available }}</span>
        <span class="ok">已确认 {{ ledgerSummary.confirmedTents }}</span>
        <span>预占 {{ ledgerSummary.heldTents }}</span>
        <span class="warn">剩余 {{ ledgerSummary.remaining }}</span>
        <span class="muted">待确认 {{ ledgerSummary.pendingBatches }} 批（{{ ledgerSummary.pendingTents }} 顶）</span>
      </div>

      <el-table v-if="ledgerRows.length" :data="ledgerRows" size="small" border stripe>
        <el-table-column label="状态" width="104">
          <template #default="{ row }">
            <el-tag :type="statusTag(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="campName" label="营地" min-width="150" />
        <el-table-column label="入住日" width="110">
          <template #default="{ row }">{{ formatDate(row.stayDate) }}</template>
        </el-table-column>
        <el-table-column prop="batchNo" label="批次号" min-width="140" />
        <el-table-column prop="tentCount" label="申请/占用" width="100" align="right">
          <template #default="{ row }">
            {{ row.tentCount }} / {{ row.status === 'confirmed' || row.status === 'held' ? row.occupiedTents : 0 }}
          </template>
        </el-table-column>
        <el-table-column label="排队" width="70" align="center">
          <template #default="{ row }">{{ row.queuePosition || '—' }}</template>
        </el-table-column>
        <el-table-column label="倒计时" width="88" align="center">
          <template #default="{ row }">{{ countdown(row) }}</template>
        </el-table-column>
        <el-table-column prop="contact" label="负责人" width="100" />
        <el-table-column label="登记版本" width="170">
          <template #default="{ row }">
            <span class="version-text">
              {{ row.capacityVersion ?? '旧' }} / {{ row.factorVersion ?? '旧' }} /
              {{ row.vetoVersion ?? '旧' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="142">
          <template #default="{ row }">{{ formatDateTime(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="245" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'held' && row.ownerId === occupancyStore.ownerId"
              size="small"
              type="success"
              text
              @click="confirmRow(row.id)"
            >
              确认
            </el-button>
            <el-button
              v-if="row.status === 'needs_confirmation' || row.status === 'queued'"
              size="small"
              type="primary"
              text
              @click="reconfirmRow(row.id)"
            >
              重新确认
            </el-button>
            <el-button size="small" text @click="useRowForForm(row)">带入表单</el-button>
            <el-button
              v-if="row.status !== 'released' && row.status !== 'expired'"
              size="small"
              type="danger"
              text
              @click="releaseRow(row.id)"
            >
              释放
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <p v-else class="panel__hint">当前筛选条件下还没有入住批次。</p>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>各营地日期汇总</h2>
        <span class="weight-note">待确认旧入住不挤占剩余名额</span>
      </div>
      <el-table v-if="summaries.length" :data="summaries" size="small" border>
        <el-table-column prop="campName" label="营地" min-width="160" />
        <el-table-column label="入住日" width="118">
          <template #default="{ row }">{{ formatDate(row.stayDate) }}</template>
        </el-table-column>
        <el-table-column prop="capacity" label="总容量" width="80" align="right" />
        <el-table-column prop="reserved" label="20%余量" width="90" align="right" />
        <el-table-column prop="available" label="可登记" width="80" align="right" />
        <el-table-column prop="confirmedTents" label="已确认" width="80" align="right" />
        <el-table-column prop="heldTents" label="预占" width="70" align="right" />
        <el-table-column label="剩余" width="80" align="right">
          <template #default="{ row }">
            <strong :class="{ danger: row.remaining < 0 }">{{ row.remaining }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="待确认" width="90" align="right">
          <template #default="{ row }">{{ row.pendingBatches }} 批 / {{ row.pendingTents }} 顶</template>
        </el-table-column>
        <el-table-column label="排队" width="80" align="right">
          <template #default="{ row }">{{ row.queuedBatches }} 批</template>
        </el-table-column>
      </el-table>
      <p v-else class="panel__hint">暂无容量账本数据。</p>
    </section>
  </div>
</template>

<style scoped>
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 0 18px;
}
.capacity-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  padding: 10px 12px;
  margin-bottom: 14px;
  font-size: 13px;
  color: var(--gb-muted);
  background: var(--gb-surface);
  border-radius: 8px;
}
.capacity-strip strong {
  color: var(--gb-ink);
  font-variant-numeric: tabular-nums;
}
.capacity-strip .danger,
.danger {
  color: #b91c1c;
}
.ledger-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-bottom: 12px;
  padding: 10px 12px;
  font-size: 13px;
  background: #f8faf8;
  border: 1px solid var(--gb-line);
  border-radius: 8px;
}
.ok {
  color: #15803d;
}
.warn {
  color: #b45309;
}
.muted {
  color: var(--gb-muted);
}
.version-text {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
</style>
