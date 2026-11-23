import { useCallback, useEffect, useState } from 'react'
import {
  createOperation,
  reverseOperation,
  type BalanceProjection,
  type Operation,
} from '../domain'
import { createLedgerRepository } from '../storage/ledgerRepository'
import type { OutboxEvent } from '../storage/ledgerRepository'
import { deliverPending } from '../sync/outboxSync'
import { SimulatedOutboxTransport, type SimulatedTransportMode } from '../sync/simulatedTransport'
import { createUuidV4 } from '../../utils/uuid'
import FinanceConcurrencyPanel from './FinanceConcurrencyPanel'

const repository = createLedgerRepository()
const simulatedTransport = new SimulatedOutboxTransport()
const accounts = [
  { id: 'cash', name: 'Caixa' },
  { id: 'revenue', name: 'Receitas' },
  { id: 'expenses', name: 'Despesas' },
  { id: 'reserve', name: 'Reserva' },
]

function newId(): string {
  return createUuidV4()
}

function money(cents: number): string {
  const sign = cents < 0 ? '−' : ''
  const absolute = Math.abs(cents)
  const reais = Math.floor(absolute / 100)
  const remainder = absolute % 100
  return `${sign}R$ ${new Intl.NumberFormat('pt-BR').format(reais)},${String(remainder).padStart(2, '0')}`
}

export default function FinanceDemo() {
  const [operations, setOperations] = useState<Operation[]>([])
  const [balances, setBalances] = useState<BalanceProjection[]>([])
  const [outboxEvents, setOutboxEvents] = useState<OutboxEvent[]>([])
  const [outboxCursor, setOutboxCursor] = useState(0)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    const [nextOperations, nextBalances, nextOutbox, nextCursor] = await Promise.all([
      repository.getOperations(),
      repository.getBalanceProjection(),
      repository.getOutboxEvents(),
      repository.getOutboxCursor(),
    ])
    setOperations(nextOperations)
    setBalances(nextBalances)
    setOutboxEvents(nextOutbox)
    setOutboxCursor(nextCursor)
  }, [])

  useEffect(() => {
    async function initialize() {
      try {
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Falha ao abrir o diário.')
      }
    }
    void initialize()
  }, [refresh])

  async function save(operation: Operation) {
    setError('')
    setMessage('')
    try {
      const result = await repository.commit(operation)
      await refresh()
      setMessage(result.duplicate ? 'Operação já registrada: nenhuma duplicação criada.' : 'Operação gravada no diário local.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao gravar a operação.')
    }
  }

  async function simulateDelivery(mode: SimulatedTransportMode = 'normal', partialSize?: number) {
    setError('')
    setMessage('')
    simulatedTransport.setMode(mode)
    simulatedTransport.setPartialBatchSize(partialSize)
    try {
      const result = await deliverPending(repository, simulatedTransport)
      setMessage(`Transporte simulado: ${result.acknowledgedEventIds.length} ACK(s); cursor local ${result.cursor}.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha no transporte simulado.')
    } finally {
      simulatedTransport.setPartialBatchSize(undefined)
      await refresh()
    }
  }

  function createScenario(type: 'revenue' | 'expense' | 'transfer') {
    const idempotencyKey = `demo-${type}-v1`
    if (operations.some((operation) => operation.idempotencyKey === idempotencyKey)) {
      setError('Este cenário já foi registrado. Os fatos do diário não podem ser removidos nesta demonstração.')
      return
    }
    const amountCents = type === 'revenue' ? 10000 : type === 'expense' ? 3000 : 2000
    const entries = type === 'revenue'
      ? [
          { accountId: 'cash', side: 'debit' as const, amountCents, currency: 'BRL' },
          { accountId: 'revenue', side: 'credit' as const, amountCents, currency: 'BRL' },
        ]
      : type === 'expense'
        ? [
            { accountId: 'expenses', side: 'debit' as const, amountCents, currency: 'BRL' },
            { accountId: 'cash', side: 'credit' as const, amountCents, currency: 'BRL' },
          ]
        : [
            { accountId: 'reserve', side: 'debit' as const, amountCents, currency: 'BRL' },
            { accountId: 'cash', side: 'credit' as const, amountCents, currency: 'BRL' },
          ]
    void save(createOperation({
      id: newId(), idempotencyKey, type,
      description: type === 'revenue' ? 'Receita de demonstração' : type === 'expense' ? 'Despesa de demonstração' : 'Transferência para reserva',
      createdAt: new Date().toISOString(), entries,
    }))
  }

  async function reverseRevenue() {
    const original = operations.find((operation) => operation.type === 'revenue' && !operation.reversesOperationId)
    if (!original) {
      setError('Registre a receita antes de estorná-la.')
      return
    }
    if (operations.some((operation) => operation.reversesOperationId === original.id)) {
      setError('A receita já possui estorno integral.')
      return
    }
    await save(reverseOperation(original, newId(), `demo-reversal-${original.id}`, new Date().toISOString()))
  }

  function tryUnbalanced() {
    try {
      const operation = createOperation({
        id: newId(), idempotencyKey: `demo-invalid-${newId()}`, type: 'revenue',
        description: 'Operação inválida de demonstração', createdAt: new Date().toISOString(),
        entries: [
          { accountId: 'cash', side: 'debit', amountCents: 10000, currency: 'BRL' },
          { accountId: 'revenue', side: 'credit', amountCents: 9999, currency: 'BRL' },
        ],
      })
      void save(operation)
    } catch (cause) {
      setMessage(cause instanceof Error ? `Rejeitada corretamente: ${cause.message}` : 'Operação rejeitada corretamente.')
      setError('')
    }
  }

  return (
    <main className="app">
      <header className="header">
        <span className="eyebrow">PROVA DE CONCEITO · POC-03</span>
        <h1>Diário financeiro local</h1>
        <p>Operações imutáveis em partidas balanceadas, armazenadas neste dispositivo.</p>
      </header>
      <section className="form-card">
        <span className="section-label">CENÁRIOS</span>
        <h2>Registrar operações de demonstração</h2>
        <div className="finance-actions">
          <button className="button button-primary" onClick={() => createScenario('revenue')}>Registrar receita de R$ 100,00</button>
          <button className="button button-primary" onClick={() => createScenario('expense')}>Registrar despesa de R$ 30,00</button>
          <button className="button button-primary" onClick={() => createScenario('transfer')}>Transferir R$ 20,00</button>
          <button className="button button-secondary" onClick={tryUnbalanced}>Testar rejeição de desbalanceamento</button>
          <button className="button button-secondary" onClick={() => void reverseRevenue()}>Estornar receita integralmente</button>
          <button className="button button-secondary" onClick={() => void refresh().then(() => setMessage('Saldos reconstruídos a partir das partidas persistidas.'))}>Reconstruir saldos</button>
        </div>
        {message && <div className="feedback feedback-success" role="status">{message}</div>}
        {error && <div className="feedback feedback-error" role="alert">{error}</div>}
      </section>
      <section className="form-card">
        <span className="section-label">POC-04 · OUTBOX LOCAL</span>
        <h2>Entrega simulada</h2>
        <p className="helper">Pendentes: {outboxEvents.filter((event) => event.status === 'pending').length} · ACK: {outboxEvents.filter((event) => event.status === 'acked').length} · cursor contínuo: {outboxCursor}</p>
        <div className="finance-actions">
          <button className="button button-primary" onClick={() => void simulateDelivery()}>Enviar lote simulado</button>
          <button className="button button-secondary" onClick={() => void simulateDelivery('timeout-after-acceptance')}>Simular timeout após aceite</button>
          <button className="button button-secondary" onClick={() => void simulateDelivery('fail-before-acceptance')}>Simular falha antes do aceite</button>
          <button className="button button-secondary" onClick={() => void simulateDelivery('invalid-ack')}>Simular ACK inválido</button>
          <button className="button button-secondary" onClick={() => void simulateDelivery('normal', 1)}>Simular lote parcial</button>
        </div>
      </section>
      <FinanceConcurrencyPanel onPersisted={refresh} />
      <section className="form-card">
        <span className="section-label">PROJEÇÃO TÉCNICA PROVISÓRIA · BRL</span>
        <div className="finance-balances">
          {accounts.map((account) => {
            const balance = balances.find((item) => item.accountId === account.id && item.currency === 'BRL')
            return <div key={account.id}><span>{account.name}</span><strong>{money(balance?.amountCents ?? 0)}</strong></div>
          })}
        </div>
        <p className="helper">Cálculo técnico: débitos positivos e créditos negativos, reconstruídos das partidas. Isto não representa saldo financeiro definitivo; a natureza normal das contas ainda precisa ser definida.</p>
      </section>
      <section className="records-section">
        <div className="section-heading"><div><span className="section-label">DIÁRIO APPEND-ONLY</span><h2>Operações confirmadas</h2></div><span className="record-count">{operations.length}</span></div>
        {operations.length === 0 ? <p className="empty-state">Nenhuma operação gravada.</p> : <ul className="record-list">{operations.map((operation) => (
          <li className="record-item" key={operation.id}><div className="record-content"><strong>{operation.description}</strong><span>{new Date(operation.createdAt).toLocaleString('pt-BR')}</span><small>{operation.entries.map((entry) => `${entry.side === 'debit' ? 'D' : 'C'} ${entry.accountId} ${money(entry.amountCents)}`).join(' · ')}</small>{operation.reversesOperationId && <small>Estorna: {operation.reversesOperationId}</small>}</div></li>
        ))}</ul>}
      </section>
      <footer className="footer"><span>POC local · sem dados financeiros reais</span><span>Operações e partidas permanecem neste navegador.</span></footer>
    </main>
  )
}
