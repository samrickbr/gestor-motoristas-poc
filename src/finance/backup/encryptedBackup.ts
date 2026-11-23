import { canonicalizeJson, measureCanonicalJsonUtf8 } from './canonicalJson'
import { encodeRecoveryBytes, parseRecoveryCode, type RecoveryCode, toArrayBuffer } from './recoveryCode'
import {
  bytesToHex,
  digestSnapshot,
  isCanonicalIsoDate,
  requireSubtleCrypto,
  validateFinanceSnapshot,
} from './snapshot'
import type { FinanceSnapshot, SnapshotCounts } from './snapshot'

const MAGIC = new Uint8Array([0x47, 0x4d, 0x4c, 0x42, 0x4b, 0x55, 0x50, 0x00]) // GMLBKUP\0
const PREFIX_SIZE = 14
const FORMAT_VERSION = 1
const SOURCE_SCHEMA_VERSION = 4
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_HEADER_BYTES = 4096
const SALT_BYTES = 16
const NONCE_BYTES = 12
const TAG_BITS = 128
const HKDF_INFO = new TextEncoder().encode('gestor-motoristas/backup/v1/aes-gcm-256')

interface BackupHeader {
  formatVersion: 1
  sourceSchemaVersion: 4
  cipher: 'AES-256-GCM'
  kdf: 'HKDF-SHA-256'
  salt: string
  nonce: string
  tagLength: 128
}

interface BackupManifest {
  formatVersion: 1
  sourceSchemaVersion: 4
  createdAt: string
  counts: SnapshotCounts
  snapshotSha256: string
}

interface BackupPayload {
  manifest: BackupManifest
  snapshot: FinanceSnapshot
}

export interface BackupLimits {
  maxFileBytes?: number
  maxHeaderBytes?: number
}

export interface InspectedBackup {
  readonly formatVersion: 1
  readonly sourceSchemaVersion: 4
  readonly prefix: Uint8Array
  readonly headerBytes: Uint8Array
  readonly header: BackupHeader
  readonly ciphertextOffset: number
  readonly ciphertextLength: number
}

export interface BackupPreview {
  formatVersion: 1
  sourceSchemaVersion: 4
  createdAt: string
  counts: SnapshotCounts
  snapshotSha256: string
}

export interface ValidatedBackup {
  preview: BackupPreview
  snapshot: FinanceSnapshot
}

export async function createEncryptedBackup(
  snapshot: FinanceSnapshot,
  recoveryCode: RecoveryCode,
  createdAt = new Date().toISOString(),
): Promise<Blob> {
  if (await encodeRecoveryBytes(recoveryCode.bytes) !== recoveryCode.text) {
    throw new Error('Objeto de código de recuperação inválido ou divergente.')
  }
  if (!isCanonicalIsoDate(createdAt)) throw new Error('Data de criação deve estar em ISO 8601 UTC canônico.')
  const cryptoApi = requireCryptoWithRandom()
  const salt = cryptoApi.getRandomValues(new Uint8Array(SALT_BYTES))
  const nonce = cryptoApi.getRandomValues(new Uint8Array(NONCE_BYTES))
  const header: BackupHeader = {
    formatVersion: FORMAT_VERSION,
    sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
    cipher: 'AES-256-GCM',
    kdf: 'HKDF-SHA-256',
    salt: bytesToHex(salt),
    nonce: bytesToHex(nonce),
    tagLength: TAG_BITS,
  }
  const headerBytes = new TextEncoder().encode(canonicalizeJson(header))
  const availablePlaintextBytes = MAX_FILE_BYTES - PREFIX_SIZE - headerBytes.length - TAG_BITS / 8
  if (availablePlaintextBytes < 0) throw new Error('Cabeçalho excede o limite de tamanho permitido.')

  if (!snapshot || snapshot.schemaVersion !== SOURCE_SCHEMA_VERSION || !Array.isArray(snapshot.operations) ||
      !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.outbox) || !Array.isArray(snapshot.sync_state)) {
    throw new Error('Snapshot não contém o schema e as quatro stores esperadas.')
  }
  const counts: SnapshotCounts = {
    operations: snapshot.operations.length,
    entries: snapshot.entries.length,
    outbox: snapshot.outbox.length,
    sync_state: snapshot.sync_state.length,
  }

  // The digest is always 64 hexadecimal characters, so this placeholder has the
  // exact serialized length of the eventual manifest value. Count before digesting
  // or materializing the full payload and stop as soon as the file budget is exceeded.
  const payload: BackupPayload = {
    manifest: {
      formatVersion: FORMAT_VERSION,
      sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
      createdAt,
      counts,
      snapshotSha256: '0'.repeat(64),
    },
    snapshot,
  }
  measureCanonicalJsonUtf8(payload, availablePlaintextBytes)
  validateFinanceSnapshot(snapshot)
  const snapshotSha256 = await digestSnapshot(snapshot)
  payload.manifest.snapshotSha256 = snapshotSha256
  const plaintext = new TextEncoder().encode(canonicalizeJson(payload))
  if (plaintext.length > availablePlaintextBytes) {
    plaintext.fill(0)
    throw new Error('Payload de backup excede o orçamento do arquivo permitido.')
  }
  const prefix = makePrefix(headerBytes.length)
  const additionalData = concatenate(prefix, headerBytes)
  const key = await deriveBackupKey(recoveryCode.bytes, salt)
  let ciphertext: ArrayBuffer
  try {
    ciphertext = await requireSubtleCrypto().encrypt({
      name: 'AES-GCM',
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(additionalData),
      tagLength: TAG_BITS,
    }, key, toArrayBuffer(plaintext))
  } finally {
    plaintext.fill(0)
  }
  if (PREFIX_SIZE + headerBytes.length + ciphertext.byteLength > MAX_FILE_BYTES) {
    throw new Error('Backup cifrado excede o limite de tamanho permitido.')
  }
  return new Blob([toArrayBuffer(prefix), toArrayBuffer(headerBytes), ciphertext], { type: 'application/octet-stream' })
}

export async function inspectBackupEnvelope(
  file: Blob,
  limits: BackupLimits = {},
): Promise<InspectedBackup> {
  const maxFileBytes = limits.maxFileBytes ?? MAX_FILE_BYTES
  const maxHeaderBytes = limits.maxHeaderBytes ?? MAX_HEADER_BYTES
  if (file.size > maxFileBytes) throw new Error('Arquivo excede o limite permitido.')
  if (file.size < PREFIX_SIZE + 1 + TAG_BITS / 8) throw new Error('Arquivo truncado ou incompleto.')
  const prefix = new Uint8Array(await file.slice(0, PREFIX_SIZE).arrayBuffer())
  for (let index = 0; index < MAGIC.length; index++) {
    if (prefix[index] !== MAGIC[index]) throw new Error('Prefixo de backup inválido.')
  }
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength)
  const formatVersion = view.getUint16(8, false)
  if (formatVersion !== FORMAT_VERSION) throw new Error('Versão de formato de backup incompatível.')
  const headerLength = view.getUint32(10, false)
  if (headerLength < 2 || headerLength > maxHeaderBytes || PREFIX_SIZE + headerLength + TAG_BITS / 8 > file.size) {
    throw new Error('Comprimento de cabeçalho inválido ou arquivo truncado.')
  }
  const headerBytes = new Uint8Array(await file.slice(PREFIX_SIZE, PREFIX_SIZE + headerLength).arrayBuffer())
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headerBytes))
  } catch {
    throw new Error('Cabeçalho JSON inválido.')
  }
  const header = validateHeader(parsed)
  if (canonicalizeJson(header) !== new TextDecoder().decode(headerBytes)) {
    throw new Error('Cabeçalho não está na forma canônica.')
  }
  return {
    formatVersion: FORMAT_VERSION,
    sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
    prefix,
    headerBytes,
    header,
    ciphertextOffset: PREFIX_SIZE + headerLength,
    ciphertextLength: file.size - PREFIX_SIZE - headerLength,
  }
}

export async function decryptBackupPayload(
  file: Blob,
  inspected: InspectedBackup,
  code: RecoveryCode,
): Promise<Uint8Array> {
  const ciphertext = new Uint8Array(await file.slice(inspected.ciphertextOffset).arrayBuffer())
  try {
    if (ciphertext.length !== inspected.ciphertextLength || ciphertext.length < TAG_BITS / 8) {
      throw new Error('Ciphertext truncado.')
    }
    const salt = hexToBytes(inspected.header.salt)
    const nonce = hexToBytes(inspected.header.nonce)
    const key = await deriveBackupKey(code.bytes, salt)
    const subtle = requireSubtleCrypto()
    try {
      const additionalData = concatenate(inspected.prefix, inspected.headerBytes)
      const result = await subtle.decrypt({
        name: 'AES-GCM',
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(additionalData),
        tagLength: inspected.header.tagLength,
      }, key, toArrayBuffer(ciphertext))
      return new Uint8Array(result)
    } catch {
      throw new Error('Não foi possível autenticar o arquivo ou o código de recuperação está incorreto.')
    }
  } finally {
    ciphertext.fill(0)
  }
}

export async function validateBackupPayload(plaintext: Uint8Array): Promise<ValidatedBackup> {
  try {
    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    } catch {
      throw new Error('Conteúdo descriptografado inválido.')
    }
    return await validatePayload(payload)
  } finally {
    plaintext.fill(0)
  }
}

export async function importAndValidateBackup(
  file: Blob,
  inspected: InspectedBackup,
  recoveryCodeText: string,
): Promise<ValidatedBackup> {
  const code = await parseRecoveryCode(recoveryCodeText)
  try {
    const plaintext = await decryptBackupPayload(file, inspected, code)
    return await validateBackupPayload(plaintext)
  } finally {
    code.bytes.fill(0)
  }
}

export async function deriveBackupKey(rawCodeBytes: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  if (rawCodeBytes.length !== 32) throw new Error('Código de recuperação inválido.')
  if (salt.length !== SALT_BYTES) throw new Error('Salt de backup inválido.')
  const subtle = requireSubtleCrypto()
  const material = await subtle.importKey('raw', toArrayBuffer(rawCodeBytes), 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: toArrayBuffer(salt),
    info: toArrayBuffer(HKDF_INFO),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function validatePayload(value: unknown): Promise<ValidatedBackup> {
  if (!isRecord(value) || !isRecord(value.manifest) || !isRecord(value.snapshot)) {
    throw new Error('Estrutura do payload inválida.')
  }
  assertKeys(value, ['manifest', 'snapshot'], 'payload')
  assertKeys(value.manifest, ['formatVersion', 'sourceSchemaVersion', 'createdAt', 'counts', 'snapshotSha256'], 'manifest')
  const manifest = value.manifest as unknown as BackupManifest
  const snapshot = value.snapshot as unknown as FinanceSnapshot
  if (manifest.formatVersion !== FORMAT_VERSION || manifest.sourceSchemaVersion !== SOURCE_SCHEMA_VERSION ||
      snapshot.schemaVersion !== SOURCE_SCHEMA_VERSION || !isCanonicalIsoDate(manifest.createdAt)) {
    throw new Error('Versão ou data ISO UTC canônica do manifesto inválida.')
  }
  const counts = validateFinanceSnapshot(snapshot)
  if (canonicalizeJson(counts) !== canonicalizeJson(manifest.counts)) {
    throw new Error('Contagens do manifesto divergentes.')
  }
  const snapshotSha256 = await digestSnapshot(snapshot)
  if (snapshotSha256 !== manifest.snapshotSha256) throw new Error('Digest do snapshot divergente.')
  return {
    preview: {
      formatVersion: FORMAT_VERSION,
      sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
      createdAt: manifest.createdAt,
      counts,
      snapshotSha256,
    },
    snapshot,
  }
}

function validateHeader(value: unknown): BackupHeader {
  if (!isRecord(value)) throw new Error('Cabeçalho inválido.')
  const keys = Object.keys(value).sort()
  const expected = ['cipher', 'formatVersion', 'kdf', 'nonce', 'salt', 'sourceSchemaVersion', 'tagLength'].sort()
  if (canonicalizeJson(keys) !== canonicalizeJson(expected) ||
      value.formatVersion !== FORMAT_VERSION || value.sourceSchemaVersion !== SOURCE_SCHEMA_VERSION ||
      value.cipher !== 'AES-256-GCM' || value.kdf !== 'HKDF-SHA-256' || value.tagLength !== TAG_BITS ||
      typeof value.salt !== 'string' || !/^[0-9a-f]{32}$/.test(value.salt) ||
      typeof value.nonce !== 'string' || !/^[0-9a-f]{24}$/.test(value.nonce)) {
    throw new Error('Parâmetros criptográficos ou versão do cabeçalho inválidos.')
  }
  return value as unknown as BackupHeader
}

function makePrefix(headerLength: number): Uint8Array {
  const prefix = new Uint8Array(PREFIX_SIZE)
  prefix.set(MAGIC)
  const view = new DataView(prefix.buffer)
  view.setUint16(8, FORMAT_VERSION, false)
  view.setUint32(10, headerLength, false)
  return prefix
}

function requireCryptoWithRandom(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new Error('Web Crypto indisponível. Abra a aplicação em um contexto seguro (HTTPS).')
  }
  return globalThis.crypto
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length)
  result.set(left)
  result.set(right, left.length)
  return result
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return bytes
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertKeys(value: Record<string, unknown>, expectedKeys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Campos inválidos em ${label}.`)
  }
}

export const backupFormatConstants = {
  maxFileBytes: MAX_FILE_BYTES,
  maxHeaderBytes: MAX_HEADER_BYTES,
  nonceBytes: NONCE_BYTES,
  saltBytes: SALT_BYTES,
  tagBits: TAG_BITS,
  formatVersion: FORMAT_VERSION,
}
