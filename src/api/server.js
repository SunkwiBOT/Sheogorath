'use strict';
/**
 * The bot's web server. All that is on it is the sign-ins that need a page
 * a browser can come back to:
 *
 *   /wardogs  the WARDOGS Steam sign-in, while some guild has `wardogs` on
 *             (none has since that feature was switched off on 2026-09-30)
 *   /wow      the Battle.net sign-in for /wow, while some guild has `wow` on
 *
 * It starts only while one of them is wanted.
 *
 * It used to serve the companion music page and its control API too. Those
 * were shut down on 2026-11-03, when the music player channel (music/panel.js)
 * took their place.
 */
const http = require('http');
const express = require('express');
const wardogs = require('../services/wardogs');
const battlenet = require('../services/battlenet');
const { guildIds, hasFeature } = require('../config/guilds');

const PORT = Number(process.env.CONTROL_API_PORT) || 3005;
// Bind to the Tailscale interface by default, never 0.0.0.0 — the LAN should
// not be able to reach this at all.
const HOST = process.env.CONTROL_API_HOST || '127.0.0.1';

/**
 * Start the web server when something needs it. Returns null (without
 * throwing) otherwise, so it can never take the Discord bot down with it.
 */
function startWebServer() {
  const wanted = (feature) => guildIds().some((id) => hasFeature(id, feature));
  const wardogsOn = wanted('wardogs');
  const wowOn = wanted('wow');
  if (!wardogsOn && !wowOn) return null;

  const app = express();
  app.disable('x-powered-by');

  // The sign-ins are unauthenticated on purpose: Steam and Battle.net send the
  // member's browser here, and a one-time nonce from the command is the only
  // thing that gets a request past /login and /callback.
  if (wardogsOn) app.use('/wardogs', wardogs.routes());
  if (wowOn) app.use('/wow', battlenet.routes());

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  const server = http.createServer(app);
  server.on('error', (err) => {
    console.error('[Web] Server error:', err?.message || err);
  });
  server.listen(PORT, HOST, () => {
    console.log(`[Web] Listening on http://${HOST}:${PORT}`);
  });
  return server;
}

module.exports = { startWebServer };
