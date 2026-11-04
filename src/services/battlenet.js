'use strict';
/**
 * Battle.net account links, for /wow (World of Warcraft: Forever).
 *
 * A member links the same way /wardogs link works with Steam:
 *
 *   1. /wow link hands them a one-time link to /wow/login on the bot's web
 *      server (public through Tailscale Funnel, PUBLIC_URL).
 *   2. That redirects to Battle.net's own sign-in and consent page. We never
 *      see a password.
 *   3. Battle.net sends the browser back to /wow/callback with a code. We trade
 *      it for a token, ask who they are (their BattleTag) and which WoW Forever
 *      characters they have, keep that, and drop the token.
 *
 * The token lasts a day and Blizzard gives no way to renew it, so nothing here
 * holds one. Characters refresh when someone links again, which is one click
 * once Battle.net remembers them.
 *
 * Forever's characters: at launch (2026-11-04) Blizzard had not published the
 * API namespace they live under. Each link tries BLIZZARD_FOREVER_NAMESPACE
 * when it is set, else a few likely names, and logs which one answered. A link
 * where none does still records the BattleTag, which is all /wow friends needs.
 * Classic Era's namespace (profile-classic1x) is not guessed: those are another
 * game's characters, and listing them as Forever ones would be wrong. If
 * Forever turns out to live there, set the variable to it.
 */
const crypto = require('crypto');
const path = require('path');
const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const { jsonFile } = require('../storage/jsonFile');
const { page } = require('../api/page');

const OAUTH_HOST = 'https://oauth.battle.net';
const SCOPE = 'openid wow.profile';
/** How long a link from /wow link stays good. Under Discord's 15-minute interaction token. */
const LINK_TTL_MS = 10 * 60 * 1000;
/** Likely names for Forever's profile namespace, tried in order. The region is added on the end. */
const FOREVER_GUESSES = ['profile-forever', 'profile-classic-forever', 'profile-wowforever', 'profile-classicforever'];
const REGIONS = ['us', 'eu', 'kr', 'tw'];
const COLOR = 0x148eff;
/** Lines in the /wow friends list before the rest are counted rather than shown. */
const FRIENDS_SHOWN = 60;

const store = jsonFile(path.join(__dirname, '../../data/battlenet.json'), { empty: () => ({ links: {} }) });

/** Pending links by nonce: { userId, interaction, expires }. Memory only; a restart voids them. */
const pending = new Map();

class LinkError extends Error {}

function publicUrl() {
  return (process.env.PUBLIC_URL || process.env.WARDOGS_PUBLIC_URL || '').replace(/\/+$/, '');
}

function region() {
  const r = String(process.env.BLIZZARD_REGION || 'us').toLowerCase();
  return REGIONS.includes(r) ? r : 'us';
}

const redirectUri = () => `${publicUrl()}/wow/callback`;

/** The settings still missing before linking can work, or null when it is ready. */
function missingSetup() {
  const missing = [];
  if (!publicUrl()) missing.push('PUBLIC_URL');
  if (!process.env.BLIZZARD_CLIENT_ID) missing.push('BLIZZARD_CLIENT_ID');
  if (!process.env.BLIZZARD_CLIENT_SECRET) missing.push('BLIZZARD_CLIENT_SECRET');
  return missing.length ? missing : null;
}

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

function sweepPending() {
  const now = Date.now();
  for (const [nonce, p] of pending) if (p.expires < now) pending.delete(nonce);
}

/**
 * A one-time sign-in link for this Discord user, or null when linking is not
 * set up. The interaction is kept so the result can be shown in the same
 * private reply once they come back from Battle.net.
 */
function createLink(interaction) {
  if (missingSetup()) return null;
  sweepPending();
  // One live link per person: a second /wow link replaces the first.
  for (const [nonce, p] of pending) if (p.userId === interaction.user.id) pending.delete(nonce);
  const nonce = crypto.randomBytes(24).toString('base64url');
  pending.set(nonce, { userId: interaction.user.id, interaction, expires: Date.now() + LINK_TTL_MS });
  return `${publicUrl()}/wow/login?n=${nonce}`;
}

/** Where to send the browser for Battle.net's sign-in, or null if the nonce is unknown or stale. */
function authorizeRedirect(nonce) {
  sweepPending();
  if (!nonce || !pending.has(nonce)) return null;
  const params = new URLSearchParams({
    client_id: process.env.BLIZZARD_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    // The nonce doubles as OAuth's state: a callback without a live one is refused.
    state: nonce,
  });
  return `${OAUTH_HOST}/authorize?${params}`;
}

const failure = (err) => err.response?.status || err.code || err.message;

async function exchangeCode(code) {
  let data;
  try {
    ({ data } = await axios.post(`${OAUTH_HOST}/token`, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
    }).toString(), {
      auth: { username: process.env.BLIZZARD_CLIENT_ID, password: process.env.BLIZZARD_CLIENT_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20000,
    }));
  } catch (err) {
    console.error('[Battle.net] Token exchange failed:', failure(err), err.response?.data || '');
    throw new LinkError(`Battle.net would not finish the sign-in (${failure(err)}). Run /wow link again.`);
  }
  if (!data?.access_token) throw new LinkError('Battle.net finished the sign-in but gave no token back. Run /wow link again.');
  return data.access_token;
}

/** { accountId, battletag } for the signed-in account. */
async function whoIs(token) {
  let data;
  try {
    ({ data } = await axios.get(`${OAUTH_HOST}/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000,
    }));
  } catch (err) {
    throw new LinkError(`Battle.net would not say who you are (${failure(err)}). Run /wow link again.`);
  }
  const accountId = data?.id ?? data?.sub;
  if (!accountId || !data?.battletag) throw new LinkError('Battle.net did not send a BattleTag for this account.');
  return { accountId: String(accountId), battletag: String(data.battletag) };
}

/** A name from the API: a string with a locale given, an object of locales without one. */
function text(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return v.en_US || v.en_GB || Object.values(v)[0] || null;
  return null;
}

/** The realm slug from a character's API link, `/profile/wow/character/{realm}/{name}`, when it has one. */
function slugFromHref(href) {
  const m = /\/profile\/wow\/character\/([^/?]+)\//.exec(String(href || ''));
  return m && m[1] !== 'null' ? decodeURIComponent(m[1]) : null;
}

/**
 * One character from the account profile. Before Forever launched, Blizzard
 * sent its characters with no realm at all; `realmSlug` stays null until one
 * is known, and services/wowRace.js finds it once the realm list exists.
 */
function character(c) {
  return {
    id: c?.id != null ? String(c.id) : null,
    name: text(c?.name),
    realm: text(c?.realm?.name) || c?.realm?.slug || null,
    realmSlug: c?.realm?.slug || slugFromHref(c?.key?.href) || null,
    level: Number(c?.level) || 0,
    class: text(c?.playable_class?.name),
    race: text(c?.playable_race?.name),
    faction: text(c?.faction?.name),
  };
}

/**
 * A fresh character list, keeping what the race board learned about the ones
 * already known: the realm it found and when each reached its level, so a
 * re-link doesn't reset anyone's place.
 */
function mergeCharacters(prev, next, now) {
  const key = (c) => c.id || `${c.name}@${c.realmSlug || c.realm || ''}`.toLowerCase();
  const old = new Map((prev || []).map((c) => [key(c), c]));
  return next.map((c) => {
    const was = old.get(key(c));
    if (!was) return { ...c, levelAt: now };
    const level = Math.max(c.level, was.level || 0);
    return {
      ...was,
      ...c,
      realm: c.realm || was.realm || null,
      realmSlug: c.realmSlug || was.realmSlug || null,
      level,
      levelAt: level === was.level ? (was.levelAt || now) : now,
    };
  });
}

function namespacesToTry() {
  const r = region();
  const set = String(process.env.BLIZZARD_FOREVER_NAMESPACE || '').trim();
  return (set ? [set] : FOREVER_GUESSES).map((ns) => (ns.endsWith(`-${r}`) ? ns : `${ns}-${r}`));
}

/**
 * Their Forever characters, highest level first, and the namespace that held
 * them. { namespace: null, characters: [] } when no namespace answered, which
 * is also what an account with no characters there looks like: Blizzard
 * answers 404 to both.
 */
async function foreverCharacters(token) {
  const r = region();
  for (const namespace of namespacesToTry()) {
    try {
      const { data } = await axios.get(`https://${r}.api.blizzard.com/profile/user/wow`, {
        params: { namespace, locale: 'en_US' },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20000,
      });
      const characters = (data?.wow_accounts || [])
        .flatMap((a) => a?.characters || [])
        .map(character)
        .filter((c) => c.name)
        .sort((a, b) => b.level - a.level);
      console.log(`[Battle.net] ${namespace} answered with ${characters.length} character(s).`);
      return { namespace, characters };
    } catch (err) {
      const status = err.response?.status;
      if (status !== 404) console.warn(`[Battle.net] ${namespace}: ${failure(err)}`);
    }
  }
  return { namespace: null, characters: [] };
}

/**
 * Finish a link from Battle.net's redirect. Returns { entry, userId } on
 * success; throws LinkError with a message for the member otherwise. The
 * pending link is spent either way, so a replayed callback does nothing.
 */
async function completeLink(query) {
  const nonce = typeof query.state === 'string' ? query.state : '';
  sweepPending();
  const link = nonce && pending.get(nonce);
  if (!link) throw new LinkError('This sign-in link has expired or was already used. Run /wow link again.');
  pending.delete(nonce);

  try {
    if (query.error) {
      throw new LinkError(query.error === 'access_denied'
        ? 'Battle.net sign-in was cancelled.'
        : `Battle.net refused the sign-in (${String(query.error)}).`);
    }
    const code = typeof query.code === 'string' ? query.code : '';
    if (!code) throw new LinkError('Battle.net sent back an incomplete sign-in. Run /wow link again.');

    const token = await exchangeCode(code);
    const who = await whoIs(token);
    const forever = await foreverCharacters(token);

    const now = new Date().toISOString();
    const entry = store.update((db) => {
      db.links ||= {};
      // One Discord member per Battle.net account: whoever signed in last has it.
      for (const [id, e] of Object.entries(db.links)) {
        if (id !== link.userId && e.accountId === who.accountId) delete db.links[id];
      }
      const prev = db.links[link.userId];
      const same = prev?.accountId === who.accountId;
      const next = {
        accountId: who.accountId,
        battletag: who.battletag,
        linkedAt: same ? prev.linkedAt : now,
        updatedAt: now,
        // A sign-in where no namespace answered keeps what an earlier one found.
        namespace: forever.namespace || (same ? prev.namespace : null) || null,
        characters: forever.namespace
          ? mergeCharacters(same ? prev.characters : [], forever.characters, now)
          : (same ? prev.characters || [] : []),
      };
      db.links[link.userId] = next;
      return next;
    });

    console.log(`[Battle.net] Linked ${link.userId} to ${who.battletag}: ${entry.characters.length} Forever character(s).`);
    link.interaction.editReply({
      content: '✅ Linked. Run `/wow link` again whenever your characters need refreshing.',
      embeds: [profileEmbed(entry, link.interaction.user)],
      components: [],
    }).catch(() => {});
    return { entry, userId: link.userId };
  } catch (err) {
    const message = err instanceof LinkError ? err.message : 'Something went wrong linking your Battle.net account.';
    if (!(err instanceof LinkError)) console.error('[Battle.net] Link failed:', err);
    link.interaction.editReply({ content: `❌ ${message}`, components: [] }).catch(() => {});
    throw err instanceof LinkError ? err : new LinkError(message);
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function getLink(userId) {
  return store.read().links?.[userId] || null;
}

/** Every link, by Discord user ID. For the race board. */
function allLinks() {
  return store.read().links || {};
}

/** Change the links in one write. For the race board, which keeps levels on them. */
function updateLinks(mutate) {
  return store.update((db) => {
    db.links ||= {};
    return mutate(db.links);
  });
}

function unlink(userId) {
  return store.update((db) => {
    if (!db.links?.[userId]) return false;
    delete db.links[userId];
    return true;
  });
}

const ts = (iso) => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;

function characterLine(c) {
  const what = [c.level ? `${c.level}` : null, c.race, c.class].filter(Boolean).join(' ');
  return `**${c.name}**${what ? ` · ${what}` : ''}${c.realm ? ` · ${c.realm}` : ''}`;
}

function profileEmbed(entry, user) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`⚔️ ${entry.battletag}`)
    .setDescription(`BattleTag \`${entry.battletag}\`\nLinked ${ts(entry.linkedAt)}`);
  if (user) embed.setAuthor({ name: user.username, iconURL: user.displayAvatarURL() });

  const chars = entry.characters || [];
  embed.addFields({
    name: 'WoW Forever characters',
    value: chars.length
      ? chars.slice(0, 10).map(characterLine).join('\n') + (chars.length > 10 ? `\n…and ${chars.length - 10} more` : '')
      : 'None readable yet. Blizzard has not opened Forever\'s characters to its API; `/wow link` again once it has.',
  });
  return embed.setFooter({ text: `Updated ${new Date(entry.updatedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC` });
}

/** Of these user IDs, the ones still in the guild. Fetched 100 at a time, Discord's limit. */
async function membersOf(guild, ids) {
  const present = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = await guild.members.fetch({ user: ids.slice(i, i + 100) }).catch(() => null);
    for (const id of batch?.keys() || []) present.add(id);
  }
  return present;
}

/** Everyone in this guild who has linked, with their BattleTag and highest character. */
async function friendsEmbed(guild) {
  const links = Object.entries(store.read().links || {});
  const present = links.length ? await membersOf(guild, links.map(([id]) => id)) : new Set();
  const rows = links
    .filter(([id]) => present.has(id))
    .sort((a, b) => a[1].battletag.localeCompare(b[1].battletag));

  const embed = new EmbedBuilder().setColor(COLOR).setTitle('⚔️ BattleTags in this server');
  if (!rows.length) {
    return embed.setDescription('Nobody here has linked a Battle.net account yet. `/wow link` to be the first.');
  }
  const lines = rows.slice(0, FRIENDS_SHOWN).map(([id, e]) => {
    const main = e.characters?.[0];
    return `<@${id}> · \`${e.battletag}\`${main ? ` · ${main.name} (${main.level})` : ''}`;
  });
  if (rows.length > FRIENDS_SHOWN) lines.push(`…and ${rows.length - FRIENDS_SHOWN} more`);
  return embed
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Add them in the Battle.net app: Add a Friend, then paste the BattleTag.' });
}

// ---------------------------------------------------------------------------
// HTTP routes, mounted on the bot's web server (api/server.js) at /wow
// ---------------------------------------------------------------------------

function routes() {
  const express = require('express');
  const router = express.Router();

  router.get('/login', (req, res) => {
    const target = authorizeRedirect(String(req.query.n || ''));
    if (!target) {
      return res.status(410).send(page('Link expired', 'This sign-in link has expired or was already used. Run /wow link in Discord for a new one.'));
    }
    res.set('Referrer-Policy', 'no-referrer').redirect(302, target);
  });

  router.get('/callback', async (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    try {
      const { entry } = await completeLink(req.query);
      res.send(page('Linked', `Linked as ${entry.battletag}. You can close this tab and go back to Discord.`));
    } catch (err) {
      res.status(400).send(page('Could not link', err.message));
    }
  });

  return router;
}

module.exports = {
  createLink,
  completeLink,
  missingSetup,
  getLink,
  allLinks,
  updateLinks,
  unlink,
  profileEmbed,
  friendsEmbed,
  membersOf,
  routes,
  region,
  failure,
  OAUTH_HOST,
  COLOR,
  // For tests.
  character,
  mergeCharacters,
  namespacesToTry,
};
