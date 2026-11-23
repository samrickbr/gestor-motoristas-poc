
import { useCallback, useEffect, useState } from 'react'
import {
  deleteRecord,
  getRecords,
  getStorageStatus,
  requestPersistentStorage,
  saveRecord,
  type TestRecord,
} from './storage/indexedDb'
import './App.css'
import FinanceDemo from './finance/demo/FinanceDemo'

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value))
}

function formatBytes(value: number | null): string {
  if (value === null) return 'Indisponível'

  return new Intl.NumberFormat('pt-BR', {
    maximumFractionDigits: 2,
  }).format(value / 1024 / 1024) + ' MB'
}

function StorageDemo() {
  const [description, setDescription] = useState('')
  const [records, setRecords] = useState<TestRecord[]>([])
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [usage, setUsage] = useState<number | null>(null)
  const [quota, setQuota] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    const [savedRecords, storageStatus] = await Promise.all([
      getRecords(),
      getStorageStatus(),
    ])

    setRecords(savedRecords)
    setPersisted(storageStatus.persisted)
    setUsage(storageStatus.usage)
    setQuota(storageStatus.quota)
  }, [])

  useEffect(() => {
    let active = true

    async function initialize() {
      try {
        await refresh()
      } catch (cause) {
        if (active) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Não foi possível acessar o armazenamento.',
          )
        }
      } finally {
        if (active) setLoading(false)
      }
    }

    void initialize()

    return () => {
      active = false
    }
  }, [refresh])

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const value = description.trim()

    if (!value) {
      setError('Digite uma descrição para o registro.')
      return
    }

    setSaving(true)
    setError('')
    setMessage('')

    try {
      await saveRecord(value)
      setDescription('')
      await refresh()
      setMessage('Registro gravado e transação concluída.')
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Falha ao gravar o registro.',
      )
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    setError('')
    setMessage('')

    try {
      await deleteRecord(id)
      await refresh()
      setMessage('Registro excluído com sucesso.')
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Falha ao excluir o registro.',
      )
    }
  }

  async function handlePersistentStorage() {
    setError('')
    setMessage('')

    try {
      const result = await requestPersistentStorage()

      await refresh()

      if (result === null) {
        setMessage('Este navegador não oferece solicitação de persistência.')
      } else if (result) {
        setMessage('O navegador concedeu armazenamento persistente.')
      } else {
        setMessage('O navegador não concedeu armazenamento persistente.')
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível solicitar persistência.',
      )
    }
  }

  return (
    <main className="app">
      <header className="header">
        <span className="eyebrow">PROVA DE CONCEITO · POC-02</span>
        <h1>Persistência local</h1>
        <p>
          Teste de armazenamento de registros no dispositivo usando IndexedDB.
        </p>
      </header>

      <section className="status-card">
        <div>
          <span className="section-label">BANCO DE DADOS</span>
          <strong>IndexedDB</strong>
          <span className="muted">gestor-motoristas-poc</span>
        </div>

        <span className="status-indicator">
          <span className="status-dot" />
          {loading ? 'Verificando' : error ? 'Verificar erro' : 'Disponível'}
        </span>
      </section>

      <section className="storage-card">
        <div className="section-heading">
          <div>
            <span className="section-label">ARMAZENAMENTO</span>
            <h2>Estado do dispositivo</h2>
          </div>
        </div>

        <div className="storage-grid">
          <div>
            <span>Persistência</span>
            <strong>
              {persisted === null
                ? 'Não informado'
                : persisted
                  ? 'Concedida'
                  : 'Não concedida'}
            </strong>
          </div>

          <div>
            <span>Uso estimado</span>
            <strong>{formatBytes(usage)}</strong>
          </div>

          <div>
            <span>Quota estimada</span>
            <strong>{formatBytes(quota)}</strong>
          </div>
        </div>

        <button
          className="button button-secondary"
          type="button"
          onClick={handlePersistentStorage}
        >
          Solicitar armazenamento persistente
        </button>

        <p className="helper">
          A concessão depende do navegador. Mesmo quando concedida, não
          substitui backup.
        </p>
      </section>

      <section className="form-card">
        <span className="section-label">NOVO REGISTRO</span>
        <h2>Adicionar dado de teste</h2>

        <form onSubmit={handleSave}>
          <label htmlFor="description">Descrição</label>

          <input
            id="description"
            type="text"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Ex.: Registro de teste número 1"
            maxLength={200}
            disabled={saving}
          />

          <button
            className="button button-primary"
            type="submit"
            disabled={saving || !description.trim()}
          >
            {saving ? 'Gravando...' : 'Gravar no IndexedDB'}
          </button>
        </form>
      </section>

      {message && (
        <div className="feedback feedback-success" role="status">
          {message}
        </div>
      )}

      {error && (
        <div className="feedback feedback-error" role="alert">
          {error}
        </div>
      )}

      <section className="records-section">
        <div className="section-heading">
          <div>
            <span className="section-label">DADOS PERSISTIDOS</span>
            <h2>Registros de teste</h2>
          </div>

          <span className="record-count">{records.length}</span>
        </div>

        {loading ? (
          <p className="empty-state">Carregando registros...</p>
        ) : records.length === 0 ? (
          <p className="empty-state">
            Nenhum registro salvo. Adicione um registro para começar.
          </p>
        ) : (
          <ul className="record-list">
            {records.map((record) => (
              <li className="record-item" key={record.id}>
                <div className="record-content">
                  <strong>{record.description}</strong>
                  <span>{formatDate(record.createdAt)}</span>
                  <small>ID: {record.id}</small>
                </div>

                <button
                  className="button-delete"
                  type="button"
                  onClick={() => void handleDelete(record.id)}
                  aria-label={`Excluir ${record.description}`}
                >
                  Excluir
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="footer">
        <span>Gestor de Motoristas · Protótipo técnico</span>
        <span>Os dados permanecem neste navegador e nesta origem.</span>
      </footer>
    </main>
  )
}

function App() {
  const [view, setView] = useState<'poc02' | 'poc03'>('poc03')

  return (
    <>
      <nav className="demo-nav" aria-label="Demonstrações">
        <button type="button" aria-pressed={view === 'poc03'} onClick={() => setView('poc03')}>POC-03 · Diário financeiro</button>
        <button type="button" aria-pressed={view === 'poc02'} onClick={() => setView('poc02')}>POC-02 · Persistência local</button>
      </nav>
      {view === 'poc03' ? <FinanceDemo /> : <StorageDemo />}
    </>
  )
}

export default App
