import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { createOperation, operationFingerprint, reverseOperation, type Operation, type OperationInput } from './domain'
import { createLedgerRepository, type LedgerRepository, type LedgerRepositoryOptions } from './storage/ledgerRepository'
import { createUuidV4 } from '../utils/uuid'

const databaseNames: string[] = []
const repositories: LedgerRepository[] = []

function repository(options: LedgerRepositoryOptions) {
  const instance = createLedgerRepository(options)
  repositories.push(instance)
  return instance
}

function makeOperation(overrides: Partial<OperationInput> = {}) {
  return createOperation({
    id: createUuidV4(), idempotencyKey: 'receipt-100', type: 'revenue',
    description: 'Receita de teste', createdAt: '2026-01-01T12:00:00.000Z',
    entries: [
      { accountId: 'cash', side: 'debit', amountCents: 10000, currency: 'BRL' },
      { accountId: 'revenue', side: 'credit', amountCents: 10000, currency: 'BRL' },
    ],
    ...overrides,
  })
}

function newDatabaseName() {
  const name = `ledger-test-${createUuidV4()}`
  databaseNames.push(name)
  return name
}

async function createLegacyV3Database(databaseName: string, operation: ReturnType<typeof makeOperation>) {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 3)
    request.onupgradeneeded = () => {
      const db = request.result
      const operations = db.createObjectStore('operations', { keyPath: 'id' })
      operations.createIndex('idempotencyKey', 'idempotencyKey', { unique: true })
      operations.createIndex('reversesOperationId', 'reversesOperationId', { unique: true })
      const entries = db.createObjectStore('entries', { keyPath: 'id' })
      entries.createIndex('operationId', 'operationId')
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(['operations', 'entries'], 'readwrite')
      tx.objectStore('operations').add({ ...operation, fingerprint: operationFingerprint(operation) })
      for (const [index, entry] of operation.entries.entries()) {
        tx.objectStore('entries').add({ ...entry, id: `${operation.id}:${index}`, operationId: operation.id })
      }
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
  })
}

async function createLegacyV3Connection(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 3)
    request.onupgradeneeded = () => {
      const db = request.result
      const operations = db.createObjectStore('operations', { keyPath: 'id' })
      operations.createIndex('idempotencyKey', 'idempotencyKey', { unique: true })
      operations.createIndex('reversesOperationId', 'reversesOperationId', { unique: true })
      const entries = db.createObjectStore('entries', { keyPath: 'id' })
      entries.createIndex('operationId', 'operationId')
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

function readSyncState(database: IDBDatabase): Promise<{ key: string; nextSequence: number; cursor: number } | undefined> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction('sync_state', 'readonly')
    const request = tx.objectStore('sync_state').get('state')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

afterEach(async () => {
  for (const repo of repositories.splice(0)) repo.close()
  for (const name of databaseNames.splice(0)) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
      request.onblocked = () => resolve()
    })
  }
})

describe('adaptador IndexedDB do diário', () => {
  it('grava operação e partidas; saldos são projeção das partidas', async () => {
    const repo = repository({ databaseName: newDatabaseName() })
    const result = await repo.commit(makeOperation())
    expect(result.duplicate).toBe(false)
    expect(await repo.getOperations()).toHaveLength(1)
    expect(await repo.getEntries()).toHaveLength(2)
    const outbox = await repo.getOutboxEvents()
    expect(outbox).toHaveLength(1)
    expect(outbox[0].status).toBe('pending')
    expect(outbox[0].eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(outbox[0].sequence).toBe(1)
    expect(outbox[0].snapshot).toEqual(result.operation)
    outbox[0].snapshot.entries[0].amountCents = 1
    expect((await repo.getOutboxEvents())[0].snapshot.entries[0].amountCents).toBe(10000)
    expect((await repo.getBalanceProjection()).find((balance) => balance.accountId === 'cash')?.amountCents).toBe(10000)
    repo.close()
  })

  it('registra receita, despesa e transferência com UUIDs v4 na outbox', async () => {
    const repo = repository({ databaseName: newDatabaseName() })
    await repo.commit(makeOperation({ idempotencyKey: 'uuid-revenue', type: 'revenue' }))
    await repo.commit(makeOperation({
      idempotencyKey: 'uuid-expense', type: 'expense',
      entries: [
        { accountId: 'expenses', side: 'debit', amountCents: 3000, currency: 'BRL' },
        { accountId: 'cash', side: 'credit', amountCents: 3000, currency: 'BRL' },
      ],
    }))
    await repo.commit(makeOperation({
      idempotencyKey: 'uuid-transfer', type: 'transfer',
      entries: [
        { accountId: 'reserve', side: 'debit', amountCents: 2000, currency: 'BRL' },
        { accountId: 'cash', side: 'credit', amountCents: 2000, currency: 'BRL' },
      ],
    }))

    expect(await repo.getOperations()).toHaveLength(3)
    const events = await repo.getOutboxEvents()
    expect(events).toHaveLength(3)
    expect(events.every((event) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.eventId))).toBe(true)
    expect(new Set(events.map((event) => event.eventId)).size).toBe(3)
    repo.close()
  })

  it('mantém idempotência depois de fechar e reabrir o banco', async () => {
    const databaseName = newDatabaseName()
    const repo = repository({ databaseName })
    const operation = makeOperation()
    await repo.commit(operation)
    repo.close()

    const reopened = repository({ databaseName })
    const result = await reopened.commit(makeOperation({
      idempotencyKey: operation.idempotencyKey,
    }))
    expect(result.duplicate).toBe(true)
    expect(await reopened.getOperations()).toHaveLength(1)
    expect(await reopened.getEntries()).toHaveLength(2)
    expect(await reopened.getOutboxEvents()).toHaveLength(1)
    reopened.close()
  })

  it('rejeita reutilização da chave com conteúdo diferente', async () => {
    const repo = repository({ databaseName: newDatabaseName() })
    await repo.commit(makeOperation())
    await expect(repo.commit(makeOperation({
      idempotencyKey: 'receipt-100',
      entries: [
        { accountId: 'cash', side: 'debit', amountCents: 5000, currency: 'BRL' },
        { accountId: 'revenue', side: 'credit', amountCents: 5000, currency: 'BRL' },
      ],
    }))).rejects.toThrow(/chave de idempotência/)
    expect(await repo.getOperations()).toHaveLength(1)
    repo.close()
  })

  it('permite no máximo um estorno integral por operação', async () => {
    const repo = repository({ databaseName: newDatabaseName() })
    const original = makeOperation()
    await repo.commit(original)
    await repo.commit(reverseOperation(original, 'reversal-1', 'reversal-key-1', '2026-01-02T12:00:00.000Z'))
    await expect(repo.commit(reverseOperation(original, 'reversal-2', 'reversal-key-2', '2026-01-03T12:00:00.000Z')))
      .rejects.toThrow(/já possui estorno/)
    expect(await repo.getOperations()).toHaveLength(2)
    expect(await repo.getEntries()).toHaveLength(4)
  })

  it('rejeita estorno com valores ou contas diferentes das partidas originais', async () => {
    const repo = repository({ databaseName: newDatabaseName() })
    const original = makeOperation()
    await repo.commit(original)

    const changedValues = reverseOperation(original, 'reversal-values', 'reversal-values-key', '2026-01-02T12:00:00.000Z')
    changedValues.entries[0].amountCents = 5000
    changedValues.entries[1].amountCents = 5000
    await expect(repo.commit(changedValues)).rejects.toThrow(/inverter exatamente/)

    const changedAccounts = reverseOperation(original, 'reversal-accounts', 'reversal-accounts-key', '2026-01-03T12:00:00.000Z')
    changedAccounts.entries[0].accountId = 'different-cash'
    changedAccounts.entries[1].accountId = 'different-revenue'
    await expect(repo.commit(changedAccounts)).rejects.toThrow(/inverter exatamente/)
    expect(await repo.getOperations()).toHaveLength(1)
    expect(await repo.getEntries()).toHaveLength(2)
  })

  it('serializa dois estornos concorrentes e confirma apenas um', async () => {
    const repo = repository({ databaseName: newDatabaseName() })
    const original = makeOperation()
    await repo.commit(original)
    const first = reverseOperation(original, 'concurrent-reversal-1', 'concurrent-key-1', '2026-01-02T12:00:00.000Z')
    const second = reverseOperation(original, 'concurrent-reversal-2', 'concurrent-key-2', '2026-01-02T12:00:01.000Z')

    const results = await Promise.allSettled([repo.commit(first), repo.commit(second)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await repo.getOperations()).toHaveLength(2)
    expect(await repo.getEntries()).toHaveLength(4)
  })

  it('não grava estorno quando a operação original não existe', async () => {
    const repo = repository({ databaseName: newDatabaseName() })
    const original = makeOperation()
    const reversal = reverseOperation(original, 'reversal-1', 'reversal-key-1', '2026-01-02T12:00:00.000Z')
    await expect(repo.commit(reversal)).rejects.toThrow(/original do estorno não foi encontrada/)
    expect(await repo.getOperations()).toEqual([])
    expect(await repo.getEntries()).toEqual([])
  })

  it('aborta operação e partidas se houver falha durante a gravação das partidas', async () => {
    const databaseName = newDatabaseName()
    const failing = repository({
      databaseName,
      beforeEntryWrite: () => { throw new Error('Falha simulada ao gravar partidas.') },
    })
    await expect(failing.commit(makeOperation())).rejects.toBeDefined()
    failing.close()

    const reopened = repository({ databaseName })
    expect(await reopened.getOperations()).toEqual([])
    expect(await reopened.getEntries()).toEqual([])
    expect(await reopened.getOutboxEvents()).toEqual([])
    reopened.close()
  })

  it('aborta operação, partidas e evento se falhar a gravação da outbox', async () => {
    const databaseName = newDatabaseName()
    const failing = repository({ databaseName, beforeOutboxWrite: () => { throw new Error('falha outbox') } })
    await expect(failing.commit(makeOperation())).rejects.toBeDefined()
    failing.close()
    const reopened = repository({ databaseName })
    expect(await reopened.getOperations()).toEqual([])
    expect(await reopened.getEntries()).toEqual([])
    expect(await reopened.getOutboxEvents()).toEqual([])
    expect(await reopened.getOutboxCursor()).toBe(0)
    reopened.close()
  })

  it('copia a operação antes de esperar pela abertura e persiste somente o conteúdo copiado', async () => {
    const databaseName = newDatabaseName()
    let releaseOpen!: () => void
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve })
    const repo = repository({ databaseName, beforeDatabaseOpen: () => openGate })
    const original = makeOperation()
    const expected = structuredClone(original)
    const committing = repo.commit(original)

    original.id = 'mutated-id'
    original.idempotencyKey = 'mutated-key'
    original.description = 'Conteúdo mutado depois da chamada'
    original.entries[0].amountCents = 1
    releaseOpen()

    await committing
    expect(await repo.getOperations()).toEqual([expected])
    expect(await repo.getEntries()).toEqual(expected.entries.map((entry, index) => ({
      ...entry,
      id: `${expected.id}:${index}`,
      operationId: expected.id,
    })))
    const outbox = await repo.getOutboxEvents()
    expect(outbox).toHaveLength(1)
    expect(outbox[0].operationId).toBe(expected.id)
    expect(outbox[0].snapshot).toEqual(expected)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 4)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const stored = await new Promise<{ fingerprint: string }>((resolve, reject) => {
      const request = db.transaction('operations', 'readonly').objectStore('operations').get(expected.id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    expect(stored.fingerprint).toBe(operationFingerprint(expected))
    db.close()
    repo.close()
  })

  it('migra dados v3 para v4 sem alterar operações e partidas existentes', async () => {
    const databaseName = newDatabaseName()
    const operation = makeOperation()
    await createLegacyV3Database(databaseName, operation)
    const upgraded = repository({ databaseName })
    expect(await upgraded.getOperations()).toEqual([operation])
    expect(await upgraded.getEntries()).toHaveLength(2)
    expect(await upgraded.getOutboxEvents()).toEqual([])
    expect(await upgraded.getOutboxCursor()).toBe(0)
    await upgraded.commit(makeOperation({ idempotencyKey: 'after-upgrade' }))
    expect((await upgraded.getOutboxEvents()).map((event) => event.sequence)).toEqual([1])
    upgraded.close()
  })

  it('migra um banco v3 vazio e inicializa todos os stores e nextSequence', async () => {
    const databaseName = newDatabaseName()
    const legacy = await createLegacyV3Connection(databaseName)
    legacy.close()
    const upgraded = repository({ databaseName })
    expect(await upgraded.getOperations()).toEqual([])
    expect(await upgraded.getEntries()).toEqual([])
    expect(await upgraded.getOutboxEvents()).toEqual([])
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 4)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    expect(['operations', 'entries', 'outbox', 'sync_state'].every((store) => db.objectStoreNames.contains(store))).toBe(true)
    expect(await readSyncState(db)).toEqual({ key: 'state', nextSequence: 1, cursor: 0 })
    db.close()
    upgraded.close()
  })

  it('rejeita ACKs com IDs repetidos, vazios ou data inválida sem atualização parcial', async () => {
    const repo = repository({ databaseName: newDatabaseName() })
    await repo.commit(makeOperation({ idempotencyKey: 'ack-first' }))
    await repo.commit(makeOperation({ idempotencyKey: 'ack-second' }))
    const events = await repo.getOutboxEvents()

    await expect(repo.acknowledgeEvents([events[0].eventId, events[0].eventId]))
      .rejects.toThrow(/IDs de evento ausentes ou repetidos/)
    await expect(repo.acknowledgeEvents([events[0].eventId, '']))
      .rejects.toThrow(/IDs de evento ausentes ou repetidos/)
    await expect(repo.acknowledgeEvents([events[0].eventId], 'not-a-date'))
      .rejects.toThrow(/Data de ACK inválida/)

    expect((await repo.getOutboxEvents()).map((event) => event.status)).toEqual(['pending', 'pending'])
    expect(await repo.getOutboxCursor()).toBe(0)
  })

  it('faz rollback quando a gravação real da outbox viola o índice único', async () => {
    const databaseName = newDatabaseName()
    let eventIdCall = 0
    const repo = repository({
      databaseName,
      createEventId: () => ++eventIdCall === 2 ? 'event-1' : `event-${eventIdCall}`,
    })
    await repo.commit(makeOperation({ idempotencyKey: 'constraint-first' }))
    await expect(repo.commit(makeOperation({ idempotencyKey: 'constraint-duplicate-event' }))).rejects.toBeDefined()

    expect(await repo.getOperations()).toHaveLength(1)
    expect(await repo.getEntries()).toHaveLength(2)
    expect((await repo.getOutboxEvents()).map((event) => event.sequence)).toEqual([1])
    expect(await repo.getOutboxCursor()).toBe(0)

    await repo.commit(makeOperation({ idempotencyKey: 'constraint-recovery' }))
    expect((await repo.getOutboxEvents()).map((event) => event.sequence)).toEqual([1, 2])
    expect(await repo.getOperations()).toHaveLength(2)
    expect(await repo.getEntries()).toHaveLength(4)
  })

  it('fecha o resultado tardio após blocked sem invalidar uma abertura posterior', async () => {
    const databaseName = newDatabaseName()
    const blocker = await createLegacyV3Connection(databaseName)
    const requests: IDBOpenDBRequest[] = []
    const openedDatabases: IDBDatabase[] = []
    let retryPromise: Promise<Operation[]> | undefined
    const repo = repository({
      databaseName,
      createOpenRequest: (name, version) => {
        const request = indexedDB.open(name, version)
        const requestNumber = requests.push(request)
        request.addEventListener('success', () => {
          openedDatabases[requestNumber - 1] = request.result
          if (requestNumber === 1) retryPromise = repo.getOperations()
        })
        return request
      },
    })
    await expect(repo.getOperations()).rejects.toThrow(/bloqueada por outra conexão/)
    const lateSuccess = new Promise<void>((resolve) => {
      requests[0].addEventListener('success', () => resolve(), { once: true })
    })
    blocker.close()
    await lateSuccess
    expect(retryPromise).toBeDefined()
    await expect(retryPromise).resolves.toEqual([])
    expect(requests).toHaveLength(2)
    expect(() => openedDatabases[0].transaction('operations', 'readonly')).toThrow()
    expect(() => openedDatabases[1].transaction('operations', 'readonly')).not.toThrow()

    repo.close()
    await expect(repo.getOperations()).resolves.toEqual([])
    expect(requests).toHaveLength(3)
    repo.close()
  })

  it('mantém um único evento para commits concorrentes com a mesma chave', async () => {
    const repo = repository({ databaseName: newDatabaseName() })
    const first = makeOperation()
    const second = makeOperation({ idempotencyKey: first.idempotencyKey })
    const results = await Promise.all([repo.commit(first), repo.commit(second)])
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1)
    expect(results.filter((result) => result.duplicate)).toHaveLength(1)
    expect(await repo.getOperations()).toHaveLength(1)
    expect(await repo.getEntries()).toHaveLength(2)
    expect(await repo.getOutboxEvents()).toHaveLength(1)
  })

  it('ACK parcial avança somente sobre uma sequência contínua e persiste no reinício', async () => {
    const databaseName = newDatabaseName()
    const repo = repository({ databaseName })
    await repo.commit(makeOperation())
    await repo.commit(makeOperation({ idempotencyKey: 'receipt-101' }))
    const events = await repo.getOutboxEvents()
    expect(await repo.acknowledgeEvents([events[1].eventId], '2026-01-03T00:00:00.000Z')).toBe(0)
    expect((await repo.getOutboxEvents()).map((event) => event.status)).toEqual(['pending', 'acked'])
    expect(await repo.acknowledgeEvents([events[0].eventId], '2026-01-03T00:00:01.000Z')).toBe(2)
    repo.close()
    const reopened = repository({ databaseName })
    expect(await reopened.getOutboxCursor()).toBe(2)
    expect((await reopened.getOutboxEvents()).map((event) => event.status)).toEqual(['acked', 'acked'])
    reopened.close()
  })

  it('rejeita ACK desconhecido sem confirmar eventos nem avançar cursor', async () => {
    const repo = repository({ databaseName: newDatabaseName() })
    await repo.commit(makeOperation())
    await expect(repo.acknowledgeEvents(['unknown-event'])).rejects.toThrow(/evento desconhecido/)
    expect((await repo.getOutboxEvents())[0].status).toBe('pending')
    expect(await repo.getOutboxCursor()).toBe(0)
  })
})
