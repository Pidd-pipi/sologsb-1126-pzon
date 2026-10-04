/**
 * OccupancyBatch（入住批次 / 容量台账）—— 把营地容量做成「带日期的占用账本」。
 *
 * 每个批次代表一个分队在某营地、某入住日的帐篷占用请求：
 *   - 预占（hold）：窗口填表时的临时占位，带 TTL，失联或到期自动释放；
 *   - 已确认（confirmed）：真正占用容量，进入营位名次与地图；
 *   - 排队（queued）：可分配容量不足时 FIFO 等待，腾出名额后自动递进；
 *   - 待重算（stale）：容量 / 营位因子 / 风险否决变化后立即失效，需重新确认，确认前不占容量、不进名次地图；
 *   - 旧入住（legacy）：没有容量批次的历史入住，列待确认、不挤占剩余名额；
 *   - 已释放（released）：终态。
 *
 * 批次携带营地版本（campVersion）：旧窗口保存时若版本已变，拒绝写入并保留表单、提示重新确认，
 * 不能覆盖新容量。批次号（batchNo）幂等：同一批次号重复提交只生效一次。
 */

/** 批次生命周期状态 */
export type BatchStatus =
  | 'hold'
  | 'confirmed'
  | 'queued'
  | 'stale'
  | 'legacy'
  | 'released'

export interface OccupancyBatch {
  /** 主键，自增 */
  id?: number
  /** 批次号（幂等键），同一批次号重复提交只生效一次 */
  batchNo: string
  /** 所属营地 */
  campName: string
  /** 意向营位（可空，表示营地级分配） */
  siteId: number | null
  /** 分队名称 */
  teamName: string
  /** 联系人 / 提交窗口 */
  contact: string
  /** 入住日（YYYY-MM-DD） */
  checkInDate: string
  /** 占用帐篷数 */
  tentCount: number
  /** 生命周期状态 */
  status: BatchStatus
  /** 登记 / 最近一次确认时携带的营地容量版本 */
  campVersion: number
  /** 提交窗口标识（同标签页会话一致，用于失联释放本窗口预占） */
  windowId: string
  /** 预占到期时间（ISO），仅 hold 有值 */
  holdExpiresAt: string | null
  /** 最近一次心跳时间（ISO） */
  lastHeartbeatAt: string | null
  /** 确认时间（ISO） */
  confirmedAt: string | null
  /** 失效时间（ISO） */
  invalidatedAt: string | null
  /** 失效原因（容量 / 因子 / 否决变化） */
  invalidateReason: string
  /** 是否为没有容量批次的旧入住 */
  legacy: boolean
  /** 备注 */
  note: string
  createdAt: string
  updatedAt: string
}

/** 营地容量版本元数据（每个营地一条） */
export interface CampMeta {
  /** 营地名称（主键） */
  campName: string
  /** 容量版本号，随容量 / 因子 / 否决变化单调递增 */
  version: number
  /** 最近一次容量相关变更时间（ISO） */
  capacityUpdatedAt: string
}

/** 批次状态展示元数据 */
export interface BatchStatusMeta {
  label: string
  /** Element Plus tag type */
  type: 'success' | 'warning' | 'info' | 'danger' | 'primary'
  /** 是否占用容量（confirmed 计入已确认，hold 计入预占） */
  occupies: 'confirmed' | 'hold' | 'none'
}

export const BATCH_STATUS_META: Record<BatchStatus, BatchStatusMeta> = {
  hold: { label: '预占中', type: 'warning', occupies: 'hold' },
  confirmed: { label: '已确认', type: 'success', occupies: 'confirmed' },
  queued: { label: '排队中', type: 'info', occupies: 'none' },
  stale: { label: '待重算', type: 'danger', occupies: 'none' },
  legacy: { label: '旧入住·待确认', type: 'info', occupies: 'none' },
  released: { label: '已释放', type: 'info', occupies: 'none' }
}

/** 应急余量比例：按营地与入住日留出两成应急余量 */
export const EMERGENCY_RESERVE_RATIO = 0.2

/** 临时预占有效期（毫秒）：失联或到期自动释放 */
export const HOLD_TTL_MS = 45_000

/** 心跳间隔（毫秒） */
export const HEARTBEAT_INTERVAL_MS = 10_000

/** 到期扫描间隔（毫秒） */
export const SWEEP_INTERVAL_MS = 5_000

/** 批次号前缀 */
export const BATCH_NO_PREFIX = 'PC-'
