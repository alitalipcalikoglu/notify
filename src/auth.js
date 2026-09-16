import { createHash, timingSafeEqual } from 'node:crypto';

/** @typedef {import('./types.js').ApiKey} ApiKey */

/**
 * Bearer API-key authentication for Fastify. Every configured key is compared in constant
 * time so timing does not reveal whether, or which, key matched.
 */
export class ApiKeyAuth {
  /** @param {ApiKey[]} apiKeys */
  constructor(apiKeys) {
    this.apiKeys = apiKeys;
  }

  /**
   * Fastify `onRequest` hook. Arrow property so it can be passed directly to `addHook`.
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   */
  hook = async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const secret = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const id = secret ? this.identify(secret) : undefined;
    if (!id) {
      reply.header('www-authenticate', 'Bearer');
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'missing or invalid API key' } });
    }
    request.apiKeyId = id;
  };

  /**
   * @param {string} secret Presented secret.
   * @returns {string|undefined} Matching key id.
   */
  identify(secret) {
    /** @type {string|undefined} */
    let matched;
    for (const key of this.apiKeys) {
      if (ApiKeyAuth.#secretsEqual(secret, key.secret)) matched = key.id;
    }
    return matched;
  }

  /**
   * Constant-time comparison independent of input length.
   * @param {string} a
   * @param {string} b
   */
  static #secretsEqual(a, b) {
    return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
  }
}
