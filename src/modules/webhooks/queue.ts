/**
 * Minimal queue port. The API process only ever *enqueues*; the worker owns
 * consumption. Keeping this an interface lets tests drive delivery
 * deterministically without a Redis server.
 */
export interface DeliveryQueue {
  /** Enqueues a delivery attempt. Implementations must deduplicate on `deliveryId`. */
  enqueue(deliveryId: string, delayMs?: number): Promise<void>;
  close?(): Promise<void>;
}

/** No-op used when the API runs without Redis; the poller still picks work up. */
export const noopDeliveryQueue: DeliveryQueue = {
  enqueue: () => Promise.resolve(),
};
