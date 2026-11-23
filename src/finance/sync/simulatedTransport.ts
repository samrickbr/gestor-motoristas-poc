import type { OutboxEvent } from '../storage/ledgerRepository'
import type { BatchAcknowledgement, OutboxTransport } from './outboxSync'

export type SimulatedTransportMode = 'normal' | 'timeout-after-acceptance' | 'fail-before-acceptance' | 'invalid-ack'

export interface SimulatedTransportOptions {
  mode?: SimulatedTransportMode
  partialBatchSize?: number
  acknowledgedAt?: () => string
}

/** In-memory stand-in for a remote receiver; it never performs network I/O. */
export class SimulatedOutboxTransport implements OutboxTransport {
  private readonly acceptedEventIds = new Set<string>()
  private mode: SimulatedTransportMode
  private partialBatchSize: number | undefined
  private readonly acknowledgedAt: () => string
  readonly deliveryAttempts: string[][] = []

  constructor(options: SimulatedTransportOptions = {}) {
    this.mode = options.mode ?? 'normal'
    this.partialBatchSize = options.partialBatchSize
    this.acknowledgedAt = options.acknowledgedAt ?? (() => new Date().toISOString())
  }

  setMode(mode: SimulatedTransportMode): void {
    this.mode = mode
  }

  setPartialBatchSize(size: number | undefined): void {
    this.partialBatchSize = size
  }

  async deliver(events: readonly OutboxEvent[]): Promise<BatchAcknowledgement> {
    const ids = events.map((event) => event.eventId)
    this.deliveryAttempts.push(ids)

    if (this.mode === 'fail-before-acceptance') {
      this.mode = 'normal'
      throw new Error('Falha simulada antes do aceite.')
    }
    for (const id of ids) this.acceptedEventIds.add(id)

    if (this.mode === 'timeout-after-acceptance') {
      this.mode = 'normal'
      throw new Error('Timeout simulado após o aceite; retry seguro pelo mesmo eventId.')
    }

    const eventIds = this.mode === 'invalid-ack'
      ? [...ids, 'unknown-event-id']
      : ids.filter((id) => this.acceptedEventIds.has(id))
    if (this.mode === 'invalid-ack') this.mode = 'normal'
    const partialIds = this.partialBatchSize === undefined
      ? eventIds
      : eventIds.slice(0, this.partialBatchSize)
    return { eventIds: partialIds, acknowledgedAt: this.acknowledgedAt() }
  }

  get acceptedIds(): readonly string[] {
    return [...this.acceptedEventIds]
  }
}
