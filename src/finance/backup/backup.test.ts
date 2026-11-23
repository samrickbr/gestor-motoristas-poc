import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalizeJson, measureCanonicalJsonUtf8 } from './canonicalJson'
import {
  backupFormatConstants,
  createEncryptedBackup,
  decryptBackupPayload,
  importAndValidateBackup,
  inspectBackupEnvelope,
  deriveBackupKey,
  validateBackupPayload,
} from './encryptedBackup'
import {
  decodeBase32,
  encodeBase32,
  encodeRecoveryBytes,
  generateRecoveryCode,
  parseRecoveryCode,
  releaseRecoveryCode,
} from './recoveryCode'
import { digestSnapshot, validateFinanceSnapshot, type FinanceSnapshot } from './snapshot'
import { createOperation, operationFingerprint } from '../domain'

const codes: Awaited<ReturnType<typeof generateRecoveryCode>>[] = []

async function newCode() {
  const code = await generateRecoveryCode()
  codes.push(code)
  return code
}

function snapshotFixture(): FinanceSnapshot {
  const operation = createOperation({
    id: 'backup-op-1',
    idempotencyKey: 'backup-key-1',
    type: 'revenue',
    description: 'Receita de backup',
    createdAt: '2026-01-01T12:00:00.000Z',
    entries: [
      { accountId: 'cash', side: 'debit', amountCents: 10000, currency: 'BRL' },
      { accountId: 'revenue', side: 'credit', amountCents: 10000, currency: 'BRL' },
    ],
  })
  return {
    schemaVersion: 4,
    operations: [{ ...operation, fingerprint: JSON.stringify({
      type: operation.type,
      description: operation.description,
      reversesOperationId: null,
      entries: operation.entries,
    }) }],
    entries: [
      { id: 'backup-op-1:0', operationId: 'backup-op-1', ...operation.entries[0] },
      { id: 'backup-op-1:1', operationId: 'backup-op-1', ...operation.entries[1] },
    ],
    outbox: [{
      eventId: 'backup-event-1', sequence: 1, operationId: operation.id,
      createdAt: operation.createdAt, status: 'pending', snapshot: operation,
    }],
    sync_state: [{ key: 'state', nextSequence: 2, cursor: 0 }],
  }
}

afterEach(() => {
  for (const code of codes.splice(0)) releaseRecoveryCode(code)
  vi.restoreAllMocks()
})

function watchCiphertextZeroFill(length: number): { buffers: Uint8Array[]; restore: () => void } {
  const buffers: Uint8Array[] = []
  const originalFill = Uint8Array.prototype.fill
  const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
    this: Uint8Array,
    value: number,
    start?: number,
    end?: number,
  ) {
    if (value === 0 && this.byteLength === length) buffers.push(this)
    return originalFill.call(this, value, start, end)
  })
  return { buffers, restore: () => spy.mockRestore() }
}

function expectCiphertextWasZeroed(buffers: Uint8Array[]): void {
  expect(buffers).toHaveLength(1)
  expect(buffers[0]?.every((byte) => byte === 0)).toBe(true)
}

describe('código de recuperação Base32', () => {
  it('implementa vetores RFC 4648 e a forma de 32 bytes aprovada', async () => {
    expect(encodeBase32(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI')
    expect(new TextDecoder().decode(decodeBase32('MZXW6YTBOI'))).toBe('foobar')
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index)
    expect(encodeBase32(bytes)).toBe('AAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPQ')
    expect(await encodeRecoveryBytes(bytes)).toBe(
      'AAAQ-EAYE-AUDA-OCAJ-BIFQ-YDIO-B4IB-CEQT-CQKR-MFYY-DENB-WHA5-DYPQ~R2QX',
    )
    expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes)
  })

  it('faz roundtrip do código gerado para os mesmos 32 bytes', async () => {
    const generated = await newCode()
    const parsed = await parseRecoveryCode(generated.text)
    expect(parsed.bytes).toEqual(generated.bytes)
    expect(generated.text.replaceAll('-', '').split('~')[0]).toHaveLength(52)
  })

  it.each([
    'AAAQ-EAYE-AUDA-OCAJ-BIFQ-YDIO-B4IB-CEQT-CQKR-MFYY-DENB-WHA5-DYP0~R2QX',
    'AAAQ-EAYE-AUDA-OCAJ-BIFQ-YDIO-B4IB-CEQT-CQKR-MFYY-DENB-WHA5-DYPQ~R2QW',
    'AAAQ EAYE AUDA OCAJ BIFQ YDIO B4IB CEQT CQKR MFYY DENB WHA5 DYPQ~R2QX',
    'AAAQ-EAYE-AUDA-OCAJ-BIFQ-YDIO-B4IB-CEQT-CQKR-MFYY-DENB-WHA5-DYPR~R2QX',
  ])('rejeita entrada Base32/checksum inválida: %s', async (text) => {
    await expect(parseRecoveryCode(text)).rejects.toThrow()
  })
})

describe('canonicalização e integridade do snapshot', () => {
  it('produz JSON JCS determinístico e ordena stores independentemente da ordem de entrada', async () => {
    expect(canonicalizeJson({ z: 1, a: 'x', omitted: undefined })).toBe('{"a":"x","z":1}')
    const first = snapshotFixture()
    const second = structuredClone(first)
    second.operations.reverse()
    second.entries.reverse()
    second.outbox.reverse()
    expect(await digestSnapshot(first)).toBe(await digestSnapshot(second))
  })

  it('rejeita números não finitos e inteiros inseguros', () => {
    expect(() => canonicalizeJson({ value: Number.NaN })).toThrow(/não finito/)
    expect(() => canonicalizeJson({ value: Number.POSITIVE_INFINITY })).toThrow(/não finito/)
    expect(() => canonicalizeJson({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/limite seguro/)
    expect(() => canonicalizeJson(new Array(1))).toThrow(/Valor ausente em array/)
  })

  it('rejeita acessores de índice sem executar getter ou setter', () => {
    const getter = vi.fn(() => 'value')
    const array = [] as string[]
    Object.defineProperty(array, '0', { configurable: true, enumerable: true, get: getter })
    array.length = 1
    expect(() => canonicalizeJson(array)).toThrow(/acessora/)
    expect(getter).not.toHaveBeenCalled()

    const setterArray = [] as string[]
    Object.defineProperty(setterArray, '0', {
      configurable: true,
      enumerable: true,
      get: getter,
      set: vi.fn(),
    })
    setterArray.length = 1
    expect(() => canonicalizeJson(setterArray)).toThrow(/acessora/)
    expect(getter).not.toHaveBeenCalled()
  })

  it('rejeita arrays esparsos, undefined, propriedades enumeráveis extras e Symbols', () => {
    expect(() => canonicalizeJson(new Array(1))).toThrow(/Valor ausente/)
    expect(() => canonicalizeJson([undefined])).toThrow(/Valor ausente/)
    const extra = [1] as number[] & { extra?: number }
    extra.extra = 2
    expect(() => canonicalizeJson(extra)).toThrow(/Propriedade extra/)
    const symbol = [1]
    Object.defineProperty(symbol, Symbol('extra'), { value: 2, enumerable: true })
    expect(() => canonicalizeJson(symbol)).toThrow(/Symbol/)
  })

  it('preserva a ordem de arrays válidos e mede UTF-8 canônico', () => {
    const value = ['z', 'á', '😀', 1]
    const json = canonicalizeJson(value)
    expect(json).toBe('["z","á","😀",1]')
    expect(measureCanonicalJsonUtf8(value, 100)).toBe(new TextEncoder().encode(json).length)
    expect(() => measureCanonicalJsonUtf8(value, 2)).toThrow(/limite de tamanho/)
  })

  it('conta bytes de escapes JSON e caracteres multibyte exatamente', () => {
    const values = ['\b\t\n\f\r"\\', '\u0000', 'á', '😀']
    for (const value of values) {
      const json = canonicalizeJson(value)
      expect(measureCanonicalJsonUtf8(value, 100)).toBe(new TextEncoder().encode(json).length)
    }
  })

  it('valida relações financeiras e aceita operação legada sem evento de outbox', () => {
    const legacy = snapshotFixture()
    legacy.outbox = []
    legacy.sync_state = [{ key: 'state', nextSequence: 1, cursor: 0 }]
    expect(validateFinanceSnapshot(legacy)).toMatchObject({ operations: 1, entries: 2, outbox: 0 })
    legacy.entries.pop()
    expect(() => validateFinanceSnapshot(legacy)).toThrow(/partidas/i)
  })
})

describe('backup criptografado', () => {
  it('faz HKDF/AES-GCM roundtrip e gera chave não extraível', async () => {
    const code = await newCode()
    const key = await deriveBackupKey(code.bytes, new Uint8Array(16).fill(1))
    expect(key.extractable).toBe(false)
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
    expect(key.usages).toEqual(['encrypt', 'decrypt'])

    const file = await createEncryptedBackup(snapshotFixture(), code, '2026-06-01T00:00:00.000Z')
    const inspected = await inspectBackupEnvelope(file)
    expect(file.size).toBeLessThanOrEqual(backupFormatConstants.maxFileBytes)
    const imported = await importAndValidateBackup(file, inspected, code.text)
    expect(imported.preview).toMatchObject({
      sourceSchemaVersion: 4,
      createdAt: '2026-06-01T00:00:00.000Z',
      counts: { operations: 1, entries: 2, outbox: 1, sync_state: 1 },
    })
    expect(imported.snapshot).toEqual(snapshotFixture())
  })

  it('contabiliza prefixo, cabeçalho e tag AES-GCM no tamanho final', async () => {
    const code = await newCode()
    const file = await createEncryptedBackup(snapshotFixture(), code)
    const inspected = await inspectBackupEnvelope(file)
    const plaintext = await decryptBackupPayload(file, inspected, code)
    expect(file.size).toBe(14 + inspected.headerBytes.length + plaintext.length + 16)
    plaintext.fill(0)
  })

  it('limpa ciphertext quando o tamanho informado é inválido', async () => {
    const code = await newCode()
    const file = await createEncryptedBackup(snapshotFixture(), code)
    const inspected = await inspectBackupEnvelope(file)
    const watcher = watchCiphertextZeroFill(inspected.ciphertextLength)
    try {
      await expect(decryptBackupPayload(file, { ...inspected, ciphertextLength: inspected.ciphertextLength + 1 }, code))
        .rejects.toThrow(/Ciphertext truncado/)
      expectCiphertextWasZeroed(watcher.buffers)
    } finally {
      watcher.restore()
    }
  })

  it('limpa ciphertext quando a derivação da chave falha', async () => {
    const code = await newCode()
    const file = await createEncryptedBackup(snapshotFixture(), code)
    const inspected = await inspectBackupEnvelope(file)
    const watcher = watchCiphertextZeroFill(inspected.ciphertextLength)
    try {
      await expect(decryptBackupPayload(file, inspected, { ...code, bytes: new Uint8Array(31) }))
        .rejects.toThrow(/Código de recuperação inválido/)
      expectCiphertextWasZeroed(watcher.buffers)
    } finally {
      watcher.restore()
    }
  })

  it('limpa ciphertext quando Web Crypto rejeita a descriptografia', async () => {
    const code = await newCode()
    const file = await createEncryptedBackup(snapshotFixture(), code)
    const inspected = await inspectBackupEnvelope(file)
    const watcher = watchCiphertextZeroFill(inspected.ciphertextLength)
    const decrypt = vi.spyOn(globalThis.crypto.subtle, 'decrypt').mockRejectedValue(new Error('simulated failure'))
    try {
      await expect(decryptBackupPayload(file, inspected, code)).rejects.toThrow(/Não foi possível autenticar/)
      expect(decrypt).toHaveBeenCalledOnce()
      expectCiphertextWasZeroed(watcher.buffers)
    } finally {
      watcher.restore()
      decrypt.mockRestore()
    }
  })

  it('limpa ciphertext após falha de autenticação AES-GCM', async () => {
    const code = await newCode()
    const original = await createEncryptedBackup(snapshotFixture(), code)
    const bytes = new Uint8Array(await original.arrayBuffer())
    bytes[bytes.length - 1] ^= 1
    const file = new Blob([bytes])
    const inspected = await inspectBackupEnvelope(file)
    const watcher = watchCiphertextZeroFill(inspected.ciphertextLength)
    try {
      await expect(decryptBackupPayload(file, inspected, code)).rejects.toThrow(/Não foi possível autenticar/)
      expectCiphertextWasZeroed(watcher.buffers)
    } finally {
      watcher.restore()
    }
  })

  it('limpa ciphertext também após descriptografia bem-sucedida', async () => {
    const code = await newCode()
    const file = await createEncryptedBackup(snapshotFixture(), code)
    const inspected = await inspectBackupEnvelope(file)
    const watcher = watchCiphertextZeroFill(inspected.ciphertextLength)
    try {
      const plaintext = await decryptBackupPayload(file, inspected, code)
      expect(plaintext.length).toBeGreaterThan(0)
      expectCiphertextWasZeroed(watcher.buffers)
      plaintext.fill(0)
    } finally {
      watcher.restore()
    }
  })

  it('rejeita payload acima do orçamento antes de chamar AES-GCM', async () => {
    const code = await newCode()
    const snapshot = snapshotFixture()
    const operation = snapshot.operations[0]
    if (!operation) throw new Error('Fixture sem operação.')
    operation.description = 'x'.repeat(34 * 1024 * 1024)
    operation.fingerprint = operationFingerprint(operation)
    const event = snapshot.outbox[0]
    if (!event) throw new Error('Fixture sem evento.')
    event.snapshot = {
      id: operation.id,
      idempotencyKey: operation.idempotencyKey,
      type: operation.type,
      description: operation.description,
      createdAt: operation.createdAt,
      entries: operation.entries,
    }
    const encrypt = vi.spyOn(globalThis.crypto.subtle, 'encrypt')
    try {
      await expect(createEncryptedBackup(snapshot, code)).rejects.toThrow(/limite de tamanho/)
      expect(encrypt).not.toHaveBeenCalled()
    } finally {
      encrypt.mockRestore()
    }
  })

  it('executa a checagem final quando AES-GCM retorna ciphertext acima do limite', async () => {
    const code = await newCode()
    const oversizedCiphertext = new Proxy(new ArrayBuffer(0), {
      get(target, property) {
        if (property === 'byteLength') return backupFormatConstants.maxFileBytes
        return Reflect.get(target, property, target)
      },
    }) as ArrayBuffer
    const encrypt = vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockResolvedValue(oversizedCiphertext)
    try {
      await expect(createEncryptedBackup(snapshotFixture(), code)).rejects.toThrow(/Backup cifrado excede o limite/)
      expect(encrypt).toHaveBeenCalledOnce()
    } finally {
      encrypt.mockRestore()
    }
  })

  it('mantém o limite de 64 MiB na inspeção final do arquivo', async () => {
    expect(backupFormatConstants.maxFileBytes).toBe(64 * 1024 * 1024)
    const oversized = { size: backupFormatConstants.maxFileBytes + 1 } as Blob
    await expect(inspectBackupEnvelope(oversized)).rejects.toThrow(/limite/)
  })

  it('exige data canônica na criação e na validação do manifesto importado', async () => {
    const code = await newCode()
    for (const invalid of [
      '2026-06-01T00:00:00Z',
      '2026-06-01T00:00:00.000+00:00',
      '2026-06-01T00:00:00.000',
      '2026-02-30T00:00:00.000Z',
    ]) {
      await expect(createEncryptedBackup(snapshotFixture(), code, invalid)).rejects.toThrow(/ISO 8601 UTC canônico/)
    }

    const file = await createEncryptedBackup(snapshotFixture(), code)
    const inspected = await inspectBackupEnvelope(file)
    const plaintext = await decryptBackupPayload(file, inspected, code)
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as { manifest: Record<string, unknown> }
    plaintext.fill(0)
    payload.manifest.createdAt = '2026-06-01T00:00:00Z'
    await expect(validateBackupPayload(new TextEncoder().encode(canonicalizeJson(payload)))).rejects.toThrow(/ISO UTC canônica/)
  })

  it('usa salt e nonce distintos em exportações independentes', async () => {
    const code = await newCode()
    const first = await inspectBackupEnvelope(await createEncryptedBackup(snapshotFixture(), code))
    const second = await inspectBackupEnvelope(await createEncryptedBackup(snapshotFixture(), code))
    expect(first.header.salt).not.toBe(second.header.salt)
    expect(first.header.nonce).not.toBe(second.header.nonce)
    expect(first.header.nonce).toHaveLength(backupFormatConstants.nonceBytes * 2)
  })

  it('rejeita código incorreto, ciphertext adulterado e AAD alterado', async () => {
    const code = await newCode()
    const file = await createEncryptedBackup(snapshotFixture(), code)
    const inspected = await inspectBackupEnvelope(file)
    const wrongCode = await newCode()
    await expect(importAndValidateBackup(file, inspected, wrongCode.text)).rejects.toThrow(/autenticar/)

    const bytes = new Uint8Array(await file.arrayBuffer())
    bytes[bytes.length - 1] ^= 1
    const changedCiphertext = new Blob([bytes])
    const changedCiphertextInfo = await inspectBackupEnvelope(changedCiphertext)
    await expect(importAndValidateBackup(changedCiphertext, changedCiphertextInfo, code.text)).rejects.toThrow(/autenticar/)

    const changedHeader = new Uint8Array(await file.arrayBuffer())
    const headerStart = 14
    const saltPosition = headerStart + new TextDecoder().decode(changedHeader.slice(headerStart)).indexOf('salt') + 8
    changedHeader[saltPosition] = changedHeader[saltPosition] === 0x30 ? 0x31 : 0x30
    const changedAadFile = new Blob([changedHeader])
    const changedAadInfo = await inspectBackupEnvelope(changedAadFile)
    await expect(importAndValidateBackup(changedAadFile, changedAadInfo, code.text)).rejects.toThrow(/autenticar/)
  })

  it('rejeita arquivo truncado, versão inválida e tamanho acima do limite', async () => {
    const code = await newCode()
    const file = await createEncryptedBackup(snapshotFixture(), code)
    await expect(inspectBackupEnvelope(file.slice(0, file.size - 1))).resolves.toBeDefined()
    const inspected = await inspectBackupEnvelope(file.slice(0, file.size - 1))
    await expect(importAndValidateBackup(file.slice(0, file.size - 1), inspected, code.text)).rejects.toThrow()

    const invalidVersionBytes = new Uint8Array(await file.arrayBuffer())
    invalidVersionBytes[9] = 2
    await expect(inspectBackupEnvelope(new Blob([invalidVersionBytes]))).rejects.toThrow(/versão/i)
    await expect(inspectBackupEnvelope(file, { maxFileBytes: 20 })).rejects.toThrow(/limite/)

    const invalidHeaderBytes = new Uint8Array(await file.arrayBuffer())
    const headerText = new TextDecoder().decode(invalidHeaderBytes.slice(14))
    const headerStart = 14
    const kdfOffset = headerStart + headerText.indexOf('HKDF-SHA-256')
    invalidHeaderBytes[kdfOffset + 'HKDF-SHA-256'.length - 1] = '5'.charCodeAt(0)
    await expect(inspectBackupEnvelope(new Blob([invalidHeaderBytes]))).rejects.toThrow(/parâmetros/i)
  })

  it('rejeita manifesto com contagens ou digest divergentes', async () => {
    const snapshot = snapshotFixture()
    const code = await newCode()
    const file = await createEncryptedBackup(snapshot, code)
    const inspected = await inspectBackupEnvelope(file)
    const plaintext = await decryptBackupPayload(file, inspected, code)
    const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>
    plaintext.fill(0)
    const payload = decoded as { manifest: Record<string, unknown>; snapshot: FinanceSnapshot }
    payload.manifest.counts = { operations: 2, entries: 2, outbox: 1, sync_state: 1 }
    await expect(validateBackupPayload(new TextEncoder().encode(canonicalizeJson(payload)))).rejects.toThrow(/contagens/i)
    payload.manifest.counts = { operations: 1, entries: 2, outbox: 1, sync_state: 1 }
    payload.manifest.snapshotSha256 = '0'.repeat(64)
    await expect(validateBackupPayload(new TextEncoder().encode(canonicalizeJson(payload)))).rejects.toThrow(/digest/i)
  })

  it('expõe descriptografia autenticada separada da validação do payload', async () => {
    const code = await newCode()
    const file = await createEncryptedBackup(snapshotFixture(), code)
    const inspected = await inspectBackupEnvelope(file)
    const plaintext = await decryptBackupPayload(file, inspected, code)
    expect(new TextDecoder().decode(plaintext)).toContain('snapshotSha256')
    plaintext.fill(0)
  })
})
