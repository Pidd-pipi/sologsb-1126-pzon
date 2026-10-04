/**
 * 容量台账纯函数：容量测算、应急余量、占用汇总、排队分配。
 * 不依赖 Vue / Dexie，便于 store 与页面共同复用与测试。
 */
import type { Campsite } from '@/types/campsite'
import type { OccupancyBatch } from '@/types/ledger'
import { BATCH_NO_PREFIX, EMERGENCY_RESERVE_RATIO } from '@/types/ledger'

/** 某营地 / 某日的容量视图 */
export interface CapacityView {
  /** 物理容量（营位可容帐篷数合计） */
  physical: number
  /** 被否决营位占用的容量（一票否决，不可入住） */
  vetoed: number
  /** 可用容量 = physical - vetoed */
  usable: number
  /** 应急余量（两成）= ceil(usable * 0.2) */
  reserve: number
  /** 可分配容量 = usable - reserve（留出两成应急余量） */
  bookable: number
  /** 已确认占用帐篷数 */
  confirmed: number
  /** 预占中（未过期）帐篷数 */
  held: number
  /** 排队中帐篷数（不占剩余，仅展示） */
  queued: number
  /** 待重算帐篷数（不占剩余，仅展示） */
  stale: number
  /** 旧入住待确认帐篷数（不占剩余，仅展示） */
  legacy: number
  /** 剩余可订 = bookable - confirmed - held（不为负展示） */
  remaining: number
}

/** 可分配容量：留出两成应急余量后向下取整，保证余量只多不少。 */
export function bookableCapacity(usable: number): number {
  return Math.max(0, Math.floor(usable * (1 - EMERGENCY_RESERVE_RATIO)))
}

/** 应急余量 = 可用容量 - 可分配容量（向上取整，至少两成）。 */
export function reserveCapacity(usable: number): number {
  return Math.max(0, usable - bookableCapacity(usable))
}

function siteIdOf(site: Campsite): number | null {
  return typeof site.id === 'number' ? site.id : null
}

/** 营地物理容量：该营地全部营位可容帐篷数合计。 */
export function campPhysicalCapacity(sites: Campsite[], campName: string): number {
  return sites
    .filter((s) => s.campName === campName)
    .reduce((acc, s) => acc + (Number(s.tentCapacity) || 0), 0)
}

/** 被否决（一票否决）营位的容量合计：这些营位不可入住。 */
export function campVetoedCapacity(
  sites: Campsite[],
  campName: string,
  vetoedSiteIds: number[]
): number {
  const vetoSet = new Set(vetoedSiteIds)
  return sites
    .filter((s) => s.campName === campName && vetoSet.has(siteIdOf(s) ?? -1))
    .reduce((acc, s) => acc + (Number(s.tentCapacity) || 0), 0)
}

/** 判断预占是否已到期。 */
export function isHoldExpired(batch: OccupancyBatch, now: number): boolean {
  if (batch.status !== 'hold' || !batch.holdExpiresAt) return true
  const t = new Date(batch.holdExpiresAt).getTime()
  return Number.isNaN(t) || t <= now
}

/** 汇总某营地 / 某日的容量与占用情况。sites 与 vetoedSiteIds 由调用方从 store 注入。 */
export function summarizeCapacity(
  batches: OccupancyBatch[],
  sites: Campsite[],
  campName: string,
  date: string,
  vetoedSiteIds: number[],
  now: number
): CapacityView {
  const physical = campPhysicalCapacity(sites, campName)
  const vetoed = campVetoedCapacity(sites, campName, vetoedSiteIds)
  const usable = Math.max(0, physical - vetoed)
  const reserve = reserveCapacity(usable)
  const bookable = bookableCapacity(usable)

  let confirmed = 0
  let held = 0
  let queued = 0
  let stale = 0
  let legacy = 0
  for (const b of batches) {
    if (b.campName !== campName || b.checkInDate !== date) continue
    const n = Number(b.tentCount) || 0
    switch (b.status) {
      case 'confirmed':
        confirmed += n
        break
      case 'hold':
        if (!isHoldExpired(b, now)) held += n
        break
      case 'queued':
        queued += n
        break
      case 'stale':
        stale += n
        break
      case 'legacy':
        legacy += n
        break
      default:
        break
    }
  }

  const remaining = Math.max(0, bookable - confirmed - held)
  return { physical, vetoed, usable, reserve, bookable, confirmed, held, queued, stale, legacy, remaining }
}

/**
 * 分配判定：在排除某批次自身已有占用后，剩余额度是否够分。
 * 够 → confirmed；不够 → queued。
 */
export function decideStatus(
  view: CapacityView,
  tentCount: number,
  selfOccupies: number
): 'confirmed' | 'queued' {
  const available = view.remaining + selfOccupies
  return available >= tentCount ? 'confirmed' : 'queued'
}

/** 生成下一个批次号，如 PC-0001。 */
export function nextBatchNo(existing: string[]): string {
  let max = 0
  for (const no of existing) {
    const m = /(\d+)\s*$/.exec(no ?? '')
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${BATCH_NO_PREFIX}${String(max + 1).padStart(4, '0')}`
}

/** 预占剩余秒数（用于页面倒计时展示），已到期返回 0。 */
export function holdRemainingSeconds(batch: OccupancyBatch, now: number): number {
  if (batch.status !== 'hold' || !batch.holdExpiresAt) return 0
  const ms = new Date(batch.holdExpiresAt).getTime() - now
  return Math.max(0, Math.ceil(ms / 1000))
}
