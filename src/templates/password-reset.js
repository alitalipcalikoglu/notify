import { EmailTemplate } from './template.js';

/**
 * @typedef {object} Data
 * @property {'tr'|'en'} locale
 * @property {string} appName
 * @property {string} resetUrl
 * @property {number} expiresInMinutes
 * @property {string} [name]
 * @property {string} [requestIp]
 */

/**
 * Password reset link with optional requester IP.
 * @extends {EmailTemplate<Data>}
 */
export class PasswordResetTemplate extends EmailTemplate {
  /** @type {Record<Data['locale'], { subject: (d: Data) => string, title: string, greeting: (d: Data) => string, body: (d: Data) => string, expiry: (d: Data) => string, ip: (d: Data) => string, button: string, footnote: string }>} */
  static STRINGS = {
    tr: {
      subject: (d) => `${d.appName} şifre sıfırlama isteği`,
      title: 'Şifrenizi sıfırlayın',
      greeting: (d) => (d.name ? `Merhaba ${d.name},` : 'Merhaba,'),
      body: (d) => `${d.appName} hesabınız için şifre sıfırlama isteği aldık. Yeni şifre belirlemek için butona tıklayın.`,
      expiry: (d) => `Bu bağlantı ${d.expiresInMinutes} dakika içinde geçerliliğini yitirir.`,
      ip: (d) => `İstek şu IP adresinden yapıldı: ${d.requestIp}`,
      button: 'Şifremi sıfırla',
      footnote: 'Bu isteği siz yapmadıysanız hiçbir işlem yapmanız gerekmez, şifreniz değişmez.',
    },
    en: {
      subject: (d) => `Reset your ${d.appName} password`,
      title: 'Reset your password',
      greeting: (d) => (d.name ? `Hi ${d.name},` : 'Hi,'),
      body: (d) => `We received a request to reset the password for your ${d.appName} account. Click the button to choose a new one.`,
      expiry: (d) => `This link expires in ${d.expiresInMinutes} minutes.`,
      ip: (d) => `The request came from IP address ${d.requestIp}.`,
      button: 'Reset my password',
      footnote: 'If you did not request this, no action is needed and your password stays the same.',
    },
  };

  get name() {
    return 'password-reset';
  }

  get description() {
    return 'Password reset link with optional requester IP.';
  }

  get schema() {
    const c = EmailTemplate.common;
    return {
      type: 'object',
      additionalProperties: false,
      required: ['appName', 'resetUrl', 'expiresInMinutes'],
      properties: {
        locale: c.locale,
        appName: c.appName,
        name: c.shortText,
        resetUrl: c.httpsUrl,
        expiresInMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
        requestIp: { type: 'string', maxLength: 45, pattern: '^[0-9a-fA-F.:]+$' },
      },
    };
  }

  /** @param {Data} d */
  subject(d) {
    return PasswordResetTemplate.STRINGS[d.locale].subject(d);
  }

  /** @param {Data} d */
  layout(d) {
    const s = PasswordResetTemplate.STRINGS[d.locale];
    const paragraphs = [s.greeting(d), s.body(d), s.expiry(d)];
    if (d.requestIp) paragraphs.push(s.ip(d));
    return {
      locale: d.locale,
      appName: d.appName,
      title: s.title,
      paragraphs,
      button: { label: s.button, url: d.resetUrl },
      footnote: s.footnote,
    };
  }
}
