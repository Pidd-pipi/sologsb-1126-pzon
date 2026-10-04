/** 日期化容量账本：入住批次、预占心跳、排队与容量版本。 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  buildOccupancySnapshots,
  broadcastOccupancyChanged,
  confirmOccupancy,
  heartbeatOwnerHolds,
  holdOccupancy,
  loadOccupancy,
  onOccupancyChanged,
  releaseOccupancy,
  releaseOwnerHoldsOnUnload,
  reconfirmOccupancy,
  submitOccupancy
} from '@/utils/occupancy'
import type {
  CampVersion,
  OccupancyBatch,
  OccupancyInput,
  OccupancySnapshotRow,
  OccupancyStatus,
  OccupancySummary,
  OccupancyVersions,
  SubmitOccupancyResult
} from '@/types/occupancy'
import { occupancyKey } from '@/types/occupancy'
import { useSiteStore } from '@/stores/siteStore'
import { useUiStore } from '@/stores/uiStore'

export const useOccupancyStore = defineStore('occupancy', () => {
  const batches = ref<OccupancyBatch[]>([])
  const versions = ref<CampVersion[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const ownerId = ref<string>('')
  const clock = ref(Date.now())

  async function load(): Promise<void> {
    loading.value = true
    try {
      const result = await loadOccupancy()
      batches.value = result.batches
      versions.value = result.versions
      loaded.value = true
      ownerId.value = window.sessionStorage.getItem('gbcampsite:occupancy-owner') ?? ''
    } finally {
      loading.value = false
    }
  }

  function notifyChanged(): void {
    broadcastOccupancyChanged()
    void load()
  }

  function versionOf(campName: string): OccupancyVersions {
    const row = versions.value.find((v) => v.campName === campName)
    return {
      capacityVersion: row?.capacityVersion ?? 1,
      factorVersion: row?.factorVersion ?? 1,
      vetoVersion: row?.vetoVersion ?? 1
    }
  }

  async function submit(input: OccupancyInput, clientVersions?: Partial<OccupancyVersions> | null) {
    const result = await submitOccupancy(input, clientVersions)
    notifyChanged()
    return result
  }

  async function hold(input: OccupancyInput, clientVersions?: Partial<OccupancyVersions> | null) {
    const result = await holdOccupancy(input, clientVersions)
    notifyChanged()
    return result
  }

  async function confirm(id: number): Promise<void> {
    await confirmOccupancy(id)
    notifyChanged()
  }

  async function reconfirm(id: number): Promise<void> {
    await reconfirmOccupancy(id)
    notifyChanged()
  }

  async function release(id: number, status: 'released' | 'expired' = 'released'): Promise<void> {
    await releaseOccupancy(id, status)
    notifyChanged()
  }

  async function heartbeat(): Promise<void> {
    const activeHolds = await heartbeatOwnerHolds()
    clock.value = Date.now()
    if (activeHolds > 0) broadcastOccupancyChanged()
    await load()
  }

  async function releaseOnUnload(): Promise<void> {
    await releaseOwnerHoldsOnUnload()
  }

  function snapshots(): OccupancySnapshotRow[] {
    const siteStore = useSiteStore()
    const uiStore = useUiStore()
    return buildOccupancySnapshots(
      siteStore.list,
      uiStore.vetos,
      batches.value,
      versions.value
    )
  }

  const activeBatches = computed(() =>
    batches.value
      .filter((b) => b.status !== 'released' && b.status !== 'expired')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  )

  function rowsFor(campName: string, stayDate: string): OccupancySnapshotRow[] {
    return snapshots()
      .filter((row) => row.campName === campName && row.stayDate === stayDate)
      .sort((a, b) => {
        const order: Record<OccupancyStatus, number> = {
          confirmed: 0,
          held: 1,
          queued: 2,
          needs_confirmation: 3,
          released: 4,
          expired: 5
        }
        return order[a.status] - order[b.status] || a.createdAt.localeCompare(b.createdAt)
      })
  }

  function summaryOf(campName: string, stayDate: string): OccupancySummary | null {
    return summaryMap.value.get(occupancyKey(campName, stayDate)) ?? null
  }

  const summaryMap = computed(() => {
    const map = new Map<string, OccupancySummary>()
    for (const row of snapshots()) {
      const existing = map.get(row.key)
      if (!existing) {
        map.set(row.key, {
          campName: row.campName,
          stayDate: row.stayDate,
          capacity: row.capacity,
          reserved: row.reserved,
          available: row.available,
          confirmedTents: row.confirmedTents,
          heldTents: row.heldTents,
          queuedTents: row.queuedTents,
          pendingTents: row.pendingTents,
          remaining: row.remaining,
          confirmedBatches: row.status === 'confirmed' ? 1 : 0,
          queuedBatches: row.status === 'queued' ? 1 : 0,
          pendingBatches: row.status === 'needs_confirmation' ? 1 : 0,
          versions: versionOf(row.campName)
        })
        continue
      }
      existing.confirmedBatches += row.status === 'confirmed' ? 1 : 0
      existing.queuedBatches += row.status === 'queued' ? 1 : 0
      existing.pendingBatches += row.status === 'needs_confirmation' ? 1 : 0
    }
    return map
  })

  function confirmedTents(campName: string, stayDate: string): number {
    return batches.value
      .filter((b) => b.campName === campName && b.stayDate === stayDate && b.status === 'confirmed')
      .reduce((sum, b) => sum + b.occupiedTents, 0)
  }

  function batchById(id: number): OccupancyBatch | null {
    return batches.value.find((b) => b.id === id) ?? null
  }

  let stopListening: (() => void) | null = null
  function startRealtime(): void {
    if (stopListening) return
    stopListening = onOccupancyChanged(() => {
      void (async () => {
        const siteStore = useSiteStore()
        const uiStore = useUiStore()
        await Promise.all([siteStore.load(), uiStore.loadVetos()])
        await load()
      })()
    })
    window.addEventListener('pagehide', () => {
      void releaseOnUnload()
    })
    window.setInterval(() => {
      void heartbeat()
    }, 10_000)
  }

  const totalActive = computed(
    () => batches.value.filter((b) => b.status !== 'released' && b.status !== 'expired').length
  )
  const totalPending = computed(
    () => batches.value.filter((b) => b.status === 'needs_confirmation').length
  )

  return {
    batches,
    versions,
    loading,
    loaded,
    ownerId,
    clock,
    activeBatches,
    totalActive,
    totalPending,
    load,
    startRealtime,
    versionOf,
    submit,
    hold,
    confirm,
    reconfirm,
    release,
    heartbeat,
    releaseOnUnload,
    snapshots,
    rowsFor,
    summaryOf,
    summaryMap,
    confirmedTents,
    batchById
  }
})

export type { SubmitOccupancyResult }
