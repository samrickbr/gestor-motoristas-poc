import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { createOperation, materializeEntries, operationFingerprint, type Operation } from '../domain'
import { createLedgerRepository, type LedgerRepository } from '../storage/ledgerRepository'
import { createUuidV4 } from '../../utils/uuid'
import { digestSnapshot, isCanonicalIsoDate, validateFinanceSnapshot, type FinanceSnapshot } from './snapshot'

const names: string[] = []
const repositories: LedgerRepository[] = []

function makeRepository(name = `backup-snapshot-${createUuidV4()}`): LedgerRepository {
  names.push(name)
  const repository = createLedgerRepository({ databaseName: name })
  repositories.push(repository)
  return repository
}

function operation(id: string, key: string): Operation {
  return createOperation({
    id,
    idempotencyKey: key,
    type: 'revenue',
    description: 'Receita isolada para teste de backup',
    createdAt: '2026-03-01T12:00:00.000Z',
    entries: [
      { accountId: 'cash', side: 'debit', amountCents: 5000, currency: 'BRL' },
      { accountId: 'revenue', side: 'credit', amountCents: 5000, currency: 'BRL' },
    ],
  })
}

function financialSnapshotFixture(): FinanceSnapshot {
  const source = operation('date-op', 'date-key')
  return {
    schemaVersion: 4,
    operations: [{ ...source, fingerprint: operationFingerprint(source) }],
    entries: materializeEntries(source),
    outbox: [{
      eventId: 'date-event', sequence: 1, operationId: source.id,
      createdAt: source.createdAt, status: 'pending', snapshot: source,
    }],
    sync_state: [{ key: 'state', nextSequence: 2, cursor: 0 }],
  }
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
  for (const repository of repositories.splice(0)) repository.close()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  for (const name of names.splice(0)) await deleteDatabase(name)
})

describe('snapshot financeiro de backup', () => {
  it('aceita somente representação ISO UTC exatamente igual a toISOString()', () => {
    expect(isCanonicalIsoDate('2026-03-01T12:00:00.000Z')).toBe(true)
    expect(isCanonicalIsoDate('2026-03-01T12:00:00Z')).toBe(false)
    expect(isCanonicalIsoDate('2026-03-01T12:00:00.000-03:00')).toBe(false)
    expect(isCanonicalIsoDate('2026-03-01T12:00:00.000')).toBe(false)
    expect(isCanonicalIsoDate('2026-02-30T12:00:00.000Z')).toBe(false)
    expect(isCanonicalIsoDate('2026-03-01')).toBe(false) // Date.parse aceita, o contrato estrito não.
  })

  it('rejeita datas não canônicas em operações e eventos e exige data de ACK', () => {
    const operationDate = financialSnapshotFixture()
    const operationRow = operationDate.operations[0]
    if (!operationRow) throw new Error('Fixture sem operação.')
    operationRow.createdAt = '2026-03-01'
    expect(() => validateFinanceSnapshot(operationDate)).toThrow(/Data ISO UTC não canônica na operação/)

    const eventDate = financialSnapshotFixture()
    const eventRow = eventDate.outbox[0]
    if (!eventRow) throw new Error('Fixture sem evento.')
    eventRow.createdAt = '2026-03-01T12:00:00.000-03:00'
    expect(() => validateFinanceSnapshot(eventDate)).toThrow(/Data ISO UTC não canônica no evento/)

    const missingAckDate = financialSnapshotFixture()
    const ackEvent = missingAckDate.outbox[0]
    const state = missingAckDate.sync_state[0]
    if (!ackEvent || !state) throw new Error('Fixture incompleta.')
    ackEvent.status = 'acked'
    state.cursor = 1
    expect(() => validateFinanceSnapshot(missingAckDate)).toThrow(/data de ACK ausente ou não canônica/i)

    ackEvent.acknowledgedAt = '2026-03-01T12:00:00.000Z'
    expect(() => validateFinanceSnapshot(missingAckDate)).not.toThrow()
  })

  it('lê as quatro stores numa captura coerente e não altera os dados', async () => {
    const repository = makeRepository()
    await repository.commit(operation('snap-op-1', 'snap-key-1'))
    const before = await repository.createConsistentSnapshot()
    const after = await repository.createConsistentSnapshot()
    expect(before).toEqual(after)
    expect(before).toMatchObject({
      schemaVersion: 4,
      operations: [{ id: 'snap-op-1' }],
      entries: [{ operationId: 'snap-op-1' }, { operationId: 'snap-op-1' }],
      outbox: [{ sequence: 1, status: 'pending' }],
      sync_state: [{ key: 'state', nextSequence: 2, cursor: 0 }],
    })
  })

  it('mantém integridade quando snapshot concorre com commit e ACK', async () => {
    const first = makeRepository()
    const second = makeRepository(names[names.length - 1])
    await first.commit(operation('snap-race-1', 'snap-race-key-1'))
    const firstEvent = (await first.getOutboxEvents())[0]
    const results = await Promise.all([
      first.createConsistentSnapshot(),
      second.commit(operation('snap-race-2', 'snap-race-key-2')),
      second.acknowledgeEvents([firstEvent.eventId], '2026-03-02T12:00:00.000Z'),
    ])
    const captured = results[0] as FinanceSnapshot
    expect(() => validateFinanceSnapshot(captured)).not.toThrow()
    const capturedDigest = await digestSnapshot(captured)
    expect(capturedDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(validateFinanceSnapshot(await first.createConsistentSnapshot())).toMatchObject({
      operations: 2,
      entries: 4,
      outbox: 2,
    })
  })

  it('aceita operação legada sem evento de outbox após migração v3→v4', async () => {
    const name = `backup-legacy-${createUuidV4()}`
    names.push(name)
    const legacyOperation = operation('legacy-op', 'legacy-key')
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 3)
      request.onupgradeneeded = () => {
        const db = request.result
        const operations = db.createObjectStore('operations', { keyPath: 'id' })
        operations.createIndex('idempotencyKey', 'idempotencyKey', { unique: true })
        operations.createIndex('reversesOperationId', 'reversesOperationId', { unique: true })
        const entries = db.createObjectStore('entries', { keyPath: 'id' })
        entries.createIndex('operationId', 'operationId')
        operations.add({ ...legacyOperation, fingerprint: operationFingerprint(legacyOperation) })
        entries.add({ ...legacyOperation.entries[0], id: 'legacy-op:0', operationId: 'legacy-op' })
        entries.add({ ...legacyOperation.entries[1], id: 'legacy-op:1', operationId: 'legacy-op' })
      }
      request.onsuccess = () => { request.result.close(); resolve() }
      request.onerror = () => reject(request.error)
    })
    const repository = makeRepository(name)
    const snapshot = await repository.createConsistentSnapshot()
    expect(snapshot.outbox).toEqual([])
    expect(snapshot.sync_state).toEqual([{ key: 'state', nextSequence: 1, cursor: 0 }])
    expect(validateFinanceSnapshot(snapshot)).toMatchObject({ operations: 1, entries: 2, outbox: 0 })
  })

  it('rejeita outbox órfã, salto de sequência e cursor que não segue ACK contínuo', () => {
    const repositorySnapshot: FinanceSnapshot = {
      schemaVersion: 4,
      operations: [], entries: [], outbox: [],
      sync_state: [{ key: 'state', nextSequence: 1, cursor: 0 }],
    }
    const orphan = structuredClone(repositorySnapshot)
    orphan.outbox = [{
      eventId: 'orphan-event', sequence: 1, operationId: 'missing-op',
      createdAt: '2026-03-01T00:00:00.000Z', status: 'pending',
      snapshot: operation('missing-op', 'missing-key'),
    }]
    orphan.sync_state = [{ key: 'state', nextSequence: 2, cursor: 0 }]
    expect(() => validateFinanceSnapshot(orphan)).toThrow(/inexistente/)

    const gap = structuredClone(orphan)
    const source = operation('missing-op', 'missing-key')
    gap.operations = [{ ...source, fingerprint: operationFingerprint(source) }]
    gap.entries = materializeEntries(source)
    gap.outbox[0] = { ...gap.outbox[0], sequence: 2, createdAt: source.createdAt, snapshot: source }
    gap.sync_state = [{ key: 'state', nextSequence: 3, cursor: 0 }]
    expect(gap.outbox[0].snapshot).toEqual(source)
    expect(() => validateFinanceSnapshot(gap)).toThrow(/lacuna|intervalo/)

    const wrongCursor = structuredClone(repositorySnapshot)
    wrongCursor.sync_state[0].cursor = 1
    expect(() => validateFinanceSnapshot(wrongCursor)).toThrow(/nextSequence ou cursor/)
  })
})
