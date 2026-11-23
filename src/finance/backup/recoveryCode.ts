import { requireSubtleCrypto } from './snapshot'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const CODE_BYTES = 32
const CODE_CHARACTERS = 52
const CHECKSUM_DOMAIN = new TextEncoder().encode('gestor-motoristas/POC-06/recovery-code-checksum/v1\u0000')

export interface RecoveryCode {
  readonly text: string
  readonly bytes: Uint8Array
}

export async function generateRecoveryCode(): Promise<RecoveryCode> {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.getRandomValues) throw new Error('Gerador criptográfico de aleatoriedade indisponível.')
  if (!cryptoApi.subtle) throw new Error('Web Crypto indisponível. Abra a aplicação em um contexto seguro (HTTPS).')
  const bytes = cryptoApi.getRandomValues(new Uint8Array(CODE_BYTES))
  return { text: await encodeRecoveryBytes(bytes), bytes }
}

export async function parseRecoveryCode(input: string): Promise<RecoveryCode> {
  const normalized = input.toUpperCase()
  const pattern = /^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){12}~[A-Z2-7]{4}$/
  if (!pattern.test(normalized)) throw new Error('Código de recuperação em formato inválido.')
  const [groupedKey, checksum] = normalized.split('~')
  const encoded = groupedKey.replaceAll('-', '')
  if (encoded.length !== CODE_CHARACTERS) throw new Error('Tamanho inválido do código de recuperação.')
  const bytes = decodeBase32(encoded)
  if (bytes.length !== CODE_BYTES) throw new Error('O código deve decodificar para exatamente 32 bytes.')
  const expected = await checksumBase32(bytes)
  if (checksum !== expected) throw new Error('Checksum do código de recuperação inválido.')
  return { text: normalized, bytes }
}

export function releaseRecoveryCode(code: RecoveryCode): void {
  // Best effort only: JavaScript and Web Crypto may retain internal copies.
  code.bytes.fill(0)
}

export async function encodeRecoveryBytes(bytes: Uint8Array): Promise<string> {
  if (bytes.length !== CODE_BYTES) throw new Error('O código de recuperação precisa ter 32 bytes.')
  const encoded = encodeBase32(bytes)
  if (encoded.length !== CODE_CHARACTERS) throw new Error('Falha na codificação Base32 do código.')
  const grouped = encoded.match(/.{4}/g)?.join('-')
  if (!grouped) throw new Error('Falha no agrupamento do código de recuperação.')
  return `${grouped}~${await checksumBase32(bytes)}`
}

export function encodeBase32(bytes: Uint8Array): string {
  let accumulator = 0
  let bitCount = 0
  let output = ''
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bitCount += 8
    while (bitCount >= 5) {
      bitCount -= 5
      output += ALPHABET[(accumulator >>> bitCount) & 31]
    }
  }
  if (bitCount > 0) output += ALPHABET[(accumulator << (5 - bitCount)) & 31]
  return output
}

export function decodeBase32(encoded: string): Uint8Array {
  if (!/^[A-Z2-7]*$/.test(encoded)) throw new Error('Alfabeto Base32 inválido.')
  let accumulator = 0
  let bitCount = 0
  const output: number[] = []
  for (const character of encoded) {
    const digit = ALPHABET.indexOf(character)
    accumulator = (accumulator << 5) | digit
    bitCount += 5
    if (bitCount >= 8) {
      bitCount -= 8
      output.push((accumulator >>> bitCount) & 0xff)
    }
  }
  if (bitCount > 0 && (accumulator & ((1 << bitCount) - 1)) !== 0) {
    throw new Error('Padding Base32 não canônico.')
  }
  if (encoded.length % 8 === 1 || encoded.length % 8 === 3 || encoded.length % 8 === 6) {
    throw new Error('Comprimento Base32 inválido.')
  }
  return Uint8Array.from(output)
}

export async function checksumBase32(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(CHECKSUM_DOMAIN.length + bytes.length)
  input.set(CHECKSUM_DOMAIN)
  input.set(bytes, CHECKSUM_DOMAIN.length)
  const digest = new Uint8Array(await requireSubtleCrypto().digest('SHA-256', toArrayBuffer(input)))
  // The first 20 digest bits form exactly four Base32 symbols.
  return encodeBase32(digest.subarray(0, 3)).slice(0, 4)
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
