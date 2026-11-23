import { describe, expect, it } from 'vitest'
import {
  createOperation,
  reconstructBalances,
  reverseOperation,
  validateOperation,
  type OperationInput,
} from './domain'

function operation(overrides: Partial<OperationInput> = {}) {
  return createOperation({
    id: 'op-1', idempotencyKey: 'key-1', type: 'revenue',
    description: 'Receita de demonstração', createdAt: '2026-01-01T12:00:00.000Z',
    entries: [
      { accountId: 'cash', side: 'debit', amountCents: 10000, currency: 'BRL' },
      { accountId: 'revenue', side: 'credit', amountCents: 10000, currency: 'BRL' },
    ],
    ...overrides,
  })
}

describe('regras do diário financeiro', () => {
  it('aceita receita de R$ 100,00 e mantém centavos inteiros', () => {
    const receipt = operation()
    expect(receipt.entries.map((entry) => entry.amountCents)).toEqual([10000, 10000])
  })

  it('aceita despesa de R$ 30,00', () => {
    const expense = operation({
      type: 'expense',
      entries: [
        { accountId: 'expenses', side: 'debit', amountCents: 3000, currency: 'BRL' },
        { accountId: 'cash', side: 'credit', amountCents: 3000, currency: 'BRL' },
      ],
    })
    expect(expense.entries[0].amountCents).toBe(3000)
  })

  it('aceita transferência de R$ 20,00 entre contas', () => {
    const transfer = operation({
      type: 'transfer',
      entries: [
        { accountId: 'reserve', side: 'debit', amountCents: 2000, currency: 'BRL' },
        { accountId: 'cash', side: 'credit', amountCents: 2000, currency: 'BRL' },
      ],
    })
    expect(transfer.entries).toHaveLength(2)
  })

  it('rejeita operação desbalanceada e valor fracionário de centavo', () => {
    expect(() => operation({ entries: [
      { accountId: 'cash', side: 'debit', amountCents: 10000, currency: 'BRL' },
      { accountId: 'revenue', side: 'credit', amountCents: 9999, currency: 'BRL' },
    ] })).toThrow(/desbalanceada/)
    expect(() => operation({ entries: [
      { accountId: 'cash', side: 'debit', amountCents: 10.5, currency: 'BRL' },
      { accountId: 'revenue', side: 'credit', amountCents: 10.5, currency: 'BRL' },
    ] })).toThrow(/inteiro positivo/)
  })

  it('rejeita side e type inválidos em runtime', () => {
    const valid = operation()
    const invalidSide = structuredClone(valid) as unknown as OperationInput
    invalidSide.entries[0].side = 'credit-ish' as OperationInput['entries'][number]['side']
    expect(() => validateOperation(invalidSide)).toThrow(/Lado da partida inválido/)

    const invalidType = { ...valid, type: 'refund' } as unknown as OperationInput
    expect(() => validateOperation(invalidType)).toThrow(/Tipo de operação inválido/)
  })

  it('exige referência válida para estorno e não aceita referência em outros tipos', () => {
    const valid = operation()
    const reversalWithoutReference = {
      ...valid, type: 'reversal', reversesOperationId: undefined,
    } as unknown as OperationInput
    expect(() => validateOperation(reversalWithoutReference)).toThrow(/referenciar a operação original/)

    expect(() => validateOperation({
      ...valid, reversesOperationId: 'outro-id',
    })).toThrow(/Somente uma operação de estorno/)
  })

  it('cria estorno integral inverso sem mutar a receita original', () => {
    const original = operation()
    const snapshot = structuredClone(original)
    const reversal = reverseOperation(original, 'op-2', 'key-2', '2026-01-02T12:00:00.000Z')
    expect(reversal.reversesOperationId).toBe(original.id)
    expect(reversal.entries.map((entry) => entry.side)).toEqual(['credit', 'debit'])
    expect(original).toEqual(snapshot)
  })

  it('reconstrói saldos das partidas, incluindo estorno', () => {
    const receipt = operation()
    const reversal = reverseOperation(receipt, 'op-2', 'key-2', '2026-01-02T12:00:00.000Z')
    const entries = [receipt, reversal].flatMap((item) => item.entries.map((entry, index) => ({
      ...entry, operationId: item.id, id: `${item.id}:${index}`,
    })))
    expect(reconstructBalances(entries).every((balance) => balance.amountCents === 0)).toBe(true)
  })
})
