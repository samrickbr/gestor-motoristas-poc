export type Currency = 'BRL' | (string & {})
export type EntrySide = 'debit' | 'credit'
export type OperationType = 'revenue' | 'expense' | 'transfer' | 'reversal'

export interface Account {
  id: string
  name: string
}

export interface EntryInput {
  accountId: string
  side: EntrySide
  amountCents: number
  currency: Currency
}

export interface JournalEntry extends EntryInput {
  id: string
  operationId: string
}

export interface Operation {
  id: string
  idempotencyKey: string
  type: OperationType
  description: string
  createdAt: string
  reversesOperationId?: string
  entries: EntryInput[]
}

export interface OperationInput {
  id: string
  idempotencyKey: string
  type: OperationType
  description: string
  createdAt: string
  reversesOperationId?: string
  entries: EntryInput[]
}

export interface BalanceProjection {
  /** Provisional debit-positive/credit-negative figure, not a financial balance. */
  accountId: string
  currency: Currency
  amountCents: number
}

export function validateOperation(input: OperationInput): void {
  if (input === null || typeof input !== 'object') {
    throw new Error('A operação é obrigatória.')
  }
  if (typeof input.id !== 'string' || !input.id.trim() ||
      typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) {
    throw new Error('Operação e chave de idempotência são obrigatórias.')
  }
  if (!['revenue', 'expense', 'transfer', 'reversal'].includes(input.type)) {
    throw new Error('Tipo de operação inválido.')
  }
  if (typeof input.description !== 'string' || !input.description.trim() ||
      typeof input.createdAt !== 'string' || !input.createdAt.trim() ||
      !Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error('Descrição e data válida são obrigatórias.')
  }
  const hasReversalReference = input.reversesOperationId !== undefined
  if (input.type === 'reversal') {
    if (typeof input.reversesOperationId !== 'string' || !input.reversesOperationId.trim()) {
      throw new Error('Estorno precisa referenciar a operação original.')
    }
    if (input.reversesOperationId === input.id) {
      throw new Error('Uma operação não pode estornar a si própria.')
    }
  } else if (hasReversalReference) {
    throw new Error('Somente uma operação de estorno pode referenciar outra operação.')
  }
  if (!Array.isArray(input.entries)) {
    throw new Error('As partidas da operação são obrigatórias.')
  }
  if (input.entries.length < 2) {
    throw new Error('A operação precisa ter ao menos duas partidas.')
  }

  const totals = new Map<Currency, { debit: number; credit: number }>()
  for (const entry of input.entries) {
    if (entry === null || typeof entry !== 'object') {
      throw new Error('Cada partida deve ser um objeto válido.')
    }
    if (entry.side !== 'debit' && entry.side !== 'credit') {
      throw new Error('Lado da partida inválido; use debit ou credit.')
    }
    if (typeof entry.accountId !== 'string' || !entry.accountId.trim() ||
        typeof entry.currency !== 'string' || !entry.currency.trim()) {
      throw new Error('Cada partida precisa de conta e moeda.')
    }
    if (!Number.isSafeInteger(entry.amountCents) || entry.amountCents <= 0) {
      throw new Error('O valor da partida deve ser um inteiro positivo em centavos.')
    }
    const total = totals.get(entry.currency) ?? { debit: 0, credit: 0 }
    total[entry.side] += entry.amountCents
    if (!Number.isSafeInteger(total[entry.side])) {
      throw new Error('O total das partidas excede o limite seguro de inteiros.')
    }
    totals.set(entry.currency, total)
  }

  for (const [currency, total] of totals) {
    if (total.debit !== total.credit) {
      throw new Error(`Operação desbalanceada para ${currency}.`)
    }
  }
}

export function createOperation(input: OperationInput): Operation {
  validateOperation(input)
  return {
    ...input,
    description: input.description.trim(),
    entries: input.entries.map((entry) => ({ ...entry })),
  }
}

export function reverseOperation(
  original: Operation,
  id: string,
  idempotencyKey: string,
  createdAt: string,
): Operation {
  validateOperation(original)
  if (original.type === 'reversal') {
    throw new Error('Um estorno não pode ser estornado novamente.')
  }
  return createOperation({
    id,
    idempotencyKey,
    type: 'reversal',
    description: `Estorno: ${original.description}`,
    createdAt,
    reversesOperationId: original.id,
    entries: original.entries.map((entry) => ({
      ...entry,
      side: entry.side === 'debit' ? 'credit' : 'debit',
    })),
  })
}

/**
 * Reconstrói uma projeção técnica provisória: débito soma e crédito subtrai.
 * Isso não é saldo financeiro definitivo. A natureza normal das contas e a
 * interpretação financeira dos saldos ainda precisam ser definidas.
 */
export function reconstructBalances(entries: readonly JournalEntry[]): BalanceProjection[] {
  const balances = new Map<string, BalanceProjection>()
  for (const entry of entries) {
    const key = `${entry.accountId}\u0000${entry.currency}`
    const balance = balances.get(key) ?? {
      accountId: entry.accountId,
      currency: entry.currency,
      amountCents: 0,
    }
    balance.amountCents += entry.side === 'debit' ? entry.amountCents : -entry.amountCents
    if (!Number.isSafeInteger(balance.amountCents)) {
      throw new Error('O saldo excede o limite seguro de inteiros.')
    }
    balances.set(key, balance)
  }
  return [...balances.values()].sort((a, b) =>
    a.accountId.localeCompare(b.accountId) || a.currency.localeCompare(b.currency),
  )
}

export function materializeEntries(operation: Operation): JournalEntry[] {
  return operation.entries.map((entry, index) => ({
    ...entry,
    id: `${operation.id}:${index}`,
    operationId: operation.id,
  }))
}

export function operationFingerprint(operation: Operation): string {
  return JSON.stringify({
    type: operation.type,
    description: operation.description,
    reversesOperationId: operation.reversesOperationId ?? null,
    entries: operation.entries.map(({ accountId, side, amountCents, currency }) => ({
      accountId,
      side,
      amountCents,
      currency,
    })),
  })
}
