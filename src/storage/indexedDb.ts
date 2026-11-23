import { createUuidV4 } from '../utils/uuid'

export interface TestRecord {
  id: string
  description: string
  createdAt: string
}

const DATABASE_NAME = 'gestor-motoristas-poc'
const DATABASE_VERSION = 1
const STORE_NAME = 'test_records'

let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (!('indexedDB' in window)) {
    return Promise.reject(
      new Error('IndexedDB não está disponível neste navegador.'),
    )
  }

  if (databasePromise) return databasePromise

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, {
          keyPath: 'id',
        })
      }
    }

    request.onsuccess = () => {
      const database = request.result

      database.onversionchange = () => {
        database.close()
        databasePromise = null
      }

      resolve(database)
    }

    request.onerror = () => {
      databasePromise = null
      reject(request.error ?? new Error('Falha ao abrir o banco de dados.'))
    }

    request.onblocked = () => {
      databasePromise = null
      reject(
        new Error(
          'A abertura do banco foi bloqueada por outra conexão. Feche outras abas do aplicativo.',
        ),
      )
    }
  })

  return databasePromise
}

function executeTransaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        let result: T

        let transaction: IDBTransaction

        try {
          transaction = database.transaction(STORE_NAME, mode)

          const store = transaction.objectStore(STORE_NAME)
          const request = operation(store)

          request.onsuccess = () => {
            result = request.result
          }

          request.onerror = () => {
            // A falha do request deve abortar a transação.
          }

          transaction.oncomplete = () => {
            resolve(result)
          }

          transaction.onabort = () => {
            reject(
              transaction.error ??
                new Error('A operação foi cancelada pelo banco de dados.'),
            )
          }

          transaction.onerror = () => {
            // O evento abort tratará a rejeição da operação.
          }
        } catch (error) {
          reject(error)
        }
      }),
  )
}

export async function saveRecord(
  description: string,
): Promise<void> {
  const record: TestRecord = {
    id: createUuidV4(),
    description,
    createdAt: new Date().toISOString(),
  }

  await executeTransaction('readwrite', (store) =>
    store.add(record),
  )
}

export async function getRecords(): Promise<TestRecord[]> {
  const records = await executeTransaction<TestRecord[]>(
    'readonly',
    (store) => store.getAll(),
  )

  return records.sort(
    (a, b) =>
      new Date(b.createdAt).getTime() -
      new Date(a.createdAt).getTime(),
  )
}

export async function deleteRecord(id: string): Promise<void> {
  await executeTransaction('readwrite', (store) =>
    store.delete(id),
  )
}

export async function getStorageStatus(): Promise<{
  persisted: boolean | null
  usage: number | null
  quota: number | null
}> {
  if (!navigator.storage) {
    return {
      persisted: null,
      usage: null,
      quota: null,
    }
  }

  let persisted: boolean | null = null

  if (navigator.storage.persisted) {
    persisted = await navigator.storage.persisted()
  }

  let usage: number | null = null
  let quota: number | null = null

  if (navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate()

    usage = estimate.usage ?? null
    quota = estimate.quota ?? null
  }

  return {
    persisted,
    usage,
    quota,
  }
}

export async function requestPersistentStorage(): Promise<boolean | null> {
  if (!navigator.storage?.persist) {
    return null
  }

  return navigator.storage.persist()
}
