import {
  materializeEntries,
  operationFingerprint,
  reconstructBalances,
  validateOperation,
  type BalanceProjection,
  type JournalEntry,
  type Operation,
} from '../domain'
import { createUuidV4 } from '../../utils/uuid'

export interface StoredOperation extends Operation {
  fingerprint: string
}

export type OutboxStatus = 'pending' | 'acked'

export interface OutboxEvent {
  eventId: string
  sequence: number
  operationId: string
  createdAt: string
  status: OutboxStatus
  snapshot: Operation
  acknowledgedAt?: string
}

export interface SyncState {
  key: 'state'
  nextSequence: number
  cursor: number
}

export interface LedgerRepositoryOptions {
  databaseName?: string
  /** Test seam for pausing before the IndexedDB open request begins. */
  beforeDatabaseOpen?: () => Promise<void>
  /** Test seam for observing and controlling open requests. */
  createOpenRequest?: (databaseName: string, version: number) => IDBOpenDBRequest
  /** Test seam for simulating a failure between operation and entry writes. */
  beforeEntryWrite?: () => void
  /** Test seam for simulating a failure before the outbox write. */
  beforeOutboxWrite?: () => void
  createEventId?: () => string
}

export interface LedgerRepository {
  commit(operation: Operation): Promise<{ operation: Operation; duplicate: boolean }>
  getOperations(): Promise<Operation[]>
  getEntries(): Promise<JournalEntry[]>
  getBalanceProjection(): Promise<BalanceProjection[]>
  getOutboxEvents(): Promise<OutboxEvent[]>
  getPendingOutbox(limit?: number): Promise<OutboxEvent[]>
  acknowledgeEvents(eventIds: readonly string[], acknowledgedAt?: string): Promise<number>
  getOutboxCursor(): Promise<number>
  createConsistentSnapshot(): Promise<{
    schemaVersion: 4
    operations: StoredOperation[]
    entries: JournalEntry[]
    outbox: OutboxEvent[]
    sync_state: SyncState[]
  }>
  close(): void
}

const DEFAULT_DATABASE_NAME = 'gestor-motoristas-ledger'
const DATABASE_VERSION = 4
const OPERATIONS_STORE = 'operations'
const ENTRIES_STORE = 'entries'
const OUTBOX_STORE = 'outbox'
const SYNC_STATE_STORE = 'sync_state'

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Falha no IndexedDB.'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('Transação cancelada.'))
    transaction.onerror = () => reject(transaction.error ?? new Error('Falha na transação.'))
  })
}

export function createLedgerRepository(options: LedgerRepositoryOptions = {}): LedgerRepository {
  const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME
  let databasePromise: Promise<IDBDatabase> | null = null

  function openDatabase(): Promise<IDBDatabase> {
    if (databasePromise) return databasePromise
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(new Error('IndexedDB não está disponível neste navegador.'))
    }

    let settled = false
    let fail!: (error: Error) => void
    let beginOpen!: () => void
    const attemptPromise = new Promise<IDBDatabase>((resolve, reject) => {
      fail = (error: Error) => {
        if (settled) return
        settled = true
        if (databasePromise === attemptPromise) databasePromise = null
        reject(error)
      }
      beginOpen = () => {
        if (settled) return
        let request: IDBOpenDBRequest
        try {
          request = options.createOpenRequest?.(databaseName, DATABASE_VERSION) ??
            indexedDB.open(databaseName, DATABASE_VERSION)
        } catch (error) {
          fail(error instanceof Error ? error : new Error('Falha ao abrir o diário financeiro.'))
          return
        }
        request.onupgradeneeded = () => {
          const db = request.result
          const operations = db.objectStoreNames.contains(OPERATIONS_STORE)
            ? request.transaction!.objectStore(OPERATIONS_STORE)
            : db.createObjectStore(OPERATIONS_STORE, { keyPath: 'id' })
          if (!operations.indexNames.contains('idempotencyKey')) {
            operations.createIndex('idempotencyKey', 'idempotencyKey', { unique: true })
          }
          if (operations.indexNames.contains('reversesOperationId') &&
              !operations.index('reversesOperationId').unique) {
            operations.deleteIndex('reversesOperationId')
          }
          if (!operations.indexNames.contains('reversesOperationId')) {
            operations.createIndex('reversesOperationId', 'reversesOperationId', { unique: true })
          }
          const entries = db.objectStoreNames.contains(ENTRIES_STORE)
            ? request.transaction!.objectStore(ENTRIES_STORE)
            : db.createObjectStore(ENTRIES_STORE, { keyPath: 'id' })
          if (!entries.indexNames.contains('operationId')) entries.createIndex('operationId', 'operationId')
          const outbox = db.objectStoreNames.contains(OUTBOX_STORE)
            ? request.transaction!.objectStore(OUTBOX_STORE)
            : db.createObjectStore(OUTBOX_STORE, { keyPath: 'sequence' })
          if (!outbox.indexNames.contains('eventId')) outbox.createIndex('eventId', 'eventId', { unique: true })
          if (!outbox.indexNames.contains('status')) outbox.createIndex('status', 'status')
          const hasSyncState = db.objectStoreNames.contains(SYNC_STATE_STORE)
          const syncState = hasSyncState
            ? request.transaction!.objectStore(SYNC_STATE_STORE)
            : db.createObjectStore(SYNC_STATE_STORE, { keyPath: 'key' })
          if (!hasSyncState) {
            syncState.put({ key: 'state', nextSequence: 1, cursor: 0 } satisfies SyncState)
          }
        }
        request.onsuccess = () => {
          const db = request.result
          if (settled || databasePromise !== attemptPromise) {
            db.close()
            return
          }
          settled = true
          db.onversionchange = () => {
            db.close()
            if (databasePromise === attemptPromise) databasePromise = null
          }
          resolve(db)
        }
        request.onerror = () => {
          fail(request.error ?? new Error('Falha ao abrir o diário financeiro.'))
        }
        request.onblocked = () => {
          fail(new Error('A abertura do diário foi bloqueada por outra conexão.'))
        }
      }
    })
    databasePromise = attemptPromise
    try {
      if (options.beforeDatabaseOpen) {
        void options.beforeDatabaseOpen().then(beginOpen, (error: unknown) => {
          fail(error instanceof Error ? error : new Error('Falha ao preparar a abertura do diário.'))
        })
      } else {
        beginOpen()
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error('Falha ao preparar a abertura do diário.'))
    }
    return attemptPromise
  }

  async function readAll<T>(storeName: string): Promise<T[]> {
    const db = await openDatabase()
    const tx = db.transaction(storeName, 'readonly')
    const done = transactionDone(tx)
    const rows = await requestResult(tx.objectStore(storeName).getAll()) as T[]
    await done
    return rows
  }

  return {
    async commit(operation) {
      const committedOperation = copyOperation(operation)
      validateOperation(committedOperation)
      const fingerprint = operationFingerprint(committedOperation)
      const snapshot = cloneOperation(committedOperation)
      const db = await openDatabase()
      const tx = db.transaction([OPERATIONS_STORE, ENTRIES_STORE, OUTBOX_STORE, SYNC_STATE_STORE], 'readwrite')
      const done = transactionDone(tx)
      let outcome: { operation: Operation; duplicate: boolean } | undefined
      let explicitFailure: Error | undefined
      const operations = tx.objectStore(OPERATIONS_STORE)
      const entries = tx.objectStore(ENTRIES_STORE)
      const outbox = tx.objectStore(OUTBOX_STORE)
      const syncState = tx.objectStore(SYNC_STATE_STORE)
      const lookup = operations.index('idempotencyKey').get(committedOperation.idempotencyKey)

      const writeOperation = () => {
        try {
          operations.add({ ...committedOperation, fingerprint })
          options.beforeEntryWrite?.()
          for (const entry of materializeEntries(committedOperation)) entries.add(entry)
          options.beforeOutboxWrite?.()
          const stateRequest = syncState.get('state')
          stateRequest.onsuccess = () => {
            try {
              const state = stateRequest.result as SyncState | undefined
              if (!state || !Number.isSafeInteger(state.nextSequence) || state.nextSequence < 1) {
                throw new Error('Estado de sequência da outbox inválido.')
              }
              const sequence = state.nextSequence
              const event: OutboxEvent = {
                eventId: (options.createEventId ?? createUuidV4)(),
                sequence,
                operationId: committedOperation.id,
                createdAt: committedOperation.createdAt,
                status: 'pending',
                snapshot,
              }
              if (!event.eventId.trim()) throw new Error('UUID do evento da outbox inválido.')
              outbox.add(event)
              syncState.put({ ...state, nextSequence: sequence + 1 })
              outcome = { operation: committedOperation, duplicate: false }
            } catch {
              try { tx.abort() } catch { /* already aborted */ }
            }
          }
          outcome = { operation: committedOperation, duplicate: false }
        } catch {
          try { tx.abort() } catch { /* already aborted */ }
        }
      }

      lookup.onsuccess = () => {
        const existing = lookup.result as StoredOperation | undefined
        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            explicitFailure = new Error('A chave de idempotência já foi usada por outra operação.')
            try { tx.abort() } catch { /* already aborted */ }
            return
          }
          outcome = { operation: stripFingerprint(existing), duplicate: true }
          return
        }
        if (!committedOperation.reversesOperationId) {
          writeOperation()
          return
        }
        const sourceId = committedOperation.reversesOperationId
        const source = operations.get(sourceId)
        source.onsuccess = () => {
          if (!source.result) {
            explicitFailure = new Error('A operação original do estorno não foi encontrada.')
            try { tx.abort() } catch { /* already aborted */ }
            return
          }
          const original = source.result as StoredOperation
          if (original.type === 'reversal') {
            explicitFailure = new Error('Não é permitido estornar uma operação de estorno.')
            try { tx.abort() } catch { /* already aborted */ }
            return
          }
          if (!isExactReversal(committedOperation, original)) {
            explicitFailure = new Error('As partidas do estorno devem inverter exatamente as partidas originais.')
            try { tx.abort() } catch { /* already aborted */ }
            return
          }
          const priorReversal = operations.index('reversesOperationId').getKey(sourceId)
          priorReversal.onsuccess = () => {
            if (priorReversal.result !== undefined) {
              explicitFailure = new Error('A operação original já possui estorno integral.')
              try { tx.abort() } catch { /* already aborted */ }
              return
            }
            writeOperation()
          }
        }
      }

      try {
        await done
      } catch (error) {
        if (explicitFailure) throw explicitFailure
        if (error instanceof DOMException && error.name === 'ConstraintError') {
          throw new Error('Uma chave ou identificador único já foi usado por outra operação.', { cause: error })
        }
        throw error
      }
      if (!outcome) {
        throw new Error('A chave de idempotência já foi usada por outra operação.')
      }
      return outcome
    },

    async getOperations() {
      const stored = await readAll<StoredOperation>(OPERATIONS_STORE)
      return stored.map(stripFingerprint).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    },

    getEntries() {
      return readAll<JournalEntry>(ENTRIES_STORE)
    },

    async getOutboxEvents() {
      return (await readAll<OutboxEvent>(OUTBOX_STORE)).sort((a, b) => a.sequence - b.sequence)
    },

    async getPendingOutbox(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('O limite do lote deve ser um inteiro positivo.')
      return (await readAll<OutboxEvent>(OUTBOX_STORE))
        .filter((event) => event.status === 'pending')
        .sort((a, b) => a.sequence - b.sequence)
        .slice(0, limit)
    },

    async acknowledgeEvents(eventIds, acknowledgedAt = new Date().toISOString()) {
      if (!Array.isArray(eventIds) || eventIds.some((id) => typeof id !== 'string' || !id.trim()) ||
          new Set(eventIds).size !== eventIds.length) {
        throw new Error('ACK inválido: IDs de evento ausentes ou repetidos.')
      }
      if (Number.isNaN(Date.parse(acknowledgedAt))) throw new Error('Data de ACK inválida.')
      const db = await openDatabase()
      const tx = db.transaction([OUTBOX_STORE, SYNC_STATE_STORE], 'readwrite')
      const done = transactionDone(tx)
      const outbox = tx.objectStore(OUTBOX_STORE)
      const syncState = tx.objectStore(SYNC_STATE_STORE)
      let explicitFailure: Error | undefined
      let cursor = 0
      const allRequest = outbox.getAll()
      allRequest.onsuccess = () => {
        try {
          const events = allRequest.result as OutboxEvent[]
          const byId = new Map(events.map((event) => [event.eventId, event]))
          const selected = eventIds.map((id) => byId.get(id))
          if (selected.some((event) => !event)) throw new Error('ACK inválido: evento desconhecido.')
          for (const event of selected as OutboxEvent[]) {
            if (event.status !== 'acked') outbox.put({ ...event, status: 'acked', acknowledgedAt })
          }
          const stateRequest = syncState.get('state')
          stateRequest.onsuccess = () => {
            try {
              const state = stateRequest.result as SyncState
              const statusBySequence = new Map(events.map((event) => [event.sequence, event.status]))
              for (const event of selected as OutboxEvent[]) statusBySequence.set(event.sequence, 'acked')
              cursor = state.cursor
              while (statusBySequence.get(cursor + 1) === 'acked') cursor++
              syncState.put({ ...state, cursor })
            } catch (error) {
              explicitFailure = error instanceof Error ? error : new Error('Falha ao validar ACK.')
              try { tx.abort() } catch { /* already aborted */ }
            }
          }
        } catch (error) {
          explicitFailure = error instanceof Error ? error : new Error('Falha ao validar ACK.')
          try { tx.abort() } catch { /* already aborted */ }
        }
      }
      try {
        await done
      } catch (error) {
        if (explicitFailure) throw explicitFailure
        throw error
      }
      return cursor
    },

    async getOutboxCursor() {
      const db = await openDatabase()
      const tx = db.transaction(SYNC_STATE_STORE, 'readonly')
      const done = transactionDone(tx)
      const row = await requestResult(tx.objectStore(SYNC_STATE_STORE).get('state')) as SyncState | undefined
      await done
      return row?.cursor ?? 0
    },

    async createConsistentSnapshot() {
      const db = await openDatabase()
      const tx = db.transaction(
        [OPERATIONS_STORE, ENTRIES_STORE, OUTBOX_STORE, SYNC_STATE_STORE],
        'readonly',
      )
      const done = transactionDone(tx)
      const reads = Promise.all([
        requestResult(tx.objectStore(OPERATIONS_STORE).getAll()) as Promise<StoredOperation[]>,
        requestResult(tx.objectStore(ENTRIES_STORE).getAll()) as Promise<JournalEntry[]>,
        requestResult(tx.objectStore(OUTBOX_STORE).getAll()) as Promise<OutboxEvent[]>,
        requestResult(tx.objectStore(SYNC_STATE_STORE).getAll()) as Promise<SyncState[]>,
      ])
      const [operations, entries, outbox, sync_state] = await Promise.all([reads, done]).then(([rows]) => rows)
      return { schemaVersion: 4, operations, entries, outbox, sync_state }
    },

    async getBalanceProjection() {
      return reconstructBalances(await readAll<JournalEntry>(ENTRIES_STORE))
    },

    close() {
      if (!databasePromise) return
      void databasePromise.then((db) => db.close()).catch(() => undefined)
      databasePromise = null
    },
  }
}

function stripFingerprint(row: StoredOperation): Operation {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    type: row.type,
    description: row.description,
    createdAt: row.createdAt,
    ...(row.reversesOperationId ? { reversesOperationId: row.reversesOperationId } : {}),
    entries: row.entries,
  }
}

function cloneOperation(operation: Operation): Operation {
  return {
    ...operation,
    entries: operation.entries.map((entry) => ({ ...entry })),
  }
}

function copyOperation(operation: Operation): Operation {
  if (operation === null || typeof operation !== 'object') return operation
  const entries: unknown = (operation as Operation & { entries?: unknown }).entries
  return {
    ...operation,
    entries: Array.isArray(entries)
      ? entries.map((entry: unknown) => entry !== null && typeof entry === 'object' ? { ...entry } : entry)
      : entries,
  } as Operation
}

function isExactReversal(reversal: Operation, original: Operation): boolean {
  if (reversal.entries.length !== original.entries.length) return false
  return original.entries.every((entry, index) => {
    const reversed = reversal.entries[index]
    return reversed !== undefined &&
      reversed.accountId === entry.accountId &&
      reversed.currency === entry.currency &&
      reversed.amountCents === entry.amountCents &&
      reversed.side === (entry.side === 'debit' ? 'credit' : 'debit')
  })
}
