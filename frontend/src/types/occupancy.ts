/**
 * Occupancy —— 按「营地 + 入住日」记账的帐篷容量占用。
 *
 * 容量版本是乐观锁：两个值班室同时打开表单时各带同一份版本，
 * 先保存的一方成功，后保存的一方不会覆盖新容量，只能按新版本重新确认。
 */

/** 批次状态 */
export type OccupancyStatus =
  | 'held' // 临时预占：窗口在线，计入账本但未进入名次/地图
  | 'confirmed' // 已确认：占用正式名额，进入名次/地图
  | 'queued' // 排队：剩余名额不足，不占用名额
  | 'needs_confirmation' // 容量/因子/否决变化或旧数据迁入后待确认，不占用名额
  | 'released' // 已释放（保留流水，不参与计算）
  | 'expired' // 临时预占超时/窗口失联（保留流水，不参与计算）

/** 容量账本版本：每次容量、营位因子或风险否决变化都递增 */
export interface CampVersion {
  /** 营地名称 */
  campName: string
  /** 可容帐篷总量变化版本 */
  capacityVersion: number
  /** 营位因子变化版本 */
  factorVersion: number
  /** 风险否决变化版本 */
  vetoVersion: number
  updatedAt: string
}

export interface OccupancyBatch {
  /** 主键，自增 */
  id?: number
  /** 同一分队入住批次的幂等键：营地 + 日期 + 批次号 */
  batchKey: string
  /** 批次号/分队号，由值班室填写 */
  batchNo: string
  /** 所属营地 */
  campName: string
  /** 入住日期（YYYY-MM-DD） */
  stayDate: string
  /** 申请帐篷数 */
  tentCount: number
  /** 联系人/负责人 */
  contact: string
  status: OccupancyStatus
  /** 提交时看到的容量版本；为空表示容量账本建立前的旧入住 */
  capacityVersion: number | null
  /** 提交时看到的因子版本 */
  factorVersion: number | null
  /** 提交时看到的否决版本 */
  vetoVersion: number | null
  /** 当前账本最新容量版本（登记后由账本回填，供 UI 判断是否需重新确认） */
  currentCapacityVersion: number | null
  currentFactorVersion: number | null
  currentVetoVersion: number | null
  /** held 状态的拥有者；页面心跳刷新，超时即自动释放 */
  ownerId: string
  /** 临时预占到期时间（ISO） */
  expiresAt: string | null
  lastHeartbeatAt: string | null
  /** 排队序号/名次（账本按提交顺序重排） */
  queuePosition: number
  /** 已确认时占用的帐篷数 */
  occupiedTents: number
  note: string
  createdAt: string
  updatedAt: string
}

export interface OccupancyInput {
  campName: string
  stayDate: string
  batchNo: string
  tentCount: number
  contact?: string
  note?: string
}

export interface OccupancyVersions {
  capacityVersion: number
  factorVersion: number
  vetoVersion: number
}

export interface OccupancySnapshotRow extends OccupancyBatch {
  key: string
  capacity: number
  reserved: number
  available: number
  confirmedTents: number
  heldTents: number
  queuedTents: number
  pendingTents: number
  remaining: number
}

export interface OccupancySummary {
  campName: string
  stayDate: string
  capacity: number
  reserved: number
  available: number
  confirmedTents: number
  heldTents: number
  queuedTents: number
  pendingTents: number
  remaining: number
  confirmedBatches: number
  queuedBatches: number
  pendingBatches: number
  versions: OccupancyVersions
}

export interface SubmitOccupancyResult {
  batch: OccupancyBatch
  duplicated: boolean
  conflict: boolean
  message: string
}

/** 两成应急余量，至少留 1 顶。 */
export function reservedTents(capacity: number): number {
  if (capacity <= 0) return 0
  return Math.max(1, Math.ceil(capacity * 0.2))
}

/** 可用于分队入住的容量：总容量扣除两成应急余量。 */
export function availableTents(capacity: number): number {
  return Math.max(0, capacity - reservedTents(capacity))
}

export function occupancyKey(campName: string, stayDate: string): string {
  return `${campName}@${stayDate}`
}

export function occupancyBatchKey(campName: string, stayDate: string, batchNo: string): string {
  return `${occupancyKey(campName, stayDate)}#${batchNo.trim()}`
}

export function isActiveOccupancy(status: OccupancyStatus): boolean {
  return status === 'held' || status === 'confirmed' || status === 'queued' || status === 'needs_confirmation'
}

export const OCCUPANCY_STATUS_LABELS: Record<OccupancyStatus, string> = {
  held: '临时预占',
  confirmed: '已确认',
  queued: '排队中',
  needs_confirmation: '待确认',
  released: '已释放',
  expired: '已失联释放'
}

export const OCCUPANCY_STATUS_TYPES: Record<
  OccupancyStatus,
  'primary' | 'success' | 'warning' | 'info' | 'danger'
> = {
  held: 'primary',
  confirmed: 'success',
  queued: 'warning',
  needs_confirmation: 'info',
  released: 'info',
  expired: 'danger'
}

export const HOLD_TTL_MS = 90_000
export const HEARTBEAT_INTERVAL_MS = 10_000
