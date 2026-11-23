import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { createOperation, reverseOperation, type Operation } from './domain'
import { createLedgerRepository, type LedgerRepository } from './storage/ledgerRepository'
import { createUuidV4 } from '../utils/uuid'

const databaseNames: string[] = []
const repositories: LedgerRepository[] = []

function newDatabaseName(): string {
  const name = `ledger-concurrency-${createUuidV4()}`
  databaseNames.push(name)
  return name
}

function repository(databaseName: string, options: Parameters<typeof createLedgerRepository>[0] = {}): LedgerRepository {
  const instance = createLedgerRepository({ ...options, databaseName })
  repositories.push(instance)
  return instance
}

function operation(
  id: string,
  idempotencyKey: string,
  amountCents = 10000,
  description = 'Receita concorrente',
): Operation {
  return createOperation({
    id,
    idempotencyKey,
    type: 'revenue',
    description,
    createdAt: '2026-02-01T12:00:00.000Z',
    entries: [
      { accountId: 'cash', side: 'debit', amountCents, currency: 'BRL' },
      { accountId: 'revenue', side: 'credit', amountCents, currency: 'BRL' },
    ],
  })
}

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

afterEach(async () => {
  for (const instance of repositories.splice(0)) instance.close()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  for (const name of databaseNames.splice(0)) await deleteDatabase(name)
})

describe('concorrência local do diário', () => {
  it('serializa commits independentes feitos por repositórios distintos', async () => {
    const databaseName = newDatabaseName()
    const firstRepository = repository(databaseName)
    const secondRepository = repository(databaseName)

    const results = await Promise.all([
      firstRepository.commit(operation('independent-1', 'independent-key-1')),
      secondRepository.commit(operation('independent-2', 'independent-key-2', 3000, 'Despesa independente')),
    ])

    expect(results.every((result) => !result.duplicate)).toBe(true)
    expect(await firstRepository.getOperations()).toHaveLength(2)
    expect(await firstRepository.getEntries()).toHaveLength(4)
    const events = await secondRepository.getOutboxEvents()
    expect(events.map((event) => event.sequence)).toEqual([1, 2])
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2)
    expect(events.map((event) => event.operationId).sort()).toEqual(['independent-1', 'independent-2'])
  })

  it('confirma uma vez a mesma chave e o mesmo conteúdo em repositórios distintos', async () => {
    const databaseName = newDatabaseName()
    const firstRepository = repository(databaseName)
    const secondRepository = repository(databaseName)
    const results = await Promise.all([
      firstRepository.commit(operation('same-content-1', 'same-key')),
      secondRepository.commit(operation('same-content-2', 'same-key')),
    ])

    expect(results.filter((result) => !result.duplicate)).toHaveLength(1)
    expect(results.filter((result) => result.duplicate)).toHaveLength(1)
    const operations = await firstRepository.getOperations()
    expect(operations).toHaveLength(1)
    expect(await secondRepository.getEntries()).toHaveLength(2)
    expect(await firstRepository.getOutboxEvents()).toHaveLength(1)
  })

  it('rejeita conteúdo divergente sob a mesma chave sem gravação parcial', async () => {
    const databaseName = newDatabaseName()
    const firstRepository = repository(databaseName)
    const secondRepository = repository(databaseName)
    const results = await Promise.allSettled([
      firstRepository.commit(operation('divergent-1', 'divergent-key', 10000)),
      secondRepository.commit(operation('divergent-2', 'divergent-key', 5000)),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await firstRepository.getOperations()).toHaveLength(1)
    expect(await firstRepository.getEntries()).toHaveLength(2)
    expect(await secondRepository.getOutboxEvents()).toHaveLength(1)
    expect(await secondRepository.getOutboxCursor()).toBe(0)
  })

  it('rejeita colisão de ID de operação sem acrescentar partidas ou evento', async () => {
    const databaseName = newDatabaseName()
    const firstRepository = repository(databaseName)
    const secondRepository = repository(databaseName)
    const results = await Promise.allSettled([
      firstRepository.commit(operation('colliding-id', 'collision-key-1')),
      secondRepository.commit(operation('colliding-id', 'collision-key-2', 7000)),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await firstRepository.getOperations()).toHaveLength(1)
    expect(await firstRepository.getEntries()).toHaveLength(2)
    expect(await firstRepository.getOutboxEvents()).toHaveLength(1)
  })

  it('confirma somente um de dois estornos simultâneos em repositórios distintos', async () => {
    const databaseName = newDatabaseName()
    const firstRepository = repository(databaseName)
    const secondRepository = repository(databaseName)
    const original = operation('reversal-source', 'reversal-source-key')
    await firstRepository.commit(original)
    const firstReversal = reverseOperation(original, 'reversal-a', 'reversal-key-a', '2026-02-02T12:00:00.000Z')
    const secondReversal = reverseOperation(original, 'reversal-b', 'reversal-key-b', '2026-02-02T12:00:01.000Z')

    const results = await Promise.allSettled([
      firstRepository.commit(firstReversal),
      secondRepository.commit(secondReversal),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await firstRepository.getOperations()).toHaveLength(2)
    expect(await firstRepository.getEntries()).toHaveLength(4)
    expect((await secondRepository.getOutboxEvents()).map((event) => event.sequence)).toEqual([1, 2])
  })

  it('serializa ACKs concorrentes sem regressão nem salto do cursor', async () => {
    const databaseName = newDatabaseName()
    const firstRepository = repository(databaseName)
    const secondRepository = repository(databaseName)
    for (let index = 1; index <= 3; index++) {
      await firstRepository.commit(operation(`ack-operation-${index}`, `ack-key-${index}`))
    }
    const events = await firstRepository.getOutboxEvents()

    const cursors = await Promise.all([
      firstRepository.acknowledgeEvents([events[1].eventId], '2026-02-03T12:00:00.000Z'),
      secondRepository.acknowledgeEvents([events[0].eventId], '2026-02-03T12:00:01.000Z'),
    ])

    expect(cursors.every((cursor) => cursor >= 0 && cursor <= 2)).toBe(true)
    expect(cursors[0]).toBeLessThanOrEqual(cursors[1])
    expect(await secondRepository.getOutboxCursor()).toBe(2)
    expect((await firstRepository.getOutboxEvents()).map((event) => event.status)).toEqual(['acked', 'acked', 'pending'])
    expect(await firstRepository.acknowledgeEvents([events[2].eventId])).toBe(3)
  })

  it('isola o abort de um commit enquanto outro commit independente conclui', async () => {
    const databaseName = newDatabaseName()
    const failingRepository = repository(databaseName, {
      beforeEntryWrite: () => { throw new Error('Falha concorrente simulada.') },
    })
    const healthyRepository = repository(databaseName)

    const results = await Promise.allSettled([
      failingRepository.commit(operation('aborted-operation', 'aborted-key')),
      healthyRepository.commit(operation('healthy-operation', 'healthy-key')),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await healthyRepository.getOperations()).toMatchObject([
      { id: 'healthy-operation', idempotencyKey: 'healthy-key' },
    ])
    expect(await failingRepository.getEntries()).toHaveLength(2)
    const events = await healthyRepository.getOutboxEvents()
    expect(events).toHaveLength(1)
    expect(events[0].operationId).toBe('healthy-operation')
    expect(events[0].sequence).toBe(1)
    expect(await healthyRepository.getOutboxCursor()).toBe(0)
  })

  it('preserva consistência após reabrir repositórios concorrentes', async () => {
    const databaseName = newDatabaseName()
    const firstRepository = repository(databaseName)
    const secondRepository = repository(databaseName)
    const firstOperation = operation('restart-operation-1', 'restart-key-1')
    const secondOperation = operation('restart-operation-2', 'restart-key-2', 2000)
    await Promise.all([
      firstRepository.commit(firstOperation),
      secondRepository.commit(secondOperation),
    ])
    firstRepository.close()
    secondRepository.close()

    const reopenedFirst = repository(databaseName)
    const reopenedSecond = repository(databaseName)
    const replay = await reopenedSecond.commit(firstOperation)
    const operations = await reopenedFirst.getOperations()
    const entries = await reopenedFirst.getEntries()
    const events = await reopenedSecond.getOutboxEvents()

    expect(replay.duplicate).toBe(true)
    expect(operations).toHaveLength(2)
    expect(new Set(operations.map((item) => item.id)).size).toBe(2)
    expect(entries).toHaveLength(4)
    expect(events).toHaveLength(2)
    expect(events.map((event) => event.sequence)).toEqual([1, 2])
    expect(new Set(events.map((event) => event.operationId)).size).toBe(2)
    expect(await reopenedFirst.getOutboxCursor()).toBe(0)
  })
})
