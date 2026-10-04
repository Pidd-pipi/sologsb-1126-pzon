/**
 * 容量账本领域服务：日期化占用、两成应急余量、排队、幂等提交、版本失效与预占释放。
 * 所有会改变账本的动作都放在 IndexedDB 事务里，避免两个值班室同时放出最后一顶帐篷。
 */
import { db } from '@/utils/db'
import type { Campsite } from '@/types/campsite'
import type { RiskVeto } from '@/types/veto'
import { nowIso } from '@/utils/format'
import {
  availableTents,
  HOLD_TTL_MS,
  occupancyBatchKey,
  occupancyKey,
  reservedTents,
  type CampVersion,
  type OccupancyBatch,
  type OccupancyInput,
  type OccupancySnapshotRow,
  type OccupancyStatus,
  type OccupancySummary,
  type OccupancyVersions,
  type SubmitOccupancyResult
} from '@/types/occupancy'

export type VersionKind = 'capacity' | 'factor' | 'veto'

const ACTIVE_STATUSES: OccupancyStatus[] = ['held', 'confirmed', 'queued', 'needs_confirmation']
const LEDGER_TABLES = [db.sites, db.vetos, db.campVersions, db.occupancyBatches] as const

export class OccupancyConflictError extends Error {
  versions: OccupancyVersions
  constructor(versions: OccupancyVersions, message = '营地容量已变化，请重新确认') {
    super(message)
    this.name = 'OccupancyConflictError'
    this.versions = versions
  }
}

function ownerId(): string {
  const key = 'gbcampsite:occupancy-owner'
  const existing = window.sessionStorage.getItem(key)
  if (existing) return existing
  const id = `win-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  window.sessionStorage.setItem(key, id)
  return id
}

export function currentOwnerId(): string {
  return ownerId()
}

function toVersions(row: CampVersion): OccupancyVersions {
  return {
    capacityVersion: row.capacityVersion,
    factorVersion: row.factorVersion,
    vetoVersion: row.vetoVersion
  }
}

async function ensureCampVersion(campName: string, at: string): Promise<CampVersion> {
  const existing = await db.campVersions.get(campName)
  if (existing) return existing
  const row: CampVersion = {
    campName,
    capacityVersion: 1,
    factorVersion: 1,
    vetoVersion: 1,
    updatedAt: at
  }
  await db.campVersions.put(row)
  return row
}

async function ensureCampVersions(campNames: string[], at: string): Promise<Map<string, CampVersion>> {
  const names = Array.from(new Set(campNames.filter(Boolean)))
  const rows = names.length ? await db.campVersions.bulkGet(names) : []
  const map = new Map<string, CampVersion>()
  const missing: CampVersion[] = []
  names.forEach((name, idx) => {
    const row = rows[idx]
    if (row) {
      map.set(name, row)
    } else {
      const fallback: CampVersion = {
        campName: name,
        capacityVersion: 1,
        factorVersion: 1,
        vetoVersion: 1,
        updatedAt: at
      }
      map.set(name, fallback)
      missing.push(fallback)
    }
  })
  if (missing.length) await db.campVersions.bulkPut(missing)
  return map
}

function isStale(batch: OccupancyBatch, version: CampVersion): boolean {
  return (
    batch.capacityVersion === null ||
    batch.factorVersion === null ||
    batch.vetoVersion === null ||
    batch.capacityVersion !== version.capacityVersion ||
    batch.factorVersion !== version.factorVersion ||
    batch.vetoVersion !== version.vetoVersion
  )
}

async function capacityOfCamp(
  campName: string,
  vetoedSiteIds: Set<number>
): Promise<{ capacity: number; available: number }> {
  const sites = await db.sites.where('campName').equals(campName).toArray()
  const capacity = sites
    .filter((s) => typeof s.id === 'number' && !vetoedSiteIds.has(s.id as number))
    .reduce((sum, s) => sum + Math.max(0, s.tentCapacity), 0)
  return { capacity, available: availableTents(capacity) }
}

async function vetoedIdsForCamp(campName: string): Promise<Set<number>> {
  const [sites, vetos] = await Promise.all([
    db.sites.where('campName').equals(campName).toArray(),
    db.vetos.toArray()
  ])
  const ids = new Set(sites.map((s) => s.id).filter((id): id is number => typeof id === 'number'))
  return new Set(vetos.filter((v) => ids.has(v.siteId)).map((v) => v.siteId))
}

function markPending(batch: OccupancyBatch, version: CampVersion, at: string): void {
  batch.status = 'needs_confirmation'
  batch.occupiedTents = 0
  batch.expiresAt = null
  batch.lastHeartbeatAt = null
  batch.queuePosition = 0
  batch.currentCapacityVersion = version.capacityVersion
  batch.currentFactorVersion = version.factorVersion
  batch.currentVetoVersion = version.vetoVersion
  batch.updatedAt = at
}

async function batchesForDate(campName: string, stayDate: string): Promise<OccupancyBatch[]> {
  const rows = await db.occupancyBatches.where('campName').equals(campName).toArray()
  return rows.filter((b) => b.stayDate === stayDate)
}

async function reconcileDate(
  campName: string,
  stayDate: string,
  version: CampVersion,
  at: string,
  nowMs: number
): Promise<void> {
  const [batches, vetoedIds] = await Promise.all([
    batchesForDate(campName, stayDate),
    vetoedIdsForCamp(campName)
  ])
  const { capacity, available } = await capacityOfCamp(campName, vetoedIds)
  const changed: OccupancyBatch[] = []

  for (const batch of batches) {
    let dirty = false
    if (
      batch.currentCapacityVersion !== version.capacityVersion ||
      batch.currentFactorVersion !== version.factorVersion ||
      batch.currentVetoVersion !== version.vetoVersion
    ) {
      batch.currentCapacityVersion = version.capacityVersion
      batch.currentFactorVersion = version.factorVersion
      batch.currentVetoVersion = version.vetoVersion
      dirty = true
    }

    if (batch.status === 'held' && batch.expiresAt && Date.parse(batch.expiresAt) <= nowMs) {
      batch.status = 'expired'
      batch.occupiedTents = 0
      batch.expiresAt = null
      batch.lastHeartbeatAt = null
      batch.queuePosition = 0
      batch.updatedAt = at
      changed.push(batch)
      continue
    }

    if (ACTIVE_STATUSES.includes(batch.status) && isStale(batch, version)) {
      markPending(batch, version, at)
      changed.push(batch)
      continue
    }

    if (dirty) {
      batch.updatedAt = at
      changed.push(batch)
    }
  }

  const active = batches.filter((b) => ACTIVE_STATUSES.includes(b.status) && b.status !== 'expired')
  const allocated = active
    .filter((b) => b.status === 'confirmed' || b.status === 'held')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id ?? 0) - (b.id ?? 0))

  let used = 0
  for (const batch of allocated) {
    if (used + batch.tentCount <= available) {
      used += batch.tentCount
      if (batch.occupiedTents !== batch.tentCount) {
        batch.occupiedTents = batch.tentCount
        batch.updatedAt = at
        changed.push(batch)
      }
    } else {
      // 正常路径下容量变化已先令批次失效；这里只做防御性兜底，不顶掉更早的批次。
      batch.status = 'needs_confirmation'
      batch.occupiedTents = 0
      batch.queuePosition = 0
      batch.updatedAt = at
      changed.push(batch)
    }
  }

  const queued = active
    .filter((b) => b.status === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id ?? 0) - (b.id ?? 0))

  let queuePosition = 0
  for (const batch of queued) {
    if (used + batch.tentCount <= available) {
      batch.status = 'confirmed'
      batch.occupiedTents = batch.tentCount
      batch.queuePosition = 0
      batch.updatedAt = at
      used += batch.tentCount
      changed.push(batch)
    } else {
      queuePosition += 1
      if (batch.queuePosition !== queuePosition) {
        batch.queuePosition = queuePosition
        batch.updatedAt = at
        changed.push(batch)
      }
    }
  }

  // 容量仅用于上层汇总；未变化的记录不写入，避免无意义地推高 updatedAt。
  void capacity
  if (changed.length) await db.occupancyBatches.bulkPut(changed)
}

async function reconcileCamps(campNames?: string[], at = nowIso()): Promise<Map<string, CampVersion>> {
  const names =
    campNames ??
    (await db.campVersions.toCollection().primaryKeys()) as string[]
  const versionMap = await ensureCampVersions(names, at)
  const batches = await db.occupancyBatches
    .where('status')
    .anyOf(ACTIVE_STATUSES)
    .toArray()
  const keys = Array.from(
    new Set(
      batches
        .filter((b) => !campNames || campNames.includes(b.campName))
        .map((b) => occupancyKey(b.campName, b.stayDate))
    )
  )
  const nowMs = Date.parse(at)
  for (const key of keys) {
    const [campName, stayDate] = key.split('@')
    const version = versionMap.get(campName)
    if (version) await reconcileDate(campName, stayDate, version, at, nowMs)
  }
  return versionMap
}

async function findActiveBatch(batchKey: string): Promise<OccupancyBatch | null> {
  const rows = await db.occupancyBatches.where('batchKey').equals(batchKey).toArray()
  return rows.find((b) => ACTIVE_STATUSES.includes(b.status)) ?? null
}

function checkClientVersion(batch: OccupancyBatch, version: CampVersion): boolean {
  return (
    batch.capacityVersion === version.capacityVersion &&
    batch.factorVersion === version.factorVersion &&
    batch.vetoVersion === version.vetoVersion
  )
}

function setBatchVersions(batch: OccupancyBatch, version: CampVersion): void {
  batch.capacityVersion = version.capacityVersion
  batch.factorVersion = version.factorVersion
  batch.vetoVersion = version.vetoVersion
  batch.currentCapacityVersion = version.capacityVersion
  batch.currentFactorVersion = version.factorVersion
  batch.currentVetoVersion = version.vetoVersion
}

async function remainingFor(campName: string, stayDate: string, version: CampVersion): Promise<number> {
  await reconcileDate(campName, stayDate, version, nowIso(), Date.now())
  const [batches, vetoedIds] = await Promise.all([
    batchesForDate(campName, stayDate),
    vetoedIdsForCamp(campName)
  ])
  const { available } = await capacityOfCamp(campName, vetoedIds)
  const used = batches
    .filter((b) => b.status === 'confirmed' || b.status === 'held')
    .reduce((sum, b) => sum + b.occupiedTents, 0)
  return available - used
}

export async function loadOccupancy(): Promise<{
  batches: OccupancyBatch[]
  versions: CampVersion[]
}> {
  return db.transaction('rw', LEDGER_TABLES, async () => {
    const at = nowIso()
    const campNames = Array.from(
      new Set([
        ...((await db.sites.orderBy('campName').uniqueKeys()) as string[]),
        ...(await db.campVersions.toCollection().primaryKeys()) as string[]
      ])
    ).filter(Boolean)
    await ensureCampVersions(campNames, at)
    await reconcileCamps(campNames, at)
    const [batches, versions] = await Promise.all([
      db.occupancyBatches.toArray(),
      db.campVersions.toArray()
    ])
    return { batches, versions }
  })
}

export async function submitOccupancy(
  input: OccupancyInput,
  clientVersions?: Partial<OccupancyVersions> | null
): Promise<SubmitOccupancyResult> {
  const campName = input.campName.trim()
  const stayDate = input.stayDate
  const batchNo = input.batchNo.trim()
  const tentCount = Math.floor(Number(input.tentCount))
  if (!campName) throw new Error('请选择营地')
  if (!stayDate) throw new Error('请选择入住日期')
  if (!batchNo) throw new Error('请填写分队/批次号')
  if (!Number.isFinite(tentCount) || tentCount <= 0) throw new Error('帐篷数必须大于 0')

  const key = occupancyBatchKey(campName, stayDate, batchNo)
  return db.transaction('rw', LEDGER_TABLES, async () => {
    const at = nowIso()
    const version = await ensureCampVersion(campName, at)
    await reconcileDate(campName, stayDate, version, at, Date.now())
    const existing = await findActiveBatch(key)

    if (existing) {
      return {
        batch: existing,
        duplicated: true,
        conflict: false,
        message:
          existing.status === 'needs_confirmation'
            ? '该批次已提交过，但营地数据有变化，请重新确认'
            : '该批次已提交过，本次重复提交未重复占名额'
      }
    }

    if (
      clientVersions &&
      (clientVersions.capacityVersion !== undefined ||
        clientVersions.factorVersion !== undefined ||
        clientVersions.vetoVersion !== undefined) &&
      (clientVersions.capacityVersion !== version.capacityVersion ||
        clientVersions.factorVersion !== version.factorVersion ||
        clientVersions.vetoVersion !== version.vetoVersion)
    ) {
      throw new OccupancyConflictError(toVersions(version))
    }

    const remaining = await remainingFor(campName, stayDate, version)
    const batch: OccupancyBatch = {
      batchKey: key,
      batchNo,
      campName,
      stayDate,
      tentCount,
      contact: input.contact?.trim() || '未署名',
      status: tentCount <= remaining ? 'confirmed' : 'queued',
      capacityVersion: version.capacityVersion,
      factorVersion: version.factorVersion,
      vetoVersion: version.vetoVersion,
      currentCapacityVersion: version.capacityVersion,
      currentFactorVersion: version.factorVersion,
      currentVetoVersion: version.vetoVersion,
      ownerId: ownerId(),
      expiresAt: null,
      lastHeartbeatAt: null,
      queuePosition: 0,
      occupiedTents: tentCount <= remaining ? tentCount : 0,
      note: input.note?.trim() ?? '',
      createdAt: at,
      updatedAt: at
    }
    if (batch.status === 'queued') {
      const queued = await db.occupancyBatches
        .where('status')
        .equals('queued')
        .toArray()
        .then((rows) => rows.filter((b) => b.campName === campName && b.stayDate === stayDate))
      batch.queuePosition = queued.length + 1
    }
    const id = await db.occupancyBatches.add(batch)
    return {
      batch: { ...batch, id },
      duplicated: false,
      conflict: false,
      message:
        batch.status === 'confirmed'
          ? '登记成功，已按两成应急余量后的剩余容量确认名额'
          : '剩余容量不足，该批次已进入排队，未占用名额'
    }
  })
}

export async function holdOccupancy(
  input: OccupancyInput,
  clientVersions?: Partial<OccupancyVersions> | null
): Promise<SubmitOccupancyResult> {
  const campName = input.campName.trim()
  const stayDate = input.stayDate
  const batchNo = input.batchNo.trim()
  const tentCount = Math.floor(Number(input.tentCount))
  if (!campName || !stayDate || !batchNo || tentCount <= 0) {
    throw new Error('请完整填写营地、入住日期、批次号与帐篷数')
  }

  const key = occupancyBatchKey(campName, stayDate, batchNo)
  return db.transaction('rw', LEDGER_TABLES, async () => {
    const at = nowIso()
    const version = await ensureCampVersion(campName, at)
    await reconcileDate(campName, stayDate, version, at, Date.now())
    const existing = await findActiveBatch(key)
    if (existing) {
      if (
        existing.status === 'held' &&
        existing.ownerId === ownerId() &&
        checkClientVersion(existing, version)
      ) {
        existing.expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString()
        existing.lastHeartbeatAt = at
        existing.updatedAt = at
        await db.occupancyBatches.put(existing)
        return { batch: existing, duplicated: true, conflict: false, message: '临时预占仍有效' }
      }
      return {
        batch: existing,
        duplicated: true,
        conflict: existing.status === 'needs_confirmation',
        message:
          existing.status === 'needs_confirmation'
            ? '该批次已有登记，但营地数据有变化，请重新确认'
            : '该批次已提交过，本次重复提交未重复占名额'
      }
    }

    if (
      clientVersions &&
      (clientVersions.capacityVersion !== version.capacityVersion ||
        clientVersions.factorVersion !== version.factorVersion ||
        clientVersions.vetoVersion !== version.vetoVersion)
    ) {
      throw new OccupancyConflictError(toVersions(version))
    }

    const remaining = await remainingFor(campName, stayDate, version)
    const fits = tentCount <= remaining
    const batch: OccupancyBatch = {
      batchKey: key,
      batchNo,
      campName,
      stayDate,
      tentCount,
      contact: input.contact?.trim() || '未署名',
      status: fits ? 'held' : 'queued',
      capacityVersion: version.capacityVersion,
      factorVersion: version.factorVersion,
      vetoVersion: version.vetoVersion,
      currentCapacityVersion: version.capacityVersion,
      currentFactorVersion: version.factorVersion,
      currentVetoVersion: version.vetoVersion,
      ownerId: ownerId(),
      expiresAt: fits ? new Date(Date.now() + HOLD_TTL_MS).toISOString() : null,
      lastHeartbeatAt: fits ? at : null,
      queuePosition: 0,
      occupiedTents: fits ? tentCount : 0,
      note: input.note?.trim() ?? '',
      createdAt: at,
      updatedAt: at
    }
    if (!fits) {
      const queued = await db.occupancyBatches
        .where('status')
        .equals('queued')
        .toArray()
        .then((rows) => rows.filter((b) => b.campName === campName && b.stayDate === stayDate))
      batch.queuePosition = queued.length + 1
    }
    const id = await db.occupancyBatches.add(batch)
    return {
      batch: { ...batch, id },
      duplicated: false,
      conflict: false,
      message: fits ? '已临时预占 90 秒，请尽快确认' : '剩余容量不足，已进入排队'
    }
  })
}

async function mutateOwnedBatch(
  id: number,
  mutate: (batch: OccupancyBatch, version: CampVersion) => Promise<void> | void
): Promise<OccupancyBatch> {
  return db.transaction('rw', LEDGER_TABLES, async () => {
    const batch = await db.occupancyBatches.get(id)
    if (!batch) throw new Error('批次不存在或已被清理')
    const at = nowIso()
    const version = await ensureCampVersion(batch.campName, at)
    await reconcileDate(batch.campName, batch.stayDate, version, at, Date.now())
    const fresh = await db.occupancyBatches.get(id)
    if (!fresh) throw new Error('批次不存在或已被清理')
    await mutate(fresh, version)
    fresh.updatedAt = at
    await db.occupancyBatches.put(fresh)
    return fresh
  })
}

export async function confirmOccupancy(id: number): Promise<OccupancyBatch> {
  return mutateOwnedBatch(id, async (batch, version) => {
    if (batch.status === 'released' || batch.status === 'expired') {
      throw new Error('批次已释放，请重新登记')
    }
    setBatchVersions(batch, version)
    const remaining = await remainingFor(batch.campName, batch.stayDate, version)
    const fits = batch.tentCount <= remaining + (batch.status === 'held' ? batch.occupiedTents : 0)
    if (fits) {
      batch.status = 'confirmed'
      batch.occupiedTents = batch.tentCount
      batch.queuePosition = 0
      batch.expiresAt = null
      batch.lastHeartbeatAt = null
    } else {
      batch.status = 'queued'
      batch.occupiedTents = 0
      batch.expiresAt = null
      batch.lastHeartbeatAt = null
      const queued = await db.occupancyBatches
        .where('status')
        .equals('queued')
        .toArray()
        .then((rows) => rows.filter((b) => b.campName === batch.campName && b.stayDate === batch.stayDate))
      batch.queuePosition = queued.length + 1
    }
  })
}

export async function reconfirmOccupancy(
  id: number,
  clientVersions?: Partial<OccupancyVersions> | null
): Promise<OccupancyBatch> {
  return db.transaction('rw', LEDGER_TABLES, async () => {
    const at = nowIso()
    const stored = await db.occupancyBatches.get(id)
    if (!stored) throw new Error('批次不存在或已被清理')
    const version = await ensureCampVersion(stored.campName, at)
    if (
      clientVersions &&
      (clientVersions.capacityVersion !== version.capacityVersion ||
        clientVersions.factorVersion !== version.factorVersion ||
        clientVersions.vetoVersion !== version.vetoVersion)
    ) {
      throw new OccupancyConflictError(toVersions(version))
    }
    await reconcileDate(stored.campName, stored.stayDate, version, at, Date.now())
    const batch = await db.occupancyBatches.get(id)
    if (!batch) throw new Error('批次不存在或已被清理')
    setBatchVersions(batch, version)
    const remaining = await remainingFor(batch.campName, batch.stayDate, version)
    if (batch.tentCount <= remaining) {
      batch.status = 'confirmed'
      batch.occupiedTents = batch.tentCount
      batch.queuePosition = 0
    } else {
      batch.status = 'queued'
      batch.occupiedTents = 0
      const queued = await db.occupancyBatches
        .where('status')
        .equals('queued')
        .toArray()
        .then((rows) => rows.filter((b) => b.campName === batch.campName && b.stayDate === batch.stayDate))
      batch.queuePosition = queued.length + 1
    }
    batch.expiresAt = null
    batch.lastHeartbeatAt = null
    batch.updatedAt = at
    await db.occupancyBatches.put(batch)
    return batch
  })
}

export async function releaseOccupancy(
  id: number,
  reason: 'released' | 'expired' = 'released'
): Promise<void> {
  await db.transaction('rw', LEDGER_TABLES, async () => {
    const batch = await db.occupancyBatches.get(id)
    if (!batch || batch.status === 'released' || batch.status === 'expired') return
    const at = nowIso()
    const version = await ensureCampVersion(batch.campName, at)
    batch.status = reason
    batch.occupiedTents = 0
    batch.queuePosition = 0
    batch.expiresAt = null
    batch.lastHeartbeatAt = null
    batch.updatedAt = at
    await db.occupancyBatches.put(batch)
    // 释放后立即重排同日队列，让下一批在同一事务内递补。
    await reconcileDate(batch.campName, batch.stayDate, version, nowIso(), Date.now())
  })
}

export async function heartbeatOwnerHolds(): Promise<number> {
  const owner = ownerId()
  return db.transaction('rw', db.occupancyBatches, db.campVersions, async () => {
    const at = nowIso()
    const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString()
    const rows = await db.occupancyBatches
      .where('ownerId')
      .equals(owner)
      .filter((b) => b.status === 'held')
      .toArray()
    for (const batch of rows) {
      batch.lastHeartbeatAt = at
      batch.expiresAt = expiresAt
      batch.updatedAt = at
    }
    if (rows.length) await db.occupancyBatches.bulkPut(rows)
    return rows.length
  })
}

export async function releaseOwnerHoldsOnUnload(): Promise<void> {
  const owner = ownerId()
  await db.occupancyBatches
    .where('ownerId')
    .equals(owner)
    .filter((b) => b.status === 'held')
    .modify((b) => {
      b.status = 'released'
      b.occupiedTents = 0
      b.queuePosition = 0
      b.expiresAt = null
      b.lastHeartbeatAt = null
      b.updatedAt = nowIso()
    })
}

export async function bumpCampVersions(campNames: string[], kind: VersionKind): Promise<void> {
  const names = Array.from(new Set(campNames.map((n) => n?.trim()).filter(Boolean)))
  if (!names.length) return
  await db.transaction('rw', db.campVersions, db.occupancyBatches, async () => {
    const at = nowIso()
    const map = await ensureCampVersions(names, at)
    for (const campName of names) {
      const version = map.get(campName)
      if (!version) continue
      if (kind === 'capacity') version.capacityVersion += 1
      if (kind === 'factor') version.factorVersion += 1
      if (kind === 'veto') version.vetoVersion += 1
      version.updatedAt = at
      await db.campVersions.put(version)

      await db.occupancyBatches
        .where('campName')
        .equals(campName)
        .filter((b) => ACTIVE_STATUSES.includes(b.status))
        .modify((b) => {
          markPending(b, version, at)
        })
    }
  })
}

export async function renameCampOccupancy(oldName: string, newName: string): Promise<void> {
  const oldCamp = oldName.trim()
  const newCamp = newName.trim()
  if (!oldCamp || oldCamp === newCamp) return
  const rows = await db.occupancyBatches.where('campName').equals(oldCamp).toArray()
  for (const row of rows) {
    row.campName = newCamp
    row.batchKey = occupancyBatchKey(newCamp, row.stayDate, row.batchNo)
    row.updatedAt = nowIso()
  }
  if (rows.length) await db.occupancyBatches.bulkPut(rows)
}

const OCCUPANCY_CHANNEL = 'gbcampsite-occupancy'
const OCCUPANCY_EVENT = 'gbcampsite:occupancy-changed'

export function broadcastOccupancyChanged(): void {
  const payload = { at: nowIso(), owner: currentOwnerId() }
  window.dispatchEvent(new CustomEvent(OCCUPANCY_EVENT, { detail: payload }))
  try {
    const channel = new BroadcastChannel(OCCUPANCY_CHANNEL)
    channel.postMessage(payload)
    channel.close()
  } catch {
    window.localStorage.setItem(OCCUPANCY_CHANNEL, JSON.stringify(payload))
    window.localStorage.removeItem(OCCUPANCY_CHANNEL)
  }
}

export function onOccupancyChanged(listener: () => void): () => void {
  let channel: BroadcastChannel | null = null
  const handler = (): void => listener()
  const customHandler = (): void => listener()
  window.addEventListener(OCCUPANCY_EVENT, customHandler)
  try {
    channel = new BroadcastChannel(OCCUPANCY_CHANNEL)
    channel.addEventListener('message', handler)
  } catch {
    window.addEventListener('storage', handler)
  }
  return () => {
    window.removeEventListener(OCCUPANCY_EVENT, customHandler)
    if (channel) {
      channel.removeEventListener('message', handler)
      channel.close()
    } else {
      window.removeEventListener('storage', handler)
    }
  }
}

/* ------------------------------ 纯计算快照 ------------------------------ */

export function buildOccupancySnapshots(
  sites: Campsite[],
  vetos: RiskVeto[],
  batches: OccupancyBatch[],
  versions: CampVersion[]
): OccupancySnapshotRow[] {
  const vetoSet = new Set(vetos.map((v) => v.siteId))
  const versionMap = new Map(versions.map((v) => [v.campName, v]))
  const capacityMap = new Map<string, number>()
  for (const site of sites) {
    if (typeof site.id === 'number' && vetoSet.has(site.id)) continue
    capacityMap.set(site.campName, (capacityMap.get(site.campName) ?? 0) + site.tentCapacity)
  }

  return batches
    .filter((b) => ACTIVE_STATUSES.includes(b.status))
    .map((batch) => {
      const key = occupancyKey(batch.campName, batch.stayDate)
      const same = batches.filter(
        (b) => b.campName === batch.campName && b.stayDate === batch.stayDate
      )
      const capacity = capacityMap.get(batch.campName) ?? 0
      const reserved = reservedTents(capacity)
      const available = availableTents(capacity)
      const confirmedTents = same
        .filter((b) => b.status === 'confirmed')
        .reduce((sum, b) => sum + b.occupiedTents, 0)
      const heldTents = same
        .filter((b) => b.status === 'held')
        .reduce((sum, b) => sum + b.occupiedTents, 0)
      const queuedTents = same.filter((b) => b.status === 'queued').reduce((sum, b) => sum + b.tentCount, 0)
      const pendingTents = same
        .filter((b) => b.status === 'needs_confirmation')
        .reduce((sum, b) => sum + b.tentCount, 0)
      const version = versionMap.get(batch.campName)
      return {
        ...batch,
        key,
        capacity,
        reserved,
        available,
        confirmedTents,
        heldTents,
        queuedTents,
        pendingTents,
        remaining: available - confirmedTents - heldTents,
        currentCapacityVersion: version?.capacityVersion ?? batch.currentCapacityVersion,
        currentFactorVersion: version?.factorVersion ?? batch.currentFactorVersion,
        currentVetoVersion: version?.vetoVersion ?? batch.currentVetoVersion
      }
    })
}

export function summarizeOccupancy(rows: OccupancySnapshotRow[]): OccupancySummary[] {
  const map = new Map<string, OccupancySnapshotRow[]>()
  for (const row of rows) {
    const list = map.get(row.key) ?? []
    list.push(row)
    map.set(row.key, list)
  }
  return Array.from(map.values()).map((list) => {
    const first = list[0]
    return {
      campName: first.campName,
      stayDate: first.stayDate,
      capacity: first.capacity,
      reserved: first.reserved,
      available: first.available,
      confirmedTents: first.confirmedTents,
      heldTents: first.heldTents,
      queuedTents: first.queuedTents,
      pendingTents: first.pendingTents,
      remaining: first.remaining,
      confirmedBatches: list.filter((b) => b.status === 'confirmed').length,
      queuedBatches: list.filter((b) => b.status === 'queued').length,
      pendingBatches: list.filter((b) => b.status === 'needs_confirmation').length,
      versions: {
        capacityVersion: first.currentCapacityVersion ?? 1,
        factorVersion: first.currentFactorVersion ?? 1,
        vetoVersion: first.currentVetoVersion ?? 1
      }
    }
  })
}
