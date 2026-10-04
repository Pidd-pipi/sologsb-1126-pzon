/**
 * 容量台账状态：入住批次的生命周期、营地版本、预占到期、排队递进与失效重算。
 *
 * 并发约定（对应值班室两个窗口同时放最后一间帐篷位）：
 *   - 批次号幂等：同一 batchNo 重复提交只生效一次；
 *   - 营地版本乐观锁：表单携带 campVersion，提交时若营地容量 / 因子 / 否决已变化导致版本递增，
 *     拒绝写入并由页面保留表单、提示重新确认，绝不覆盖新容量；
 *   - 临时预占（hold）带 TTL 与心跳：窗口失联或到期自动释放，腾出的名额按 FIFO 递进排队；
 *   - 容量 / 营位因子 / 风险否决变化 → bumpCampVersion，相关批次立即置 stale，重新确认前不占容量。
 *
 * 容量数值（剩余 / 应急余量）由页面通过 setViewProvider 注入（基于 siteStore + uiStore 实时算出），
 * store 不反向依赖 siteStore / uiStore，避免循环引用。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, toPlain } from '@/utils/db'
import type { CampMeta, OccupancyBatch } from '@/types/ledger'
import { HOLD_TTL_MS } from '@/types/ledger'
import {
  decideStatus,
  isHoldExpired,
  nextBatchNo,
  type CapacityView
} from '@/utils/ledger'
import { nowIso } from '@/utils/format'

export type LedgerErrorCode = 'DUP_BATCH' | 'VERSION_CONFLICT' | 'NOT_FOUND' | 'VALIDATION'

export class LedgerError extends Error {
  code: LedgerErrorCode
  constructor(code: LedgerErrorCode, message: string) {
    super(message)
    this.name = 'LedgerError'
    this.code = code
  }
}

/** 预占 / 补登表单入参 */
export interface HoldInput {
  batchNo: string
  campName: string
  siteId: number | null
  teamName: string
  contact: string
  checkInDate: string
  tentCount: number
  campVersion: number
  note?: string
}

type ViewProvider = (campName: string, date: string) => CapacityView

const WINDOW_KEY = 'gbcampsite:window-id'

/** 每个标签页会话一个窗口标识，用于失联时只释放本窗口的预占。 */
function getWindowId(): string {
  try {
    let id = window.sessionStorage.getItem(WINDOW_KEY)
    if (!id) {
      id = `w_${Math.random().toString(36).slice(2, 10)}`
      window.sessionStorage.setItem(WINDOW_KEY, id)
    }
    return id
  } catch {
    return 'w_unknown'
  }
}

export const useLedgerStore = defineStore('ledger', () => {
  const batches = ref<OccupancyBatch[]>([])
  const campMeta = ref<CampMeta[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const windowId = ref(getWindowId())

  const viewProvider = ref<ViewProvider | null>(null)
  function setViewProvider(fn: ViewProvider): void {
    viewProvider.value = fn
  }
  function viewFor(campName: string, date: string): CapacityView {
    if (viewProvider.value) return viewProvider.value(campName, date)
    return {
      physical: 0,
      vetoed: 0,
      usable: 0,
      reserve: 0,
      bookable: 0,
      confirmed: 0,
      held: 0,
      queued: 0,
      stale: 0,
      legacy: 0,
      remaining: 0
    }
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      batches.value = await db.batches.orderBy('id').toArray()
      campMeta.value = await db.campMeta.toArray()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /** 取营地版本；无记录时惰性建为 v1。 */
  async function ensureMeta(campName: string): Promise<CampMeta> {
    const existing = await db.campMeta.get(campName)
    if (existing) return existing
    const meta: CampMeta = { campName, version: 1, capacityUpdatedAt: nowIso() }
    await db.campMeta.put(meta)
    campMeta.value.push(meta)
    return meta
  }

  function campVersionOf(campName: string): number {
    return campMeta.value.find((m) => m.campName === campName)?.version ?? 1
  }

  /** 批次号建议（PC-0001…）。 */
  function suggestBatchNo(): string {
    return nextBatchNo(batches.value.map((b) => b.batchNo))
  }

  function findBatch(id: number | undefined): OccupancyBatch | undefined {
    return batches.value.find((b) => b.id === id)
  }

  /** 幂等：同一批次号是否已有未终结记录。 */
  function findActiveByBatchNo(batchNo: string): OccupancyBatch | undefined {
    const key = batchNo.trim()
    return batches.value.find(
      (b) => b.batchNo === key && b.status !== 'released' && b.status !== 'legacy'
    )
  }

  /**
   * 营地容量 / 因子 / 否决变化后调用：版本号 +1，相关批次立即置 stale。
   * stale 批次不占容量、不进名次地图，需重新确认。
   */
  async function bumpCampVersion(campName: string, reason: string): Promise<void> {
    if (!campName) return
    const meta = await ensureMeta(campName)
    const next = meta.version + 1
    const now = nowIso()
    await db.campMeta.put({ campName, version: next, capacityUpdatedAt: now })
    const targets = batches.value.filter(
      (b) =>
        b.campName === campName &&
        (b.status === 'hold' || b.status === 'confirmed' || b.status === 'queued')
    )
    for (const b of targets) {
      if (typeof b.id !== 'number') continue
      await db.batches.update(b.id, {
        status: 'stale',
        campVersion: next,
        holdExpiresAt: null,
        lastHeartbeatAt: null,
        invalidatedAt: now,
        invalidateReason: reason,
        updatedAt: now
      })
    }
    await load()
  }

  /** 预占名额（hold，带 TTL）。幂等 + 版本乐观锁在此拦截。 */
  async function prehold(input: HoldInput): Promise<OccupancyBatch> {
    const batchNo = input.batchNo.trim()
    if (!batchNo) throw new LedgerError('VALIDATION', '批次号不能为空')
    if (!input.campName.trim()) throw new LedgerError('VALIDATION', '请选择营地')
    if (!input.checkInDate) throw new LedgerError('VALIDATION', '请选择入住日')
    if (!input.tentCount || input.tentCount <= 0) {
      throw new LedgerError('VALIDATION', '帐篷数必须大于 0')
    }
    const dup = findActiveByBatchNo(batchNo)
    if (dup) {
      throw new LedgerError(
        'DUP_BATCH',
        `批次号 ${batchNo} 已提交（当前状态：${dup.status}），同一批次重复提交只生效一次。`,
      )
    }
    const current = campVersionOf(input.campName)
    if (input.campVersion !== current) {
      throw new LedgerError(
        'VERSION_CONFLICT',
        `营地「${input.campName}」容量版本已更新（v${input.campVersion} → v${current}），` +
          `表单内容已保留，请核对最新容量后重新确认提交。`,
      )
    }

    const now = nowIso()
    const record = toPlain({
      batchNo,
      campName: input.campName.trim(),
      siteId: input.siteId,
      teamName: input.teamName.trim() || '未署名分队',
      contact: input.contact.trim() || '未署名窗口',
      checkInDate: input.checkInDate,
      tentCount: Number(input.tentCount),
      status: 'hold' as const,
      campVersion: current,
      windowId: windowId.value,
      holdExpiresAt: new Date(Date.now() + HOLD_TTL_MS).toISOString(),
      lastHeartbeatAt: now,
      confirmedAt: null,
      invalidatedAt: null,
      invalidateReason: '',
      legacy: false,
      note: input.note?.trim() ?? '',
      createdAt: now,
      updatedAt: now
    }) as OccupancyBatch
    const id = await db.batches.add(record)
    await load()
    return { ...record, id }
  }

  /** 确认入住：重新校验版本后分配容量，不足则排队。 */
  async function confirmHold(id: number): Promise<{ batch: OccupancyBatch; status: 'confirmed' | 'queued' }> {
    const batch = findBatch(id)
    if (!batch) throw new LedgerError('NOT_FOUND', '预占记录不存在或已被释放')
    const current = campVersionOf(batch.campName)
    const now = nowIso()
    if (batch.campVersion !== current) {
      // 容量在预占期间变化：置 stale，保留表单提示重新确认，不覆盖新容量
      await db.batches.update(id, {
        status: 'stale',
        campVersion: current,
        holdExpiresAt: null,
        lastHeartbeatAt: null,
        invalidatedAt: now,
        invalidateReason: '预占期间营地容量版本已更新，需重新确认',
        updatedAt: now
      })
      await load()
      throw new LedgerError(
        'VERSION_CONFLICT',
        `营地「${batch.campName}」容量版本已更新（v${batch.campVersion} → v${current}），` +
          `表单内容已保留，请核对最新容量后重新确认。`,
      )
    }

    const view = viewFor(batch.campName, batch.checkInDate)
    const selfOccupies = batch.status === 'hold' ? batch.tentCount : 0
    const status = decideStatus(view, batch.tentCount, selfOccupies)
    await db.batches.update(id, {
      status,
      campVersion: current,
      holdExpiresAt: null,
      lastHeartbeatAt: null,
      confirmedAt: status === 'confirmed' ? now : null,
      updatedAt: now
    })
    await load()
    if (status === 'confirmed') {
      await processQueue(batch.campName, batch.checkInDate)
    }
    return { batch: { ...batch, status }, status }
  }

  /** 重新确认 stale 批次：按当前容量重新分配，确认前不占容量。 */
  async function reconfirm(id: number): Promise<'confirmed' | 'queued'> {
    const batch = findBatch(id)
    if (!batch || batch.status !== 'stale') {
      throw new LedgerError('NOT_FOUND', '没有可重新确认的待重算批次')
    }
    const current = campVersionOf(batch.campName)
    const view = viewFor(batch.campName, batch.checkInDate)
    const status = decideStatus(view, batch.tentCount, 0)
    const now = nowIso()
    await db.batches.update(id, {
      status,
      campVersion: current,
      invalidatedAt: null,
      invalidateReason: '',
      confirmedAt: status === 'confirmed' ? now : null,
      updatedAt: now
    })
    await load()
    if (status === 'confirmed') {
      await processQueue(batch.campName, batch.checkInDate)
    }
    return status
  }

  /** 释放批次（放弃预占 / 取消入住 / 取消排队），并递进该营地当日排队。 */
  async function releaseBatch(id: number): Promise<void> {
    const batch = findBatch(id)
    if (!batch) return
    await db.batches.update(id, {
      status: 'released',
      holdExpiresAt: null,
      lastHeartbeatAt: null,
      updatedAt: nowIso()
    })
    await load()
    await processQueue(batch.campName, batch.checkInDate)
  }

  /**
   * 排队递进（FIFO）：腾出名额后，按提交时间先后把排队中的批次转为已确认。
   * 队首放不下时不跳过，避免后来者插队。
   */
  async function processQueue(campName: string, date: string): Promise<void> {
    const queued = batches.value
      .filter((b) => b.campName === campName && b.checkInDate === date && b.status === 'queued')
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
        return (a.id ?? 0) - (b.id ?? 0)
      })
    if (!queued.length) return
    let view = viewFor(campName, date)
    const now = nowIso()
    for (const b of queued) {
      if (view.remaining < b.tentCount) break
      if (typeof b.id !== 'number') continue
      await db.batches.update(b.id, {
        status: 'confirmed',
        campVersion: campVersionOf(campName),
        confirmedAt: now,
        updatedAt: now
      })
      view = viewFor(campName, date)
    }
    await load()
  }

  /** 到期扫描：释放已过期的临时预占，再递进排队。 */
  async function sweepExpired(): Promise<void> {
    const now = Date.now()
    const expired = batches.value.filter(
      (b) => b.status === 'hold' && isHoldExpired(b, now)
    )
    if (!expired.length) return
    const nowStr = nowIso()
    const keys = new Set<string>()
    for (const b of expired) {
      if (typeof b.id !== 'number') continue
      await db.batches.update(b.id, {
        status: 'released',
        holdExpiresAt: null,
        lastHeartbeatAt: null,
        updatedAt: nowStr
      })
      keys.add(`${b.campName}|${b.checkInDate}`)
    }
    await load()
    for (const key of keys) {
      const [camp, date] = key.split('|')
      await processQueue(camp, date)
    }
  }

  /** 心跳：为本窗口仍有效的预占续期。 */
  async function heartbeat(): Promise<void> {
    const now = Date.now()
    const mine = batches.value.filter(
      (b) => b.status === 'hold' && b.windowId === windowId.value && !isHoldExpired(b, now)
    )
    if (!mine.length) return
    const nowStr = nowIso()
    const expires = new Date(now + HOLD_TTL_MS).toISOString()
    for (const b of mine) {
      if (typeof b.id !== 'number') continue
      await db.batches.update(b.id, {
        holdExpiresAt: expires,
        lastHeartbeatAt: nowStr,
        updatedAt: nowStr
      })
    }
    await load()
  }

  /** 窗口失联：释放本窗口名下全部临时预占（页面关闭 / 断网）。 */
  async function releaseWindowHolds(): Promise<void> {
    const mine = batches.value.filter(
      (b) => b.status === 'hold' && b.windowId === windowId.value
    )
    if (!mine.length) return
    const now = nowIso()
    const keys = new Set<string>()
    for (const b of mine) {
      if (typeof b.id !== 'number') continue
      await db.batches.update(b.id, {
        status: 'released',
        holdExpiresAt: null,
        lastHeartbeatAt: null,
        updatedAt: now
      })
      keys.add(`${b.campName}|${b.checkInDate}`)
    }
    await load()
    for (const key of keys) {
      const [camp, date] = key.split('|')
      await processQueue(camp, date)
    }
  }

  /**
   * 补登旧入住：把一条 legacy 记录转成正式容量批次（预占 → 分配），
   * 无论确认还是排队，旧入住都视为「已有容量批次」，离开待确认列表。
   */
  async function registerLegacy(
    legacyId: number,
    patch: { batchNo: string; teamName: string; contact: string; note?: string }
  ): Promise<'confirmed' | 'queued'> {
    const legacy = findBatch(legacyId)
    if (!legacy || legacy.status !== 'legacy') {
      throw new LedgerError('NOT_FOUND', '没有可补登的旧入住记录')
    }
    const batchNo = patch.batchNo.trim()
    if (!batchNo) throw new LedgerError('VALIDATION', '批次号不能为空')
    const dup = findActiveByBatchNo(batchNo)
    if (dup) {
      throw new LedgerError('DUP_BATCH', `批次号 ${batchNo} 已提交，同一批次重复提交只生效一次。`)
    }
    const current = campVersionOf(legacy.campName)
    const now = nowIso()
    const hold = toPlain({
      batchNo,
      campName: legacy.campName,
      siteId: legacy.siteId,
      teamName: patch.teamName.trim() || legacy.teamName,
      contact: patch.contact.trim() || legacy.contact,
      checkInDate: legacy.checkInDate,
      tentCount: legacy.tentCount,
      status: 'hold' as const,
      campVersion: current,
      windowId: windowId.value,
      holdExpiresAt: new Date(Date.now() + HOLD_TTL_MS).toISOString(),
      lastHeartbeatAt: now,
      confirmedAt: null,
      invalidatedAt: null,
      invalidateReason: '',
      legacy: false,
      note: patch.note?.trim() ?? `由旧入住补登（原记录 ${legacy.batchNo}）`,
      createdAt: now,
      updatedAt: now
    }) as OccupancyBatch
    const id = await db.batches.add(hold)
    const view = viewFor(legacy.campName, legacy.checkInDate)
    const status = decideStatus(view, legacy.tentCount, legacy.tentCount)
    await db.batches.update(id, {
      status,
      holdExpiresAt: null,
      lastHeartbeatAt: null,
      confirmedAt: status === 'confirmed' ? now : null,
      updatedAt: now
    })
    // 旧入住已转为正式容量批次，离开待确认列表
    await db.batches.update(legacyId, {
      status: 'released',
      note: `已补登为批次 ${batchNo}`,
      updatedAt: now
    })
    await load()
    if (status === 'confirmed') {
      await processQueue(legacy.campName, legacy.checkInDate)
    }
    return status
  }

  const total = computed(() => batches.value.length)
  const pendingLegacyCount = computed(() => batches.value.filter((b) => b.status === 'legacy').length)
  const staleCount = computed(() => batches.value.filter((b) => b.status === 'stale').length)

  return {
    batches,
    campMeta,
    loading,
    loaded,
    windowId,
    total,
    pendingLegacyCount,
    staleCount,
    setViewProvider,
    load,
    ensureMeta,
    campVersionOf,
    suggestBatchNo,
    findBatch,
    findActiveByBatchNo,
    bumpCampVersion,
    prehold,
    confirmHold,
    reconfirm,
    releaseBatch,
    processQueue,
    sweepExpired,
    heartbeat,
    releaseWindowHolds,
    registerLegacy
  }
})
