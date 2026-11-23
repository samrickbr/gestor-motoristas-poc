/** RFC 8785 JSON Canonicalization Scheme for JSON-compatible data. */
export function canonicalizeJson(value: unknown): string {
  return serialize(value, '$')
}

/** Counts canonical UTF-8 bytes without constructing the serialized JSON or a byte buffer. */
export function measureCanonicalJsonUtf8(value: unknown, maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Limite de bytes inválido.')
  let byteCount = 0
  const add = (count: number, path: string) => {
    byteCount += count
    if (byteCount > maxBytes) throw new Error(`JSON canônico excede o limite de tamanho em ${path}.`)
  }
  const addString = (text: string, path: string) => {
    assertUnicode(text, path)
    add(1, path) // opening quote
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index)
      if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
        add(2, path)
      } else if (code < 0x20) {
        add(6, path) // \\u00xx
      } else if (code <= 0x7f) {
        add(1, path)
      } else if (code <= 0x7ff) {
        add(2, path)
      } else if (code >= 0xd800 && code <= 0xdbff) {
        add(4, path)
        index++
      } else {
        add(3, path)
      }
    }
    add(1, path) // closing quote
  }
  const visit = (current: unknown, path: string): void => {
    if (current === null) { add(4, path); return }
    if (typeof current === 'boolean') { add(current ? 4 : 5, path); return }
    if (typeof current === 'string') { addString(current, path); return }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error(`Número não finito em ${path}.`)
      if (Number.isInteger(current) && !Number.isSafeInteger(current)) throw new Error(`Inteiro fora do limite seguro em ${path}.`)
      add(JSON.stringify(current).length, path)
      return
    }
    if (Array.isArray(current)) {
      assertNoExtraArrayProperties(current, path)
      add(1, path)
      for (let index = 0; index < current.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
        if (!descriptor) throw new Error(`Valor ausente em array em ${path}[${index}].`)
        if (!('value' in descriptor)) throw new Error(`Propriedade acessora não suportada em ${path}[${index}].`)
        if (descriptor.value === undefined) throw new Error(`Valor ausente em array em ${path}[${index}].`)
        if (index > 0) add(1, path)
        visit(descriptor.value, `${path}[${index}]`)
      }
      add(1, path)
      return
    }
    if (typeof current === 'object') {
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) throw new Error(`Objeto não JSON em ${path}.`)
      if (Object.getOwnPropertySymbols(current).length > 0) throw new Error(`Chave Symbol não suportada em ${path}.`)
      const descriptors = Object.getOwnPropertyDescriptors(current)
      const keys = Object.keys(descriptors).filter((key) => descriptors[key].enumerable).sort(compareUtf16)
      add(1, path)
      let included = 0
      for (const key of keys) {
        assertUnicode(key, `${path} key`)
        const descriptor = descriptors[key]
        if (!('value' in descriptor)) throw new Error(`Propriedade acessora não suportada em ${path}.${key}.`)
        if (descriptor.value === undefined) continue
        if (included++ > 0) add(1, path)
        addString(key, `${path} key`)
        add(1, path)
        visit(descriptor.value, `${path}.${key}`)
      }
      add(1, path)
      return
    }
    throw new Error(`Valor não JSON em ${path}.`)
  }
  visit(value, '$')
  return byteCount
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') {
    assertUnicode(value, path)
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Número não finito em ${path}.`)
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`Inteiro fora do limite seguro em ${path}.`)
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    assertNoExtraArrayProperties(value, path)
    const items: string[] = []
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor) {
        throw new Error(`Valor ausente em array em ${path}[${index}].`)
      }
      if (!('value' in descriptor)) throw new Error(`Propriedade acessora não suportada em ${path}[${index}].`)
      if (descriptor.value === undefined) throw new Error(`Valor ausente em array em ${path}[${index}].`)
      items.push(serialize(descriptor.value, `${path}[${index}]`))
    }
    return `[${items.join(',')}]`
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Objeto não JSON em ${path}.`)
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(`Chave Symbol não suportada em ${path}.`)
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Object.keys(descriptors).filter((key) => descriptors[key].enumerable)
    keys.sort(compareUtf16)
    const properties: string[] = []
    for (const key of keys) {
      assertUnicode(key, `${path} key`)
      const descriptor = descriptors[key]
      if (!('value' in descriptor)) throw new Error(`Propriedade acessora não suportada em ${path}.${key}.`)
      // JSON serialization omits undefined object members; this also preserves optional fields.
      if (descriptor.value === undefined) continue
      properties.push(`${JSON.stringify(key)}:${serialize(descriptor.value, `${path}.${key}`)}`)
    }
    return `{${properties.join(',')}}`
  }
  throw new Error(`Valor não JSON em ${path}.`)
}

function assertNoExtraArrayProperties(value: unknown[], path: string): void {
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`Chave Symbol não suportada em ${path}.`)
  for (const key of Object.keys(value)) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
      throw new Error(`Propriedade extra não suportada em array em ${path}.${key}.`)
    }
  }
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`Unicode inválido em ${path}.`)
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`Unicode inválido em ${path}.`)
    }
  }
}
