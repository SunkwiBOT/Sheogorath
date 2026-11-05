'use strict';
/**
 * Twitch and Kick drops for the games we play.
 *
 * Neither site offers drops through its official API. Helix has only the
 * entitlement endpoints a game's own developer uses, and Twitch's internal
 * GraphQL lists campaigns only to a signed-in viewer. So Twitch's come from
 * drops.sunkwi.com, a community mirror of the campaign list that
 * needs no key, and Kick's from the endpoint its own drops page reads. Both are
 * undocumented and could change or vanish without notice, so a source that
 * fails is logged and skipped, and the other still posts.
 *
 * "The games we play" are the Steam games gameNews follows, plus any named in
 * `gameNews.drops.games` (a game not on Steam), plus any added in Discord with
 * /drops add. What is added or removed in Discord lives in guild state, laid
 * over config the way the calendar's changes are, so the list never needs a
 * deploy.
 *
 * A game matches a campaign when every word of its name appears, in order, in
 * the campaign's game: "Rust" matches "Rust" and "Rust Console Edition" but not
 * "Rusty Lake", and "Dawn of War IV" matches "Warhammer 40,000: Dawn of War IV".
 *
 * Each campaign is posted once, keyed by its id. What is new for one game on one
 * site goes out as one post: a Rust event is a dozen campaigns, one per pair of
 * streamers, and a dozen posts would bury the channel. Unlike news, nothing is
 * seeded silently. A campaign already running is exactly what is worth knowing,
 * and for a handful of games there are only ever a few.
 */
const axios = require('axios');
const { EmbedBuilder, escapeMarkdown } = require('discord.js');
const { getGuildConfig } = require('../config/guilds');
const { getGuildState, setGuildState } = require('../storage/state');
const { isAdmin } = require('../utils/permissions');

const TWITCH_SOURCE = 'https://drops.sunkwi.com/api/twitch/drops';
const KICK_SOURCE = 'https://web.kick.com/api/v1/drops/campaigns';
const USER_AGENT = 'Sheogorath/1.0 (Discord bot)';
// Shared by every guild's poll and by /drops, so neither source is asked more
// than once in this long however many ask.
const FRESH_MS = 5 * 60 * 1000;
// A post holds this many campaigns before the rest are counted, not listed.
const PER_POST = 10;

const SITES = {
  twitch: { label: 'Twitch', color: 0x9146ff },
  kick: { label: 'Kick', color: 0x53fc18 },
};

const unix = (date) => Math.floor(date.getTime() / 1000);
const validDate = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// --- Reading the two sources ----------------------------------------------------

/** Twitch's campaigns, from the community mirror's per-game groups. */
function fromTwitch(body) {
  const out = [];
  for (const group of Array.isArray(body?.games) ? body.games : []) {
    for (const c of group?.rewards || []) {
      const start = validDate(c?.startAt);
      const end = validDate(c?.endAt);
      if (!c?.id || !start || !end || String(c.status).toUpperCase() === 'EXPIRED') continue;
      const game = c.game?.displayName || group.gameDisplayName;
      if (!game) continue;
      const slug = c.game?.slug;
      out.push({
        key: `twitch:${c.id}`,
        site: 'twitch',
        name: c.name || game,
        game,
        start,
        end,
        // An empty allow list, or one switched off, means any stream of the game.
        channels: c.allow?.isEnabled ? (c.allow.channels || []).map((ch) => ch.displayName || ch.name).filter(Boolean) : [],
        rewards: (c.timeBasedDrops || []).map((d) => ({
          name: (d.benefitEdges || []).map((e) => e.benefit?.name).filter(Boolean).join(', ') || d.name || 'A reward',
          minutes: Number(d.requiredMinutesWatched) || 0,
          subs: Number(d.requiredSubs) || 0,
        })),
        url: `https://www.twitch.tv/drops/campaigns?dropID=${c.id}`,
        watch: slug ? `https://www.twitch.tv/directory/category/${slug}?filter=drops` : null,
        link: /^https:\/\//.test(c.accountLinkURL || '') ? c.accountLinkURL : null,
        about: /^https:\/\//.test(c.detailsURL || '') ? c.detailsURL : null,
        image: /^https:\/\//.test(group.gameBoxArtURL || '') ? group.gameBoxArtURL : null,
      });
    }
  }
  return out;
}

/** Kick's campaigns. One with no category (a Kick-wide giveaway) is for no game. */
function fromKick(body) {
  const out = [];
  for (const c of Array.isArray(body?.data) ? body.data : []) {
    const start = validDate(c?.starts_at);
    const end = validDate(c?.ends_at);
    if (!c?.id || !start || !end || c.status === 'expired' || !c.category?.name) continue;
    const slug = c.category.slug;
    out.push({
      key: `kick:${c.id}`,
      site: 'kick',
      name: c.name || c.category.name,
      game: c.category.name,
      start,
      end,
      channels: (c.channels || []).map((ch) => ch.user?.username || ch.slug).filter(Boolean),
      // Kick counts in minutes watched: Rust's are 120, 240, 360.
      rewards: (c.rewards || []).map((r) => ({ name: r.name || 'A reward', minutes: Number(r.required_units) || 0, subs: 0 })),
      url: 'https://kick.com/drops/campaigns',
      watch: slug ? `https://kick.com/category/${slug}` : null,
      link: /^https:\/\//.test(c.connect_url || '') ? c.connect_url : null,
      about: /^https:\/\//.test(c.url || '') ? c.url : null,
      image: /^https:\/\//.test(c.category.image_url || '') ? c.category.image_url : null,
    });
  }
  return out;
}

const SOURCES = {
  twitch: { url: TWITCH_SOURCE, read: fromTwitch },
  kick: { url: KICK_SOURCE, read: fromKick },
};

// The last good read of each site: what /drops and his knowledge block show,
// and what the poll reuses while it is fresh.
const latest = { twitch: null, kick: null };

async function readSite(site) {
  const have = latest[site];
  if (have && Date.now() - have.at < FRESH_MS) return have.campaigns;
  const res = await axios.get(SOURCES[site].url, { timeout: 20000, headers: { 'User-Agent': USER_AGENT } });
  const campaigns = SOURCES[site].read(res.data);
  latest[site] = { at: Date.now(), campaigns };
  return campaigns;
}

/**
 * Every running or coming campaign on both sites. `failed` names the sites that
 * could not be read, whose campaigns are simply absent this time.
 */
async function allCampaigns() {
  const campaigns = [];
  const failed = [];
  for (const site of Object.keys(SOURCES)) {
    try {
      campaigns.push(...await readSite(site));
    } catch (err) {
      failed.push(site);
      console.warn(`[Drops] ${SITES[site].label}: read failed: ${err?.response?.status || ''} ${err?.message || err}`);
    }
  }
  const now = Date.now();
  return { campaigns: campaigns.filter((c) => c.end.getTime() > now), failed };
}

// --- The games we play ----------------------------------------------------------

/** A name as its words: lower-cased, accents and punctuation gone. */
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
const keyOf = (name) => words(name).join(' ');

/** Whether a campaign for `campaignGame` is one for `gameName`. */
function isFor(gameName, campaignGame) {
  const want = words(gameName);
  const have = words(campaignGame);
  if (!want.length) return false;
  for (let i = 0; i + want.length <= have.length; i++) {
    if (want.every((w, j) => have[i + j] === w)) return true;
  }
  return false;
}

function stateOf(guildId) {
  const saved = getGuildState(guildId).drops || {};
  return { added: saved.added || {}, removed: saved.removed || [], seen: saved.seen || {} };
}

/** Read, change and write the drops record in one synchronous pass. `change` must not await. */
function mutate(guildId, change) {
  const record = stateOf(guildId);
  const result = change(record);
  // A campaign is forgotten a day after it ends; its id never comes back.
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [key, end] of Object.entries(record.seen)) if (end < cutoff) delete record.seen[key];
  setGuildState(guildId, { drops: record });
  return result;
}

/** Config's games for drops: the Steam games, then `drops.games`. */
function configGames(guildId) {
  const news = getGuildConfig(guildId)?.gameNews;
  return [...(news?.steamApps || []).map((g) => g.name), ...(news?.drops?.games || [])];
}

/** The games followed for drops: config's, then those added in Discord, less those removed in Discord. */
function gamesFor(guildId) {
  const { added, removed } = stateOf(guildId);
  const out = new Map();
  const put = (name, by) => {
    const key = keyOf(name);
    if (key && !out.has(key)) out.set(key, { key, name, by: by || null, fromConfig: by === undefined });
  };
  for (const name of configGames(guildId)) put(name, undefined);
  for (const rec of Object.values(added)) put(rec.name, rec.by);
  for (const key of removed) out.delete(key);
  return [...out.values()];
}

/** A followed game by name as people say it: exactly, then as the only one containing it. */
function findGame(guildId, query) {
  const games = gamesFor(guildId);
  const q = keyOf(query);
  if (!q) return null;
  const exact = games.find((g) => g.key === q);
  if (exact) return exact;
  const near = games.filter((g) => g.key.includes(q));
  return near.length === 1 ? near[0] : null;
}

function addGame(guildId, name, member) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const key = keyOf(clean);
  if (!key) throw new Error('give the game its name, as Twitch or Kick has it');
  const already = gamesFor(guildId).find((g) => g.key === key);
  if (already) throw new Error(`${already.name} is already followed`);
  // A config game taken off and put back needs no record of its own.
  const inConfig = configGames(guildId).some((n) => keyOf(n) === key);
  return mutate(guildId, (record) => {
    record.removed = record.removed.filter((k) => k !== key);
    if (!inConfig) record.added[key] = { name: clean, by: member?.id || null, at: Date.now() };
    return { key, name: clean, by: inConfig ? null : member?.id || null, fromConfig: inConfig };
  });
}

/** Take a game off: whoever added it may, and an Owner may take off any. */
function removeGame(guildId, query, member) {
  const game = findGame(guildId, query);
  if (!game) throw new Error(`no followed game is called "${query}"`);
  if (!isAdmin(member) && !(game.by && game.by === member?.id)) {
    throw new Error(game.fromConfig
      ? `${game.name} is on the server's own list, so only an Owner can take it off`
      : `${game.name} was added by someone else, so only they or an Owner can take it off`);
  }
  return mutate(guildId, (record) => {
    delete record.added[game.key];
    if (game.fromConfig) record.removed = [...new Set([...record.removed, game.key])];
    return game;
  });
}

/**
 * Which followed game a campaign is for, or null. When several match, the one
 * naming the most words wins: with "Path of Exile" and "Path of Exile 2" both
 * followed, a Path of Exile 2 campaign is the second's alone.
 */
function gameOf(games, campaign) {
  let best = null;
  for (const g of games) {
    if (isFor(g.name, campaign.game) && (!best || words(g.name).length > words(best.name).length)) best = g;
  }
  return best;
}

// --- Posting ----------------------------------------------------------------------

function needs(reward) {
  if (reward.subs > 0) return `${reward.subs} sub${reward.subs === 1 ? '' : 's'}`;
  if (!reward.minutes) return 'just for tuning in';
  if (reward.minutes < 60) return `${reward.minutes} min watched`;
  return `${Number((reward.minutes / 60).toFixed(1))} h watched`;
}

// The sites list rewards in no particular order; the quickest to earn come first.
const byEffort = (rewards) => [...rewards].sort((a, b) => a.subs - b.subs || a.minutes - b.minutes);

/** A campaign as a few lines: when, where, what for how long, and the links. */
function describe(c, now = Date.now()) {
  const lines = [c.start.getTime() > now
    ? `Starts <t:${unix(c.start)}:f>, ends <t:${unix(c.end)}:f>`
    : `Ends <t:${unix(c.end)}:f> (<t:${unix(c.end)}:R>)`];
  if (c.channels.length) {
    const named = c.channels.slice(0, 5).map((n) => escapeMarkdown(n)).join(', ');
    lines.push(`Only on ${named}${c.channels.length > 5 ? ` and ${c.channels.length - 5} more` : ''}`);
  }
  for (const r of byEffort(c.rewards).slice(0, 6)) lines.push(`• ${escapeMarkdown(r.name)} — ${needs(r)}`);
  if (c.rewards.length > 6) lines.push(`• …and ${c.rewards.length - 6} more`);
  const links = [`[Campaign](${c.url})`];
  if (c.link) links.push(`[Link your account](${c.link})`);
  if (c.about) links.push(`[Details](${c.about})`);
  lines.push(links.join(' · '));
  return lines.join('\n').slice(0, 1024);
}

/** One post for one game's new campaigns on one site. */
function buildPost(game, site, campaigns, pingRole) {
  const s = SITES[site];
  const first = campaigns[0];
  const now = Date.now();
  const coming = campaigns.every((c) => c.start.getTime() > now);
  const lastEnd = new Date(Math.max(...campaigns.map((c) => c.end.getTime())));
  const headline = coming
    ? `🎁 **${escapeMarkdown(game.name)}** has ${s.label} drops coming <t:${unix(first.start)}:R>`
    : `🎁 **${escapeMarkdown(game.name)}** has ${s.label} drops on, until <t:${unix(lastEnd)}:f>`;

  const embed = new EmbedBuilder()
    .setColor(s.color)
    .setAuthor({ name: `${s.label} drops` })
    .setTitle(first.game.slice(0, 256));
  if (first.watch) embed.setURL(first.watch);
  if (first.image) embed.setThumbnail(first.image);
  for (const c of campaigns.slice(0, PER_POST)) {
    embed.addFields({ name: c.name.slice(0, 256), value: describe(c, now) });
  }
  if (campaigns.length > PER_POST) {
    embed.setFooter({ text: `And ${campaigns.length - PER_POST} more — /drops list has them all` });
  }
  return {
    content: `${pingRole ? `<@&${pingRole}> ` : ''}${headline}`,
    embeds: [embed],
    allowedMentions: pingRole ? { roles: [pingRole] } : { parse: [] },
  };
}

async function pollGuild(client, guildId, cfg) {
  const games = gamesFor(guildId);
  if (!games.length) return;
  const { campaigns } = await allCampaigns();
  const { seen } = stateOf(guildId);

  // New campaigns, gathered by site and game, soonest-ending first.
  const groups = new Map();
  for (const c of campaigns) {
    if (seen[c.key]) continue;
    const game = gameOf(games, c);
    if (!game) continue;
    const id = `${c.site}:${game.key}`;
    if (!groups.has(id)) groups.set(id, { game, site: c.site, campaigns: [] });
    groups.get(id).campaigns.push(c);
  }
  if (!groups.size) return;

  const channelId = cfg.drops?.channel || cfg.channel;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.warn(`[Drops] ${guildId}: channel ${channelId} is unreachable.`);
    return;
  }
  for (const { game, site, campaigns: list } of groups.values()) {
    list.sort((a, b) => a.end - b.end);
    await channel.send(buildPost(game, site, list, cfg.drops?.pingRole));
    // Marked as each post goes, so one failing never repeats the ones before it.
    mutate(guildId, (record) => {
      for (const c of list) record.seen[c.key] = c.end.getTime();
    });
    console.log(`[Drops] ${guildId}: posted ${list.length} ${SITES[site].label} campaign(s) for ${game.name}.`);
  }
}

// One poll at a time per guild, so /drops add arriving mid-poll cannot post the
// same campaign twice.
const running = new Map();

/** Post what is new for this guild's games. `cfg` is the guild's `gameNews`. */
function pollDrops(client, guildId, cfg) {
  const next = (running.get(guildId) || Promise.resolve())
    .then(() => pollGuild(client, guildId, cfg))
    .catch((err) => console.warn(`[Drops] ${guildId}: poll failed: ${err?.message || err}`));
  running.set(guildId, next);
  return next;
}

// --- Telling people -----------------------------------------------------------------

/** What is on now for each followed game, by site, each campaign under the game it is for. */
function onNow(games, campaigns) {
  const rows = new Map(games.map((game) => [game.key, { game, bySite: {}, count: 0 }]));
  for (const c of campaigns) {
    const row = rows.get(gameOf(games, c)?.key);
    if (!row) continue;
    (row.bySite[c.site] ||= []).push(c);
    row.count++;
  }
  return [...rows.values()];
}

/** The public list for /drops list. */
async function listEmbed(guildId) {
  const games = gamesFor(guildId);
  const embed = new EmbedBuilder().setColor(SITES.twitch.color).setTitle('🎁 Drops for the games we play');
  if (!games.length) return embed.setDescription('No games are followed. `/drops add` puts one on the list.');

  const { campaigns, failed } = await allCampaigns();
  const rows = onNow(games, campaigns).sort((a, b) => (b.count > 0) - (a.count > 0));
  const lines = rows.map(({ game, bySite, count }) => {
    if (!count) return `**${escapeMarkdown(game.name)}** — nothing on`;
    const parts = Object.entries(bySite).map(([site, list]) => {
      const end = new Date(Math.max(...list.map((c) => c.end.getTime())));
      const link = list[0].watch || list[0].url;
      const what = list.length === 1 && list[0].name !== list[0].game
        ? escapeMarkdown(list[0].name)
        : `${list.length} campaign${list.length === 1 ? '' : 's'}`;
      return `[${SITES[site].label}](${link}): ${what}, until <t:${unix(end)}:R>`;
    });
    return `**${escapeMarkdown(game.name)}** — ${parts.join(' · ')}`;
  });
  embed.setDescription(lines.join('\n').slice(0, 4096));
  const notes = ['/drops add follows another game'];
  if (failed.length) notes.unshift(`${failed.map((s) => SITES[s].label).join(' and ')} could not be read just now`);
  return embed.setFooter({ text: notes.join(' · ') });
}

/** What is on now for one game, as a line for the /drops add reply. */
async function summaryFor(guildId, game) {
  const { campaigns } = await allCampaigns();
  const { bySite, count } = onNow(gamesFor(guildId), campaigns).find((r) => r.game.key === game.key)
    || { bySite: {}, count: 0 };
  if (!count) return 'Nothing is on for it right now.';
  return `On now: ${Object.entries(bySite).map(([site, list]) => `${list.length} on ${SITES[site].label}`).join(', ')}.`;
}

/**
 * The games and what is on for them, for his knowledge block. Read from the last
 * poll rather than fetched, so a chat reply never waits on either site.
 */
function dropsFacts(guildId) {
  const games = gamesFor(guildId);
  if (!games.length) return [];
  const lines = [`The games this server follows for Twitch and Kick drops: ${games.map((g) => g.name).join(', ')}.`];
  const read = Object.entries(latest).filter(([, v]) => v);
  if (!read.length) {
    lines.push('What is on for them has not been checked yet since you woke.');
    return lines;
  }
  const now = Date.now();
  const campaigns = read.flatMap(([, v]) => v.campaigns).filter((c) => c.end.getTime() > now);
  const on = onNow(games, campaigns).filter((r) => r.count);
  if (!on.length) {
    lines.push('None of them has drops on right now.');
    return lines;
  }
  for (const { game, bySite } of on) {
    for (const [site, list] of Object.entries(bySite)) {
      const named = list.slice(0, 3).map((c) => {
        const rewards = byEffort(c.rewards).slice(0, 3).map((r) => `${r.name} (${needs(r)})`).join(', ');
        const when = c.start.getTime() > now
          ? `from ${c.start.toISOString().slice(0, 16)}Z`
          : `until ${c.end.toISOString().slice(0, 16)}Z`;
        return `"${c.name}" ${when}${rewards ? `: ${rewards}` : ''}`;
      });
      lines.push(`• ${game.name} on ${SITES[site].label}: ${named.join('; ')}${list.length > 3 ? `; and ${list.length - 3} more` : ''}`);
    }
  }
  return lines;
}

/** Game names the sites have campaigns for now, for /drops add's suggestions. */
function knownGameNames() {
  const names = new Set();
  for (const v of Object.values(latest)) for (const c of v?.campaigns || []) names.add(c.game);
  return [...names].sort((a, b) => a.localeCompare(b));
}

module.exports = {
  pollDrops,
  allCampaigns,
  gamesFor,
  findGame,
  addGame,
  removeGame,
  listEmbed,
  summaryFor,
  dropsFacts,
  knownGameNames,
  isFor,
  fromTwitch,
  fromKick,
};
