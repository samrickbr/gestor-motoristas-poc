import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { createOperation, type OperationInput } from './domain'
import { createLedgerRepository, type LedgerRepository } from './storage/ledgerRepository'
import { deliverPending } from './sync/outboxSync'
import { SimulatedOutboxTransport } from './sync/simulatedTransport'
import { createUuidV4 } from '../utils/uuid'

const names: string[] = []
const repositories: LedgerRepository[] = []

function newRepository() {
  const databaseName = `outbox-test-${createUuidV4()}`
  names.push(databaseName)
  const repository = createLedgerRepository({ databaseName })
  repositories.push(repository)
  return repository
}

function operation(key: string) {
  return createOperation({
    id: createUuidV4(), idempotencyKey: key, type: 'revenue',
    description: 'Receita de teste', createdAt: '2026-01-01T12:00:00.000Z',
    entries: [
      { accountId: 'cash', side: 'debit', amountCents: 10000, currency: 'BRL' },
      { accountId: 'revenue', side: 'credit', amountCents: 10000, currency: 'BRL' },
    ],
  } satisfies OperationInput)
}

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const name of names.splice(0)) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
      request.onblocked = () => resolve()
    })
  }
})

describe('transporte simulado da outbox', () => {
  it('faz retry após timeout posterior ao aceite usando os mesmos UUIDs', async () => {
    const repository = newRepository()
    await repository.commit(operation('timeout-case'))
    const transport = new SimulatedOutboxTransport({ mode: 'timeout-after-acceptance' })
    await expect(deliverPending(repository, transport)).rejects.toThrow(/Timeout simulado após o aceite/)
    expect((await repository.getPendingOutbox())).toHaveLength(1)
    const result = await deliverPending(repository, transport)
    expect(transport.deliveryAttempts[0]).toEqual(transport.deliveryAttempts[1])
    expect(transport.acceptedIds).toHaveLength(1)
    expect(result.acknowledgedEventIds).toEqual(transport.deliveryAttempts[0])
    expect((await repository.getOutboxEvents())[0].status).toBe('acked')
  })

  it('mantém pendente após falha antes do aceite e permite retry', async () => {
    const repository = newRepository()
    await repository.commit(operation('before-acceptance'))
    const transport = new SimulatedOutboxTransport({ mode: 'fail-before-acceptance' })
    await expect(deliverPending(repository, transport)).rejects.toThrow(/antes do aceite/)
    expect(transport.acceptedIds).toEqual([])
    expect((await repository.getPendingOutbox())).toHaveLength(1)
    await deliverPending(repository, transport)
    expect((await repository.getOutboxEvents())[0].status).toBe('acked')
  })

  it('rejeita ACK inválido sem alterar o estado local', async () => {
    const repository = newRepository()
    await repository.commit(operation('invalid-ack'))
    const transport = new SimulatedOutboxTransport({ mode: 'invalid-ack' })
    await expect(deliverPending(repository, transport)).rejects.toThrow(/ACK inválido/)
    expect((await repository.getOutboxEvents())[0].status).toBe('pending')
    expect(await repository.getOutboxCursor()).toBe(0)
  })

  it('confirma parcialmente um lote e retoma apenas os eventos pendentes', async () => {
    const repository = newRepository()
    await repository.commit(operation('partial-1'))
    await repository.commit(operation('partial-2'))
    const transport = new SimulatedOutboxTransport({ partialBatchSize: 1 })
    const first = await deliverPending(repository, transport)
    expect(first.acknowledgedEventIds).toHaveLength(1)
    expect(first.cursor).toBe(1)
    expect((await repository.getOutboxEvents()).map((event) => event.status)).toEqual(['acked', 'pending'])
    const second = await deliverPending(repository, transport)
    expect(second.acknowledgedEventIds).toHaveLength(1)
    expect(second.cursor).toBe(2)
    expect((await repository.getOutboxEvents()).map((event) => event.status)).toEqual(['acked', 'acked'])
  })

  it('retoma pendências e cursor após fechar e reabrir o banco', async () => {
    const databaseName = `outbox-restart-${createUuidV4()}`
    names.push(databaseName)
    const beforeRestart = createLedgerRepository({ databaseName })
    repositories.push(beforeRestart)
    await beforeRestart.commit(operation('restart-pending'))
    const eventBefore = (await beforeRestart.getPendingOutbox())[0]
    await beforeRestart.acknowledgeEvents([eventBefore.eventId])
    await beforeRestart.commit(operation('restart-pending-2'))
    beforeRestart.close()

    const afterRestart = createLedgerRepository({ databaseName })
    repositories.push(afterRestart)
    expect(await afterRestart.getOutboxCursor()).toBe(1)
    expect((await afterRestart.getPendingOutbox()).map((event) => event.sequence)).toEqual([2])
    expect(await deliverPending(afterRestart, new SimulatedOutboxTransport()).then((result) => result.cursor)).toBe(2)
  })
})
