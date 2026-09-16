import { EmailTemplate } from './template.js';

/**
 * @typedef {object} Data
 * @property {'tr'|'en'} locale
 * @property {string} appName
 * @property {string} subject
 * @property {string} title
 * @property {string[]} paragraphs
 * @property {{ label: string, url: string }} [button]
 * @property {string} [footnote]
 */

/**
 * Free-form transactional message: title, paragraphs, optional call-to-action button.
 * @extends {EmailTemplate<Data>}
 */
export class GenericTemplate extends EmailTemplate {
  get name() {
    return 'generic';
  }

  get description() {
    return 'Generic transactional email: title, paragraphs and an optional call-to-action button.';
  }

  get schema() {
    const c = EmailTemplate.common;
    return {
      type: 'object',
      additionalProperties: false,
      required: ['appName', 'subject', 'title', 'paragraphs'],
      properties: {
        locale: c.locale,
        appName: c.appName,
        subject: c.shortText,
        title: c.shortText,
        paragraphs: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 2000 } },
        button: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'url'],
          properties: { label: { type: 'string', minLength: 1, maxLength: 60 }, url: c.httpsUrl },
        },
        footnote: { type: 'string', maxLength: 500 },
      },
    };
  }

  /** @param {Data} d */
  subject(d) {
    return d.subject;
  }

  /** @param {Data} d */
  layout(d) {
    return d;
  }
}
