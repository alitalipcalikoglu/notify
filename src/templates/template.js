import { Html } from '../html.js';

/** @typedef {'tr'|'en'} Locale */
/** @typedef {import('../types.js').RenderedEmail} RenderedEmail */

/**
 * @typedef {object} LayoutInput
 * @property {Locale} locale
 * @property {string} appName
 * @property {string} title
 * @property {string[]} paragraphs   Plain text; escaped on output.
 * @property {{ label: string, url: string }} [button]
 * @property {string} [footnote]     Plain text shown under the body.
 */

/** Shared HTML/text shell. Every dynamic value is escaped; button URLs must be http(s). */
export class Layout {
  /** @type {Record<Locale, { fallback: string, footer: string }>} */
  static CHROME = {
    tr: { fallback: 'Buton çalışmıyorsa bu bağlantıyı tarayıcınıza yapıştırın:', footer: 'Bu e-posta otomatik gönderildi, lütfen yanıtlamayın.' },
    en: { fallback: 'If the button does not work, paste this link into your browser:', footer: 'This is an automated message, please do not reply.' },
  };

  /**
   * @param {LayoutInput} input
   * @returns {string}
   */
  static html(input) {
    const e = Html.escape;
    const t = Layout.CHROME[input.locale];
    const url = input.button ? Html.safeHttpUrl(input.button.url) : null;
    const button = input.button && url
      ? `<p style="margin:28px 0"><a href="${e(url)}" style="display:inline-block;padding:12px 22px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">${e(input.button.label)}</a></p>
      <p style="font-size:13px;color:#6b7280">${e(t.fallback)}<br><a href="${e(url)}" style="color:#2563eb;word-break:break-all">${e(url)}</a></p>`
      : '';
    const paragraphs = input.paragraphs.map((p) => `<p style="margin:0 0 16px">${e(p)}</p>`).join('\n');
    const footnote = input.footnote ? `<p style="font-size:13px;color:#6b7280;margin-top:24px">${e(input.footnote)}</p>` : '';
    return `<!doctype html>
<html lang="${input.locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${e(input.title)}</title></head>
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;font-size:16px;line-height:1.5">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
    <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:8px;padding:32px">
      <tr><td>
        <p style="margin:0 0 24px;font-weight:700;color:#374151">${e(input.appName)}</p>
        <h1 style="margin:0 0 20px;font-size:22px">${e(input.title)}</h1>
        ${paragraphs}
        ${button}
        ${footnote}
      </td></tr>
    </table>
    <p style="font-size:12px;color:#9ca3af;margin-top:16px">${e(t.footer)}</p>
  </td></tr></table>
</body>
</html>`;
  }

  /**
   * @param {LayoutInput} input
   * @returns {string}
   */
  static text(input) {
    const lines = [input.appName, '', input.title, '', ...input.paragraphs.flatMap((p) => [p, ''])];
    const url = input.button ? Html.safeHttpUrl(input.button.url) : null;
    if (input.button && url) lines.push(`${input.button.label}: ${url}`, '');
    if (input.footnote) lines.push(input.footnote, '');
    lines.push(Layout.CHROME[input.locale].footer);
    return lines.join('\n');
  }
}

/**
 * Base class for email templates. Subclasses declare `name`, `description`, `schema`
 * (JSON Schema for `data`) and implement {@link subject} and {@link layout}.
 * @abstract
 * @template {{ locale: Locale }} D
 */
export class EmailTemplate {
  /** Schema fragments reused by templates. */
  static common = {
    locale: { type: 'string', enum: ['tr', 'en'], default: 'tr' },
    appName: { type: 'string', minLength: 1, maxLength: 80 },
    httpsUrl: { type: 'string', format: 'uri', pattern: '^https?://', maxLength: 2048 },
    shortText: { type: 'string', minLength: 1, maxLength: 200 },
  };

  /** @type {string} */
  get name() {
    throw new Error('EmailTemplate.name must be overridden');
  }

  /** @type {string} */
  get description() {
    throw new Error('EmailTemplate.description must be overridden');
  }

  /** JSON Schema for `data`. @type {object} */
  get schema() {
    throw new Error('EmailTemplate.schema must be overridden');
  }

  /**
   * @abstract
   * @param {D} data
   * @returns {string}
   */
  subject(data) {
    void data;
    throw new Error('EmailTemplate.subject must be overridden');
  }

  /**
   * @abstract
   * @param {D} data
   * @returns {LayoutInput}
   */
  layout(data) {
    void data;
    throw new Error('EmailTemplate.layout must be overridden');
  }

  /**
   * Render subject, HTML and plain text. Assumes `data` already passed {@link schema}.
   * @param {Record<string, unknown>} data
   * @returns {RenderedEmail}
   */
  render(data) {
    const d = /** @type {D} */ ({ locale: 'tr', ...data });
    const input = this.layout(d);
    return { subject: Html.singleLine(this.subject(d)), html: Layout.html(input), text: Layout.text(input) };
  }
}
