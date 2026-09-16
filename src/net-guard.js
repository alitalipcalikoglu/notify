import { lookup as dnsLookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';

export class NetGuardError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ retryable?: boolean }} [opts]
   */
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'NetGuardError';
    this.code = code;
    /** False means the target itself is disallowed and must never be retried. */
    this.retryable = retryable;
  }
}

/**
 * @typedef {object} VettedTarget
 * @property {URL} url
 * @property {string} address  Pinned IP to connect to.
 * @property {4|6} family
 */

/**
 * Outbound request guard against SSRF: only absolute http(s) URLs whose host resolves
 * exclusively to public unicast addresses may be contacted. The vetted address is pinned
 * for the actual connection so DNS rebinding between check and connect is not possible.
 */
export class NetGuard {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.allowHttp]        Permit plain http:// targets. Default false.
   * @param {string[]} [opts.allowedHosts]    Lower-case host allowlist (exact or parent domain). Empty = any.
   * @param {typeof dnsLookup} [opts.lookup]  Injectable resolver for tests.
   * @param {(ip: string) => boolean} [opts.isPublic]  Injectable address predicate for tests.
   */
  constructor({ allowHttp = false, allowedHosts = [], lookup = dnsLookup, isPublic = NetGuard.isPublicAddress } = {}) {
    this.allowHttp = allowHttp;
    this.allowedHosts = allowedHosts;
    this.lookup = lookup;
    this.isPublic = isPublic;
  }

  /**
   * Validate a URL and resolve it to a single public IP.
   * @param {string} rawUrl
   * @returns {Promise<VettedTarget>}
   */
  async resolve(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new NetGuardError('INVALID_URL', 'url is not a valid absolute URL');
    }
    if (url.protocol !== 'https:' && !(this.allowHttp && url.protocol === 'http:')) {
      throw new NetGuardError('SCHEME_NOT_ALLOWED', `scheme "${url.protocol}" is not allowed`);
    }
    if (url.username || url.password) throw new NetGuardError('CREDENTIALS_IN_URL', 'url must not contain credentials');

    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    if (!host) throw new NetGuardError('INVALID_URL', 'url has no host');
    if (this.allowedHosts.length && !this.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
      throw new NetGuardError('HOST_NOT_ALLOWED', `host "${host}" is not in WEBHOOK_ALLOWED_HOSTS`);
    }

    /** @type {{ address: string, family: number }[]} */
    let addresses;
    if (isIPv4(host) || isIPv6(host)) {
      addresses = [{ address: host, family: isIPv4(host) ? 4 : 6 }];
    } else {
      try {
        addresses = await this.lookup(host, { all: true });
      } catch {
        throw new NetGuardError('DNS_FAILED', `could not resolve "${host}"`, { retryable: true });
      }
    }
    if (!addresses.length) throw new NetGuardError('DNS_FAILED', `"${host}" has no addresses`);
    const bad = addresses.find((a) => !this.isPublic(a.address));
    if (bad) throw new NetGuardError('PRIVATE_ADDRESS', `host "${host}" resolves to non-public address ${bad.address}`);

    const pick = addresses[0];
    return { url, address: pick.address, family: /** @type {4|6} */ (pick.family) };
  }

  /**
   * True only for globally routable unicast addresses.
   * @param {string} ip
   * @returns {boolean}
   */
  static isPublicAddress(ip) {
    if (isIPv4(ip)) return !NetGuard.#isPrivateV4(ip.split('.').map(Number));
    if (isIPv6(ip)) {
      const g = NetGuard.parseIPv6(ip);
      return g !== null && !NetGuard.#isPrivateV6(g);
    }
    return false;
  }

  /**
   * Expand an IPv6 textual address to eight 16-bit groups.
   * @param {string} ip
   * @returns {number[]|null}
   */
  static parseIPv6(ip) {
    let s = ip;
    const zone = s.indexOf('%');
    if (zone !== -1) s = s.slice(0, zone);
    /** @type {number[]} */
    let tail = [];
    const lastColon = s.lastIndexOf(':');
    if (s.includes('.', lastColon)) {
      const v4 = s.slice(lastColon + 1);
      if (!isIPv4(v4)) return null;
      const o = v4.split('.').map(Number);
      tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
      s = s.slice(0, lastColon + 1) + '0:0';
    }
    const parts = s.split('::');
    if (parts.length > 2) return null;
    const head = parts[0] ? parts[0].split(':') : [];
    const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
    const missing = 8 - head.length - rest.length;
    if (missing < 0 || (parts.length === 1 && missing !== 0)) return null;
    const groups = [...head, ...Array(missing).fill('0'), ...rest].map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
    if (groups.some(Number.isNaN)) return null;
    if (tail.length) {
      groups[6] = tail[0];
      groups[7] = tail[1];
    }
    return groups;
  }

  /**
   * IPv4 ranges that must never be contacted (RFC 6890 special-purpose + multicast + reserved).
   * @param {number[]} o Four octets.
   */
  static #isPrivateV4(o) {
    const [a, b, c] = o;
    return a === 0                                   // 0.0.0.0/8 "this network"
      || a === 10                                    // 10/8
      || a === 127                                   // loopback
      || (a === 100 && b >= 64 && b <= 127)          // 100.64/10 shared address space
      || (a === 169 && b === 254)                    // link-local
      || (a === 172 && b >= 16 && b <= 31)           // 172.16/12
      || (a === 192 && b === 0 && c === 0)           // 192.0.0/24 IETF protocol assignments
      || (a === 192 && b === 0 && c === 2)           // TEST-NET-1
      || (a === 192 && b === 88 && c === 99)         // 6to4 relay anycast
      || (a === 192 && b === 168)                    // 192.168/16
      || (a === 198 && (b === 18 || b === 19))       // 198.18/15 benchmarking
      || (a === 198 && b === 51 && c === 100)        // TEST-NET-2
      || (a === 203 && b === 0 && c === 113)         // TEST-NET-3
      || a >= 224;                                   // multicast + reserved + broadcast
  }

  /** @param {number[]} g Eight 16-bit groups. */
  static #isPrivateV6(g) {
    const zeroPrefix = (/** @type {number} */ n) => g.slice(0, n).every((x) => x === 0);
    const embeddedV4 = (/** @type {number} */ hi, /** @type {number} */ lo) => NetGuard.#isPrivateV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
    if (zeroPrefix(7) && (g[7] === 0 || g[7] === 1)) return true;                 // :: and ::1
    if (zeroPrefix(5) && g[5] === 0xffff) return embeddedV4(g[6], g[7]);           // ::ffff:a.b.c.d mapped
    if (zeroPrefix(6)) return true;                                                // ::a.b.c.d compatible (deprecated)
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embeddedV4(g[6], g[7]); // 64:ff9b::/96 NAT64
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;               // 64:ff9b:1::/48 local NAT64
    if ((g[0] & 0xfe00) === 0xfc00) return true;                                   // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true;                                   // fe80::/10 link-local
    if ((g[0] & 0xff00) === 0xff00) return true;                                   // ff00::/8 multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                           // 2001:db8::/32 documentation
    if (g[0] === 0x2001 && g[1] === 0) return true;                                // 2001::/32 Teredo (embeds v4)
    if (g[0] === 0x2002) return embeddedV4(g[1], g[2]);                            // 2002::/16 6to4 (embeds v4)
    return false;
  }
}
