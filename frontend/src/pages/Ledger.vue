<script setup lang="ts">
/**
 * `/ledger` 容量台账 —— 把营地容量做成带日期的占用账本。
 *
 * 对应值班室两个窗口同时放最后一间帐篷位的并发问题：
 *   - 按营地 + 入住日测算容量，留出两成应急余量，不足的批次 FIFO 排队；
 *   - 批次号幂等：同一批次重复提交只生效一次；
 *   - 登记携带营地版本：旧窗口保存时若容量 / 因子 / 否决已变化，保留表单并提示重新确认，不覆盖新容量；
 *   - 临时预占（hold）带 TTL 与心跳，窗口失联或到期自动释放；
 *   - 容量 / 营位因子 / 风险否决变化后批次立即失效（待重算），确认前不占容量、不进名次地图；
 *   - 旧入住（legacy）没有容量批次，列待确认、不挤占剩余名额。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useSiteStore } from '@/stores/siteStore'
import { useUiStore } from '@/stores/uiStore'
import { useLedgerStore, LedgerError } from '@/stores/ledgerStore'
import { BATCH_STATUS_META, HOLD_TTL_MS, type OccupancyBatch } from '@/types/ledger'
import { summarizeCapacity, holdRemainingSeconds, type CapacityView } from '@/utils/ledger'
import { todayIso } from '@/utils/format'

const router = useRouter()
const siteStore = useSiteStore()
const uiStore = useUiStore()
const ledger = useLedgerStore()

/* ------------------------------- 账本控制条 ------------------------------- */
const form = reactive({
  batchNo: '',
  teamName: '',
  contact: '',
  campName: '',
  siteId: null as number | null,
  checkInDate: todayIso(),
  tentCount: 2,
  campVersion: 1
})

/** 当前选中营地 / 入住日的容量视图（随秒针刷新，驱动预占倒计时与到期）。 */
const nowTick = ref(Date.now())
let tickTimer: number | null = null

const view = computed<CapacityView>(() =>
  summarizeCapacity(
    ledger.batches,
    siteStore.list,
    form.campName,
    form.checkInDate,
    uiStore.vetoedSiteIds,
    nowTick.value
  )
)

const campOptions = computed(() => siteStore.camps)
const siteOptions = computed(() =>
  siteStore.list
    .filter((s) => s.campName === form.campName && typeof s.id === 'number')
    .map((s) => ({ value: s.id as number, label: `${s.code} · ${s.name}` }))
)

function refreshCampVersion(): void {
  form.campVersion = ledger.campVersionOf(form.campName)
}

/* ------------------------------- 预占 / 提交 ------------------------------- */
const holdId = ref<number | null>(null)
const submitting = ref(false)

function handleError(err: unknown): void {
  if (err instanceof LedgerError) {
    if (err.code === 'VERSION_CONFLICT') {
      void ElMessageBox.alert(err.message, '容量版本已更新，请重新确认', {
        type: 'warning',
        confirmButtonText: '我知道了'
      })
    } else {
      ElMessage.warning(err.message)
    }
  } else {
    ElMessage.error(`操作失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

async function doPrehold(): Promise<void> {
  if (!form.campName) {
    ElMessage.warning('请选择营地')
    return
  }
  // 提交前再取一次最新版本，旧版本直接在此拦截并保留表单
  refreshCampVersion()
  submitting.value = true
  try {
    const hold = await ledger.prehold({
      batchNo: form.batchNo,
      teamName: form.teamName,
      contact: form.contact,
      campName: form.campName,
      siteId: form.siteId,
      checkInDate: form.checkInDate,
      tentCount: Number(form.tentCount),
      campVersion: form.campVersion
    })
    holdId.value = hold.id ?? null
    ElMessage.success(`已预占 ${Math.round(HOLD_TTL_MS / 1000)} 秒，请在到期前确认入住`)
  } catch (err) {
    // 版本冲突时同步最新版本号，表单内容（分队 / 帐篷数等）全部保留，便于重新确认提交
    if (err instanceof LedgerError && err.code === 'VERSION_CONFLICT') {
      refreshCampVersion()
    }
    handleError(err)
  } finally {
    submitting.value = false
  }
}

async function doConfirm(): Promise<void> {
  if (holdId.value == null) return
  submitting.value = true
  try {
    const { status } = await ledger.confirmHold(holdId.value)
    ElMessage.success(
      status === 'confirmed'
        ? '已确认入住，占用容量并进入名次地图'
        : '可分配容量不足，已进入排队，腾出名额后自动递进'
    )
    holdId.value = null
    form.batchNo = ledger.suggestBatchNo()
  } catch (err) {
    // 版本冲突时预占已置为待重算，表单保留，引导到列表重新确认
    if (err instanceof LedgerError && err.code === 'VERSION_CONFLICT') {
      refreshCampVersion()
    }
    handleError(err)
    holdId.value = null
  } finally {
    submitting.value = false
  }
}

async function doReleaseHold(): Promise<void> {
  if (holdId.value == null) return
  await ledger.releaseBatch(holdId.value)
  holdId.value = null
  ElMessage.info('已放弃预占，名额已释放')
}

/** 预占列表行内「确认」：携带该预占批次重新走分配。 */
async function doConfirmFromRow(row: OccupancyBatch): Promise<void> {
  if (typeof row.id !== 'number') return
  holdId.value = row.id
  await doConfirm()
}

/** 模拟窗口失联：释放本窗口名下全部预占。 */
async function simulateDisconnect(): Promise<void> {
  await ledger.releaseWindowHolds()
  holdId.value = null
  ElMessage.info('已模拟窗口失联，本窗口预占全部释放')
}

/* ------------------------------- 批次操作 ------------------------------- */
async function onReconfirm(id: number): Promise<void> {
  try {
    const status = await ledger.reconfirm(id)
    ElMessage.success(status === 'confirmed' ? '已重新确认入住' : '容量仍不足，已排队等待')
  } catch (err) {
    handleError(err)
  }
}

async function onRelease(id: number): Promise<void> {
  try {
    await ledger.releaseBatch(id)
    ElMessage.info('已释放该批次，腾出的名额将递进排队')
  } catch (err) {
    handleError(err)
  }
}

/* ------------------------------- 旧入住补登 ------------------------------- */
const legacyDialog = ref(false)
const legacyForm = reactive({ legacyId: 0, batchNo: '', teamName: '', contact: '' })

function openLegacy(b: OccupancyBatch): void {
  legacyForm.legacyId = b.id ?? 0
  legacyForm.batchNo = ledger.suggestBatchNo()
  legacyForm.teamName = b.teamName.startsWith('山野') ? '' : b.teamName
  legacyForm.contact = b.contact
  legacyDialog.value = true
}

async function submitLegacy(): Promise<void> {
  try {
    const status = await ledger.registerLegacy(legacyForm.legacyId, {
      batchNo: legacyForm.batchNo,
      teamName: legacyForm.teamName,
      contact: legacyForm.contact
    })
    legacyDialog.value = false
    ElMessage.success(
      status === 'confirmed'
        ? '旧入住已补登为正式批次并确认入住'
        : '旧入住已补登，当前容量不足已排队，腾出名额后自动确认'
    )
  } catch (err) {
    handleError(err)
  }
}

/* ------------------------------- 列表 ------------------------------- */
function listByStatus(status: OccupancyBatch['status']): OccupancyBatch[] {
  return ledger.batches
    .filter((b) => b.status === status)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

const holds = computed(() => listByStatus('hold'))
const confirmed = computed(() => listByStatus('confirmed'))
const queued = computed(() => listByStatus('queued'))
const stale = computed(() => listByStatus('stale'))
const legacy = computed(() => listByStatus('legacy'))

function metaOf(status: OccupancyBatch['status']) {
  return BATCH_STATUS_META[status]
}

function countdown(b: OccupancyBatch): number {
  return holdRemainingSeconds(b, nowTick.value)
}

/** 批次携带版本是否落后于营地当前版本（提示需重新确认）。 */
function isOutdated(b: OccupancyBatch): boolean {
  return b.campVersion < ledger.campVersionOf(b.campName)
}

/* ------------------------------- 生命周期 ------------------------------- */
onMounted(() => {
  // 容量视图注入（全局 App 已注入一次，这里再注入保证进入台账页即最新）
  ledger.setViewProvider((camp, date) =>
    summarizeCapacity(
      ledger.batches,
      siteStore.list,
      camp,
      date,
      uiStore.vetoedSiteIds,
      Date.now()
    )
  )
  if (!form.campName && campOptions.value.length) form.campName = campOptions.value[0]
  refreshCampVersion()
  if (!form.batchNo) form.batchNo = ledger.suggestBatchNo()

  // 仅驱动预占倒计时秒针；到期扫描 / 心跳 / 失联释放由 App 全局执行
  tickTimer = window.setInterval(() => {
    nowTick.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  if (tickTimer !== null) window.clearInterval(tickTimer)
})
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__title">
        <h1>容量台账</h1>
        <p>
          按营地与入住日管理帐篷位：留出两成应急余量，不足的批次排队，同一批次重复提交只生效一次；
          预占到期或窗口失联自动释放，容量 / 因子 / 否决变化后批次立即失效重算。
        </p>
      </div>
      <div class="page-actions">
        <el-button @click="simulateDisconnect">模拟窗口失联</el-button>
        <el-button @click="router.push('/')">返回名次表</el-button>
      </div>
    </div>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="并发占用规则"
      description="可分配容量 = 可用容量 × 80%（留出两成应急余量）；已确认批次占用容量，预占批次临时占位，排队 / 待重算 / 旧入住均不占剩余名额。批次号幂等，营地版本乐观锁防止旧窗口覆盖新容量。"
    />

    <section class="panel control-bar">
      <div class="control-bar__item">
        <span class="control-bar__label">入住日</span>
        <el-date-picker
          v-model="form.checkInDate"
          type="date"
          value-format="YYYY-MM-DD"
          style="width: 170px"
          @change="refreshCampVersion"
        />
      </div>
      <div class="control-bar__item">
        <span class="control-bar__label">营地</span>
        <el-select
          v-model="form.campName"
          placeholder="选择营地"
          style="width: 190px"
          @change="refreshCampVersion"
        >
          <el-option v-for="c in campOptions" :key="c" :label="c" :value="c" />
        </el-select>
      </div>
      <div class="control-bar__item">
        <span class="control-bar__label">营地版本</span>
        <el-tag type="info" effect="plain">v{{ form.campVersion }}</el-tag>
        <span class="weight-note">随容量 / 因子 / 否决变化递增</span>
      </div>
      <div class="control-bar__item">
        <span class="control-bar__label">本窗口</span>
        <el-tag type="info" effect="plain" size="small">{{ ledger.windowId }}</el-tag>
      </div>
    </section>

    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-card__label">物理容量</div>
        <div class="stat-card__value">{{ view.physical }}</div>
        <div class="stat-card__extra">否决营位占用 {{ view.vetoed }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">应急余量（两成）</div>
        <div class="stat-card__value" style="color: #d97706">{{ view.reserve }}</div>
        <div class="stat-card__extra">不可动用</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">可分配容量</div>
        <div class="stat-card__value">{{ view.bookable }}</div>
        <div class="stat-card__extra">可用 {{ view.usable }} × 80%</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">已确认占用</div>
        <div class="stat-card__value">{{ view.confirmed }}</div>
        <div class="stat-card__extra">预占中 {{ view.held }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">剩余可订</div>
        <div class="stat-card__value" :style="{ color: view.remaining ? '#15803d' : '#b91c1c' }">
          {{ view.remaining }}
        </div>
        <div class="stat-card__extra">排队 {{ view.queued }} · 待重算 {{ view.stale }}</div>
      </div>
    </div>

    <div class="ledger-layout">
      <!-- 登记入住 -->
      <section class="panel">
        <div class="panel__head">
          <h2>登记入住批次</h2>
          <span class="weight-note">预占 {{ Math.round(HOLD_TTL_MS / 1000) }} 秒，到期 / 失联自动释放</span>
        </div>
        <el-form label-width="100px" @submit.prevent>
          <el-form-item label="批次号">
            <el-input v-model="form.batchNo" placeholder="如 PC-0002（幂等键，重复提交只生效一次）" />
          </el-form-item>
          <el-form-item label="分队名称">
            <el-input v-model="form.teamName" placeholder="如 亲子露营团" />
          </el-form-item>
          <el-form-item label="联系人 / 窗口">
            <el-input v-model="form.contact" placeholder="如 王领队 / 1 号窗口" />
          </el-form-item>
          <el-form-item label="营地">
            <el-select v-model="form.campName" placeholder="选择营地" style="width: 100%" @change="refreshCampVersion">
              <el-option v-for="c in campOptions" :key="c" :label="c" :value="c" />
            </el-select>
          </el-form-item>
          <el-form-item label="入住日">
            <el-date-picker
              v-model="form.checkInDate"
              type="date"
              value-format="YYYY-MM-DD"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="意向营位">
            <el-select v-model="form.siteId" placeholder="营地级分配（可空）" clearable style="width: 100%">
              <el-option v-for="s in siteOptions" :key="s.value" :label="s.label" :value="s.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="帐篷数">
            <el-input-number v-model="form.tentCount" :min="1" :max="60" controls-position="right" style="width: 100%" />
          </el-form-item>
          <el-form-item>
            <el-button type="warning" :loading="submitting" :disabled="holdId != null" @click="doPrehold">
              预占名额
            </el-button>
            <el-button type="primary" :disabled="holdId == null" @click="doConfirm">确认入住</el-button>
            <el-button :disabled="holdId == null" @click="doReleaseHold">放弃预占</el-button>
          </el-form-item>
        </el-form>

        <div v-if="holdId != null" class="hold-tip">
          <el-tag type="warning" effect="plain">预占中</el-tag>
          <span>名额已临时冻结，请在倒计时内确认；到期或窗口失联将自动释放。</span>
        </div>
      </section>

      <!-- 批次列表 -->
      <section class="panel">
        <el-tabs>
          <el-tab-pane :label="`预占中 (${holds.length})`">
            <BatchTable
              :rows="holds"
              :meta-of="metaOf"
              :now="nowTick"
              :countdown-of="countdown"
              :is-outdated="isOutdated"
              empty-text="没有进行中的预占。预占到期或窗口失联会自动释放。"
            >
              <template #actions="{ row }">
                <el-button size="small" type="primary" @click="doConfirmFromRow(row)">确认</el-button>
                <el-button size="small" @click="onRelease(row.id)">放弃</el-button>
              </template>
            </BatchTable>
          </el-tab-pane>

          <el-tab-pane :label="`已确认 (${confirmed.length})`">
            <BatchTable
              :rows="confirmed"
              :meta-of="metaOf"
              :now="nowTick"
              :is-outdated="isOutdated"
              empty-text="暂无已确认入住。确认后占用容量并进入名次地图。"
            >
              <template #actions="{ row }">
                <el-button size="small" text type="danger" @click="onRelease(row.id)">取消入住</el-button>
              </template>
            </BatchTable>
          </el-tab-pane>

          <el-tab-pane :label="`排队中 (${queued.length})`">
            <BatchTable
              :rows="queued"
              :meta-of="metaOf"
              :now="nowTick"
              :is-outdated="isOutdated"
              empty-text="没有排队批次。可分配容量不足时新批次自动进入排队，腾出名额按 FIFO 递进。"
            >
              <template #actions="{ row }">
                <el-button size="small" text type="danger" @click="onRelease(row.id)">取消排队</el-button>
              </template>
            </BatchTable>
          </el-tab-pane>

          <el-tab-pane :label="`待重算 (${stale.length})`">
            <BatchTable
              :rows="stale"
              :meta-of="metaOf"
              :now="nowTick"
              :is-outdated="isOutdated"
              empty-text="没有待重算批次。容量 / 营位因子 / 风险否决变化后，相关批次会立即失效并在此等待重新确认。"
            >
              <template #actions="{ row }">
                <el-button size="small" type="primary" @click="onReconfirm(row.id)">重新确认</el-button>
                <el-button size="small" text type="danger" @click="onRelease(row.id)">放弃</el-button>
              </template>
            </BatchTable>
          </el-tab-pane>

          <el-tab-pane :label="`旧入住待确认 (${legacy.length})`">
            <BatchTable
              :rows="legacy"
              :meta-of="metaOf"
              :now="nowTick"
              :is-outdated="isOutdated"
              empty-text="没有旧入住。开台账前的纸质 / 口头入住会列在这里，补登后才占用容量。"
            >
              <template #actions="{ row }">
                <el-button size="small" type="primary" @click="openLegacy(row)">补登批次</el-button>
              </template>
            </BatchTable>
          </el-tab-pane>
        </el-tabs>
      </section>
    </div>

    <!-- 旧入住补登 -->
    <el-dialog v-model="legacyDialog" title="补登旧入住为容量批次" width="460px">
      <el-form label-width="100px">
        <el-form-item label="批次号">
          <el-input v-model="legacyForm.batchNo" />
        </el-form-item>
        <el-form-item label="分队名称">
          <el-input v-model="legacyForm.teamName" placeholder="如 山野徒步队" />
        </el-form-item>
        <el-form-item label="联系人 / 窗口">
          <el-input v-model="legacyForm.contact" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="legacyDialog = false">取消</el-button>
        <el-button type="primary" @click="submitLegacy">提交补登</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script lang="ts">
import { defineComponent, h, type PropType } from 'vue'
import type { BatchStatusMeta } from '@/types/ledger'

/** 批次表格：内联小组件，避免五个 tab 重复写列。 */
const BatchTable = defineComponent({
  name: 'BatchTable',
  props: {
    rows: { type: Array as PropType<OccupancyBatch[]>, required: true },
    metaOf: {
      type: Function as PropType<(s: OccupancyBatch['status']) => BatchStatusMeta>,
      required: true
    },
    now: { type: Number, required: true },
    countdownOf: {
      type: Function as PropType<(b: OccupancyBatch) => number>,
      default: null
    },
    isOutdated: { type: Function as PropType<(b: OccupancyBatch) => boolean>, required: true },
    emptyText: { type: String, default: '暂无记录' }
  },
  setup(props, { slots }) {
    return () =>
      props.rows.length === 0
        ? h('p', { class: 'panel__hint', style: 'margin:0' }, props.emptyText)
        : h(
            'el-table',
            { data: props.rows, size: 'small', border: true, stripe: true },
            {
              default: () => [
                h('el-table-column', {
                  label: '批次号',
                  width: 110,
                  default: ({ row }: { row: OccupancyBatch }) =>
                    h('span', { class: 'batch-no' }, row.batchNo)
                }),
                h('el-table-column', {
                  label: '状态',
                  width: 110,
                  default: ({ row }: { row: OccupancyBatch }) =>
                    h(
                      'el-tag',
                      { type: props.metaOf(row.status).type, size: 'small' },
                      () => props.metaOf(row.status).label
                    )
                }),
                h('el-table-column', { prop: 'teamName', label: '分队', minWidth: 140 }),
                h('el-table-column', { prop: 'contact', label: '联系人', width: 110 }),
                h('el-table-column', { prop: 'campName', label: '营地', width: 150 }),
                h('el-table-column', { prop: 'checkInDate', label: '入住日', width: 112 }),
                h('el-table-column', { prop: 'tentCount', label: '帐篷', width: 70, align: 'center' }),
                h('el-table-column', {
                  label: '版本',
                  width: 120,
                  default: ({ row }: { row: OccupancyBatch }) =>
                    h('span', {}, [
                      h('span', { class: 'weight-note' }, `v${row.campVersion}`),
                      props.isOutdated(row)
                        ? h(
                            'el-tag',
                            { type: 'danger', size: 'small', style: 'margin-left:6px' },
                            () => '需重算'
                          )
                        : null
                    ])
                }),
                h('el-table-column', {
                  label: '预占到期',
                  width: 110,
                  default: ({ row }: { row: OccupancyBatch }) => {
                    if (row.status !== 'hold') return h('span', { class: 'muted' }, '—')
                    const secs = props.countdownOf ? props.countdownOf(row) : 0
                    return h(
                      'span',
                      { class: secs <= 10 ? 'hold-countdown is-soon' : 'hold-countdown' },
                      `${secs}s`
                    )
                  }
                }),
                h('el-table-column', {
                  label: '失效原因',
                  minWidth: 160,
                  default: ({ row }: { row: OccupancyBatch }) =>
                    row.invalidateReason
                      ? h('span', { class: 'muted' }, row.invalidateReason)
                      : h('span', { class: 'muted' }, '—')
                }),
                h('el-table-column', {
                  label: '操作',
                  width: 170,
                  fixed: 'right',
                  default: ({ row }: { row: OccupancyBatch }) =>
                    slots.actions ? slots.actions({ row }) : null
                })
              ]
            }
          )
  }
})

export default { components: { BatchTable } }
</script>
<style scoped>
.control-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 16px 28px;
  align-items: center;
  padding: 14px 18px;
  margin-bottom: 14px;
}
.control-bar__item {
  display: flex;
  align-items: center;
  gap: 8px;
}
.control-bar__label {
  font-size: 13px;
  color: var(--gb-muted);
}
.ledger-layout {
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.3fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 1180px) {
  .ledger-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
.hold-tip {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding: 8px 12px;
  font-size: 12px;
  color: #92400e;
  background: #fff8e6;
  border: 1px solid #f5e0ae;
  border-radius: 8px;
}
.batch-no {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--gb-accent-strong);
}
.hold-countdown {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  color: #d97706;
}
.hold-countdown.is-soon {
  color: #b91c1c;
}
.muted {
  color: var(--gb-muted);
  font-size: 12px;
}
</style>
