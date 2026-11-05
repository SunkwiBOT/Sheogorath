'use strict';
/**
 * The game's patch notes, once a day.
 *
 * Every build of Grime & Punishment is published to a public GitHub release
 * under one tag (the one the game updates itself from), and its notes list, as
 * "- " lines, the commits that changed the game since the build before. The
 * release is replaced at each build, so each build's notes have to be read
 * while they are up: build.txt (the build's commit) is checked every two
 * minutes, a plain download that no API limit counts, and only a new build
 * costs an API call. What comes in is kept in state, and at `hour` each day
 * whatever has gathered goes out as one post in `channel`. Builds come several
 * times a day, so one post a day keeps #announcements, and every server
 * following it, readable. The post is his own, so services/autopublish.js
 * publishes it to the followers.
 *
 * A first run takes the build that is up as already seen: nothing old is posted.
 * scripts/post-changelog.js shows what the next post will say.
 */
const { EmbedBuilder } = require('discord.js');
const { getGuildConfig, guildIds } = require('../config/guilds');
const { getGuildState, setGuildState } = require('../storage/state');
const { partsIn } = require('../utils/time');

const TEAL = 0x3fbfb0;      // the game's own teal
const POLL_MS = 2 * 60 * 1000;
const LINE_MAX = 220;       // characters a change is cut to
const BODY_MAX = 3900;      // of an embed description's 4,096
const HEADERS = { 'User-Agent': 'Sheogorath' };
const API_HEADERS = { ...HEADERS, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
// Who asked for a change, which the commit lines say in brackets: kept out of a public post.
const TEAM = /\s*\([^()]*\b(?:Fisher|Billy|Lucas|Gneiss Chalk)\b[^()]*\)/g;

/** The build that is up, as its short commit; null while a new one is going up (for a few seconds there is no release). */
async function currentBuild(cfg) {
  const res = await fetch(`https://github.com/${cfg.repo}/releases/download/${encodeURIComponent(cfg.tag)}/build.txt`, {
    headers: HEADERS, signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`build.txt: HTTP ${res.status}`);
  const sha = (await res.text()).trim();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

/** The changes in a build's notes, newest first as written, and how many more the notes left out. */
function parseNotes(body) {
  const lines = [];
  let more = 0;
  for (const raw of String(body || '').split('\n')) {
    const l = raw.trim();
    const left = /^…and (\d+) more$/.exec(l);
    if (left) more += Number(left[1]);
    else if (l.startsWith('- ') && !l.startsWith('- No changes to the game itself')) lines.push(l.slice(2).trim());
  }
  return { lines, more };
}

/** That build's notes, or null if the release up now is already another build's (try again next time). */
async function buildNotes(cfg, sha) {
  const res = await fetch(`https://api.github.com/repos/${cfg.repo}/releases/tags/${encodeURIComponent(cfg.tag)}`, {
    headers: API_HEADERS, signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`release: HTTP ${res.status}`);
  const rel = await res.json();
  if (!String(rel.body || '').includes(sha)) return null;
  return { sha, at: rel.published_at, ...parseNotes(rel.body) };
}

function tidy(line) {
  let l = line.replace(TEAM, '').replace(/\s+([:;,.])/g, '$1').trim();
  if (l.length > LINE_MAX) l = `${l.slice(0, LINE_MAX - 1).replace(/\s+\S*$/, '')}…`;
  return l;
}

/** The post for a day's builds (oldest first): every change once, in the order they were made. */
function buildPost(builds, dayName) {
  const lines = [...new Set(builds.flatMap((b) => [...b.lines].reverse()).map(tidy).filter(Boolean))];
  let text = '';
  let shown = 0;
  for (const l of lines) {
    const next = `• ${l}\n`;
    if (text.length + next.length > BODY_MAX) break;
    text += next;
    shown += 1;
  }
  const more = builds.reduce((n, b) => n + (b.more || 0), 0) + lines.length - shown;
  if (more) text += `…and ${more} more change${more === 1 ? '' : 's'}.`;
  const newest = builds[builds.length - 1].sha;
  return new EmbedBuilder()
    .setColor(TEAL)
    .setTitle(`🧼 Patch notes: ${dayName}`)
    .setDescription(text.trim())
    .setFooter({
      text: `${builds.length === 1 ? 'Build' : `${builds.length} builds, the newest`} ${newest}. ` +
        'Testers: the game updates itself the next time it starts.',
    });
}

const dayKey = (p) => `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
const dayName = (date, timeZone) => new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(date);

/** Reads a new build's notes into state, if one has gone up. */
async function poll(guildId, cfg) {
  const sha = await currentBuild(cfg);
  if (!sha) return;
  const st = getGuildState(guildId).changelog;
  if (!st) {
    setGuildState(guildId, { changelog: { lastBuild: sha, pending: [], lastPosted: null } });
    console.log(`[Changelog] ${guildId}: starting from build ${sha}; nothing before it is posted.`);
    return;
  }
  if (st.lastBuild === sha) return;
  const notes = await buildNotes(cfg, sha);
  if (!notes) return;
  const keep = notes.lines.length || notes.more;
  setGuildState(guildId, { changelog: { ...st, lastBuild: sha, pending: keep ? [...st.pending, notes] : st.pending } });
  console.log(`[Changelog] ${guildId}: build ${sha}, ${notes.lines.length} change(s)${keep ? ' for the next patch notes' : ''}.`);
}

/** At `hour` each day, posts what has gathered (if anything) and starts afresh. Once a day, even if a restart missed the hour. */
async function postIfDue(client, guildId, cfg) {
  const st = getGuildState(guildId).changelog;
  if (!st) return;
  const { timeZone } = getGuildConfig(guildId);
  const now = new Date();
  const p = partsIn(now, timeZone);
  if (p.hour < cfg.hour || st.lastPosted === dayKey(p)) return;
  if (st.pending.length) {
    const channel = await client.channels.fetch(cfg.channel);
    const embed = buildPost(st.pending, dayName(now, timeZone));
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    console.log(`[Changelog] ${channel.guild?.name || guildId}: posted the patch notes for ${st.pending.length} build(s).`);
  }
  setGuildState(guildId, { changelog: { ...getGuildState(guildId).changelog, pending: [], lastPosted: dayKey(p) } });
}

async function tick(client, guildId) {
  const cfg = getGuildConfig(guildId)?.changelog;
  if (!cfg) return;
  try {
    await poll(guildId, cfg);
  } catch (err) {
    console.warn(`[Changelog] ${guildId}: could not read the build: ${err?.message || err}`);
  }
  try {
    await postIfDue(client, guildId, cfg);
  } catch (err) {
    console.warn(`[Changelog] ${guildId}: could not post the patch notes: ${err?.message || err}`);
  }
}

function scheduleChangelog(client) {
  const guilds = guildIds().filter((id) => getGuildConfig(id)?.changelog);
  if (!guilds.length) return;
  const run = () => { for (const id of guilds) tick(client, id).catch(() => {}); };
  setInterval(run, POLL_MS);
  run();
  console.log(`[Changelog] Gathering patch notes for ${guilds.length} guild(s), posted daily.`);
}

module.exports = { scheduleChangelog, buildPost, parseNotes, tidy, currentBuild, buildNotes, dayName };
