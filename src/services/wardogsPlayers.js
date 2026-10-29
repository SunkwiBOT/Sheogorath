'use strict';
/**
 * How many people are playing WARDOGS, for /players: Steam's own count of
 * players in the game right now (ISteamUserStats/GetNumberOfCurrentPlayers,
 * public, no key), read every ten minutes and kept, so it can be drawn.
 *
 * Steam only ever answers "now", so the history is the bot's own. The first
 * time it runs it is backfilled once from Steam Charts, which has kept the
 * same Steam number hourly for the last month and daily before that, so the
 * graph has something to show from day one. Steam Charts has no robots.txt
 * and serves the history as a plain JSON file for its own charts.
 *
 * Kept in data/wardogs-players.json: the last eight days of readings, enough
 * for the 24-hour and 7-day graphs, and each UTC day's peak for good.
 */
const path = require('path');
const axios = require('axios');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { guildIds, hasFeature } = require('../config/guilds');
const { jsonFile } = require('../storage/jsonFile');
const { renderLineChart } = require('../utils/lineChart');

const APP_ID = 1867240;
const CURRENT_URL = 'https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/';
const HISTORY_URL = `https://steamcharts.com/app/${APP_ID}/chart-data.json`;
const UA = 'Sheogorath/1.0 (Discord bot)';
const SAMPLE_MINUTES = 10;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const KEEP_MS = 8 * DAY_MS;
// A reading this fresh answers /players without asking Steam again.
const FRESH_MS = 5 * 60 * 1000;
const BLUE = 0x3987e5;
const LINE = '#3987e5';
const CHART_FILE = 'wardogs-players.png';

const store = jsonFile(path.join(__dirname, '../../data/wardogs-players.json'), {
  empty: () => ({ samples: [], days: {}, backfilled: null }),
});

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (n) => Math.round(n).toLocaleString('en-US');
const unix = (ms) => Math.floor(ms / 1000);

function compactNumber(n) {
  const trim = (v) => String(Number(v.toFixed(2)));
  if (n >= 1e6) return `${trim(n / 1e6)}M`;
  if (n >= 1e3) return `${trim(n / 1e3)}K`;
  return String(Math.round(n));
}

function read() {
  const data = store.read();
  return {
    samples: Array.isArray(data.samples) ? data.samples : [],
    days: data.days && typeof data.days === 'object' ? data.days : {},
    backfilled: data.backfilled || null,
  };
}

// Zero is Steam (or Steam Charts) missing a reading, not a game of 100,000
// emptying for an hour: one sat in Steam Charts' history on 2026-10-26.
const validCount = (n) => Number.isInteger(n) && n > 0 && n < 1e8;

/** Fold readings into the store: each kept if recent, and every one counted toward its day's peak. */
function addReadings(data, readings) {
  const cutoff = Date.now() - KEEP_MS;
  const byTime = new Map(data.samples.map(([t, n]) => [t, n]));
  for (const [t, n] of readings) {
    if (!Number.isFinite(t) || !validCount(n)) continue;
    const day = utcDay(t);
    data.days[day] = Math.max(data.days[day] || 0, n);
    if (t >= cutoff) byTime.set(t, n);
  }
  data.samples = [...byTime].filter(([t]) => t >= cutoff).sort((a, b) => a[0] - b[0]);
  return data;
}

async function fetchCurrent() {
  const res = await axios.get(CURRENT_URL, {
    params: { appid: APP_ID },
    timeout: 15000,
    headers: { 'User-Agent': UA },
  });
  const r = res.data?.response;
  if (r?.result !== 1 || !validCount(r.player_count)) throw new Error(`Steam answered ${JSON.stringify(res.data).slice(0, 120)}`);
  return r.player_count;
}

/** One reading from Steam, kept. Returns [time, count]. */
async function sample() {
  const at = Date.now();
  const count = await fetchCurrent();
  store.write(addReadings(read(), [[at, count]]));
  return [at, count];
}

let backfillTried = 0;

/** Steam Charts' history, once. Tried again at most every six hours until it works. */
async function backfill() {
  if (read().backfilled || Date.now() - backfillTried < 6 * HOUR_MS) return;
  backfillTried = Date.now();
  try {
    const res = await axios.get(HISTORY_URL, { timeout: 20000, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const points = Array.isArray(res.data) ? res.data.filter((p) => Array.isArray(p) && p.length === 2) : [];
    if (points.length < 2) throw new Error(`only ${points.length} point(s)`);
    const data = addReadings(read(), points.map(([t, n]) => [Number(t), Number(n)]));
    data.backfilled = Date.now();
    store.write(data);
    console.log(`[WardogsPlayers] Backfilled ${points.length} point(s) from Steam Charts, back to ${utcDay(points[0][0])}.`);
  } catch (err) {
    console.warn(`[WardogsPlayers] Steam Charts backfill failed: ${err?.response?.status || ''} ${err?.message || err}`);
  }
}

/** The latest reading, asking Steam when the last one is older than five minutes. */
async function now() {
  const last = read().samples.at(-1);
  if (last && Date.now() - last[0] <= FRESH_MS) return { at: last[0], count: last[1] };
  try {
    const [at, count] = await sample();
    return { at, count };
  } catch (err) {
    console.warn(`[WardogsPlayers] Steam failed: ${err?.message || err}`);
    if (last) return { at: last[0], count: last[1], stale: true };
    throw err;
  }
}

/** The hour, minute and weekday a moment reads as in a time zone. */
function localParts(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour), minute: Number(parts.minute), weekday: parts.weekday };
}

/** Labels on the hours whose local clock `pick` accepts, named by `name`. */
function hourTicks(start, endMs, timeZone, pick, name) {
  const ticks = [];
  for (let t = Math.ceil(start / HOUR_MS) * HOUR_MS; t <= endMs; t += HOUR_MS) {
    const p = localParts(t, timeZone);
    // Zones a half hour off UTC never land on :00 here, and get no labels.
    if (p.minute === 0 && pick(p)) ticks.push({ t, label: name(t, p) });
  }
  return ticks;
}

const RANGES = ['day', 'week', 'month', 'all'];

/** What the graph shows, said under the count. */
function graphNote(range, data, zone) {
  if (range === 'day') return `Graph: the last 24 hours, in ${zone}.`;
  if (range === 'week') return `Graph: the last 7 days, the busiest reading of each hour, in ${zone}.`;
  if (range === 'month') return "Graph: each day's peak over the last 30 days (UTC days), today's so far.";
  const first = Object.keys(data.days).sort()[0];
  const since = first ? new Date(`${first}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }) : 'the start';
  return `Graph: each day's peak since ${since}, the first day on record (UTC days), today's so far.`;
}

/** The points and x-axis labels for a range, in the guild's time zone. */
function series(data, range, timeZone, at) {
  if (range === 'day' || range === 'week') {
    const start = at - (range === 'day' ? DAY_MS : 7 * DAY_MS);
    let points = data.samples.filter(([t]) => t >= start).map(([t, n]) => ({ t, value: n }));
    if (range === 'week') {
      // The busiest reading of each hour: a week of ten-minute readings is
      // more points than the graph has pixels.
      const hours = new Map();
      for (const p of points) {
        const h = Math.floor(p.t / HOUR_MS) * HOUR_MS;
        if (!hours.has(h) || p.value > hours.get(h).value) hours.set(h, { t: h, value: p.value });
      }
      points = [...hours.values()];
      const last = data.samples.at(-1);
      if (last && points.length) points[points.length - 1] = { t: last[0], value: last[1] };
    }
    const fmtHour = (t) => new Date(t).toLocaleTimeString('en-US', { timeZone, hour: 'numeric' });
    // A day's name sits at its noon, in the middle of the day it names.
    const ticks = range === 'day'
      ? hourTicks(start, at, timeZone, (p) => p.hour % 4 === 0, (t) => fmtHour(t))
      : hourTicks(start, at, timeZone, (p) => p.hour === 12, (t, p) => p.weekday);
    return { points, ticks };
  }
  let days = Object.entries(data.days).sort(([a], [b]) => (a < b ? -1 : 1));
  if (range === 'month') days = days.filter(([d]) => d >= utcDay(at - 29 * DAY_MS));
  const label = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  return { points: days.map(([d, n]) => ({ label: label(d), value: n })), ticks: null };
}

const peakSince = (samples, since) => samples.filter(([t]) => t >= since).reduce((a, b) => (!a || b[1] > a[1] ? b : a), null);

function change(nowCount, then) {
  if (nowCount === then) return 'No change';
  const pct = ((nowCount - then) / then) * 100;
  return `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%`;
}

/** The /players reply: the count now, how it compares, and a graph of `range`. */
async function playersMessage({ range = 'week', timeZone = 'UTC' } = {}) {
  if (!RANGES.includes(range)) range = 'week';
  await backfill();
  const live = await now();
  const data = read();
  const at = live.at;

  const lines = [];
  // The reading nearest this time yesterday, if there is one within half an hour of it.
  const target = at - DAY_MS;
  const yesterday = data.samples.reduce((a, b) => (!a || Math.abs(b[0] - target) < Math.abs(a[0] - target) ? b : a), null);
  if (yesterday && Math.abs(yesterday[0] - target) <= 30 * 60 * 1000) {
    lines.push(`${change(live.count, yesterday[1])} on this time yesterday (${num(yesterday[1])})`);
  }
  const zone = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')?.value || timeZone;
  lines.push(graphNote(range, data, zone));
  if (live.stale) lines.push(`-# Steam didn't answer just now. This is from <t:${unix(at)}:R>.`);

  const day = peakSince(data.samples, at - DAY_MS);
  const week = peakSince(data.samples, at - 7 * DAY_MS);
  const best = Object.entries(data.days).reduce((a, b) => (!a || b[1] > a[1] ? b : a), null);

  const embed = new EmbedBuilder()
    .setColor(BLUE)
    .setAuthor({ name: 'WARDOGS on Steam' })
    .setTitle(`${num(live.count)} playing now`)
    .setURL(`https://steamcharts.com/app/${APP_ID}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Steam's own count, read every ${SAMPLE_MINUTES} minutes. Earlier history from Steam Charts.` });
  const fields = [];
  if (day) fields.push({ name: '24-hour peak', value: `${num(day[1])} · <t:${unix(day[0])}:R>`, inline: true });
  if (week) fields.push({ name: '7-day peak', value: `${num(week[1])} · <t:${unix(week[0])}:R>`, inline: true });
  if (best) {
    const when = new Date(`${best[0]}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
    fields.push({ name: 'Highest day', value: `${num(best[1])} · ${when}`, inline: true });
  }
  if (fields.length) embed.addFields(fields);

  const files = [];
  const { points, ticks } = series(data, range, timeZone, at);
  if (points.length >= 2) {
    try {
      const png = renderLineChart(points, { color: LINE, tick: compactNumber, end: num, ticks });
      files.push(new AttachmentBuilder(png, { name: CHART_FILE }));
      embed.setImage(`attachment://${CHART_FILE}`);
    } catch (err) {
      console.warn(`[WardogsPlayers] Chart failed: ${err?.message || err}`);
    }
  }
  return { embeds: [embed], files };
}

function scheduleWardogsPlayers() {
  const guilds = guildIds().filter((id) => hasFeature(id, 'wardogsPlayers'));
  if (!guilds.length) return;
  const tick = () => sample().catch((err) => console.warn(`[WardogsPlayers] Steam failed: ${err?.message || err}`));
  backfill().finally(tick);
  setInterval(() => { tick(); backfill(); }, SAMPLE_MINUTES * 60 * 1000);
  console.log(`[WardogsPlayers] Reading the WARDOGS player count every ${SAMPLE_MINUTES} minutes for ${guilds.length} guild(s).`);
}

module.exports = {
  scheduleWardogsPlayers,
  playersMessage,
  sample,
  backfill,
  series,
  addReadings,
  compactNumber,
  RANGES,
};
