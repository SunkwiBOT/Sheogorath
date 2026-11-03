'use strict';
/**
 * WARDOGS stats, read straight from the game's own backend.
 *
 * There is no public stats API. The game runs on Pragma Engine, and Pragma will
 * log anyone in who can prove, through Steam's OpenID sign-in, that they own a
 * Steam account. So a player links like this:
 *
 *   1. /wardogs link hands them a one-time link to /wardogs/login on the
 *      bot's web server (public through Tailscale Funnel, WARDOGS_PUBLIC_URL).
 *   2. That redirects to Steam's own sign-in page. We never see a password.
 *   3. Steam sends the browser back to /wardogs/callback with a signed
 *      assertion of their Steam ID. We pass it to Pragma exactly as the
 *      game client would, get a game session, read their PlayerData once and
 *      keep the numbers.
 *
 * The game session is used for that one read and then dropped: it is a login
 * to their account, and nothing here needs to hold one. Stats therefore
 * refresh when the player links again (one click, since Steam remembers them).
 *
 * This is the same route wardogs.tools and community-network/wardogs-api use.
 * It is unofficial and Bulkhead can change it without notice, so every step
 * fails with a plain message rather than a stack trace.
 */
const crypto = require('crypto');
const path = require('path');
const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const { jsonFile } = require('../storage/jsonFile');

const GAME_HOST = 'https://game.live.wardogs.bulkhead.pragmaengine.com';
const SOCIAL_HOST = 'https://social.live.wardogs.bulkhead.pragmaengine.com';
const GAME_SHARD_ID = '00000000-0000-0000-0000-000000000001';
const STEAM_OPENID = 'https://steamcommunity.com/openid/login';

/** How long a link from /wardogs link stays good. Under Discord's 15-minute interaction token. */
const LINK_TTL_MS = 10 * 60 * 1000;
/** Snapshots kept per player, oldest dropped first. */
const HISTORY_KEEP = 50;

const ROLES = ['infantry', 'medic', 'recon', 'support', 'driver', 'pilot'];
const ROLE_LABELS = {
  infantry: 'Assault', medic: 'Medic', recon: 'Recon', support: 'Support', driver: 'Driver', pilot: 'Pilot',
};

const store = jsonFile(path.join(__dirname, '../../data/wardogs.json'), { empty: () => ({ players: {} }) });

/** Pending links by nonce: { userId, guildId, interaction, expires }. Memory only; a restart voids them. */
const pending = new Map();

function publicUrl() {
  return (process.env.WARDOGS_PUBLIC_URL || '').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

function sweepPending() {
  const now = Date.now();
  for (const [nonce, p] of pending) if (p.expires < now) pending.delete(nonce);
}

/**
 * A one-time sign-in link for this Discord user, or null when the public URL
 * is not configured. The interaction is kept so the result can be shown in
 * the same ephemeral reply once they come back from Steam.
 */
function createLink(interaction) {
  const base = publicUrl();
  if (!base) return null;
  sweepPending();
  // One live link per person: a second /wardogs link replaces the first.
  for (const [nonce, p] of pending) if (p.userId === interaction.user.id) pending.delete(nonce);
  const nonce = crypto.randomBytes(24).toString('base64url');
  pending.set(nonce, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    interaction,
    expires: Date.now() + LINK_TTL_MS,
  });
  return `${base}/wardogs/login?n=${nonce}`;
}

/** Where to send the browser for Steam's sign-in, or null if the nonce is unknown or stale. */
function steamRedirect(nonce) {
  sweepPending();
  if (!nonce || !pending.has(nonce)) return null;
  const base = publicUrl();
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': `${base}/wardogs/callback?n=${encodeURIComponent(nonce)}`,
    'openid.realm': base,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return `${STEAM_OPENID}?${params}`;
}

const OPENID_FIELDS = {
  claimedId: 'openid.claimed_id',
  ns: 'openid.ns',
  mode: 'openid.mode',
  opEndpoint: 'openid.op_endpoint',
  identity: 'openid.identity',
  returnTo: 'openid.return_to',
  responseNonce: 'openid.response_nonce',
  assocHandle: 'openid.assoc_handle',
  signed: 'openid.signed',
  sig: 'openid.sig',
};

/** The payload of a JWT, unverified. Only used on tokens that came straight from Pragma over TLS. */
function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** A failure whose message is fit to show the player. */
class LinkError extends Error {}

async function pragmaLogin(providerToken) {
  let queueToken;
  try {
    const { data } = await axios.post(`${GAME_HOST}/v1/loginqueue/getinqueuev1`, {}, { timeout: 20000 });
    queueToken = data?.loginQueuePassToken || data?.passToken || data?.token;
  } catch (err) {
    throw new LinkError(`The WARDOGS login server did not answer (${err.response?.status || err.code || err.message}). It may be down; try again later.`);
  }
  if (!queueToken) throw new LinkError('The WARDOGS login server gave no queue ticket.');
  if (String(jwtClaims(queueToken).isAllowedIn) === 'false') {
    throw new LinkError('The WARDOGS login queue is full right now. Try again in a few minutes.');
  }

  let tokens;
  try {
    const { data } = await axios.post(`${SOCIAL_HOST}/v1/account/authenticateorcreatev2`, {
      providerId: 'STEAM',
      providerToken: JSON.stringify(providerToken),
      gameShardId: GAME_SHARD_ID,
      loginQueuePassToken: queueToken,
    }, { timeout: 30000 });
    tokens = data?.pragmaTokens;
  } catch (err) {
    const status = err.response?.status;
    if (status && status < 500) {
      throw new LinkError('WARDOGS would not accept that Steam sign-in. Make sure it is the Steam account you play on, then run /wardogs link again.');
    }
    throw new LinkError(`The WARDOGS login server failed (${status || err.code || err.message}). Try again later.`);
  }
  if (!tokens?.pragmaGameToken) throw new LinkError('WARDOGS logged you in but gave no game session.');
  return tokens;
}

async function fetchPlayerData(gameToken) {
  try {
    const { data } = await axios.post(`${GAME_HOST}/v1/rpc`, {
      requestId: 1,
      type: 'PlayerDataServiceRpc.GetV1Request',
      payload: {},
    }, {
      headers: { Authorization: `Bearer ${gameToken}`, Accept: 'application/json' },
      timeout: 30000,
    });
    return data;
  } catch (err) {
    throw new LinkError(`WARDOGS would not hand over your player data (${err.response?.status || err.code || err.message}).`);
  }
}

/**
 * The numbers out of a PlayerData response. Each component is base64 JSON;
 * cash and gold are attributes, role XP carries an xpId, unlocks a nodeId.
 */
function decodeStats(data) {
  const playerData = data?.response?.payload?.playerData;
  if (!playerData || !Array.isArray(playerData.entities)) {
    throw new LinkError('WARDOGS sent player data in a shape this bot does not know. The game may have changed.');
  }
  const stats = { cash: 0, gold: 0, unlocks: 0, roles: {} };
  for (const role of ROLES) stats.roles[role] = { level: 0, xp: 0 };

  for (const entity of playerData.entities) {
    let components = entity?.components ?? [entity];
    if (!Array.isArray(components)) components = [components];
    for (const component of components) {
      const bytes = component?.serializedComponent?.bytes;
      if (!bytes) continue;
      let obj;
      try {
        obj = JSON.parse(Buffer.from(bytes, 'base64').toString('utf8'));
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object') continue;

      if (obj.nodeId) stats.unlocks += 1;
      if (obj.id === 'Attribute.Meta.Currency.Cash') stats.cash = Number(obj.amount) || 0;
      if (obj.id === 'Attribute.Meta.Currency.GoldBars') stats.gold = Number(obj.amount) || 0;

      const prefix = 'Attribute.Meta.XP.Role.';
      if (typeof obj.xpId === 'string' && obj.xpId.startsWith(prefix)) {
        const name = obj.xpId.slice(prefix.length).toLowerCase();
        if (stats.roles[name]) {
          stats.roles[name] = { level: Number(obj.rewardedLevel) || 0, xp: Number(obj.amount) || 0 };
        }
      }
    }
  }
  // The in-game Wardog level is the sum of the six role levels.
  stats.level = ROLES.reduce((sum, r) => sum + stats.roles[r].level, 0);
  stats.xp = ROLES.reduce((sum, r) => sum + stats.roles[r].xp, 0);
  return stats;
}

/**
 * Finish a link from Steam's redirect. Returns { entry, userId } on success;
 * throws LinkError with a message for the player otherwise. The pending link
 * is spent either way, so a replayed callback does nothing.
 */
async function completeLink(query) {
  const nonce = query.n;
  sweepPending();
  const link = nonce && pending.get(nonce);
  if (!link) throw new LinkError('This sign-in link has expired or was already used. Run /wardogs link again.');
  pending.delete(nonce);

  try {
    if (query['openid.mode'] !== 'id_res') {
      throw new LinkError('Steam sign-in was cancelled.');
    }
    const providerToken = {};
    for (const [key, param] of Object.entries(OPENID_FIELDS)) {
      if (typeof query[param] !== 'string') throw new LinkError('Steam sent back an incomplete sign-in. Run /wardogs link again.');
      providerToken[key] = query[param];
    }
    const steamId = providerToken.claimedId.replace(/\/+$/, '').split('/').pop();
    if (!/^\d{16,20}$/.test(steamId)) throw new LinkError('Steam sent back an account this bot cannot read.');

    // Pragma checks the assertion with Steam itself; a forged one is refused here.
    const tokens = await pragmaLogin(providerToken);
    const stats = decodeStats(await fetchPlayerData(tokens.pragmaGameToken));
    const claims = { ...jwtClaims(tokens.pragmaSocialToken), ...jwtClaims(tokens.pragmaGameToken) };

    const now = new Date().toISOString();
    const entry = store.update((db) => {
      db.players ||= {};
      const prev = db.players[link.userId];
      const history = prev?.steamId === steamId ? [...(prev.history || [])] : [];
      history.push({ at: now, level: stats.level, xp: stats.xp, cash: stats.cash, gold: stats.gold, unlocks: stats.unlocks });
      const next = {
        steamId,
        name: claims.displayName || prev?.name || null,
        discriminator: claims.discriminator || prev?.discriminator || null,
        linkedAt: prev?.steamId === steamId ? prev.linkedAt : now,
        updatedAt: now,
        stats,
        history: history.slice(-HISTORY_KEEP),
      };
      db.players[link.userId] = next;
      return next;
    });

    console.log(`[WARDOGS] Linked ${link.userId} to Steam ${steamId}: level ${stats.level}.`);
    link.interaction.editReply({
      content: '✅ Linked. Run `/wardogs link` again whenever you want these numbers refreshed.',
      embeds: [statsEmbed(entry, link.interaction.user)],
      components: [],
    }).catch(() => {});
    return { entry, userId: link.userId };
  } catch (err) {
    const message = err instanceof LinkError ? err.message : 'Something went wrong reading your stats.';
    if (!(err instanceof LinkError)) console.error('[WARDOGS] Link failed:', err);
    link.interaction.editReply({ content: `❌ ${message}`, components: [] }).catch(() => {});
    throw err instanceof LinkError ? err : new LinkError(message);
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function getPlayer(userId) {
  return store.read().players?.[userId] || null;
}

function unlink(userId) {
  return store.update((db) => {
    if (!db.players?.[userId]) return false;
    delete db.players[userId];
    return true;
  });
}

const num = (n) => Number(n || 0).toLocaleString('en-US');
const money = (n) => `$${num(n)}`;
const ts = (iso) => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;

function playerName(entry, user) {
  if (entry.name) return entry.discriminator ? `${entry.name} #${entry.discriminator}` : entry.name;
  return user?.username || 'Unknown';
}

function statsEmbed(entry, user) {
  const s = entry.stats;
  const roles = ROLES.map((r) => `**${ROLE_LABELS[r]}** ${s.roles[r].level}`).join(' · ');
  const embed = new EmbedBuilder()
    .setColor(0xc0392b)
    .setTitle(`🐕 ${playerName(entry, user)}`)
    .setDescription(`Wardog level **${s.level}**\n${roles}`)
    .addFields(
      { name: 'XP', value: num(s.xp), inline: true },
      { name: 'Cash', value: money(s.cash), inline: true },
      { name: 'Gold', value: num(s.gold), inline: true },
      { name: 'Unlocks', value: num(s.unlocks), inline: true },
      { name: 'Updated', value: ts(entry.updatedAt), inline: true },
    );
  if (user) embed.setAuthor({ name: user.username, iconURL: user.displayAvatarURL() });

  const hist = entry.history || [];
  if (hist.length >= 2) {
    const first = hist[0];
    const gained = s.level - first.level;
    if (gained > 0) embed.setFooter({ text: `+${gained} levels since ${new Date(first.at).toLocaleDateString('en-US')}` });
  }
  return embed;
}

const METRICS = {
  level: { label: 'Wardog level', value: (s) => s.level, fmt: num },
  xp: { label: 'XP', value: (s) => s.xp, fmt: num },
  cash: { label: 'Cash', value: (s) => s.cash, fmt: money },
  gold: { label: 'Gold', value: (s) => s.gold, fmt: num },
  unlocks: { label: 'Unlocks', value: (s) => s.unlocks, fmt: num },
  ...Object.fromEntries(ROLES.map((r) => [r, { label: ROLE_LABELS[r], value: (s) => s.roles[r].level, fmt: num }])),
};

/** The guild's linked players ranked by one metric. Members who left are skipped. */
async function leaderboardEmbed(guild, metricKey) {
  const metric = METRICS[metricKey] || METRICS.level;
  const players = Object.entries(store.read().players || {});
  const members = players.length
    ? await guild.members.fetch({ user: players.map(([id]) => id) }).catch(() => null)
    : null;

  const rows = players
    .filter(([id]) => members?.has(id))
    .map(([id, entry]) => ({ id, entry, value: metric.value(entry.stats) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 20);

  const embed = new EmbedBuilder().setColor(0xc0392b).setTitle(`🐕 WARDOGS: ${metric.label}`);
  if (!rows.length) {
    return embed.setDescription('Nobody here has linked a WARDOGS account yet. `/wardogs link` to be the first.');
  }
  const medals = ['🥇', '🥈', '🥉'];
  embed.setDescription(rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} <@${r.id}> · ${metric.fmt(r.value)}`
    + (r.entry.name ? ` *(${r.entry.name})*` : '')).join('\n'));
  return embed.setFooter({ text: 'Numbers are as of each player\'s last /wardogs link.' });
}

// ---------------------------------------------------------------------------
// HTTP routes, mounted on the bot's web server (api/server.js) at /wardogs
// ---------------------------------------------------------------------------

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

function routes() {
  const express = require('express');
  const router = express.Router();

  router.get('/login', (req, res) => {
    const target = steamRedirect(String(req.query.n || ''));
    if (!target) {
      return res.status(410).send(page('Link expired', 'This sign-in link has expired or was already used. Run /wardogs link in Discord for a new one.'));
    }
    res.set('Referrer-Policy', 'no-referrer').redirect(302, target);
  });

  router.get('/callback', async (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    try {
      const { entry } = await completeLink(req.query);
      res.send(page('Linked', `Wardog level ${entry.stats.level}. Your stats are waiting in Discord; you can close this tab.`));
    } catch (err) {
      res.status(400).send(page('Could not link', err.message));
    }
  });

  return router;
}

module.exports = {
  createLink,
  completeLink,
  getPlayer,
  unlink,
  statsEmbed,
  leaderboardEmbed,
  routes,
  METRICS,
  ROLE_LABELS,
  // For tests.
  decodeStats,
};
