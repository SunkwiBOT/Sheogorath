'use strict';
/**
 * The race to 60 in World of Warcraft: Forever, from the characters people
 * linked with /wow link (services/battlenet.js).
 *
 * Every POLL_MINUTES each linked character's level is read from its public
 * character profile (the `path` battlenet.js keeps) with the bot's own app
 * token (client credentials), so nobody has to link again for their level to
 * move. A member's place is their highest character.
 *
 * As of 2026-11-05 Blizzard answers those with 404 for every Forever
 * character, so until it opens them a level moves only when its owner runs
 * /wow link again. Nothing needs changing when it does: the next check reads
 * them, and the log says so once.
 *
 * In each guild with the `wow` feature and a `wow.channel`:
 *   - each time a member's best character passes 10, 20, 30, 40 or 50, it is
 *     posted with a line from him, picked from a list (no model call)
 *   - the first member seen at 60 takes `wow.title` (default "The Mad God's
 *     Champion") through the title executor pick'em uses, with one model call
 *     for his verdict, about a tenth of a cent; everyone after them is posted
 *     with the place they finished in
 *
 * What a member had reached when the board first saw them is not announced:
 * someone linking at 34 gets no posts for 10, 20 and 30. Nobody is pinged
 * except the first to 60.
 */
const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const { getGuildConfig, guildIds, hasFeature } = require('../config/guilds');
const { getGuildState, setGuildState } = require('../storage/state');
const battlenet = require('./battlenet');
const { getAIResponse } = require('../ai/grok');
const { conversationalPersona } = require('../ai/persona');
const { scrub } = require('../ai/actions');
const { runAction } = require('../ai/executors');

const MINUTE_MS = 60 * 1000;
const POLL_MINUTES = 10;
const MAX_LEVEL = 60;
const MILESTONES = [10, 20, 30, 40, 50, 60];
/** A member's highest characters followed, at most. */
const CHARACTERS_PER_MEMBER = 10;
const DEFAULT_TITLE = 'The Mad God\'s Champion';
const STATE_KEY = 'wowRace';
/** Rows on /wow race. */
const SHOWN = 20;

const LINES = {
  10: [
    'Ten levels! The first step on a long road paved with boar livers.',
    'Ten. A fine number. Two fives holding hands.',
  ],
  20: [
    'Twenty! I would throw a party, but the guests keep turning into butterflies.',
    'Twenty levels. Halfway to forty, which is nowhere near done. Run, little mortal.',
  ],
  30: [
    'Thirty. The halfway mark. Or is it? Yes. Probably. Don\'t ask Haskill.',
    'Thirty levels of murdering wildlife. The wildlife has filed a complaint.',
  ],
  40: [
    'Forty! Your knees should hurt by now. Mine do, and I don\'t have any.',
    'Forty levels. Somewhere a quest giver is still waiting for you to come back. Let him wait.',
  ],
  50: [
    'Fifty. The finish line is close enough to lick. Don\'t lick it.',
    'Fifty! Ten more and you can stop pretending you have a life outside Azeroth.',
  ],
  60: [
    'Sixty. The road ends. Now the real madness begins.',
    'Sixty! Another mortal reaches the top of the hill and finds... more hill.',
  ],
  first: ['First to sixty! Kneel, mortals. Or don\'t. They won\'t notice, they\'re busy playing.'],
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const iso = (ms = Date.now()) => new Date(ms).toISOString();
/** The highest milestone a level has passed, or 0. */
const milestoneOf = (level) => MILESTONES.filter((m) => level >= m).pop() || 0;
const titleFor = (guildId) => getGuildConfig(guildId)?.wow?.title || DEFAULT_TITLE;

/** A member's best character: highest level, and of equals, the one that got there first. */
function bestOf(link) {
  return [...(link?.characters || [])]
    .filter((c) => c.name)
    .sort((a, b) => (b.level || 0) - (a.level || 0) || String(a.levelAt || '').localeCompare(String(b.levelAt || '')))[0] || null;
}

// ---------------------------------------------------------------------------
// Blizzard
// ---------------------------------------------------------------------------

let app = null;

/** The bot's own token, from client credentials. It lasts a day and is kept until it nearly expires. */
async function appToken() {
  if (app && app.expires > Date.now()) return app.token;
  const { data } = await axios.post(`${battlenet.OAUTH_HOST}/token`, 'grant_type=client_credentials', {
    auth: { username: process.env.BLIZZARD_CLIENT_ID, password: process.env.BLIZZARD_CLIENT_SECRET },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000,
  });
  if (!data?.access_token) throw new Error('Battle.net gave no app token');
  app = { token: data.access_token, expires: Date.now() + ((Number(data.expires_in) || 3600) - 60) * 1000 };
  return app.token;
}

async function api(path, namespace) {
  const { data } = await axios.get(`https://${battlenet.region()}.api.blizzard.com${path}`, {
    params: { namespace, locale: 'en_US' },
    headers: { Authorization: `Bearer ${await appToken()}` },
    timeout: 20000,
  });
  return data;
}

/**
 * Where a character's public profile is: the link Blizzard sent with it, else
 * built from its names. Null for characters linked before launch, which were
 * kept without either; their owner's next /wow link replaces them.
 */
function lookupPath(c) {
  if (c.path) return c.path;
  if (c.realmSlug) return `/profile/wow/character/${encodeURIComponent(c.realmSlug)}/${encodeURIComponent(String(c.name).toLowerCase())}`;
  if (c.surname) return battlenet.namePath(c.name, c.surname);
  return null;
}

/** The fields worth keeping from a character profile. */
function fromProfile(data) {
  return {
    level: Number(data?.level) || 0,
    realmSlug: data?.realm?.slug || null,
    realm: (typeof data?.realm?.name === 'string' && data.realm.name) || null,
    class: (typeof data?.character_class?.name === 'string' && data.character_class.name) || null,
    race: (typeof data?.race?.name === 'string' && data.race.name) || null,
  };
}

/**
 * Whether Blizzard is answering character lookups: null until a check has run,
 * then true or false. Only for the log line and the footer on /wow race.
 */
let answering = null;

/** What changed about one character: a patch, { missing } on a 404, or null when it has nowhere to look. */
async function checkCharacter(c, namespace) {
  const where = lookupPath(c);
  if (!where) return null;
  const now = iso();
  try {
    const data = await api(where, namespace);
    // Names can change hands; a different character there is not this one.
    if (c.id && data?.id != null && String(data.id) !== c.id) return { checkedAt: now, missing: true };
    return { ...fromProfile(data), checkedAt: now };
  } catch (err) {
    // Not opened yet, renamed or deleted: kept as it was until a re-link says otherwise.
    if (err.response?.status === 404) return { checkedAt: now, missing: true };
    throw err;
  }
}

/** Read every followed character's level and store what moved. */
async function refreshLevels() {
  const links = battlenet.allLinks();
  const found = [];
  let tried = 0;
  let read = 0;
  for (const [userId, link] of Object.entries(links)) {
    if (!link.namespace) continue;
    const followed = [...(link.characters || [])]
      .filter((c) => c.name)
      .sort((a, b) => (b.level || 0) - (a.level || 0))
      .slice(0, CHARACTERS_PER_MEMBER);
    for (const c of followed) {
      try {
        const patch = await checkCharacter(c, link.namespace);
        if (!patch) continue;
        tried += 1;
        // A 404 changes nothing, so it isn't written: the file stays still between level-ups.
        const { missing, ...rest } = patch;
        if (missing) continue;
        read += 1;
        found.push({ userId, id: c.id, name: c.name, patch: rest });
      } catch (err) {
        console.warn(`[WowRace] ${battlenet.fullName(c)}: ${battlenet.failure(err)}`);
      }
    }
  }
  if (tried) {
    const now = read > 0;
    if (now && answering !== true) console.log(`[WowRace] Blizzard answers Forever character lookups: read ${read} of ${tried}.`);
    if (!now && answering === null) console.log(`[WowRace] Blizzard does not answer Forever character lookups yet (${tried} tried); levels move on /wow link.`);
    answering = now;
  }
  if (!found.length) return 0;

  const now = iso();
  let moved = 0;
  battlenet.updateLinks((all) => {
    for (const { userId, id, name, patch } of found) {
      const c = all[userId]?.characters?.find((x) => (id ? x.id === id : x.name === name));
      if (!c) continue;
      const { level, ...rest } = patch;
      for (const [k, v] of Object.entries(rest)) if (v != null) c[k] = v;
      // Levels only go up. A lower number is a stale read, not a lost level.
      if (Number.isFinite(level) && level > (c.level || 0)) {
        c.level = level;
        c.levelAt = now;
        moved += 1;
      }
    }
  });
  return moved;
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

function whatTheyAre(c) {
  return [c.race, c.class].filter(Boolean).join(' ');
}

async function crownLine(guild, userId, c) {
  const member = await guild.members.fetch(userId).catch(() => null);
  const name = member?.displayName || 'A mortal';
  const prompt = `${name} is the first in this server to reach level 60 in World of Warcraft: Forever, `
    + `on ${battlenet.fullName(c)}${whatTheyAre(c) ? `, a ${whatTheyAre(c)}` : ''}. In one or two short sentences, in character: `
    + 'crown them. Playful, never cruel. Use their name as written, no @ mentions, no action tags.';
  const text = await getAIResponse(prompt, { rawSystemPrompt: conversationalPersona(), maxTokens: 150, guildId: guild.id });
  return scrub(text || '').replace(/[ \t]{2,}/g, ' ').trim() || null;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** Post what each guild's members have reached since the last look. */
async function announce(client) {
  const links = battlenet.allLinks();
  const ids = Object.keys(links).filter((id) => bestOf(links[id]));
  if (!ids.length) return;

  for (const guildId of guildIds()) {
    if (!hasFeature(guildId, 'wow')) continue;
    const channelId = getGuildConfig(guildId)?.wow?.channel;
    const guild = client.guilds.cache.get(guildId);
    if (!channelId || !guild) continue;

    const present = await battlenet.membersOf(guild, ids);
    const saved = getGuildState(guildId)[STATE_KEY] || {};
    const state = { announced: { ...(saved.announced || {}) }, finishers: [...(saved.finishers || [])], first: saved.first || null };

    const posts = [];
    let changed = false;
    for (const userId of ids) {
      if (!present.has(userId)) continue;
      const best = bestOf(links[userId]);
      const reached = milestoneOf(best.level || 0);
      if (state.announced[userId] === undefined) {
        // First sight: nothing they reached before is news. 60 still counts,
        // so whoever links already there can finish the race.
        state.announced[userId] = Math.min(reached, 50);
        changed = true;
      }
      if (reached > state.announced[userId]) {
        posts.push({ userId, best, milestone: reached });
        state.announced[userId] = reached;
        changed = true;
      }
    }
    // Whoever got there first is told first, and is the one crowned.
    posts.sort((a, b) => String(a.best.levelAt || '').localeCompare(String(b.best.levelAt || '')));
    for (const p of posts) {
      if (p.milestone !== MAX_LEVEL) continue;
      if (!state.finishers.includes(p.userId)) state.finishers.push(p.userId);
      p.place = state.finishers.indexOf(p.userId) + 1;
      if (!state.first) {
        state.first = { userId: p.userId, name: battlenet.fullName(p.best), at: iso() };
        p.first = true;
      }
    }
    // Stored before anything is posted, so a crash mid-post never repeats one.
    if (changed) setGuildState(guildId, { [STATE_KEY]: state });
    if (!posts.length) continue;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
      console.warn(`[WowRace] ${guildId}: cannot reach channel ${channelId}.`);
      continue;
    }
    for (const p of posts) {
      await post(channel, guild, p).catch((err) =>
        console.warn(`[WowRace] ${guildId}: could not post ${battlenet.fullName(p.best)} at ${p.milestone}: ${err?.message || err}`));
    }
  }
}

async function post(channel, guild, { userId, best, milestone, place, first }) {
  const what = whatTheyAre(best);
  const who = `<@${userId}>'s **${battlenet.fullName(best)}**`;

  if (first) {
    const title = titleFor(guild.id);
    let titled = false;
    try {
      await runAction({ type: 'title', userId, title }, { guild, guildId: guild.id });
      titled = true;
    } catch (err) {
      console.warn(`[WowRace] ${guild.id}: could not give "${title}" to ${userId}: ${err.message}`);
    }
    const line = await crownLine(guild, userId, best).catch(() => null) || pick(LINES.first);
    const lines = [`👑 ${who} is the **first to 60**${what ? ` · ${what}` : ''}`, line];
    if (titled) lines.push(`<@${userId}> takes **${title}**.`);
    return channel.send({ content: lines.join('\n\n'), allowedMentions: { users: [userId] } });
  }

  const head = milestone === MAX_LEVEL
    ? `🏁 ${who} hit **60**, the ${ordinal(place)} here to get there${what ? ` · ${what}` : ''}`
    : `⚔️ ${who} reached **level ${milestone}**${what ? ` · ${what}` : ''}`;
  return channel.send({ content: `${head}\n> ${pick(LINES[milestone])}`, allowedMentions: { parse: [] } });
}

// ---------------------------------------------------------------------------
// /wow race
// ---------------------------------------------------------------------------

async function raceEmbed(guild) {
  const links = battlenet.allLinks();
  const ids = Object.keys(links);
  const present = ids.length ? await battlenet.membersOf(guild, ids) : new Set();
  const rows = ids
    .filter((id) => present.has(id))
    .map((id) => ({ id, best: bestOf(links[id]) }))
    .filter((r) => r.best)
    .sort((a, b) => (b.best.level || 0) - (a.best.level || 0)
      || String(a.best.levelAt || '').localeCompare(String(b.best.levelAt || '')));

  const embed = new EmbedBuilder().setColor(battlenet.COLOR).setTitle('⚔️ The race to 60');
  if (!rows.length) {
    return embed.setDescription('Nobody here has a WoW Forever character linked yet. `/wow link` to join the race.');
  }
  const first = (getGuildState(guild.id)[STATE_KEY] || {}).first;
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.slice(0, SHOWN).map((r, i) => {
    const what = whatTheyAre(r.best);
    return `${medals[i] || `**${i + 1}.**`} <@${r.id}> · **${battlenet.fullName(r.best)}** ${r.best.level || 1}`
      + `${what ? ` · ${what}` : ''}${first?.userId === r.id ? ' 👑' : ''}`;
  });
  if (rows.length > SHOWN) lines.push(`…and ${rows.length - SHOWN} more`);
  embed.setDescription(lines.join('\n'));

  const stale = rows.filter((r) => (links[r.id].characters || []).some((c) => c.name && !lookupPath(c))).length;
  const notes = [answering === true
    ? `Levels are checked every ${POLL_MINUTES} minutes. Made a new character? /wow link again.`
    : 'Blizzard doesn\'t share Forever levels yet: yours updates when you /wow link, and by itself once Blizzard does.'];
  if (stale) notes.push('Linked before launch? /wow link again to show your real level.');
  return embed.setFooter({ text: notes.join(' ') });
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

let running = false;

async function pollOnce(client) {
  if (running) return;
  running = true;
  try {
    const moved = await refreshLevels();
    if (moved) console.log(`[WowRace] ${moved} character(s) levelled up.`);
    await announce(client);
  } catch (err) {
    console.warn(`[WowRace] Poll failed: ${battlenet.failure(err)}`);
  } finally {
    running = false;
  }
}

function scheduleWowRace(client) {
  if (!guildIds().some((id) => hasFeature(id, 'wow'))) return;
  const tick = () => {
    if (battlenet.missingSetup()) return;
    pollOnce(client);
  };
  setTimeout(tick, MINUTE_MS);
  setInterval(tick, POLL_MINUTES * MINUTE_MS);
  console.log(`[WowRace] Following WoW Forever levels every ${POLL_MINUTES} minutes.`);
}

module.exports = {
  scheduleWowRace,
  raceEmbed,
  // For tests.
  pollOnce,
  milestoneOf,
  bestOf,
  ordinal,
};
