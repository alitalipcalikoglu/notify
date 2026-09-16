import { EmailVerificationTemplate } from './email-verification.js';
import { GenericTemplate } from './generic.js';
import { PasswordResetTemplate } from './password-reset.js';

/** @typedef {import('./template.js').EmailTemplate<any>} AnyTemplate */
/** @typedef {import('../types.js').RenderedEmail} RenderedEmail */

/**
 * Registry of email templates. Templates are code shipped with the service; callers only
 * supply data that is validated against each template's schema before it is queued.
 */
export class TemplateRegistry {
  /** @param {AnyTemplate[]} templates */
  constructor(templates) {
    /** @type {Map<string, AnyTemplate>} */
    this.templates = new Map();
    for (const t of templates) {
      if (this.templates.has(t.name)) throw new Error(`duplicate template "${t.name}"`);
      this.templates.set(t.name, t);
    }
  }

  /** The templates bundled with this service. */
  static withDefaults() {
    return new TemplateRegistry([new EmailVerificationTemplate(), new PasswordResetTemplate(), new GenericTemplate()]);
  }

  /** @returns {string[]} */
  names() {
    return [...this.templates.keys()];
  }

  /**
   * @param {string} name
   * @returns {AnyTemplate|undefined}
   */
  get(name) {
    return this.templates.get(name);
  }

  /** Public listing for `GET /v1/templates`. */
  describe() {
    return [...this.templates.values()].map((t) => ({ name: t.name, description: t.description, schema: t.schema }));
  }

  /**
   * @param {string} name
   * @param {Record<string, unknown>} data
   * @returns {RenderedEmail}
   */
  render(name, data) {
    const t = this.templates.get(name);
    if (!t) throw new Error(`unknown template "${name}"`);
    return t.render(data);
  }
}
