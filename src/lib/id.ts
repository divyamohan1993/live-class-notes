/**
 * Stable unique-id generation for segments, images, and other records.
 * Uses the platform crypto UUID; all supported browsers expose it in a secure context.
 */
export function newId(): string {
  return crypto.randomUUID()
}
