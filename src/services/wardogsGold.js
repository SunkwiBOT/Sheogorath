'use strict';
/**
 * The WARDOGS gold bar price: posted in the guild's channel on each day it
 * moves, pinging its role, and read back any time with /gold.
 *
 * The in-game Gold Exchange sets one cash price per bar a day, turning over at
 * midnight UTC. Bulkhead publishes it nowhere outside the game, and reading it
 * from the game's servers is what got /wardogs switched off (the EULA), so it
 * comes from the community trackers that put it on a public web page: WARDOGS
 * Hub first, WARDOGS Stats when the Hub is down or behind. Both credit the same
 * community data (MetaForge, whose own site refuses bots). On the 50 days they
 * shared when this was written, they agreed on every one.
 *
 * Once a guild has today's price nothing more is fetched until the next
 * midnight UTC. Until then, both pages are read every quarter of an hour.
 * /gold reuses any read up to ten minutes old.
 */
const axios = require('axios');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getGuildConfig, guildIds, hasFeature } = require('../config/guilds');
const { getGuildState, setGuildState } = require('../storage/state');
const { renderLineChart } = require('../utils/lineChart');

const UA = 'Sheogorath/1.0 (Discord bot)';
const POLL_MINUTES = 15;
const CACHE_MS = 10 * 60 * 1000;
// Early access. The Hub's days before it are the closed tests, which were wiped.
const LAUNCH = '2026-09-10';
const GOLD = 0xc98500;
const LINE = '#c98500';
const CHART_FILE = 'wardogs-gold.png';
const DAY_MS = 24 * 3600 * 1000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Clean the scraped points: real dates, positive whole-cash prices, oldest first, one per day. */
function tidy(points) {
  const byDate = new Map();
  for (const p of points) {
    const rate = Math.round(Number(p.rate));
    if (DATE.test(p.date) && Number.isFinite(rate) && rate > 0 && rate < 1e11) byDate.set(p.date, rate);
  }
  return [...byDate].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, rate]) => ({ date, rate }));
}

/** WARDOGS Hub ships the whole series as JSON in a script tag made for it. */
function parseHub(html) {
  const m = /<script[^>]*\bdata-gold-series[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('no data-gold-series block');
  return tidy(JSON.parse(m[1]).map((p) => ({ date: p.date, rate: p.rate })));
}

/** WARDOGS Stats is a Next.js page; its chart's points sit in the page data as {ts, value}. */
function parseStats(html) {
  const text = html.replace(/\\"/g, '"');
  const points = [...text.matchAll(/"ts":(\d{12,14}),"value":(\d+(?:\.\d+)?)/g)]
    .map((m) => ({ date: new Date(Number(m[1])).toISOString().slice(0, 10), rate: Number(m[2]) }));
  if (!points.length) throw new Error('no {ts, value} points');
  return tidy(points);
}

const SOURCES = [
  { name: 'WARDOGS Hub', url: 'https://wardogshub.gg/gold-market/', parse: parseHub },
  { name: 'WARDOGS Stats', url: 'https://wardogstats.app/gold', parse: parseStats },
];

async function readSource(source) {
  const res = await axios.get(source.url, {
    timeout: 20000,
    responseType: 'text',
    headers: { 'User-Agent': UA, Accept: 'text/html' },
  });
  const series = source.parse(String(res.data));
  if (series.length < 2) throw new Error(`only ${series.length} day(s) found`);
  return { source: { name: source.name, url: source.url }, series };
}

let cache = null;
let inFlight = null;

/**
 * Both trackers, read side by side. The one with the later last day wins, and
 * the Hub on a tie. A page whose layout changed fails its own parse rather
 * than handing back nonsense, and the other still answers.
 */
async function fetchGold() {
  const results = await Promise.allSettled(SOURCES.map(readSource));
  const good = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.warn(`[WardogsGold] ${SOURCES[i].name}: ${r.reason?.response?.status || ''} ${r.reason?.message || r.reason}`);
  });
  if (!good.length) throw new Error('Neither gold tracker could be read');

  const best = good.reduce((a, b) => (b.series.at(-1).date > a.series.at(-1).date ? b : a));
  if (good.length === 2) {
    const [a, b] = good.map((g) => g.series.at(-1));
    if (a.date === b.date && a.rate !== b.rate) {
      console.warn(`[WardogsGold] The trackers disagree on ${a.date}: ${a.rate} vs ${b.rate}. Using ${best.source.name}.`);
    }
  }
  return { ...best, at: Date.now() };
}

/**
 * The latest read, fetched again when older than `maxAgeMs`. With `allowStale`
 * a failed fetch falls back to the last good read, however old.
 */
async function readGold({ maxAgeMs = CACHE_MS, allowStale = false } = {}) {
  if (cache && Date.now() - cache.at <= maxAgeMs) return cache;
  inFlight = inFlight || fetchGold().finally(() => { inFlight = null; });
  try {
    cache = await inFlight;
    return cache;
  } catch (err) {
    if (allowStale && cache) return { ...cache, stale: true };
    throw err;
  }
}

const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const shiftDay = (date, days) => utcDay(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const dayLabel = (date, opts = { month: 'short', day: 'numeric' }) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });

function compactMoney(n) {
  const trim = (v) => String(Number(v.toFixed(2)));
  if (n >= 1e6) return `$${trim(n / 1e6)}M`;
  if (n >= 1e3) return `$${trim(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

function change(now, then) {
  if (now === then) return 'No change';
  const pct = ((now - then) / then) * 100;
  return `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%`;
}

/** Today against yesterday and a week ago, and the low and high over `days` (0 means since launch). */
function summarize(series, days) {
  const last = series.at(-1);
  const prev = series.at(-2) || null;
  const weekAgo = series.find((p) => p.date === shiftDay(last.date, -7)) || null;
  const from = days ? shiftDay(last.date, -(days - 1)) : LAUNCH;
  const window = series.filter((p) => p.date >= from);
  // The first day of a tie, as the trackers name it.
  const low = window.reduce((a, b) => (b.rate < a.rate ? b : a));
  const high = window.reduce((a, b) => (b.rate > a.rate ? b : a));
  return { last, prev, weekAgo, window, low, high };
}

/**
 * The embed, with the chart attached, for both the daily post and /gold.
 * `days` is the chart's range (0 for since launch). `bars` adds what that
 * many bars cost today.
 */
function goldMessage(read, { days = 30, bars = null } = {}) {
  const { series, source } = read;
  const s = summarize(series, days);
  const { last, prev, weekAgo, window, low, high } = s;
  const range = days ? `${days} days` : 'since launch';
  const today = utcDay();

  const lines = [];
  if (last.date !== today) {
    lines.push(`The trackers don't have today's rate yet. This is ${dayLabel(last.date)}'s.`);
  }
  if (prev) {
    const when = prev.date === shiftDay(last.date, -1) ? 'since yesterday' : `since ${dayLabel(prev.date)}`;
    lines.push(`${change(last.rate, prev.rate)} ${when} (was ${money(prev.rate)})`);
  }
  if (weekAgo) lines.push(`${change(last.rate, weekAgo.rate)} over 7 days`);
  if (window.length > 2 && last.rate <= low.rate) lines.push(`**The lowest in ${range}.**`);
  else if (window.length > 2 && last.rate >= high.rate) lines.push(`**The highest in ${range}.**`);
  if (last.date === today) {
    const next = Math.floor((Date.parse(`${today}T00:00:00Z`) + DAY_MS) / 1000);
    lines.push(`It holds until midnight UTC, <t:${next}:t> your time (<t:${next}:R>).`);
  }
  if (read.stale) lines.push('-# The trackers could not be reached just now. This is the last read.');

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setAuthor({ name: `WARDOGS Gold Exchange · ${dayLabel(last.date, { weekday: 'long', month: 'long', day: 'numeric' })}` })
    .setTitle(`One gold bar: ${money(last.rate)}`)
    .setURL(source.url)
    .setDescription(lines.join('\n'))
    .addFields(
      { name: `Low (${range})`, value: `${money(low.rate)} · ${dayLabel(low.date)}`, inline: true },
      { name: `High (${range})`, value: `${money(high.rate)} · ${dayLabel(high.date)}`, inline: true },
    )
    .setFooter({ text: `Community data via ${source.name}` });
  if (bars) {
    embed.addFields({ name: `${bars.toLocaleString('en-US')} bar${bars === 1 ? '' : 's'} today`, value: money(bars * last.rate), inline: true });
  }

  const files = [];
  try {
    const png = renderLineChart(
      window.map((p) => ({ label: dayLabel(p.date), value: p.rate })),
      { color: LINE, tick: compactMoney, end: money },
    );
    files.push(new AttachmentBuilder(png, { name: CHART_FILE }));
    embed.setImage(`attachment://${CHART_FILE}`);
  } catch (err) {
    console.warn(`[WardogsGold] Chart failed: ${err?.message || err}`);
  }
  return { embeds: [embed], files };
}

/**
 * One guild's daily post. A guild seeing the price for the first time is
 * seeded quietly, so the first word it gets is a move, not a deploy. A day
 * that didn't move, or one that was missed while the bot was down, is recorded
 * without a post.
 */
async function pollGuild(client, guildId, cfg, read) {
  const seen = getGuildState(guildId).wardogsGoldSeen || null;
  const { series } = read;
  const last = series.at(-1);
  if (seen?.date >= last.date) return;

  const record = () => setGuildState(guildId, { wardogsGoldSeen: { date: last.date, rate: last.rate } });
  const prev = series.at(-2);
  if (!seen) {
    record();
    console.log(`[WardogsGold] ${guildId}: seeded at ${last.date} ${last.rate}, posting from the next move.`);
    return;
  }
  if (last.date !== utcDay()) {
    record();
    console.log(`[WardogsGold] ${guildId}: ${last.date} is not today, recorded without a post.`);
    return;
  }
  if (prev && prev.rate === last.rate) {
    record();
    console.log(`[WardogsGold] ${guildId}: ${last.date} held at ${last.rate}, no post.`);
    return;
  }

  const channel = await client.channels.fetch(cfg.channel).catch(() => null);
  if (!channel) {
    console.warn(`[WardogsGold] ${guildId}: channel ${cfg.channel} is unreachable.`);
    return;
  }
  // Recorded only once it's posted, so a failed send is tried again next poll.
  await channel.send({
    content: cfg.pingRole ? `<@&${cfg.pingRole}>` : undefined,
    ...goldMessage(read, { days: 30 }),
    allowedMentions: cfg.pingRole ? { roles: [cfg.pingRole] } : { parse: [] },
  });
  record();
  console.log(`[WardogsGold] ${guildId}: posted ${last.date} at ${last.rate}.`);
}

function goldGuilds() {
  return guildIds().filter((id) => hasFeature(id, 'wardogsGold') && getGuildConfig(id)?.wardogsGold?.channel);
}

async function pollOnce(client) {
  const today = utcDay();
  const due = goldGuilds().filter((id) => client.guilds.cache.has(id)
    && getGuildState(id).wardogsGoldSeen?.date !== today);
  if (!due.length) return;

  let read;
  try {
    read = await readGold({ maxAgeMs: 5 * 60 * 1000 });
  } catch (err) {
    console.warn(`[WardogsGold] Poll failed: ${err?.message || err}`);
    return;
  }
  for (const guildId of due) {
    try {
      await pollGuild(client, guildId, getGuildConfig(guildId).wardogsGold, read);
    } catch (err) {
      console.warn(`[WardogsGold] ${guildId}: post failed: ${err?.message || err}`);
    }
  }
}

function scheduleWardogsGold(client) {
  const guilds = goldGuilds();
  if (!guilds.length) return;
  setInterval(() => { pollOnce(client).catch(() => {}); }, POLL_MINUTES * 60 * 1000);
  pollOnce(client).catch(() => {});
  console.log(`[WardogsGold] Watching the gold bar price for ${guilds.length} guild(s), every ${POLL_MINUTES} minutes until each day's appears.`);
}

module.exports = {
  scheduleWardogsGold,
  pollOnce,
  pollGuild,
  readGold,
  goldMessage,
  parseHub,
  parseStats,
  summarize,
  compactMoney,
};
