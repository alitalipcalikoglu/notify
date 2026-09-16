/** Stateless HTML and header safety helpers. */
export class Html {
  /**
   * Escape a value for safe interpolation into HTML text or attribute content.
   * @param {unknown} value
   * @returns {string}
   */
  static escape(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  /**
   * Return the URL if it is an absolute http(s) URL, otherwise null.
   * Blocks `javascript:`, `data:` and relative links from reaching an href.
   * @param {unknown} value
   * @returns {string|null}
   */
  static safeHttpUrl(value) {
    if (typeof value !== 'string') return null;
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  }

  /**
   * Collapse CR/LF so a value cannot inject additional mail headers.
   * @param {string} value
   * @returns {string}
   */
  static singleLine(value) {
    return value.replace(/[\r\n]+/g, ' ').trim();
  }
}
