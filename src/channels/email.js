import nodemailer from 'nodemailer';
import { Channel } from './channel.js';

/** @typedef {import('../types.js').EmailPayload} EmailPayload */
/** @typedef {import('../types.js').MailTransport} MailTransport */
/** @typedef {import('../templates/registry.js').TemplateRegistry} TemplateRegistry */

/**
 * Email delivery: renders a registered template and hands the message to an SMTP transport.
 * @extends {Channel<EmailPayload>}
 */
export class EmailChannel extends Channel {
  /**
   * Worst-case duration of one real-SMTP send attempt: `connectionTimeout` + `greetingTimeout` +
   * `socketTimeout` from {@link createTransport}, all hardcoded there. Stage 6.1: used by
   * `Application` to size the shutdown force-exit timer and the worker's own drain bound — these
   * must be based on the worst-case call duration, not on `LOCK_TTL_MS` (the lease TTL), since the
   * heartbeat decouples how long a call may legitimately run from how long its lease lasts without
   * one.
   */
  static SMTP_WORST_CASE_MS = 10_000 + 10_000 + 30_000;
  /**
   * @param {object} opts
   * @param {TemplateRegistry} opts.templates
   * @param {string} opts.from             Default From header.
   * @param {string} [opts.smtpUrl]        nodemailer URL (`smtps://user:pass@host:465`) or `json:` for the dev transport.
   * @param {MailTransport} [opts.transport]  Injected transport (tests). Takes precedence over `smtpUrl`.
   */
  constructor({ templates, from, smtpUrl, transport }) {
    super();
    this.templates = templates;
    this.from = from;
    this.transport = transport ?? EmailChannel.createTransport(smtpUrl ?? 'json:');
  }

  get name() {
    return /** @type {const} */ ('email');
  }

  /**
   * @param {string} smtpUrl
   * @returns {MailTransport}
   */
  static createTransport(smtpUrl) {
    const transport = smtpUrl === 'json:'
      ? nodemailer.createTransport({ jsonTransport: true })
      : nodemailer.createTransport({
        url: smtpUrl,
        pool: true,
        maxConnections: 5,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      });
    // nodemailer's Transporter type carries callback overloads; the promise surface matches MailTransport.
    return /** @type {MailTransport} */ (/** @type {unknown} */ (transport));
  }

  /**
   * @param {string} messageId
   * @param {EmailPayload} payload
   */
  async deliver(messageId, payload) {
    const rendered = this.templates.render(payload.template, payload.data);
    const info = await this.transport.sendMail({
      from: this.from,
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      replyTo: payload.replyTo,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      headers: { 'X-Notify-Id': messageId },
    });
    return info.messageId;
  }

  /**
   * Permanent SMTP replies (5xx: bad mailbox, policy rejection) fail immediately;
   * 4xx and network errors retry. 552 "exceeded storage" often clears, so it retries too.
   * @param {unknown} err
   */
  isRetryable(err) {
    const code = /** @type {{ responseCode?: number }} */ (err)?.responseCode;
    if (typeof code !== 'number') return true;
    return code < 500 || code === 552;
  }

  async verify() {
    await this.transport.verify();
  }

  close() {
    this.transport.close();
  }
}
