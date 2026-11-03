'use strict';

// Static publication boundary. Private runtime data must only pass through
// authenticated API routes, never through the repository-root file handler.
function publicFile(relative) {
  const parts = relative.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return true;
  if (parts.some(p => p.startsWith('.') || p === 'node_modules' ||
      /cookies?|api[-_]?key|\.local\.|\.sqlite(?:-|$)|\.(pem|p12|pfx|keystore|jks|ppk)$/i.test(p))) return false;
  const [top, ...rest] = parts;
  if (parts.length === 1 && /\.(html|svg|ico)$/.test(top)) return true;
  if (['pages', 'assets', 'twin-os', 'vendor', 'docs'].includes(top)) return true;
  if (top === 'data') return ['songs', 'flux', 'clip', 'gallery', 'mj', 'twin'].includes(rest[0]) ||
    rest.join('/') === 'jobs/catalog.json';
  if (top === 'lib') {
    return (rest.length === 1 && /\.js$/.test(rest[0])) ||
      (rest[0] === 'render' && /\.(mjs|js)$/.test(rest.at(-1)));
  }
  return false;
}

module.exports = { publicFile };
