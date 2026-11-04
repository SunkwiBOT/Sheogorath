'use strict';
/**
 * The one-screen page a sign-in callback (WARDOGS' Steam, Battle.net) answers
 * the browser with: a title and a line, in Discord's colours.
 */

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{font-family:system-ui,sans-serif;background:#1e1f22;color:#dbdee1;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
main{max-width:420px;text-align:center}h1{font-size:1.4rem}p{line-height:1.5;color:#b5bac1}
</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}

module.exports = { escapeHtml, page };
