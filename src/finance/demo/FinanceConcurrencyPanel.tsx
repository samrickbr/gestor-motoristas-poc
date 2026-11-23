import { useCallback, useEffect, useState } from 'react'
import { createOperation, reverseOperation, type Operation } from '../domain'
import { createLedgerRepository, type LedgerRepository, type OutboxEvent } from '../storage/ledgerRepository'
import { createUuidV4 } from '../../utils/uuid'

type ScenarioId = 'independent' | 'same-content' | 'divergent' | 'id-collision' | 'reversals' | 'acks'
type AttemptOutcome = 'sucesso' | 'duplicata' | 'rejeição' | 'falha'

interface AttemptResult {
  label: string
  outcome: AttemptOutcome
  detail: string
}

interface ScenarioRun {
  roundId: string
  completedAt: string
  attempts: AttemptResult[]
  note?: string
}

interface IntegritySummary {
  operations: number
  entries: number
  events: number
  sequences: string
  cursor: number
  consistent: boolean
  checks: string[]
}

interface ScenarioDefinition {
  id: ScenarioId
  title: string
  description: string
}

const scenarios: ScenarioDefinition[] = [
  { id: 'independent', title: 'Commits independentes', description: 'Duas operações diferentes iniciadas em paralelo.' },
  { id: 'same-content', title: 'Mesma chave e conteúdo', description: 'Uma confirmação e uma resposta de duplicata.' },
  { id: 'divergent', title: 'Mesma chave, conteúdo divergente', description: 'A primeira confirmação vence; o conteúdo divergente deve ser rejeitado.' },
  { id: 'id-collision', title: 'Colisão de ID da operação', description: 'IDs iguais com chaves de idempotência diferentes.' },
  { id: 'reversals', title: 'Estornos simultâneos', description: 'Cria uma operação-base POC-05 e tenta estorná-la pelas duas conexões.' },
  { id: 'acks', title: 'ACKs concorrentes', description: 'Cria dois eventos exclusivos da rodada e confirma cada um em paralelo.' },
]

function twoPartyBarrier(): () => Promise<void> {
  let waiting = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  return async () => {
    waiting++
    if (waiting === 2) release()
    await gate
  }
}

function makeOperation(roundId: string, role: string, amountCents = 10000, description?: string): Operation {
  return createOperation({
    id: createUuidV4(),
    idempotencyKey: `poc05:${roundId}:${role}`,
    type: 'revenue',
    description: description ?? `[POC-05] ${role} · rodada ${roundId.slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    entries: [
      { accountId: 'cash', side: 'debit', amountCents, currency: 'BRL' },
      { accountId: 'revenue', side: 'credit', amountCents, currency: 'BRL' },
    ],
  })
}

function rejectedAsExpected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /chave de idempotência|chave ou identificador único|já possui estorno integral/i.test(message)
}

async function commitAttempt(label: string, repository: LedgerRepository, operation: Operation): Promise<AttemptResult> {
  try {
    const result = await repository.commit(operation)
    return {
      label,
      outcome: result.duplicate ? 'duplicata' : 'sucesso',
      detail: result.duplicate
        ? `Chave já confirmada; operação persistida ${result.operation.id}.`
        : `Operação ${operation.id} confirmada.`,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { label, outcome: rejectedAsExpected(error) ? 'rejeição' : 'falha', detail }
  }
}

async function ackAttempt(label: string, repository: LedgerRepository, event: OutboxEvent): Promise<AttemptResult> {
  try {
    const cursor = await repository.acknowledgeEvents([event.eventId])
    return { label, outcome: 'sucesso', detail: `Evento da rodada ${event.sequence} confirmado; cursor retornado ${cursor}.` }
  } catch (error) {
    return { label, outcome: 'falha', detail: error instanceof Error ? error.message : String(error) }
  }
}

async function readIntegrity(first: LedgerRepository, second: LedgerRepository): Promise<IntegritySummary> {
  const [operations, entries, events, cursor] = await Promise.all([
    first.getOperations(),
    first.getEntries(),
    second.getOutboxEvents(),
    second.getOutboxCursor(),
  ])
  const orderedEvents = [...events].sort((left, right) => left.sequence - right.sequence)
  const uniqueSequences = new Set(orderedEvents.map((event) => event.sequence)).size === orderedEvents.length
  const contiguousSequences = orderedEvents.every((event, index) => event.sequence === index + 1)
  const eventBySequence = new Map(orderedEvents.map((event) => [event.sequence, event]))
  let expectedCursor = 0
  while (eventBySequence.get(expectedCursor + 1)?.status === 'acked') expectedCursor++
  const cursorMatches = cursor === expectedCursor
  const checks = [
    uniqueSequences ? 'Sequências únicas' : 'Há sequências repetidas',
    contiguousSequences ? 'Sequências contínuas' : 'Há lacuna na sequência da outbox',
    cursorMatches ? 'Cursor corresponde aos ACKs contínuos' : `Cursor divergente (esperado ${expectedCursor})`,
  ]
  return {
    operations: operations.length,
    entries: entries.length,
    events: events.length,
    sequences: orderedEvents.length
      ? orderedEvents.map((event) => `${event.sequence}:${event.status === 'acked' ? 'ACK' : 'pendente'}`).join(' · ')
      : 'Nenhum evento',
    cursor,
    consistent: uniqueSequences && contiguousSequences && cursorMatches,
    checks,
  }
}

function formatOutcome(outcome: AttemptOutcome): string {
  return outcome.charAt(0).toLocaleUpperCase('pt-BR') + outcome.slice(1)
}

export default function FinanceConcurrencyPanel({ onPersisted }: { onPersisted: () => Promise<void> }) {
  const [runs, setRuns] = useState<Partial<Record<ScenarioId, ScenarioRun>>>({})
  const [summary, setSummary] = useState<IntegritySummary | null>(null)
  const [integrityError, setIntegrityError] = useState('')
  const [running, setRunning] = useState<ScenarioId | 'integrity' | null>(null)

  const refreshIntegrity = useCallback(async () => {
    const first = createLedgerRepository()
    const second = createLedgerRepository()
    try {
      setSummary(await readIntegrity(first, second))
      setIntegrityError('')
    } catch (error) {
      setIntegrityError(error instanceof Error ? error.message : 'Falha ao consultar o diário.')
    } finally {
      first.close()
      second.close()
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshIntegrity() }, 0)
    return () => window.clearTimeout(timer)
  }, [refreshIntegrity])

  async function runScenario(scenarioId: ScenarioId) {
    if (running) return
    setRunning(scenarioId)
    setIntegrityError('')
    const roundId = createUuidV4()
    const first = createLedgerRepository()
    const second = createLedgerRepository()
    let attempts: AttemptResult[] = []
    let note: string | undefined

    try {
      if (scenarioId === 'independent') {
        const barrier = twoPartyBarrier()
        const operations = [makeOperation(roundId, 'independent-a'), makeOperation(roundId, 'independent-b', 3000)]
        attempts = await Promise.all([
          (async () => { await barrier(); return commitAttempt('Conexão A', first, operations[0]) })(),
          (async () => { await barrier(); return commitAttempt('Conexão B', second, operations[1]) })(),
        ])
      } else if (scenarioId === 'same-content') {
        const barrier = twoPartyBarrier()
        const sharedKey = `poc05:${roundId}:same-content`
        const description = `[POC-05] mesma chave e conteúdo · rodada ${roundId.slice(0, 8)}`
        const operations = [
          makeOperation(roundId, 'same-content-a', 10000, description),
          makeOperation(roundId, 'same-content-b', 10000, description),
        ].map((operation) => createOperation({ ...operation, idempotencyKey: sharedKey }))
        attempts = await Promise.all([
          (async () => { await barrier(); return commitAttempt('Conexão A', first, operations[0]) })(),
          (async () => { await barrier(); return commitAttempt('Conexão B', second, operations[1]) })(),
        ])
      } else if (scenarioId === 'divergent') {
        const barrier = twoPartyBarrier()
        const sharedKey = `poc05:${roundId}:divergent`
        const operations = [
          createOperation({ ...makeOperation(roundId, 'divergent-a'), idempotencyKey: sharedKey }),
          createOperation({ ...makeOperation(roundId, 'divergent-b', 5000), idempotencyKey: sharedKey }),
        ]
        attempts = await Promise.all([
          (async () => { await barrier(); return commitAttempt('Conexão A · R$ 100,00', first, operations[0]) })(),
          (async () => { await barrier(); return commitAttempt('Conexão B · R$ 50,00', second, operations[1]) })(),
        ])
      } else if (scenarioId === 'id-collision') {
        const barrier = twoPartyBarrier()
        const sharedId = createUuidV4()
        const operations = [
          createOperation({ ...makeOperation(roundId, 'id-collision-a'), id: sharedId }),
          createOperation({ ...makeOperation(roundId, 'id-collision-b', 5000), id: sharedId }),
        ]
        attempts = await Promise.all([
          (async () => { await barrier(); return commitAttempt('Conexão A · chave A', first, operations[0]) })(),
          (async () => { await barrier(); return commitAttempt('Conexão B · chave B', second, operations[1]) })(),
        ])
      } else if (scenarioId === 'reversals') {
        const original = makeOperation(roundId, 'reversal-source', 10000, `[POC-05] origem de estorno · rodada ${roundId.slice(0, 8)}`)
        const setup = await commitAttempt('Preparação · operação-base própria', first, original)
        attempts = [setup]
        if (setup.outcome !== 'sucesso') {
          note = 'Os estornos não foram iniciados porque a operação-base não foi criada nesta rodada.'
        } else {
          const barrier = twoPartyBarrier()
          const reversals = [
            reverseOperation(original, createUuidV4(), `poc05:${roundId}:reversal-a`, new Date().toISOString()),
            reverseOperation(original, createUuidV4(), `poc05:${roundId}:reversal-b`, new Date().toISOString()),
          ]
          attempts = [...attempts, ...await Promise.all([
            (async () => { await barrier(); return commitAttempt('Estorno · conexão A', first, reversals[0]) })(),
            (async () => { await barrier(); return commitAttempt('Estorno · conexão B', second, reversals[1]) })(),
          ])]
        }
      } else {
        const operations = [makeOperation(roundId, 'ack-a'), makeOperation(roundId, 'ack-b', 3000)]
        const barrier = twoPartyBarrier()
        const setup = await Promise.all([
          (async () => { await barrier(); return commitAttempt('Criar evento · conexão A', first, operations[0]) })(),
          (async () => { await barrier(); return commitAttempt('Criar evento · conexão B', second, operations[1]) })(),
        ])
        attempts = [...setup]
        if (setup.every((attempt) => attempt.outcome === 'sucesso')) {
          const ids = new Set(operations.map((operation) => operation.id))
          const ownEvents = (await second.getOutboxEvents()).filter((event) => ids.has(event.operationId))
          if (ownEvents.length !== 2) {
            attempts.push({ label: 'Preparar ACKs', outcome: 'falha', detail: `Esperados 2 eventos desta rodada; encontrados ${ownEvents.length}.` })
          } else {
            const ackBarrier = twoPartyBarrier()
            attempts = [...attempts, ...await Promise.all([
              (async () => { await ackBarrier(); return ackAttempt('ACK · conexão A', first, ownEvents[0]) })(),
              (async () => { await ackBarrier(); return ackAttempt('ACK · conexão B', second, ownEvents[1]) })(),
            ])]
            note = 'Somente os dois eventos criados nesta rodada foram confirmados; eventos anteriores não foram alterados.'
          }
        } else {
          note = 'Os ACKs não foram iniciados porque nem os dois eventos desta rodada foram criados.'
        }
      }
    } catch (error) {
      attempts.push({ label: 'Execução do cenário', outcome: 'falha', detail: error instanceof Error ? error.message : String(error) })
    }

    setRuns((current) => ({ ...current, [scenarioId]: { roundId, completedAt: new Date().toLocaleString('pt-BR'), attempts, ...(note ? { note } : {}) } }))
    try {
      setSummary(await readIntegrity(first, second))
      await onPersisted()
    } catch (error) {
      setIntegrityError(error instanceof Error ? error.message : 'Falha ao atualizar a leitura do diário.')
    } finally {
      first.close()
      second.close()
      setRunning(null)
    }
  }

  async function checkPersistedState() {
    if (running) return
    setRunning('integrity')
    await refreshIntegrity()
    setRunning(null)
  }

  return (
    <section className="form-card concurrency-panel" aria-labelledby="poc05-title">
      <span className="section-label">FERRAMENTA TEMPORÁRIA · DADOS PERSISTENTES</span>
      <h2 id="poc05-title">POC-05 — Diagnóstico de concorrência</h2>
      <p className="helper">
        Cada cenário abre dois repositórios com conexões independentes para o mesmo banco financeiro desta origem. Os testes acrescentam operações identificadas como POC-05; elas permanecem no diário. Nenhum botão limpa dados ou estorna operações anteriores. Os ACKs do cenário correspondente afetam apenas eventos criados por aquela rodada.
      </p>

      <div className="concurrency-scenarios">
        {scenarios.map((scenario) => {
          const run = runs[scenario.id]
          return (
            <article className="concurrency-scenario" key={scenario.id}>
              <div className="concurrency-scenario-heading">
                <div>
                  <h3>{scenario.title}</h3>
                  <p>{scenario.description}</p>
                </div>
                <button className="button button-secondary" type="button" disabled={running !== null} onClick={() => void runScenario(scenario.id)}>
                  {running === scenario.id ? 'Executando…' : run ? 'Repetir cenário' : 'Executar cenário'}
                </button>
              </div>
              {run && (
                <div className="concurrency-run" aria-live="polite">
                  <small>Rodada {run.roundId} · concluída {run.completedAt}</small>
                  <ul>
                    {run.attempts.map((attempt, index) => (
                      <li key={`${attempt.label}-${index}`}>
                        <span className={`concurrency-outcome outcome-${attempt.outcome}`}>{formatOutcome(attempt.outcome)}</span>
                        <strong>{attempt.label}</strong>
                        <span>{attempt.detail}</span>
                      </li>
                    ))}
                  </ul>
                  {run.note && <p className="helper">{run.note}</p>}
                </div>
              )}
            </article>
          )
        })}
      </div>

      <div className="concurrency-integrity">
        <div className="section-heading">
          <div><span className="section-label">CONSULTA SOMENTE DE LEITURA</span><h3>Estado persistido do diário</h3></div>
          <button className="button button-secondary" type="button" disabled={running !== null} onClick={() => void checkPersistedState()}>
            {running === 'integrity' ? 'Consultando…' : 'Conferir estado'}
          </button>
        </div>
        <p className="helper">Os totais incluem todas as operações desta origem, inclusive as anteriores à POC-05.</p>
        {integrityError && <div className="feedback feedback-error" role="alert">{integrityError}</div>}
        {summary && (
          <>
            <div className="concurrency-counts">
              <div><span>Operações</span><strong>{summary.operations}</strong></div>
              <div><span>Partidas</span><strong>{summary.entries}</strong></div>
              <div><span>Eventos</span><strong>{summary.events}</strong></div>
              <div><span>Cursor</span><strong>{summary.cursor}</strong></div>
            </div>
            <p className="concurrency-sequences"><strong>Sequências:</strong> {summary.sequences}</p>
            <ul className={`concurrency-checks ${summary.consistent ? 'checks-ok' : 'checks-failed'}`}>
              {summary.checks.map((check) => <li key={check}>{check}</li>)}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}
