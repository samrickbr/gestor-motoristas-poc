import {
  materializeEntries,
  operationFingerprint,
  validateOperation,
  type JournalEntry,
  type Operation,
} from '../domain'
import type { OutboxEvent, StoredOperation, SyncState } from '../storage/ledgerRepository'
import { canonicalizeJson } from './canonicalJson'

export interface FinanceSnapshot {
  schemaVersion: 4
  operations: StoredOperation[]
  entries: JournalEntry[]
  outbox: OutboxEvent[]
  sync_state: SyncState[]
}

export interface SnapshotCounts {
  operations: number
  entries: number
  outbox: number
  sync_state: number
}

export interface CanonicalSnapshot {
  readonly json: string
  readonly bytes: Uint8Array
}

export const MAX_SNAPSHOT_RECORDS_PER_STORE = 100_000

export function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

export function canonicalizeSnapshot(snapshot: FinanceSnapshot): CanonicalSnapshot {
  const canonical = {
    schemaVersion: snapshot.schemaVersion,
    stores: {
      entries: [...snapshot.entries].sort((a, b) => compareString(a.id, b.id)),
      operations: [...snapshot.operations].sort((a, b) => compareString(a.id, b.id)),
      outbox: [...snapshot.outbox].sort((a, b) => a.sequence - b.sequence),
      sync_state: [...snapshot.sync_state].sort((a, b) => compareString(a.key, b.key)),
    },
  }
  const json = canonicalizeJson(canonical)
  return { json, bytes: new TextEncoder().encode(json) }
}

export async function digestSnapshot(snapshot: FinanceSnapshot): Promise<string> {
  const bytes = canonicalizeSnapshot(snapshot).bytes
  const digest = await requireSubtleCrypto().digest('SHA-256', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  return bytesToHex(new Uint8Array(digest))
}

export function validateFinanceSnapshot(snapshot: FinanceSnapshot): SnapshotCounts {
  if (!snapshot || snapshot.schemaVersion !== 4) throw new Error('Schema de snapshot incompatível.')
  assertExactKeys(snapshot, ['schemaVersion', 'operations', 'entries', 'outbox', 'sync_state'], 'snapshot')
  if (!Array.isArray(snapshot.operations) || !Array.isArray(snapshot.entries) ||
      !Array.isArray(snapshot.outbox) || !Array.isArray(snapshot.sync_state)) {
    throw new Error('Snapshot não contém as quatro stores esperadas.')
  }
  if ([snapshot.operations, snapshot.entries, snapshot.outbox, snapshot.sync_state]
    .some((rows) => rows.length > MAX_SNAPSHOT_RECORDS_PER_STORE)) {
    throw new Error('Quantidade de registros excede o limite do backup.')
  }

  const operationById = new Map<string, StoredOperation>()
  const idempotencyKeys = new Set<string>()
  const reversalSources = new Set<string>()
  for (const stored of snapshot.operations) {
    assertExactKeys(stored, ['id', 'idempotencyKey', 'type', 'description', 'createdAt', 'entries', 'fingerprint'], 'operation', ['reversesOperationId'])
    validateOperation(stored)
    if (!isCanonicalIsoDate(stored.createdAt)) throw new Error(`Data ISO UTC não canônica na operação ${stored.id}.`)
    if (operationById.has(stored.id)) throw new Error('ID de operação duplicado no snapshot.')
    if (idempotencyKeys.has(stored.idempotencyKey)) throw new Error('Chave de idempotência duplicada no snapshot.')
    if (!stored.fingerprint || stored.fingerprint !== operationFingerprint(stored)) {
      throw new Error(`Fingerprint inválido na operação ${stored.id}.`)
    }
    if (stored.reversesOperationId) {
      if (reversalSources.has(stored.reversesOperationId)) throw new Error('Mais de um estorno para a mesma operação.')
      reversalSources.add(stored.reversesOperationId)
    }
    operationById.set(stored.id, stored)
    canonicalizeJson(stored)
  }
  for (const reversal of snapshot.operations) {
    if (!reversal.reversesOperationId) continue
    const original = operationById.get(reversal.reversesOperationId)
    if (!original || original.type === 'reversal' || reversal.entries.length !== original.entries.length) {
      throw new Error(`Relação de estorno inválida na operação ${reversal.id}.`)
    }
    const exactInverse = original.entries.every((entry, index) => {
      const inverse = reversal.entries[index]
      return inverse !== undefined && inverse.accountId === entry.accountId &&
        inverse.currency === entry.currency && inverse.amountCents === entry.amountCents &&
        inverse.side === (entry.side === 'debit' ? 'credit' : 'debit')
    })
    if (!exactInverse) throw new Error(`Partidas de estorno divergentes na operação ${reversal.id}.`)
  }

  const expectedEntries = snapshot.operations.flatMap((operation) => materializeEntries(operation))
  const actualEntries = [...snapshot.entries]
  const expectedEntryMap = uniqueBy(expectedEntries, (entry) => entry.id, 'Partida derivada duplicada.')
  const actualEntryMap = uniqueBy(actualEntries, (entry) => entry.id, 'ID de partida duplicado.')
  for (const entry of actualEntries) {
    assertExactKeys(entry, ['id', 'operationId', 'accountId', 'side', 'amountCents', 'currency'], 'entry')
  }
  if (expectedEntryMap.size !== actualEntryMap.size) throw new Error('Quantidade de partidas não corresponde às operações.')
  for (const [id, expected] of expectedEntryMap) {
    const actual = actualEntryMap.get(id)
    if (!actual || canonicalizeJson(actual) !== canonicalizeJson(expected)) {
      throw new Error(`Partida divergente ou ausente: ${id}.`)
    }
  }

  const outboxBySequence = new Map<number, OutboxEvent>()
  const eventIds = new Set<string>()
  for (const event of snapshot.outbox) {
    assertExactKeys(event, ['eventId', 'sequence', 'operationId', 'createdAt', 'status', 'snapshot'], 'outbox event', ['acknowledgedAt'])
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || outboxBySequence.has(event.sequence)) {
      throw new Error('Sequência de outbox inválida ou duplicada.')
    }
    if (!event.eventId.trim() || eventIds.has(event.eventId)) throw new Error('ID de evento da outbox inválido ou duplicado.')
    if (event.status !== 'pending' && event.status !== 'acked') throw new Error('Status de evento inválido.')
    if (!isCanonicalIsoDate(event.createdAt)) throw new Error('Data ISO UTC não canônica no evento de outbox.')
    if (event.status === 'acked' && (!event.acknowledgedAt || !isCanonicalIsoDate(event.acknowledgedAt))) {
      throw new Error('Data de ACK ausente ou não canônica em ISO UTC.')
    }
    if (event.status === 'pending' && event.acknowledgedAt !== undefined) {
      throw new Error('Evento pendente não pode ter data de ACK.')
    }
    const operation = operationById.get(event.operationId)
    if (!operation) throw new Error(`Evento aponta para operação inexistente: ${event.operationId}.`)
    if (canonicalizeJson(event.snapshot) !== canonicalizeJson(operationForOutbox(operation)) ||
        event.createdAt !== operation.createdAt) {
      throw new Error(`Snapshot do evento diverge da operação ${event.operationId}.`)
    }
    outboxBySequence.set(event.sequence, event)
    eventIds.add(event.eventId)
    canonicalizeJson(event)
  }

  const eventCount = snapshot.outbox.length
  for (let sequence = 1; sequence <= eventCount; sequence++) {
    if (!outboxBySequence.has(sequence)) throw new Error('Sequências da outbox possuem lacuna.')
  }
  if (snapshot.outbox.some((event) => event.sequence > eventCount)) throw new Error('Sequência da outbox fora do intervalo contínuo.')

  if (snapshot.sync_state.length !== 1 || snapshot.sync_state[0].key !== 'state') {
    throw new Error('A store sync_state deve conter exatamente o registro state.')
  }
  const syncState = snapshot.sync_state[0]
  assertExactKeys(syncState, ['key', 'nextSequence', 'cursor'], 'sync_state')
  if (!Number.isSafeInteger(syncState.nextSequence) || syncState.nextSequence !== eventCount + 1 ||
      !Number.isSafeInteger(syncState.cursor) || syncState.cursor < 0 || syncState.cursor > eventCount) {
    throw new Error('nextSequence ou cursor inválido.')
  }
  let continuousAckCursor = 0
  while (outboxBySequence.get(continuousAckCursor + 1)?.status === 'acked') continuousAckCursor++
  if (syncState.cursor !== continuousAckCursor) throw new Error('Cursor não corresponde ao prefixo contínuo de ACKs.')

  return {
    operations: snapshot.operations.length,
    entries: snapshot.entries.length,
    outbox: snapshot.outbox.length,
    sync_state: snapshot.sync_state.length,
  }
}

export function requireSubtleCrypto(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto indisponível. Abra a aplicação em um contexto seguro (HTTPS).')
  }
  return globalThis.crypto.subtle
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

function uniqueBy<T>(items: readonly T[], keyOf: (item: T) => string, error: string): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items) {
    const key = keyOf(item)
    if (map.has(key)) throw new Error(error)
    map.set(key, item)
  }
  return map
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertExactKeys(
  value: object,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(value).sort(compareString)
  const expected = [...required, ...optional.filter((key) => Object.hasOwn(value, key))].sort(compareString)
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Campos incompatíveis em ${label}.`)
  }
}

function operationForOutbox(operation: StoredOperation): Operation {
  return {
    id: operation.id,
    idempotencyKey: operation.idempotencyKey,
    type: operation.type,
    description: operation.description,
    createdAt: operation.createdAt,
    ...(operation.reversesOperationId ? { reversesOperationId: operation.reversesOperationId } : {}),
    entries: operation.entries,
  }
}
