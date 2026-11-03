'use strict';
/**
 * Who was in voice, and when.
 *
 * Every join, leave and move between voice channels is appended to
 * data/voice-log/<guildId>.jsonl, one line each, and staff read it back with
 * /vclog. Where a guild names `voiceLog.channel`, each one is also posted there
 * as it happens. Mutes, deafens, streams and cameras are not logged: the
 * question this answers is who was there, not what they were doing.
 *
 * Who is in voice right now, and since when, is kept in data/voice-log/open.json
 * so that a restart does not lose it. Discord sends nothing for what happened
 * while the bot was down, so at startup the two are compared:
 *
 *   Somebody we had in voice who is gone now left while we were down. Their
 *   leave is logged at the last time the bot is known to have been running,
 *   which a heartbeat keeps within a few minutes, and marked approximate.
 *
 *   Somebody in voice we had no record of joined while we were down, or was
 *   already there the first time this ran. Their join is logged at startup,
 *   also marked approximate.
 *
 * Bots are not logged, the music player included.
 */
const fs = require('fs');
const path = require('path');
const { getGuildConfig, guildIds, hasFeature } = require('../config/guilds');
const { jsonFile, writeFileAtomic } = require('../storage/jsonFile');
const { partsIn } = require('../utils/time');

const DIR = path.join(__dirname, '..', '..', 'data', 'voice-log');
const DAY_MS = 24 * 60 * 60 * 1000;

/** How often the bot writes down that it is still running. */
const HEARTBEAT_MS = 5 * 60 * 1000;

/** Joins and leaves posted to the log channel are gathered for this long, so ten people leaving at once is one message, not ten. */
const FLUSH_MS = 3000;

const openStore = jsonFile(path.join(DIR, 'open.json'), { empty: () => ({ alive: null, guilds: {} }) });

/** { alive: ms|null, guilds: { [guildId]: { [userId]: { since, channelId, channelName, name } } } } */
let open = null;
/** Events are ignored until startup has compared what we had with what Discord has. */
let reconciled = false;

const enabled = (guildId) => hasFeature(guildId, 'voiceLog');
const logFile = (guildId) => path.join(DIR, `${guildId}.jsonl`);

function loadOpen() {
  if (!open) {
    try {
      open = openStore.read();
    } catch (err) {
      console.warn(`[VoiceLog] Could not read who was in voice: ${err?.message || err}`);
      open = {};
    }
    if (!open.guilds || typeof open.guilds !== 'object') open.guilds = {};
  }
  return open;
}

function saveOpen() {
  try {
    openStore.write(loadOpen());
  } catch (err) {
    console.warn(`[VoiceLog] Could not save who is in voice: ${err?.message || err}`);
  }
}

const openFor = (guildId) => (loadOpen().guilds[guildId] ||= {});

function append(guildId, entry) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(logFile(guildId), `${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.warn(`[VoiceLog] Could not write to the log: ${err?.message || err}`);
  }
}

/**
 * Every entry for a guild from `sinceMs` on, oldest first. A line that will not
 * parse (the last one, cut short by a crash mid-write) is skipped.
 */
function readLog(guildId, sinceMs = 0) {
  let text;
  try {
    text = fs.readFileSync(logFile(guildId), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.t >= sinceMs) out.push(e);
    } catch { /* torn line */ }
  }
  return out;
}

/** Drop entries older than the guild's `keepDays`. Run at startup and once a day. */
function prune(guildId) {
  const keepDays = getGuildConfig(guildId)?.voiceLog?.keepDays || 90;
  const cutoff = Date.now() - keepDays * DAY_MS;
  const all = readLog(guildId);
  const kept = all.filter((e) => e.t >= cutoff);
  if (kept.length === all.length) return;
  try {
    writeFileAtomic(logFile(guildId), kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
    console.log(`[VoiceLog] Dropped ${all.length - kept.length} entr${all.length - kept.length === 1 ? 'y' : 'ies'} older than ${keepDays} days.`);
  } catch (err) {
    console.warn(`[VoiceLog] Could not prune the log: ${err?.message || err}`);
  }
}

// --- Formatting ------------------------------------------------------------

/** "2h 14m", "14m", "under a minute". */
function duration(ms) {
  if (ms == null || ms < 0) return null;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'under a minute';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Discord renders this in whoever is reading it's own time zone. */
const stamp = (ms, style = 't') => `<t:${Math.floor(ms / 1000)}:${style}>`;

/** Strip markdown so a name like `*bob*` cannot restyle the line it is in. */
const clean = (s) => String(s ?? 'unknown').replace(/([*_`~|\\>])/g, '\\$1');

/** One event as a log line, without its time. */
function describe(e) {
  const who = `**${clean(e.name)}**`;
  if (e.type === 'join') {
    return e.approx
      ? `📥 ${who} was in **${clean(e.chName)}** when I came back online`
      : `📥 ${who} joined **${clean(e.chName)}**`;
  }
  if (e.type === 'move') {
    return `🔀 ${who} moved **${clean(e.fromName)}** → **${clean(e.chName)}**`;
  }
  const how = e.approx ? ' while I was offline' : '';
  const dur = duration(e.dur);
  return `📤 ${who} left **${clean(e.chName)}**${how}${dur ? ` · ${dur}` : ''}`;
}

// --- The log channel ---------------------------------------------------------

/** guildId -> { lines: string[], timer } */
const pending = new Map();
/** Guilds already warned about an unusable log channel, so the warning is not repeated per event. */
const warnedChannel = new Set();

function post(client, guildId, entry) {
  const channelId = getGuildConfig(guildId)?.voiceLog?.channel;
  if (!channelId || !client) return;
  let p = pending.get(guildId);
  if (!p) {
    p = { lines: [], timer: null };
    pending.set(guildId, p);
  }
  // A late or approximate entry says when; a live one is as old as the message.
  p.lines.push(entry.approx ? `${describe(entry)} (around ${stamp(entry.t)})` : describe(entry));
  if (!p.timer) p.timer = setTimeout(() => flush(client, guildId, channelId), FLUSH_MS);
}

async function flush(client, guildId, channelId) {
  const p = pending.get(guildId);
  pending.delete(guildId);
  if (!p?.lines.length) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    if (!warnedChannel.has(guildId)) {
      warnedChannel.add(guildId);
      console.warn(`[VoiceLog] voiceLog.channel ${channelId} is not a text channel I can see; not posting there.`);
    }
    return;
  }

  // Discord's limit is 2,000 characters a message.
  const chunks = [];
  let current = '';
  for (const line of p.lines) {
    if (current && current.length + line.length + 1 > 1900) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);

  for (const content of chunks) {
    await channel.send({ content, allowedMentions: { parse: [] } }).catch((err) =>
      console.warn(`[VoiceLog] Could not post to the log channel: ${err?.message || err}`));
  }
}

// --- Recording ---------------------------------------------------------------

function record(client, guildId, entry) {
  append(guildId, entry);
  post(client, guildId, entry);
}

/** Wired to Events.VoiceStateUpdate. */
function onVoiceStateUpdate(oldState, newState) {
  if (!reconciled) return;
  const guild = newState.guild || oldState.guild;
  if (!guild || !enabled(guild.id)) return;

  const member = newState.member || oldState.member;
  if (!member || member.user?.bot) return;

  const before = oldState.channelId;
  const after = newState.channelId;
  if (before === after) return; // mute, deafen, stream or camera

  const now = Date.now();
  const sessions = openFor(guild.id);
  const name = member.displayName || member.user?.username;
  const s = sessions[member.id];
  // The channel is read now, while it is still cached: an empty voice room is
  // deleted the moment its last person leaves.
  const beforeName = oldState.channel?.name || s?.channelName || 'a channel since deleted';
  const afterName = newState.channel?.name || null;

  if (!before && after) {
    sessions[member.id] = { since: now, channelId: after, channelName: afterName, name };
    record(newState.client, guild.id, { t: now, type: 'join', user: member.id, name, ch: after, chName: afterName });
  } else if (before && !after) {
    delete sessions[member.id];
    record(oldState.client, guild.id, {
      t: now, type: 'leave', user: member.id, name, ch: before, chName: beforeName,
      dur: s ? now - s.since : null,
    });
  } else {
    sessions[member.id] = { since: s?.since ?? now, channelId: after, channelName: afterName, name };
    record(newState.client, guild.id, {
      t: now, type: 'move', user: member.id, name, ch: after, chName: afterName, from: before, fromName: beforeName,
    });
  }

  loadOpen().alive = now;
  saveOpen();
}

/**
 * Compare who we had in voice with who Discord says is there, log the
 * difference, and start the heartbeat. Called once, from ClientReady.
 */
async function startVoiceLog(client) {
  const state = loadOpen();
  const now = Date.now();
  const lastAlive = state.alive || null;

  for (const guildId of guildIds()) {
    if (!enabled(guildId)) {
      delete state.guilds[guildId];
      continue;
    }
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    prune(guildId);

    const sessions = openFor(guildId);
    const inVoice = new Map();
    for (const vs of guild.voiceStates.cache.values()) {
      if (!vs.channelId) continue;
      const member = vs.member || await guild.members.fetch(vs.id).catch(() => null);
      if (!member || member.user.bot) continue;
      inVoice.set(vs.id, { vs, member });
    }

    for (const [userId, s] of Object.entries(sessions)) {
      if (inVoice.has(userId)) continue;
      const at = Math.max(s.since, lastAlive || s.since);
      record(client, guildId, {
        t: at, type: 'leave', user: userId, name: s.name, ch: s.channelId, chName: s.channelName,
        dur: at - s.since, approx: true,
      });
      delete sessions[userId];
    }

    for (const [userId, { vs, member }] of inVoice) {
      const name = member.displayName || member.user.username;
      const chName = vs.channel?.name || null;
      const s = sessions[userId];
      if (!s) {
        sessions[userId] = { since: now, channelId: vs.channelId, channelName: chName, name };
        record(client, guildId, { t: now, type: 'join', user: userId, name, ch: vs.channelId, chName, approx: true });
      } else if (s.channelId !== vs.channelId) {
        // Moved while we were down. When is not known, so it is not logged as a
        // move; the session just carries on in the channel they are in now.
        Object.assign(s, { channelId: vs.channelId, channelName: chName, name });
      }
    }
    console.log(`[VoiceLog] ${guild.name}: ${inVoice.size} in voice at startup.`);
  }

  state.alive = now;
  saveOpen();
  reconciled = true;

  setInterval(() => {
    loadOpen().alive = Date.now();
    saveOpen();
  }, HEARTBEAT_MS).unref?.();

  setInterval(() => {
    for (const guildId of guildIds()) if (enabled(guildId)) prune(guildId);
  }, DAY_MS).unref?.();
}

// --- Reading it back -------------------------------------------------------------

/**
 * Sessions rebuilt from the log: one per stay in voice, from join to leave,
 * with every channel visited in between. `end` is null for someone still in.
 */
function sessionsFor(guildId) {
  const live = openFor(guildId);
  const current = new Map();
  const done = [];

  for (const e of readLog(guildId)) {
    let s = current.get(e.user);
    if (e.type === 'join') {
      if (s) done.push({ ...s, end: e.t, endApprox: true }); // a leave we never saw
      current.set(e.user, { user: e.user, name: e.name, start: e.t, end: null, channels: [e.chName], approx: !!e.approx });
    } else if (e.type === 'move') {
      if (!s) {
        s = { user: e.user, name: e.name, start: e.t, end: null, channels: [e.fromName], approx: true };
        current.set(e.user, s);
      }
      if (s.channels[s.channels.length - 1] !== e.chName) s.channels.push(e.chName);
      s.name = e.name || s.name;
    } else if (e.type === 'leave') {
      if (!s) {
        // Joined before the log begins: the leave says how long they had been in.
        s = { user: e.user, name: e.name, start: e.dur != null ? e.t - e.dur : e.t, channels: [e.chName], approx: e.dur == null };
      }
      done.push({ ...s, name: e.name || s.name, end: e.t, endApprox: !!e.approx });
      current.delete(e.user);
    }
  }

  // Anyone the log still has in voice is either still there, or the log lost
  // their leave; the open record decides which.
  const now = Date.now();
  for (const s of current.values()) {
    done.push(live[s.user] ? s : { ...s, end: now, endApprox: true });
  }
  return done.sort((a, b) => a.start - b.start);
}

/** Time in voice within [from, now], per session. */
const timeWithin = (s, from, now) => Math.max(0, (s.end ?? now) - Math.max(s.start, from));

/** "Tue Oct 28" in the guild's own zone. */
function dayLabel(ms, timeZone) {
  const p = partsIn(new Date(ms), timeZone);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][p.weekday];
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][p.month - 1];
  return `${day} ${month} ${p.day}`;
}
const dayKey = (ms, timeZone) => {
  const p = partsIn(new Date(ms), timeZone);
  return `${p.year}-${p.month}-${p.day}`;
};

/**
 * Keep as many of `lines` as fit in an embed description, dropping from the
 * front (the oldest) and saying how many went.
 */
function fit(lines, limit = 3900) {
  const out = [...lines];
  let dropped = 0;
  while (out.length && out.join('\n').length > limit) {
    out.shift();
    dropped++;
  }
  if (dropped) out.unshift(`*…and ${dropped} earlier line${dropped === 1 ? '' : 's'}*`);
  return out.join('\n');
}

/** Who is in voice now, by channel. */
function nowLines(guild) {
  const sessions = openFor(guild.id);
  const byChannel = new Map();
  for (const vs of guild.voiceStates.cache.values()) {
    if (!vs.channelId || vs.member?.user?.bot) continue;
    const list = byChannel.get(vs.channelId) || [];
    list.push(vs);
    byChannel.set(vs.channelId, list);
  }
  const lines = [];
  for (const [channelId, states] of byChannel) {
    lines.push(`🔊 **${clean(guild.channels.cache.get(channelId)?.name || 'unknown channel')}**`);
    for (const vs of states) {
      const s = sessions[vs.id];
      const name = vs.member?.displayName || s?.name || vs.id;
      lines.push(`- **${clean(name)}**${s ? ` · in voice since ${stamp(s.since)} (${stamp(s.since, 'R')})` : ''}`);
    }
  }
  return lines;
}

/** Every join, leave and move in the last `hours`, grouped by day. */
function recentLines(guildId, hours) {
  const timeZone = getGuildConfig(guildId)?.timeZone || 'America/Chicago';
  const lines = [];
  let lastDay = null;
  for (const e of readLog(guildId, Date.now() - hours * 60 * 60 * 1000)) {
    const key = dayKey(e.t, timeZone);
    if (key !== lastDay) {
      lines.push(`**${dayLabel(e.t, timeZone)}**`);
      lastDay = key;
    }
    lines.push(`${stamp(e.t)} ${describe(e)}`);
  }
  return lines;
}

/** One person's stays in voice over the last `days`, newest first. */
function userSummary(guildId, userId, days) {
  const timeZone = getGuildConfig(guildId)?.timeZone || 'America/Chicago';
  const now = Date.now();
  const from = now - days * DAY_MS;
  const mine = sessionsFor(guildId).filter((s) => s.user === userId && (s.end ?? now) >= from);
  const total = mine.reduce((sum, s) => sum + timeWithin(s, from, now), 0);

  const lines = mine.reverse().map((s) => {
    const until = s.end == null ? 'now' : `${s.endApprox ? '~' : ''}${stamp(s.end)}`;
    const where = s.channels.filter(Boolean).map(clean).join(' → ') || 'unknown channel';
    const dur = duration((s.end ?? now) - s.start);
    return `**${dayLabel(s.start, timeZone)}** · ${s.approx ? '~' : ''}${stamp(s.start)} – ${until} · ${dur} · ${where}`;
  });
  return { sessions: mine.length, total, lines };
}

/** Everyone ranked by time in voice over the last `days`. */
function leaderboard(guildId, days) {
  const now = Date.now();
  const from = now - days * DAY_MS;
  const byUser = new Map();
  for (const s of sessionsFor(guildId)) {
    const ms = timeWithin(s, from, now);
    if (!ms) continue;
    const row = byUser.get(s.user) || { user: s.user, name: s.name, total: 0, sessions: 0 };
    row.total += ms;
    row.sessions += 1;
    row.name = s.name || row.name;
    byUser.set(s.user, row);
  }
  return [...byUser.values()].sort((a, b) => b.total - a.total);
}

/**
 * Voice time over the last `days`, for him to answer from: by weekday and by
 * day in the guild's zone, per person, and when each person was last in voice.
 * `since` is when the log begins, so he can say how far back it goes.
 */
function voiceStats(guildId, days) {
  const timeZone = getGuildConfig(guildId)?.timeZone || 'America/Chicago';
  const now = Date.now();
  const from = now - days * DAY_MS;
  const byWeekday = Array(7).fill(0);
  const byDay = new Map();
  const lastSeen = {};
  const sessions = sessionsFor(guildId);
  for (const s of sessions) {
    const end = s.end ?? now;
    lastSeen[s.user] = Math.max(lastSeen[s.user] || 0, end);
    // An hour at a time, so a night that runs past midnight lands on both days.
    for (let t = Math.max(s.start, from); t < end; t += 60 * 60 * 1000) {
      const slice = Math.min(60 * 60 * 1000, end - t);
      byWeekday[partsIn(new Date(t), timeZone).weekday] += slice;
      const label = dayLabel(t, timeZone);
      byDay.set(label, (byDay.get(label) || 0) + slice);
    }
  }
  const first = readLog(guildId)[0];
  return {
    since: first ? first.t : null,
    byWeekday,
    byDay: [...byDay.entries()],
    perUser: leaderboard(guildId, days),
    lastSeen,
  };
}

module.exports = {
  onVoiceStateUpdate,
  voiceStats,
  startVoiceLog,
  nowLines,
  recentLines,
  userSummary,
  leaderboard,
  duration,
  fit,
  clean,
  // For tests.
  _sessionsFor: sessionsFor,
  _readLog: readLog,
  _reset: () => { open = null; reconciled = false; },
  _setReconciled: (v) => { reconciled = v; },
};
