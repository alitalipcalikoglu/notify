/** @typedef {import('../types.js').EmailPayload|import('../types.js').WebhookPayload} Payload */

/**
 * Base class for delivery channels. A channel turns a queued payload into an outbound
 * request and classifies failures as retryable or final.
 * @abstract
 * @template {Payload} P
 */
export class Channel {
  /** Channel name as stored in `messages.channel`. @type {P['channel']} */
  get name() {
    throw new Error('Channel.name must be overridden');
  }

  /**
   * Deliver one message. Resolves to a provider reference (message id, HTTP status) for the record.
   * @abstract
   * @param {string} messageId
   * @param {P} payload
   * @returns {Promise<string>}
   */
  async deliver(messageId, payload) {
    void messageId; void payload;
    throw new Error('Channel.deliver must be overridden');
  }

  /**
   * Whether a failure from {@link deliver} may succeed on a later attempt.
   * @param {unknown} err
   * @returns {boolean}
   */
  isRetryable(err) {
    return /** @type {{ retryable?: boolean }} */ (err)?.retryable !== false;
  }

  /** Readiness probe; throws when the channel's backend is unreachable. */
  async verify() {}

  /** Release pooled connections. */
  close() {}
}
