'use strict';
/**
 * The bot's web server. All that is left on it is the WARDOGS Steam sign-in
 * (/wardogs), so it starts only while some guild has the `wardogs` feature on,
 * which none does since that feature was switched off on 2026-09-30.
 *
 * It used to serve the companion music page and its control API too. Those
 * were shut down on 2026-11-03, when the music player channel (music/panel.js)
 * took their place.
 */
const http = require('http');
const express = require('express');
const wardogs = require('../services/wardogs');
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
  if (!guildIds().some((id) => hasFeature(id, 'wardogs'))) return null;

  const app = express();
  app.disable('x-powered-by');

  // Steam sign-in for /wardogs link. Unauthenticated on purpose: Steam sends
  // the player's browser here, and a one-time nonce from the command is the
  // only thing that gets a request past /login.
  app.use('/wardogs', wardogs.routes());

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
