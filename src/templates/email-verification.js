import { EmailTemplate } from './template.js';

/**
 * @typedef {object} Data
 * @property {'tr'|'en'} locale
 * @property {string} appName
 * @property {string} verifyUrl
 * @property {number} expiresInMinutes
 * @property {string} [name]
 */

/**
 * Account activation link sent after sign-up.
 * @extends {EmailTemplate<Data>}
 */
export class EmailVerificationTemplate extends EmailTemplate {
  /** @type {Record<Data['locale'], { subject: (d: Data) => string, title: string, greeting: (d: Data) => string, body: (d: Data) => string, expiry: (d: Data) => string, button: string, footnote: string }>} */
  static STRINGS = {
    tr: {
      subject: (d) => `${d.appName} e-posta adresinizi doğrulayın`,
      title: 'E-posta adresinizi doğrulayın',
      greeting: (d) => (d.name ? `Merhaba ${d.name},` : 'Merhaba,'),
      body: (d) => `${d.appName} hesabınızı etkinleştirmek için aşağıdaki butona tıklayın.`,
      expiry: (d) => `Bu bağlantı ${d.expiresInMinutes} dakika içinde geçerliliğini yitirir.`,
      button: 'E-postamı doğrula',
      footnote: 'Bu hesabı siz oluşturmadıysanız bu e-postayı yok sayabilirsiniz.',
    },
    en: {
      subject: (d) => `Verify your email for ${d.appName}`,
      title: 'Verify your email address',
      greeting: (d) => (d.name ? `Hi ${d.name},` : 'Hi,'),
      body: (d) => `Click the button below to activate your ${d.appName} account.`,
      expiry: (d) => `This link expires in ${d.expiresInMinutes} minutes.`,
      button: 'Verify my email',
      footnote: 'If you did not create this account, you can safely ignore this email.',
    },
  };

  get name() {
    return 'email-verification';
  }

  get description() {
    return 'Account activation link sent after sign-up.';
  }

  get schema() {
    const c = EmailTemplate.common;
    return {
      type: 'object',
      additionalProperties: false,
      required: ['appName', 'verifyUrl', 'expiresInMinutes'],
      properties: {
        locale: c.locale,
        appName: c.appName,
        name: c.shortText,
        verifyUrl: c.httpsUrl,
        expiresInMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
      },
    };
  }

  /** @param {Data} d */
  subject(d) {
    return EmailVerificationTemplate.STRINGS[d.locale].subject(d);
  }

  /** @param {Data} d */
  layout(d) {
    const s = EmailVerificationTemplate.STRINGS[d.locale];
    return {
      locale: d.locale,
      appName: d.appName,
      title: s.title,
      paragraphs: [s.greeting(d), s.body(d), s.expiry(d)],
      button: { label: s.button, url: d.verifyUrl },
      footnote: s.footnote,
    };
  }
}
