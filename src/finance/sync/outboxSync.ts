import type { OutboxEvent } from '../storage/ledgerRepository'

export interface OutboxRepository {
  getPendingOutbox(limit?: number): Promise<OutboxEvent[]>
  acknowledgeEvents(eventIds: readonly string[], acknowledgedAt?: string): Promise<number>
}

export interface BatchAcknowledgement {
  eventIds: string[]
  acknowledgedAt: string
}

export interface OutboxTransport {
  deliver(events: readonly OutboxEvent[]): Promise<BatchAcknowledgement>
}

export interface DeliveryResult {
  attemptedEventIds: string[]
  acknowledgedEventIds: string[]
  cursor: number
}

export async function deliverPending(
  repository: OutboxRepository,
  transport: OutboxTransport,
  batchSize = 50,
): Promise<DeliveryResult> {
  const events = await repository.getPendingOutbox(batchSize)
  if (events.length === 0) {
    const cursor = await repository.acknowledgeEvents([])
    return { attemptedEventIds: [], acknowledgedEventIds: [], cursor }
  }

  const acknowledgement = await transport.deliver(events)
  validateAcknowledgement(acknowledgement, events)
  const cursor = await repository.acknowledgeEvents(
    acknowledgement.eventIds,
    acknowledgement.acknowledgedAt,
  )
  return {
    attemptedEventIds: events.map((event) => event.eventId),
    acknowledgedEventIds: [...acknowledgement.eventIds],
    cursor,
  }
}

function validateAcknowledgement(
  acknowledgement: BatchAcknowledgement,
  attempted: readonly OutboxEvent[],
): void {
  if (!acknowledgement || !Array.isArray(acknowledgement.eventIds) ||
      typeof acknowledgement.acknowledgedAt !== 'string' ||
      Number.isNaN(Date.parse(acknowledgement.acknowledgedAt))) {
    throw new Error('ACK inválido: formato ou data inválida.')
  }
  const attemptedIds = new Set(attempted.map((event) => event.eventId))
  if (new Set(acknowledgement.eventIds).size !== acknowledgement.eventIds.length ||
      acknowledgement.eventIds.some((id) => typeof id !== 'string' || !attemptedIds.has(id))) {
    throw new Error('ACK inválido: contém evento não enviado ou IDs repetidos.')
  }
}
