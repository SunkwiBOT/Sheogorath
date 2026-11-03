'use strict';
/**
 * Who has been around: chat, games and being online.
 *
 * Asked "who's inactive" or "what are the busiest days for VC", he used to say
 * nothing was tracked, which was true. This keeps the count, per guild with the
 * `activity` feature, in data/activity/<guildId>.json:
 *
 *   users  each person's last message (when, and where), their message count,
 *          when they were last seen online, what they are playing now, and
 *          what they last played
 *   days   per day in the guild's own zone: messages per person, per channel
 *          and per hour, and minutes per game per person
 *
 * Voice is not kept here. The voice log (services/voiceLog.js) already has
 * every join and leave, and this reads it rather than keeping a second copy.
 *
 * Games come from Discord presence: what Discord shows under someone's name
 * as "Playing", "Streaming", "Watching" or "Competing". Music and custom
 * statuses are left out; a song a minute would bury the games.
 *
 * Channels in the guild's `ai.offLimits` are not counted. He is not supposed
 * to read them, and how busy a private room is says something about it.
 *
 * The first time a guild runs this, its text channels are read back
 * BACKFILL_DAYS so that "who's gone quiet" has an answer on day one.
 */
const path = require('path');
const { ActivityType, ChannelType } = require('discord.js');
const { getGuildConfig, guildIds, hasFeature, aiOffLimits } = require('../config/guilds');
const { jsonFile } = require('../storage/jsonFile');
const { partsIn } = require('../utils/time');

const DIR = path.join(__dirname, '..', '..', 'data', 'activity');
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Day buckets older than this are dropped. */
const KEEP_DAYS = 90;
/** How far back the first run reads each text channel. */
const BACKFILL_DAYS = 60;
/** Pages of 100 per channel, at most, on that first read. */
const BACKFILL_PAGES = 60;
/** Changes are written at most this often. */
const SAVE_MS = 60 * 1000;
/** Written anyway this often, so a restart knows when we were last running. */
const HEARTBEAT_MS = 5 * 60 * 1000;

const GAME_TYPES = new Set([ActivityType.Playing, ActivityType.Streaming, ActivityType.Watching, ActivityType.Competing]);
const VERB = {
  [ActivityType.Playing]: 'playing',
  [ActivityType.Streaming]: 'streaming',
  [ActivityType.Watching]: 'watching',
  [ActivityType.Competing]: 'competing in',
};

const enabled = (guildId) => hasFeature(guildId, 'activity');
const zoneOf = (guildId) => getGuildConfig(guildId)?.timeZone || 'America/Chicago';

const stores = new Map();
const state = new Map();
const dirty = new Set();

function storeFor(guildId) {
  if (!stores.has(guildId)) {
    stores.set(guildId, jsonFile(path.join(DIR, `${guildId}.json`), {
      empty: () => ({ users: {}, days: {}, backfilled: false, alive: null }),
    }));
  }
  return stores.get(guildId);
}

/** This guild's record, read once and kept. */
function dataFor(guildId) {
  if (!state.has(guildId)) {
    let d;
    try {
      d = storeFor(guildId).read();
    } catch (err) {
      console.warn(`[Activity] ${guildId}: could not read the record: ${err?.message || err}`);
      d = {};
    }
    d.users ||= {};
    d.days ||= {};
    state.set(guildId, d);
  }
  return state.get(guildId);
}

function save(guildId) {
  const d = dataFor(guildId);
  d.alive = Date.now();
  try {
    storeFor(guildId).write(d);
    dirty.delete(guildId);
  } catch (err) {
    console.warn(`[Activity] ${guildId}: could not save: ${err?.message || err}`);
  }
}

const touch = (guildId) => dirty.add(guildId);

const dayKey = (ms, timeZone) => {
  const p = partsIn(new Date(ms), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

function bucket(d, key) {
  const b = (d.days[key] ||= {});
  b.msgs ||= {};
  b.channels ||= {};
  b.hours ||= {};
  b.games ||= {};
  return b;
}

function userFor(d, id, name) {
  const u = (d.users[id] ||= { messages: 0 });
  if (name) u.name = name;
  return u;
}

// --- Chat --------------------------------------------------------------------

/** Count one message. `live` is false for the backfill, which must not move "last seen" backwards. */
function countMessage(guildId, message, { live = true } = {}) {
  if (!message.guildId || message.author?.bot || message.system) return;
  if (aiOffLimits(guildId, message.channel)) return;
  const d = dataFor(guildId);
  const t = message.createdTimestamp || Date.now();
  const zone = zoneOf(guildId);
  const b = bucket(d, dayKey(t, zone));
  const id = message.author.id;
  const name = message.member?.displayName || message.author.globalName || message.author.username;
  const channel = message.channel?.isThread?.() ? message.channel.parent?.name : message.channel?.name;

  b.msgs[id] = (b.msgs[id] || 0) + 1;
  if (channel) b.channels[channel] = (b.channels[channel] || 0) + 1;
  const hour = partsIn(new Date(t), zone).hour;
  b.hours[hour] = (b.hours[hour] || 0) + 1;

  const u = userFor(d, id, live ? name : null);
  if (!u.name) u.name = name;
  u.messages = (u.messages || 0) + 1;
  if (!u.lastMessage || t > u.lastMessage) {
    u.lastMessage = t;
    u.lastChannel = channel || null;
  }
  if (live) u.lastOnline = Math.max(u.lastOnline || 0, t);
  touch(guildId);
}

function onMessage(message) {
  if (!message.guildId || !enabled(message.guildId)) return;
  countMessage(message.guildId, message);
}

// --- Games and being online --------------------------------------------------

/** What someone is doing, from a presence: { [name]: verb }. */
function gamesIn(presence) {
  const out = {};
  for (const a of presence?.activities || []) {
    if (GAME_TYPES.has(a.type) && a.name) out[a.name] = VERB[a.type] || 'playing';
  }
  return out;
}

/** Add `ms` of `game` to the days it was played on, an hour at a time. */
function addPlaytime(d, guildId, userId, game, start, end) {
  const zone = zoneOf(guildId);
  for (let t = start; t < end; t += HOUR_MS) {
    const slice = Math.min(HOUR_MS, end - t);
    const b = bucket(d, dayKey(t, zone));
    const g = (b.games[game] ||= {});
    g[userId] = Math.round(((g[userId] || 0) + slice / 60000) * 10) / 10;
  }
}

/** Close one game session at `end`. */
function stopGame(d, guildId, userId, game, end) {
  const u = d.users[userId];
  const since = u?.playing?.[game]?.since;
  if (!since) return;
  if (end > since) addPlaytime(d, guildId, userId, game, since, end);
  u.lastPlayed = { name: game, at: end };
  delete u.playing[game];
  if (!Object.keys(u.playing).length) u.playing = null;
}

function onPresence(oldPresence, newPresence) {
  const guildId = newPresence?.guild?.id;
  if (!guildId || !enabled(guildId)) return;
  const member = newPresence.member;
  if (member?.user?.bot) return;
  const id = newPresence.userId;
  const now = Date.now();
  const d = dataFor(guildId);
  const u = userFor(d, id, member?.displayName || null);

  if (newPresence.status && newPresence.status !== 'offline') u.lastOnline = now;
  else if (oldPresence?.status && oldPresence.status !== 'offline') u.lastOnline = now;

  const before = u.playing || {};
  const after = gamesIn(newPresence);
  for (const game of Object.keys(before)) {
    if (!after[game]) stopGame(d, guildId, id, game, now);
  }
  for (const [game, verb] of Object.entries(after)) {
    if (!u.playing?.[game]) {
      u.playing ||= {};
      u.playing[game] = { since: now, verb };
    }
  }
  touch(guildId);
}

// --- Startup -----------------------------------------------------------------

/**
 * Square what we had with what Discord says now. A game we had open that is
 * not being played now ended while we were down, and is closed at the last
 * time we were known to be running.
 */
function reconcile(guild) {
  const d = dataFor(guild.id);
  const lastAlive = d.alive || Date.now();
  for (const [id, u] of Object.entries(d.users)) {
    if (!u.playing) continue;
    const now = gamesIn(guild.presences.cache.get(id));
    for (const game of Object.keys(u.playing)) {
      if (!now[game]) stopGame(d, guild.id, id, game, lastAlive);
    }
  }
  for (const presence of guild.presences.cache.values()) {
    if (presence.member?.user?.bot) continue;
    onPresence(null, presence);
  }
  touch(guild.id);
}

/** Read each text channel back BACKFILL_DAYS, once per guild. */
async function backfill(guild) {
  const d = dataFor(guild.id);
  if (d.backfilled) return;
  const since = Date.now() - BACKFILL_DAYS * DAY_MS;
  // Messages counted live before the backfill finishes would be counted twice.
  const startedAt = Date.now();
  let total = 0;
  const me = guild.members.me;
  const channels = guild.channels.cache.filter((c) => (
    (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
    && !aiOffLimits(guild.id, c)
    && (!me || c.permissionsFor(me)?.has(['ViewChannel', 'ReadMessageHistory']))
  ));
  for (const channel of channels.values()) {
    let before;
    for (let page = 0; page < BACKFILL_PAGES; page++) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
      if (!batch?.size) break;
      let done = false;
      for (const m of batch.values()) {
        if (m.createdTimestamp < since) { done = true; continue; }
        if (m.createdTimestamp >= startedAt) continue;
        countMessage(guild.id, m, { live: false });
        total++;
      }
      before = batch.last().id;
      if (done) break;
    }
  }
  d.backfilled = true;
  save(guild.id);
  console.log(`[Activity] ${guild.name}: read back ${total} message(s) from the last ${BACKFILL_DAYS} days.`);
}

function prune(guildId) {
  const d = dataFor(guildId);
  const cutoff = dayKey(Date.now() - KEEP_DAYS * DAY_MS, zoneOf(guildId));
  let dropped = 0;
  for (const key of Object.keys(d.days)) {
    if (key < cutoff) { delete d.days[key]; dropped++; }
  }
  if (dropped) touch(guildId);
}

async function startActivity(client) {
  for (const guildId of guildIds()) {
    if (!enabled(guildId)) continue;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    try {
      reconcile(guild);
      prune(guildId);
      save(guildId);
    } catch (err) {
      console.warn(`[Activity] ${guild.name}: startup failed: ${err?.message || err}`);
    }
    backfill(guild).catch((err) => console.warn(`[Activity] ${guild.name}: backfill failed: ${err?.message || err}`));
  }
  setInterval(() => {
    for (const guildId of dirty) save(guildId);
  }, SAVE_MS).unref();
  setInterval(() => {
    for (const guildId of state.keys()) touch(guildId);
  }, HEARTBEAT_MS).unref();
  setInterval(() => {
    for (const guildId of state.keys()) prune(guildId);
  }, DAY_MS).unref();
}

/** Write what is pending, on the way out. */
function flushAll() {
  for (const guildId of dirty) save(guildId);
}

// --- Reading it back ---------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "3h 10m", "45m", "under a minute". */
function hm(minutes) {
  const m = Math.round(minutes);
  if (m < 1) return 'under a minute';
  const h = Math.floor(m / 60);
  return h ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`;
}

/** "today", "yesterday", "5 days ago", "never". */
function ago(ms, now = Date.now()) {
  if (!ms) return 'never';
  const days = Math.floor((now - ms) / DAY_MS);
  if (days <= 0) {
    const hours = Math.floor((now - ms) / HOUR_MS);
    return hours <= 0 ? 'within the hour' : `${hours}h ago`;
  }
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

/** Days in the record from the last `days`, as [key, bucket]. */
function recentDays(guildId, days) {
  const d = dataFor(guildId);
  const cutoff = dayKey(Date.now() - days * DAY_MS, zoneOf(guildId));
  return Object.entries(d.days).filter(([key]) => key >= cutoff);
}

const weekdayOf = (key) => new Date(`${key}T12:00:00Z`).getUTCDay();

/** Lines on chat over the last `days`. */
function chatLines(guildId, days, nameOf) {
  const per = {};
  const channels = {};
  const weekdays = Array(7).fill(0);
  const hours = Array(24).fill(0);
  let total = 0;
  for (const [key, b] of recentDays(guildId, days)) {
    for (const [id, n] of Object.entries(b.msgs || {})) {
      per[id] = (per[id] || 0) + n;
      weekdays[weekdayOf(key)] += n;
      total += n;
    }
    for (const [c, n] of Object.entries(b.channels || {})) channels[c] = (channels[c] || 0) + n;
    for (const [h, n] of Object.entries(b.hours || {})) hours[+h] += n;
  }
  if (!total) return [];
  const busiestHours = hours.map((n, h) => [h, n]).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([h, n]) => `${String(h).padStart(2, '0')}:00 (${n})`);
  return [
    `Messages, last ${days} days: ${total}. By weekday: ${weekdays.map((n, i) => `${WEEKDAYS[i]} ${n}`).join(', ')}. Busiest hours: ${busiestHours.join(', ')}.`,
    `Most messages: ${top(per, 12).map(([id, n]) => `${nameOf(id)} ${n}`).join(', ')}.`,
    `Busiest channels: ${top(channels, 6).map(([c, n]) => `#${c} ${n}`).join(', ')}.`,
  ];
}

/** Lines on games over the last `days`, and what is being played right now. */
function gameLines(guildId, days, nameOf) {
  const d = dataFor(guildId);
  const games = {};
  for (const [, b] of recentDays(guildId, days)) {
    for (const [game, players] of Object.entries(b.games || {})) {
      const g = (games[game] ||= { total: 0, players: {} });
      for (const [id, min] of Object.entries(players)) {
        g.total += min;
        g.players[id] = (g.players[id] || 0) + min;
      }
    }
  }
  // Sessions still running count up to now.
  const now = Date.now();
  const playingNow = [];
  for (const [id, u] of Object.entries(d.users)) {
    for (const [game, s] of Object.entries(u.playing || {})) {
      playingNow.push(`${nameOf(id)} ${s.verb || 'playing'} ${game} (${hm((now - s.since) / 60000)})`);
      const g = (games[game] ||= { total: 0, players: {} });
      const min = (now - Math.max(s.since, now - days * DAY_MS)) / 60000;
      g.total += min;
      g.players[id] = (g.players[id] || 0) + min;
    }
  }
  const lines = [];
  if (playingNow.length) lines.push(`Right now: ${playingNow.join('; ')}.`);
  const ranked = Object.entries(games).sort((a, b) => b[1].total - a[1].total).slice(0, 10);
  if (ranked.length) {
    lines.push(`Games played, last ${days} days (tracked from Discord's "Playing" status):`);
    for (const [game, g] of ranked) {
      lines.push(`- ${game}: ${hm(g.total)} — ${top(g.players, 5).map(([id, m]) => `${nameOf(id)} ${hm(m)}`).join(', ')}`);
    }
  }
  return lines;
}

/** Lines on voice, from the voice log. */
function voiceLines(guild, days, nameOf) {
  if (!hasFeature(guild.id, 'voiceLog')) return [];
  const { voiceStats } = require('./voiceLog');
  const s = voiceStats(guild.id, days);
  const lines = [];
  const inVoice = [];
  for (const vs of guild.voiceStates.cache.values()) {
    if (!vs.channelId || vs.member?.user?.bot) continue;
    inVoice.push(`${vs.member?.displayName || nameOf(vs.id)} in ${guild.channels.cache.get(vs.channelId)?.name || 'a voice channel'}`);
  }
  lines.push(inVoice.length ? `In voice right now: ${inVoice.join('; ')}.` : 'Nobody is in voice right now.');
  if (!s.since) return lines;
  const span = Math.min(days, Math.max(1, Math.ceil((Date.now() - s.since) / DAY_MS)));
  lines.push(
    `Voice, last ${span} day(s) (the voice log only goes back to ${new Date(s.since).toDateString()}): `
    + `by weekday ${s.byWeekday.map((ms, i) => `${WEEKDAYS[i]} ${hm(ms / 60000)}`).join(', ')}.`,
  );
  if (s.byDay.length) {
    lines.push(`Busiest days in voice: ${[...s.byDay].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([day, ms]) => `${day} ${hm(ms / 60000)}`).join(', ')}.`);
  }
  if (s.perUser.length) {
    lines.push(`Most time in voice: ${s.perUser.slice(0, 12).map((r) => `${r.name || nameOf(r.user)} ${hm(r.total / 60000)} (${r.sessions} stays)`).join(', ')}.`);
  }
  return lines;
}

/**
 * Everyone in the server with when they were last seen, quietest first.
 * Members only — someone who left is not inactive, they are gone.
 */
async function memberLines(guild, nameOf) {
  const d = dataFor(guild.id);
  const members = await guild.members.fetch().catch(() => guild.members.cache);
  const { voiceStats } = hasFeature(guild.id, 'voiceLog') ? require('./voiceLog') : {};
  const lastVoice = voiceStats ? voiceStats(guild.id, KEEP_DAYS).lastSeen : {};
  const now = Date.now();
  const d0 = d.backfilled ? BACKFILL_DAYS : 0;
  const rows = [];
  for (const m of members.values()) {
    if (m.user.bot) continue;
    const u = d.users[m.id] || {};
    const seen = Math.max(u.lastMessage || 0, lastVoice[m.id] || 0, u.lastOnline || 0, u.lastPlayed?.at || 0);
    rows.push({
      seen,
      line: `${m.displayName}: last message ${ago(u.lastMessage, now)}${u.lastChannel ? ` (#${u.lastChannel})` : ''}`
        + `, last in voice ${ago(lastVoice[m.id], now)}, last online ${ago(u.lastOnline, now)}`
        + `${u.lastPlayed ? `, last played ${u.lastPlayed.name} ${ago(u.lastPlayed.at, now)}` : ''}`
        + `, joined the server ${ago(m.joinedTimestamp, now)}`,
    });
  }
  rows.sort((a, b) => a.seen - b.seen);
  const header = `Every member (${rows.length}), quietest first. "never" for messages means none in the `
    + `${d0 ? `last ${d0} days that were read back, or since` : 'time since tracking began'}; `
    + 'online and game tracking only began recently, so "never" there means not since then.';
  return [header, ...rows.slice(0, 80).map((r) => `- ${r.line}`)];
}

/** One person, for when they are asked about by name. */
function personLines(guild, ids, nameOf) {
  const d = dataFor(guild.id);
  const { voiceStats } = hasFeature(guild.id, 'voiceLog') ? require('./voiceLog') : {};
  const vs = voiceStats ? voiceStats(guild.id, 30) : null;
  const now = Date.now();
  const lines = [];
  for (const id of ids) {
    const u = d.users[id];
    if (!u) continue;
    let msgs30 = 0;
    const games = {};
    for (const [, b] of recentDays(guild.id, 30)) {
      msgs30 += b.msgs?.[id] || 0;
      for (const [game, players] of Object.entries(b.games || {})) {
        if (players[id]) games[game] = (games[game] || 0) + players[id];
      }
    }
    const voice = vs?.perUser.find((r) => r.user === id);
    const playing = Object.entries(u.playing || {}).map(([g, s]) => `${s.verb || 'playing'} ${g} for ${hm((now - s.since) / 60000)}`);
    lines.push(
      `${nameOf(id)}: ${msgs30} messages in the last 30 days, last one ${ago(u.lastMessage, now)}${u.lastChannel ? ` in #${u.lastChannel}` : ''}; `
      + `voice ${voice ? `${hm(voice.total / 60000)} over ${voice.sessions} stays` : 'none logged'}; `
      + `last online ${ago(u.lastOnline, now)}`
      + (playing.length ? `; right now ${playing.join(', ')}` : '')
      + (Object.keys(games).length ? `; games: ${top(games, 5).map(([g, m]) => `${g} ${hm(m)}`).join(', ')}` : '')
      + (u.lastPlayed && !playing.length ? `; last played ${u.lastPlayed.name} ${ago(u.lastPlayed.at, now)}` : ''),
    );
  }
  return lines;
}

/** Words that mean the question is about who has been doing what. */
const ACTIVITY_WORDS = /\b(activ\w*|inactiv\w*|vc|voice|in (?:the )?call|busiest|busy|online|offline|last seen|playing|played|plays|what games?|which games?|lurk\w*|quiet\w*|chatty|talk(?:s|ed|ing)? the most|most messages|who'?s on|on right now|leaderboard|stats|up to lately|been up to|ghost\w*|dead chat)\b/i;
const MEMBER_WORDS = /\b(inactiv\w*|last seen|lurk\w*|ghost\w*|quiet\w*|haven'?t (?:been|talked|spoken)|hasn'?t (?:been|talked|spoken)|not been around|missing|purge|prune|who (?:never|doesn'?t|don'?t))\b/i;

/**
 * The facts block, when the question is about activity. Empty otherwise: it
 * is long, and most questions are not about who has been around.
 */
async function activityFacts(guild, question) {
  if (!guild || !enabled(guild.id)) return [];
  const text = String(question || '');
  const d = dataFor(guild.id);
  const nameOf = (id) => guild.members.cache.get(id)?.displayName || d.users[id]?.name || 'someone';

  // Anyone named in the question gets their own line, whatever the wording.
  const lower = text.toLowerCase();
  const named = Object.entries(d.users)
    .filter(([id, u]) => {
      const names = [u.name, guild.members.cache.get(id)?.displayName, guild.members.cache.get(id)?.user?.username]
        .filter((n) => n && n.length > 2).map((n) => n.toLowerCase());
      return names.some((n) => lower.includes(n));
    })
    .map(([id]) => id)
    .slice(0, 5);

  const asked = ACTIVITY_WORDS.test(text);
  if (!asked && !named.length) return [];

  const lines = [];
  if (asked) {
    lines.push(...voiceLines(guild, 30, nameOf));
    lines.push(...chatLines(guild.id, 30, nameOf));
    lines.push(...gameLines(guild.id, 30, nameOf));
    if (MEMBER_WORDS.test(text)) lines.push(...await memberLines(guild, nameOf));
  }
  if (named.length) lines.push(...personLines(guild, named, nameOf));
  return lines;
}

module.exports = {
  onMessage,
  onPresence,
  startActivity,
  flushAll,
  activityFacts,
  // For tests.
  _dataFor: dataFor,
  _reset: () => { state.clear(); dirty.clear(); },
  ACTIVITY_WORDS,
  MEMBER_WORDS,
};
