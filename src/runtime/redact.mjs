export const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+([A-Za-z]{2,}))(?![A-Za-z0-9-])/g;
// file@2x.png and similar asset names look like addresses but are file names.
export const FILE_EXTENSION_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'js', 'mjs', 'cjs', 'ts', 'json', 'css', 'html', 'map']);
// US numbers: (212) 555-0100, 212-555-0100, 212.555.0100, 212 555 0100 with an optional +1 or 1
// prefix, +1 555 0100, and +12125550100.
export const PHONE_PATTERN = /(?<![\w.+-])(?:\+?1[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\w-])|(?<![\w.+-])\+1[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])|(?<![\w.+-])\+1\d{10}(?!\d)/g;
// /Users/<name>, /home/<name>, and C:\Users\<name> (also with escaped backslashes or forward slashes).
export const HOME_PATH_PATTERN = /(?<![A-Za-z0-9_.~-])(?:\/Users\/|\/home\/|[A-Za-z]:(?:\\+|\/)Users(?:\\+|\/))([A-Za-z0-9][A-Za-z0-9._-]*)/g;


// Runtime redaction preserves documentation domains, but never exempts synthetic personal values.
const EXAMPLE_DOMAINS = ['example.com', 'example.org', 'example.net', 'example.edu', 'school.edu', 'your-domain.edu', 'users.noreply.github.com'];
export function redact(text) {
  return String(text)
    .replace(EMAIL_PATTERN, (address, domain, topLevel) => {
      const host = domain.toLowerCase();
      return FILE_EXTENSION_TLDS.has(topLevel.toLowerCase())
        || ['test', 'example', 'invalid', 'localhost'].includes(topLevel.toLowerCase())
        || EXAMPLE_DOMAINS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
        ? address : '<email>';
    })
    .replace(PHONE_PATTERN, '<phone>')
    .replace(HOME_PATH_PATTERN, '<home>');
}
