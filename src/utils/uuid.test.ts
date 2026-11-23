import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUuidV4 } from './uuid'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createUuidV4', () => {
  it('usa crypto.randomUUID quando disponível', () => {
    const randomUUID = vi.fn(() => '123e4567-e89b-42d3-a456-426614174000')
    vi.stubGlobal('crypto', {
      randomUUID,
      getRandomValues: vi.fn(() => { throw new Error('não deveria usar o fallback') }),
    } as unknown as Crypto)

    expect(createUuidV4()).toBe('123e4567-e89b-42d3-a456-426614174000')
    expect(randomUUID).toHaveBeenCalledOnce()
  })

  it('gera UUID v4 com getRandomValues quando randomUUID não está disponível', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(0))
    vi.stubGlobal('crypto', { getRandomValues } as unknown as Crypto)

    const uuid = createUuidV4()
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(uuid).toBe('00000000-0000-4000-8000-000000000000')
    expect(getRandomValues).toHaveBeenCalledOnce()
  })
})
