import { Channel } from './channel.js';

/**
 * Stand-in for a channel the operator has turned off (Stage 7: `NOTIFY_WEBHOOK_CHANNEL=false`).
 * `Queue#claim` has no channel filter, so a message already `queued` under the real channel's
 * name still gets claimed by the worker after the switch flips — it lands here instead of a live
 * delivery attempt. `deliver()` throws a non-retryable error, so `Worker#deliver`'s normal
 * failure path settles it straight to `'failed'` (one attempt cost, no backoff, no retry): a
 * clear, deterministic terminal outcome, never a silent drop and never an infinite retry loop.
 * `verify()`/`close()` stay the inherited no-ops, so this never fails `/ready`.
 * @extends {Channel<any>}
 */
export class DisabledChannel extends Channel {
  /**
   * @param {string} name The real channel name this stands in for (e.g. `'webhook'`).
   * @param {string} reason Shown in the terminal failure's `last_error`, e.g. the env var that disabled it.
   */
  constructor(name, reason) {
    super();
    this.#name = name;
    this.reason = reason;
  }

  /** @type {string} */
  #name;

  get name() {
    return /** @type {any} */ (this.#name);
  }

  /** @returns {Promise<string>} Never resolves — always throws. */
  async deliver() {
    throw Object.assign(new Error(`"${this.#name}" channel is disabled (${this.reason})`), { retryable: false });
  }
}
