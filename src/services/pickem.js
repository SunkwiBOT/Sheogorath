'use strict';
/**
 * UFC pick'em: call the winners before each card, and be scored on it.
 *
 * Nothing new is fetched to make it work. services/ufc.js already reads every
 * card off ESPN's public scoreboard to build the Discord event, and that same
 * scoreboard marks `winner: true` on a fighter once the bout is final. So the
 * card, the lock times and the results all come from one unofficial endpoint
 * the bot already depends on, with no key and nobody typing scores in.
 *
 * A week of it:
 *
 *   Fight week Monday, alongside the event, the card is posted in the UFC
 *   channel with a button per block of bouts. Each opens a private panel with a
 *   row per bout: one click picks a fighter, a second click takes it back.
 *   Nobody sees anyone else's picks until they lock.
 *
 *   Each fight locks when it starts, as ESPN marks it under way, so a pick on
 *   the main event can be changed right up until the main event begins. The
 *   first lock opens a thread on the card, and each lock says there how the
 *   room picked that fight. Once a card is under way a pick is checked against
 *   a fresh look at ESPN, not the last poll, which could be two minutes into
 *   the fight.
 *
 *   Results land in that thread as ESPN marks each bout final, with who called
 *   it. When the last is in, the card is scored, the season table moves, the
 *   best picker takes the weekly title off whoever wore it, and Sheogorath has a
 *   word about the worst.
 *
 * Everything — the card, every pick, which locks and results have been told —
 * lives in guild state, so a restart mid-card loses no pick and posts no result
 * twice. A result is marked as told before it is sent: one lost to a Discord
 * outage stays lost, which beats the same result posted twice.
 *
 * A bout that vanishes from ESPN before it has a result is a scratch: it leaves
 * the card and its picks go with it. One that ends without a winner — a draw, a
 * no contest — counts for nobody.
 *
 * Contender Series nights, where a guild plays them, run the same way but are
 * scored into a table and a title of their own. Five fights on a Tuesday would
 * otherwise decide the UFC season for whoever happened to be about that night.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const { getGuildConfig, guildIds, hasFeature } = require('../config/guilds');
const { getGuildState, setGuildState } = require('../storage/state');
const { calendarCards, parseBouts, scoreboard, easternDay, fightWeekStart, TZ, CONTENDER } = require('./ufc');
const { getAIResponse } = require('../ai/grok');
const { conversationalPersona } = require('../ai/persona');
const { scrub } = require('../ai/actions');
const { runAction } = require('../ai/executors');

const PREFIX = 'pickem:';
const UFC_RED = 0xd20a0a;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How often new cards are looked for, and open ones re-read before they start. */
const SYNC_HOURS = 3;

/** How often a card is checked for results once it is under way. Never before. */
const POLL_MINUTES = 2;

/** How old a look at ESPN may be when a pick on a card under way is checked against it. */
const FRESH_SECONDS = 20;

/**
 * How long after its first bout a card is scored regardless. Early prelims to a
 * pay-per-view main event runs about seven hours; a bout still without a result
 * by now counts for nobody, rather than holding the whole table open.
 */
const GIVE_UP_HOURS = 12;

/** Bouts per private panel: one action row each, and a message holds five. */
const PANEL_BOUTS = 5;

/** Finished cards are forgotten after this long. The season table keeps their totals. */
const KEEP_DAYS = 45;

/** How far ahead `/pickem open` reaches for a card whose fight week has not begun. */
const EARLY_DAYS = 14;

const DEFAULT_TITLE = 'Oracle of the Octagon';
const DEFAULT_CONTENDER_TITLE = 'Talent Scout';

const unix = (ms) => Math.floor(ms / 1000);
const firstStart = (card) => Math.min(...card.bouts.map((b) => b.start));
const seasonOf = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric' }).format(new Date(ms));
const currentSeason = () => seasonOf(Date.now());
/** Whether a card is a Contender Series night, by the same test that let it in. */
const isContender = (card) => CONTENDER.test(card?.name || '');
// Normalised the way the title executor normalises a name, so the title handed
// out and the one looked for when taking it back are the same string.
const clean = (name) => name.replace(/\s+/g, ' ').trim().slice(0, 90);
/**
 * The title a card's best picker takes. The two are kept apart even if
 * configured alike: a role of one name cannot be two titles, and handing one
 * over would take the other off whoever wore it.
 */
function titleFor(guildId, contender = false) {
  const cfg = getGuildConfig(guildId)?.ufc?.pickem;
  const ufc = clean(cfg?.title || DEFAULT_TITLE);
  if (!contender) return ufc;
  const own = clean(cfg?.contenderTitle || DEFAULT_CONTENDER_TITLE);
  return own === ufc ? clean(`${own} (DWCS)`) : own;
}
const messageLink = (guildId, card) => `https://discord.com/channels/${guildId}/${card.channelId}/${card.messageId}`;
/** Where cards are posted: pick'em's own channel, or the UFC channel when it has none. */
const channelFor = (guildId) => {
  const ufc = getGuildConfig(guildId)?.ufc;
  return ufc?.pickem?.channel || ufc?.channel || null;
};
const pickemGuilds = () => guildIds().filter((id) => hasFeature(id, 'pickem') && channelFor(id));
/** Whether a card is close enough to its first fight, and not yet scored, that ESPN is watched for it. */
const isLive = (card, now = Date.now()) =>
  !card.finished && card.bouts.length > 0 && now >= firstStart(card) - 5 * MINUTE_MS;

const readings = new Map();
/**
 * The cards ESPN lists for one day, read at most once every FRESH_SECONDS
 * however many guilds, polls and picks ask. A failed read is not kept.
 */
function eventsOn(day) {
  const now = Date.now();
  for (const [key, reading] of readings) if (now - reading.at >= FRESH_SECONDS * 1000) readings.delete(key);
  if (!readings.has(day)) {
    const reading = { at: now, events: scoreboard(day).then((d) => d.events || []) };
    readings.set(day, reading);
    reading.events.catch(() => { if (readings.get(day) === reading) readings.delete(day); });
  }
  return readings.get(day).events;
}

// --- The stored record ------------------------------------------------------

/**
 * This guild's pick'em record, with every part present. The UFC season table
 * and title sit at the top, where they always have; the Contender Series keeps
 * its own under `contender`.
 */
function stateOf(guildId) {
  const saved = getGuildState(guildId).pickem || {};
  return {
    cards: saved.cards || {},
    seasons: saved.seasons || {},
    title: saved.title || null,
    contender: { seasons: saved.contender?.seasons || {}, title: saved.contender?.title || null },
  };
}

/** Where a card's points and title are kept: the UFC season's, or the Contender Series' own. */
const boardOf = (record, contender) => (contender ? record.contender : record);

/**
 * Read, change and write one guild's record in a single synchronous pass.
 *
 * `change` must not await. Two clicks landing together would otherwise each
 * read the record before the other wrote it, and one of the two picks would
 * quietly vanish.
 */
function mutate(guildId, change) {
  const record = stateOf(guildId);
  const result = change(record);
  const cutoff = Date.now() - KEEP_DAYS * DAY_MS;
  for (const [id, card] of Object.entries(record.cards)) {
    if (card.finished && card.finished < cutoff) delete record.cards[id];
  }
  setGuildState(guildId, { pickem: record });
  return result;
}

/** ESPN's stand-in for a fighter not yet named: "TBA", "Opponent TBA". */
const PLACEHOLDER = /^(opponent\s+)?tb[ad]$/i;

/**
 * A card as pick'em plays it: only the bouts with both fighters named. ESPN
 * lists a Contender Series night as one "Opponent TBA vs TBA" bout until the
 * week's fights are announced, and a late replacement as "Opponent TBA" until
 * one is signed; neither is a fight anyone can call. A card with nothing to
 * call yet is not posted, and is looked for again on the next sync.
 */
function readCard(event) {
  const parsed = parseBouts(event);
  const bouts = (parsed?.bouts || []).filter((b) => !b.fighters.some((f) => PLACEHOLDER.test(f.name)));
  return bouts.length ? { ...parsed, bouts } : null;
}

/**
 * Whether a fight can no longer be picked: once ESPN has it under way. Every
 * bout in a block carries ESPN's one start time for the block, so only the
 * bout's own state can say when it starts.
 */
function isLocked(bout) {
  return !!bout.result || bout.state !== 'pre';
}

/**
 * The card's blocks in the order a card is read: main card, then prelims, then
 * early prelims, each with its main event first. ESPN lists the other way up.
 */
function blocksOf(card) {
  const starts = [...new Set(card.bouts.map((b) => b.start))].sort((a, b) => b - a);
  const names = starts.length === 1 ? ['The card'] : ['Main card', 'Prelims', 'Early prelims'];
  return starts.map((start, i) => ({
    name: names[Math.min(i, names.length - 1)],
    start,
    bouts: card.bouts.filter((b) => b.start === start).reverse(),
  }));
}

/** The blocks, cut down to what one private panel can hold. */
function panelsOf(card) {
  return blocksOf(card).flatMap((block) => {
    if (block.bouts.length <= PANEL_BOUTS) return [block];
    const parts = [];
    for (let i = 0; i < block.bouts.length; i += PANEL_BOUTS) {
      parts.push({ ...block, name: `${block.name} ${parts.length + 1}`, bouts: block.bouts.slice(i, i + PANEL_BOUTS) });
    }
    return parts;
  });
}

/**
 * Fold ESPN's latest reading of a card into the stored one, and say what moved.
 *
 * A reading that has lost most of the card is taken for a bad response rather
 * than a wave of scratches, and ignored — dropping every pick on the strength
 * of one truncated reply is not a mistake that can be taken back.
 */
function mergeBouts(card, parsed) {
  const news = { changed: false, results: [], removed: [] };
  if (parsed.bouts.length < Math.ceil(card.bouts.length / 2)) return news;

  const stored = new Map(card.bouts.map((b) => [b.id, b]));
  const next = [];
  for (const fresh of parsed.bouts) {
    const bout = stored.get(fresh.id) || { id: fresh.id, result: null };
    if (!stored.has(fresh.id) || bout.start !== fresh.start || bout.weight !== fresh.weight
      || JSON.stringify(bout.fighters) !== JSON.stringify(fresh.fighters)) news.changed = true;
    Object.assign(bout, { start: fresh.start, weight: fresh.weight, fighters: fresh.fighters, state: fresh.state });
    if (!bout.result && fresh.final) {
      bout.result = { ...fresh.result };
      news.results.push(bout);
      news.changed = true;
    }
    next.push(bout);
    stored.delete(fresh.id);
  }
  for (const gone of stored.values()) {
    // Decided already, so ESPN dropping it afterwards changes nothing.
    // Undecided, it is a scratch.
    if (gone.result) next.push(gone);
    else {
      news.removed.push(gone);
      news.changed = true;
    }
  }
  card.bouts = next;

  // A pick survives only while it names a fighter still in a bout on the card.
  // A replacement opponent is a different fight to call.
  for (const [userId, picks] of Object.entries(card.picks)) {
    for (const [boutId, fighterId] of Object.entries(picks)) {
      const bout = card.bouts.find((b) => b.id === boutId);
      if (!bout?.fighters.some((f) => f.id === fighterId)) delete picks[boutId];
    }
    if (!Object.keys(picks).length) delete card.picks[userId];
  }
  return news;
}

/**
 * Pick a fighter, or take the pick back if they were already the pick.
 *
 * Everything the button carried is checked against the stored card. A
 * custom_id arrives from the client, and a crafted one must not be able to
 * pick a bout that has locked or a fighter who is not in it.
 *
 * `blind` is a pick on a card under way when ESPN could not be read to say
 * which fights have started. A fight is then taken to start with its block:
 * too early for most of the block, but never too late.
 */
function recordPick(guildId, espnId, boutId, fighterId, userId, { blind = false, now = Date.now() } = {}) {
  return mutate(guildId, (record) => {
    const card = record.cards[espnId];
    if (!card || card.finished) return { error: 'That card is closed.' };
    const bout = card.bouts.find((b) => b.id === boutId);
    if (!bout) return { error: 'That bout is no longer on the card.', card };
    if (!bout.fighters.some((f) => f.id === fighterId)) return { error: 'That fighter is no longer in that bout.', card };
    if (isLocked(bout)) return { error: 'That fight has started, so the pick on it is locked.', card };
    if (blind && now >= bout.start) {
      return { error: "ESPN can't be reached to check whether that fight has started. Try again in a minute.", card };
    }

    const wasIn = !!card.picks[userId];
    const mine = card.picks[userId] || {};
    if (mine[boutId] === fighterId) delete mine[boutId];
    else mine[boutId] = fighterId;
    if (Object.keys(mine).length) card.picks[userId] = mine;
    else delete card.picks[userId];
    return { card, rosterChanged: wasIn !== !!card.picks[userId] };
  });
}

/**
 * Score a finished card into its season: a point per winner called. A bout
 * without a winner is counted for nobody, whoever picked it.
 */
function scoreCard(record, card) {
  const season = seasonOf(firstStart(card));
  const { seasons } = boardOf(record, isContender(card));
  const table = seasons[season] || (seasons[season] = {});
  const rows = [];
  for (const [userId, picks] of Object.entries(card.picks)) {
    let points = 0;
    let counted = 0;
    for (const bout of card.bouts) {
      if (!picks[bout.id] || !bout.result?.winner) continue;
      counted++;
      if (picks[bout.id] === bout.result.winner) points++;
    }
    if (!counted) continue;
    const row = table[userId] || (table[userId] = { points: 0, picks: 0, cards: 0 });
    row.points += points;
    row.picks += counted;
    row.cards += 1;
    rows.push({ userId, points, picks: counted });
  }
  rows.sort((a, b) => b.points - a.points || a.picks - b.picks);
  return { season, rows };
}

/** Places with ties: equal scores share one, and the next place skips. */
function ranked(rows, score) {
  return rows.map((row) => ({ ...row, rank: 1 + rows.filter((other) => score(other) > score(row)).length }));
}

const rate = (row) => (row.picks ? row.points / row.picks : 0);
const medal = (rank) => ['🥇', '🥈', '🥉'][rank - 1] || `**${rank}.**`;

function seasonRows(guildId, season, contender = false) {
  return Object.entries(boardOf(stateOf(guildId), contender).seasons[season] || {})
    .map(([userId, row]) => ({ userId, ...row }))
    .sort((a, b) => b.points - a.points || rate(b) - rate(a) || b.cards - a.cards);
}

// --- What people see --------------------------------------------------------

function boutLine(bout) {
  const [a, b] = bout.fighters;
  if (!bout.result) return `${isLocked(bout) ? '🔒 ' : ''}${a.name} vs ${b.name}`;
  const winner = bout.fighters.find((f) => f.id === bout.result.winner);
  if (!winner) return `${a.name} vs ${b.name} · no result`;
  return `✅ **${winner.name}** def. ${bout.fighters.find((f) => f !== winner).name}`;
}

function cardEmbed(card, now = Date.now()) {
  const sections = blocksOf(card).map((block) => {
    const head = now >= block.start
      ? `**${block.name}**`
      : `**${block.name}** · starts <t:${unix(block.start)}:f> (<t:${unix(block.start)}:R>)`;
    return [head, ...block.bouts.map(boutLine)].join('\n');
  });
  const players = Object.keys(card.picks);
  const shown = players.slice(0, 40).map((id) => `<@${id}>`).join(' ');
  return new EmbedBuilder()
    .setColor(UFC_RED)
    .setTitle(`🥊 Pick'em · ${card.name}`.slice(0, 256))
    .setDescription(sections.join('\n\n').slice(0, 4096))
    .addFields({
      name: `Picks in (${players.length})`,
      value: players.length ? `${shown}${players.length > 40 ? ` and ${players.length - 40} more` : ''}` : 'Nobody yet.',
    })
    .setFooter({ text: cardFooter(card) });
}

function cardFooter(card) {
  if (isContender(card)) {
    return card.finished
      ? 'Scored. /pickem standings series:Contender Series for the table.'
      : 'A point for every winner you call, in a Contender Series table apart from the UFC season. '
        + 'Each fight locks when it starts, and picks stay hidden until then.';
  }
  return card.finished
    ? 'Scored. /pickem standings for the season.'
    : 'A point for every winner you call. Each fight locks when it starts, and picks stay hidden until then.';
}

function cardComponents(card) {
  const panels = panelsOf(card).slice(0, 5);
  const rows = [];
  if (panels.length) {
    rows.push(new ActionRowBuilder().addComponents(panels.map((panel, i) => new ButtonBuilder()
      .setCustomId(`${PREFIX}panel:${card.espnId}:${i}`)
      .setLabel(panel.name)
      .setStyle(ButtonStyle.Primary))));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}mine:${card.espnId}`).setLabel('My picks').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(isContender(card) ? `${PREFIX}table:contender` : `${PREFIX}table`)
      .setLabel('Standings')
      .setStyle(ButtonStyle.Secondary),
  ));
  return rows;
}

const cardMessage = (card) => ({
  embeds: [cardEmbed(card)],
  components: cardComponents(card),
  allowedMentions: { parse: [] },
});

/**
 * One private panel: a row per bout, a button per fighter.
 *
 * The rows carry no text of their own, so the list above them names each bout
 * in the same order. The pick is the blue button until the bout is decided,
 * then green or red; the winner wears the trophy either way.
 */
function panelView(card, index, userId, now = Date.now()) {
  const panels = panelsOf(card);
  const at = panels[index] ? index : 0;
  const panel = panels[at];
  if (!panel) return { content: 'There are no bouts left on this card.', components: [] };

  const mine = card.picks[userId] || {};
  const picked = card.bouts.filter((b) => mine[b.id]).length;
  const head = now >= panel.start
    ? `**${card.name} · ${panel.name}**`
    : `**${card.name} · ${panel.name}** · starts <t:${unix(panel.start)}:R>`;
  const lines = panel.bouts.map((b, i) => `${i + 1}. ${b.fighters[0].name} vs ${b.fighters[1].name}`
    + `${b.weight ? ` · ${b.weight}` : ''}${isLocked(b) && !b.result ? ' · 🔒' : ''}`);
  const content = `${head}\n${lines.join('\n')}\n-# ${picked} of ${card.bouts.length} picked. `
    + 'Click a name to pick it, and click it again to take the pick back. Each fight locks when it starts.';

  const components = panel.bouts.map((bout) => new ActionRowBuilder().addComponents(bout.fighters.map((f) => {
    const chosen = mine[bout.id] === f.id;
    const won = bout.result?.winner === f.id;
    let style = ButtonStyle.Secondary;
    if (chosen && !bout.result) style = ButtonStyle.Primary;
    else if (chosen && bout.result.winner) style = won ? ButtonStyle.Success : ButtonStyle.Danger;
    const button = new ButtonBuilder()
      .setCustomId(`${PREFIX}pick:${card.espnId}:${at}:${bout.id}:${f.id}`)
      .setLabel(f.name.slice(0, 80))
      .setStyle(style)
      .setDisabled(isLocked(bout));
    if (won) button.setEmoji('🏆');
    return button;
  })));
  return { content, components };
}

function mineView(card, userId) {
  const mine = card.picks[userId] || {};
  const lines = [`**${card.name}** · your picks`];
  let right = 0;
  let counted = 0;
  for (const block of blocksOf(card)) {
    lines.push('', `__${block.name}__`);
    for (const bout of block.bouts) {
      const pick = bout.fighters.find((f) => f.id === mine[bout.id]);
      const vs = `${bout.fighters[0].name} vs ${bout.fighters[1].name}`;
      let mark = '';
      if (pick && bout.result?.winner) {
        counted++;
        if (bout.result.winner === pick.id) right++;
        mark = bout.result.winner === pick.id ? ' ✅' : ' ❌';
      }
      lines.push(pick ? `**${pick.name}**${mark} · ${vs}` : `— · ${vs}`);
    }
  }
  if (counted) lines.push('', `**${right}** of ${counted} called so far.`);
  return lines.join('\n').slice(0, 2000);
}

/** The name a season goes by: the UFC year, or that year's Contender Series. */
const seasonName = (season, contender) => (contender ? `${season} Contender Series` : `${season} season`);

function standingsEmbed(guildId, season = currentSeason(), contender = false) {
  const rows = ranked(seasonRows(guildId, season, contender), (r) => r.points).slice(0, 25);
  const noun = contender ? 'night' : 'card';
  const embed = new EmbedBuilder()
    .setColor(UFC_RED)
    .setTitle(`🥊 Pick'em · ${seasonName(season, contender)}`)
    .setDescription(rows.length
      ? rows.map((r) => `${medal(r.rank)} <@${r.userId}> · **${r.points}** pts · `
        + `${Math.round(rate(r) * 100)}% · ${r.cards} ${noun}${r.cards === 1 ? '' : 's'}`).join('\n')
      : `No ${contender ? 'Contender Series night' : 'card'} has been scored this season yet.`);
  const { title } = boardOf(stateOf(guildId), contender);
  if (title?.holders?.length) {
    embed.addFields({ name: `👑 ${title.name}`, value: title.holders.map((id) => `<@${id}>`).join(' ') });
  }
  return embed;
}

function resultsEmbed(guildId, card, ranks, season) {
  const contender = isContender(card);
  const table = ranked(seasonRows(guildId, season, contender), (r) => r.points).slice(0, 5);
  return new EmbedBuilder()
    .setColor(UFC_RED)
    .setTitle(`🏁 Pick'em · ${card.name}`.slice(0, 256))
    .setDescription(ranks.map((r) => `${medal(r.rank)} <@${r.userId}> · **${r.points}** of ${r.picks}`).join('\n').slice(0, 4096))
    .addFields({
      name: seasonName(season, contender),
      value: table.map((r) => `${medal(r.rank)} <@${r.userId}> · **${r.points}** pts`).join('\n').slice(0, 1024) || '—',
    })
    .setFooter({
      text: contender ? '/pickem standings series:Contender Series for the whole table' : '/pickem standings for the whole table',
    });
}

function howItEnded({ method, round, clock }) {
  if (method === 'decision') return ' by decision';
  if (method && round) return ` by ${method} in round ${round}${clock ? ` (${clock})` : ''}`;
  return method ? ` by ${method}` : '';
}

/** Said in the thread when a fight starts: how the room split on it. Nothing if nobody picked it. */
function lockPost(card, bout) {
  const [x, y] = bout.fighters;
  const count = (fighter) => Object.values(card.picks).filter((p) => p[bout.id] === fighter.id).length;
  if (!count(x) && !count(y)) return null;
  return `🔒 ${x.name} vs ${y.name} is under way. How the room picked: `
    + `${x.name} **${count(x)}** – **${count(y)}** ${y.name}`;
}

function scratchPost(bout) {
  return `❌ ${bout.fighters[0].name} vs ${bout.fighters[1].name} is off the card. Picks on it count for nothing.`;
}

/** Said in the thread when a bout is decided, with who called it. Nobody is pinged. */
function resultPost(card, bout) {
  const [x, y] = bout.fighters;
  const winner = bout.fighters.find((f) => f.id === bout.result.winner);
  if (!winner) return `➖ ${x.name} vs ${y.name} ends without a winner. It counts for nobody.`;
  const loser = bout.fighters.find((f) => f !== winner);
  const pickers = Object.entries(card.picks).filter(([, p]) => p[bout.id]);
  const right = pickers.filter(([, p]) => p[bout.id] === winner.id).map(([id]) => `<@${id}>`);
  let tail = 'Nobody picked this one.';
  if (pickers.length) {
    tail = right.length
      ? `Called it (${right.length}/${pickers.length}): ${right.join(' ')}`
      : `Nobody called it (0/${pickers.length}).`;
  }
  return `✅ **${winner.name}** def. ${loser.name}${howItEnded(bout.result)}\n-# ${tail}`;
}

// --- Talking to Discord -----------------------------------------------------

async function editCard(client, card) {
  const channel = await client.channels.fetch(card.channelId).catch(() => null);
  const message = channel && await channel.messages.fetch(card.messageId).catch(() => null);
  if (!message) return;
  await message.edit(cardMessage(card)).catch((err) =>
    console.warn(`[Pickem] Could not update the card for "${card.name}": ${err.message}`));
}

/**
 * The card's live thread, made on first use. Without permission to make one,
 * the channel itself will do: the results matter more than the tidiness.
 */
async function threadFor(client, guildId, card) {
  if (card.threadId) {
    const thread = await client.channels.fetch(card.threadId).catch(() => null);
    if (thread) return thread;
  }
  const channel = await client.channels.fetch(card.channelId).catch(() => null);
  if (!channel) return null;
  const message = await channel.messages.fetch(card.messageId).catch(() => null);
  const thread = message?.thread || (message && await message.startThread({
    name: `${card.name} · live`.slice(0, 100),
    autoArchiveDuration: 1440,
    reason: "UFC pick'em results",
  }).catch((err) => {
    console.warn(`[Pickem] ${guildId}: no thread for "${card.name}", posting in the channel: ${err.message}`);
    return null;
  }));
  if (!thread) return channel;
  card.threadId = thread.id;
  mutate(guildId, (record) => {
    if (record.cards[card.espnId]) record.cards[card.espnId].threadId = thread.id;
  });
  return thread;
}

/** Cards being posted right now, so two passes cannot post the same one twice. */
const posting = new Set();

/** Post a card and start taking picks. Null if it is already up, already under way, or has nowhere to go. */
async function postCard(client, guildId, parsed, now = Date.now()) {
  const key = `${guildId}:${parsed.espnId}`;
  if (posting.has(key) || stateOf(guildId).cards[parsed.espnId]) return null;
  if (now >= Math.min(...parsed.bouts.map((b) => b.start))) return null;
  posting.add(key);
  try {
    const channelId = channelFor(guildId);
    const channel = channelId && await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      console.warn(`[Pickem] ${guildId}: channel ${channelId} is unreachable.`);
      return null;
    }
    const card = {
      espnId: parsed.espnId,
      name: parsed.name,
      channelId: channel.id,
      messageId: null,
      threadId: null,
      bouts: parsed.bouts.map(({ id, start, weight, fighters, state }) => ({ id, start, weight, fighters, state, result: null })),
      picks: {},
      locked: [],
      posted: now,
      finished: null,
    };
    const message = await channel.send(cardMessage(card));
    card.messageId = message.id;
    mutate(guildId, (record) => { record.cards[card.espnId] = card; });
    console.log(`[Pickem] ${guildId}: opened "${card.name}" with ${card.bouts.length} bout(s).`);
    return card;
  } finally {
    posting.delete(key);
  }
}

/**
 * A card posted before pick'em was given a channel of its own, moved there.
 *
 * Only before its first bout: once a card is under way its thread is where
 * the night is happening, and moving it would split the room. The picks live
 * in state, not on the message, so they come along untouched. The old post is
 * cut down to a pointer rather than deleted, for anyone who goes looking for
 * it where they last saw it.
 */
async function moveCard(client, guildId, card) {
  const target = channelFor(guildId);
  if (!target || card.channelId === target || card.finished || Date.now() >= firstStart(card)) return;
  const channel = await client.channels.fetch(target).catch(() => null);
  if (!channel) {
    console.warn(`[Pickem] ${guildId}: cannot move "${card.name}" — channel ${target} is unreachable.`);
    return;
  }
  const message = await channel.send(cardMessage({ ...card, channelId: channel.id }));
  const moved = mutate(guildId, (record) => {
    const stored = record.cards[card.espnId];
    if (!stored) return null;
    Object.assign(stored, { channelId: channel.id, messageId: message.id, threadId: null });
    return stored;
  });
  const oldChannel = await client.channels.fetch(card.channelId).catch(() => null);
  const old = oldChannel && await oldChannel.messages.fetch(card.messageId).catch(() => null);
  await old?.edit({
    content: `🥊 Pick'em has a channel of its own now: <#${channel.id}>. Picks already made came with it.`,
    embeds: [],
    components: [],
    allowedMentions: { parse: [] },
  }).catch(() => {});
  console.log(`[Pickem] ${guildId}: moved "${card.name}" to #${channel.name}.`);
  return moved;
}

/** Before a card starts: scratches, replacements and moved times reach the post. */
async function refreshCard(client, guildId, parsed) {
  let news = null;
  const card = mutate(guildId, (record) => {
    const stored = record.cards[parsed.espnId];
    if (!stored || stored.finished) return null;
    news = mergeBouts(stored, parsed);
    return stored;
  });
  if (card && news.changed) await editCard(client, card);
}

/**
 * Hand the weekly title to this card's best, taking it off last week's.
 *
 * Through the executor Sheogorath's own titles use, so it is held to the same
 * checks: a cosmetic role, beneath him, carrying nothing. New wearers get it
 * before old ones lose it, because the executor deletes a title nobody wears
 * and a handover should not delete and remake it. If nobody could be given it,
 * nobody loses it either.
 *
 * The Contender Series title changes hands only on Contender Series nights,
 * and the UFC one only on UFC cards.
 *
 * @returns the title's name, or null if it went to nobody.
 */
async function passTitle(guild, winners, contender = false) {
  const guildId = guild.id;
  const name = titleFor(guildId, contender);
  const previous = boardOf(stateOf(guildId), contender).title;
  const kept = (userId) => previous?.name === name && previous.holders.includes(userId);

  const given = [];
  for (const userId of winners) {
    if (kept(userId)) {
      given.push(userId);
      continue;
    }
    try {
      await runAction({ type: 'title', userId, title: name }, { guild, guildId });
      given.push(userId);
    } catch (err) {
      console.warn(`[Pickem] ${guildId}: could not give "${name}" to ${userId}: ${err.message}`);
    }
  }
  if (!given.length) return null;

  for (const userId of previous?.holders || []) {
    if (given.includes(userId) && previous.name === name) continue;
    await runAction({ type: 'untitle', userId, title: previous.name }, { guild, guildId }).catch((err) =>
      console.warn(`[Pickem] ${guildId}: could not take "${previous.name}" from ${userId}: ${err.message}`));
  }
  mutate(guildId, (record) => { boardOf(record, contender).title = { name, holders: given, since: Date.now() }; });
  return name;
}

/**
 * His verdict: the champion crowned, the worst picker mocked. The one model
 * call pick'em makes, and the one part it can lose without losing anything.
 */
async function verdictOn(guild, card, ranks, best) {
  const names = new Map();
  for (const row of ranks) {
    const member = await guild.members.fetch(row.userId).catch(() => null);
    names.set(row.userId, member?.displayName || 'someone who has since left');
  }
  // Only somebody who actually finished below the top can have picked worst;
  // in a room tied all the way down there is nobody to single out.
  const worst = ranks[ranks.length - 1]?.rank > 1 ? ranks[ranks.length - 1] : null;
  const table = ranks.map((r) => `${r.rank}. ${names.get(r.userId)}: ${r.points} of ${r.picks}`).join('\n');
  const crown = best.map((id) => names.get(id)).join(' and ');
  const prompt = `The pick'em for ${card.name} is scored. Mortals picked the winner of each bout, `
    + `and this is how they did:\n${table}\n\nIn one or two short sentences, in character: `
    + (crown ? `crown ${crown}` : 'lament that nobody called a single fight')
    + (worst ? `, and mock ${names.get(worst.userId)} for picking worst` : '')
    + '. Playful, never cruel. Use their names as written — no @ mentions, no action tags.';
  const text = await getAIResponse(prompt, { rawSystemPrompt: conversationalPersona(), maxTokens: 150 });
  return scrub(text || '').replace(/[ \t]{2,}/g, ' ').trim() || null;
}

/** The last word on a card: its table, the title changing hands, and his verdict. */
async function finish(client, guildId, card, { season, rows }) {
  console.log(`[Pickem] ${guildId}: scored "${card.name}" for ${rows.length} player(s).`);
  // Nobody played: nothing to say, and the title stays where it is.
  if (!rows.length) return;
  const guild = client.guilds.cache.get(guildId);
  const channel = await client.channels.fetch(card.channelId).catch(() => null);
  if (!guild || !channel) return;

  const ranks = ranked(rows, (r) => r.points);
  const best = ranks.filter((r) => r.rank === 1 && r.points > 0).map((r) => r.userId);
  const title = best.length ? await passTitle(guild, best, isContender(card)) : null;
  const verdict = await verdictOn(guild, card, ranks, best).catch((err) => {
    console.warn(`[Pickem] ${guildId}: no verdict on "${card.name}": ${err?.message || err}`);
    return null;
  });

  const lines = [];
  if (verdict) lines.push(verdict);
  if (title) lines.push(`👑 ${best.map((id) => `<@${id}>`).join(' ')} ${best.length === 1 ? 'takes' : 'share'} **${title}**.`);
  await channel.send({
    content: lines.join('\n\n') || undefined,
    embeds: [resultsEmbed(guildId, card, ranks, season)],
    reply: card.messageId ? { messageReference: card.messageId, failIfNotExists: false } : undefined,
    // The winners hear about it. Nobody else is pinged, whatever the verdict says.
    allowedMentions: { users: best, repliedUser: false },
  }).catch((err) => console.warn(`[Pickem] ${guildId}: could not post the result of "${card.name}": ${err.message}`));
}

// --- The loops --------------------------------------------------------------

/**
 * One look at a card that is under way: new results and late scratches folded
 * in, fights that have started locked, and the card scored once it is over.
 *
 * All of it is stored in one synchronous pass, so whichever look sees a change
 * first is the only one that will tell it. `eventsOn` reads one ESPN day.
 *
 * @returns what is new, for `tell`, or null if the card is closed.
 */
async function syncLive(guildId, espnId, eventsOn, now = Date.now()) {
  const before = stateOf(guildId).cards[espnId];
  if (!before || before.finished || !before.bouts.length) return null;
  const start = firstStart(before);
  const events = await eventsOn(easternDay(new Date(start)));
  const event = events.find((e) => String(e.id) === espnId);
  const parsed = event ? readCard(event) : null;

  let news = null;
  let scored = null;
  const card = mutate(guildId, (record) => {
    const stored = record.cards[espnId];
    if (!stored || stored.finished) return null;
    news = parsed ? mergeBouts(stored, parsed) : { changed: false, results: [], removed: [] };
    news.locks = stored.bouts.filter((b) => isLocked(b) && !stored.locked.includes(b.id));
    stored.locked.push(...news.locks.map((b) => b.id));
    if (stored.bouts.every((b) => b.result) || now >= start + GIVE_UP_HOURS * HOUR_MS) {
      stored.finished = now;
      scored = scoreCard(record, stored);
    }
    return stored;
  });
  return card && { card, news, scored, fresh: !!parsed, underWay: now >= start };
}

/** What a look at a card turned up, told in its thread and on the card. */
async function tell(client, guildId, { card, news, scored, underWay }) {
  const posts = [
    ...news.results.map((b) => resultPost(card, b)),
    // Scratches before the first bout just leave the card; once it is under
    // way, somebody may be waiting on that fight and deserves to hear why.
    ...(underWay ? news.removed.map(scratchPost) : []),
    // A fight that started and ended between two looks has its result
    // already, and that says who called it.
    ...news.locks.filter((b) => !b.result).map((b) => lockPost(card, b)),
  ].filter(Boolean);
  if (posts.length) {
    const target = await threadFor(client, guildId, card);
    for (const content of posts) {
      await target?.send({ content, allowedMentions: { parse: [] } }).catch((err) =>
        console.warn(`[Pickem] ${guildId}: could not post to "${card.name}": ${err.message}`));
    }
  }
  if (news.changed || news.locks.length || scored) await editCard(client, card);
  if (scored) await finish(client, guildId, card, scored);
}

/** Look at a card that is under way, and tell what is new. */
async function pollCard(client, guildId, espnId, read = eventsOn, now = Date.now()) {
  const update = await syncLive(guildId, espnId, read, now);
  if (update) await tell(client, guildId, update);
}

let watching = false;

/** Every open card that is under way, checked for results. Outside a fight night, no requests at all. */
async function watchResults(client, now = Date.now()) {
  if (watching) return;
  watching = true;
  try {
    for (const guildId of pickemGuilds()) {
      for (const card of Object.values(stateOf(guildId).cards)) {
        if (!isLive(card, now)) continue;
        await pollCard(client, guildId, card.espnId, eventsOn, now).catch((err) =>
          console.warn(`[Pickem] ${guildId}: results for "${card.name}" failed: ${err?.response?.status || ''} ${err?.message || err}`));
      }
    }
  } finally {
    watching = false;
  }
}

let discovering = false;

/** Open this fight week's cards, and keep open ones in step with ESPN until they start. */
async function discover(client, now = new Date()) {
  const guilds = pickemGuilds();
  if (!guilds.length || discovering) return;
  discovering = true;
  try {
    const wantsContender = (id) => !!getGuildConfig(id)?.ufc?.pickem?.contender;
    let cards;
    try {
      cards = await calendarCards((c) => new Date(c.endDate || c.startDate) > now
        && fightWeekStart(new Date(c.startDate)) <= now
        && (guilds.some(wantsContender) || !CONTENDER.test(c.label)), readCard);
    } catch (err) {
      console.warn(`[Pickem] ESPN lookup failed: ${err?.response?.status || ''} ${err?.message || err}`);
      return;
    }
    for (const guildId of guilds) {
      for (const parsed of cards) {
        if (parsed.contender && !wantsContender(guildId)) continue;
        const card = stateOf(guildId).cards[parsed.espnId];
        try {
          if (!card) await postCard(client, guildId, parsed, now.getTime());
          else if (!card.finished && now.getTime() < firstStart(card)) {
            await moveCard(client, guildId, card);
            await refreshCard(client, guildId, parsed);
          }
        } catch (err) {
          console.warn(`[Pickem] ${guildId}: sync of "${parsed.name}" failed: ${err?.message || err}`);
        }
      }
    }
  } finally {
    discovering = false;
  }
}

/**
 * Open the next card now rather than on the Monday of its fight week.
 * @returns {Promise<string>} what happened, for the person who asked.
 */
async function openNext(client, guildId, now = new Date()) {
  const cfg = getGuildConfig(guildId);
  if (!hasFeature(guildId, 'pickem') || !channelFor(guildId)) {
    return "❌ Pick'em is not set up here. It needs the `pickem` feature and a `ufc.channel` or `ufc.pickem.channel`.";
  }
  const contender = !!cfg.ufc.pickem?.contender;
  // With Contender Series nights played, a fight week can hold two cards, so
  // one already open is passed over for the next that is not. So is one ESPN
  // has no named fights for yet, which is why every card in the window is read
  // rather than only the first: there are rarely more than four.
  const cards = Object.values(stateOf(guildId).cards);
  const opened = new Set(cards.map((c) => c.name));
  const [parsed] = await calendarCards((c) => new Date(c.startDate) > now
    && new Date(c.startDate) - now < EARLY_DAYS * DAY_MS
    && (contender || !CONTENDER.test(c.label))
    && !opened.has(c.label), readCard);
  if (!parsed) {
    const waiting = cards.filter((c) => !c.finished);
    return `There is nothing new to open in the next ${EARLY_DAYS} days.`
      + (waiting.length ? ` Already open: ${waiting.map((c) => `**${c.name}** ${messageLink(guildId, c)}`).join(', ')}` : '');
  }

  const open = stateOf(guildId).cards[parsed.espnId];
  if (open) return `**${parsed.name}** is already open: ${messageLink(guildId, open)}`;
  const card = await postCard(client, guildId, parsed, now.getTime());
  return card
    ? `Opened **${card.name}**: ${messageLink(guildId, card)}`
    : `Could not open **${parsed.name}**. It may already be under way, or the UFC channel is out of reach.`;
}

// --- Buttons ----------------------------------------------------------------

const isPickemButton = (interaction) =>
  typeof interaction.customId === 'string' && interaction.customId.startsWith(PREFIX);

async function handleButton(interaction) {
  const [, kind, espnId, ...rest] = interaction.customId.split(':');
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const ephemeral = MessageFlags.Ephemeral;

  if (kind === 'table') {
    // `pickem:table:contender` on a Contender Series card; plain on a UFC one.
    return interaction.reply({ embeds: [standingsEmbed(guildId, undefined, espnId === 'contender')], flags: ephemeral });
  }

  const card = stateOf(guildId).cards[espnId];
  if (!card) return interaction.reply({ content: 'That card has closed.', flags: ephemeral });
  if (kind === 'mine') return interaction.reply({ content: mineView(card, userId), flags: ephemeral });
  if (kind === 'panel') {
    return interaction.reply({ ...panelView(card, Number(rest[0]) || 0, userId), flags: ephemeral });
  }

  if (kind === 'pick') {
    const [panel, boutId, fighterId] = rest;
    // Once the card is under way a fight locks as it starts, so the pick is
    // checked against ESPN as it is now, not as of the last poll. Whatever the
    // look turns up is told in the thread as usual, without holding the click.
    let blind = false;
    if (isLive(card)) {
      await interaction.deferUpdate();
      const update = await syncLive(guildId, espnId, eventsOn).catch((err) => {
        console.warn(`[Pickem] ${guildId}: could not check "${card.name}" before a pick: ${err?.message || err}`);
        return null;
      });
      blind = !update?.fresh;
      if (update) {
        tell(interaction.client, guildId, update).catch((err) =>
          console.warn(`[Pickem] ${guildId}: could not tell "${card.name}": ${err?.message || err}`));
      }
    }
    const outcome = recordPick(guildId, espnId, boutId, fighterId, userId, { blind });
    // Redrawn either way: a refused click is usually a bout that locked while
    // the panel was open, and the panel should show it.
    const latest = outcome.card || stateOf(guildId).cards[espnId];
    const view = latest
      ? panelView(latest, Number(panel) || 0, userId)
      : { content: 'That card has closed.', components: [] };
    await (interaction.deferred ? interaction.editReply(view) : interaction.update(view));
    if (outcome.error) await interaction.followUp({ content: outcome.error, flags: ephemeral });
    else if (outcome.rosterChanged) editCard(interaction.client, outcome.card).catch(() => {});
    return;
  }

  return interaction.reply({ content: 'That button has gone stale.', flags: ephemeral });
}

function schedulePickem(client) {
  const guilds = pickemGuilds();
  if (!guilds.length) return;
  setInterval(() => { discover(client).catch(() => {}); }, SYNC_HOURS * HOUR_MS);
  setInterval(() => { watchResults(client).catch(() => {}); }, POLL_MINUTES * MINUTE_MS);
  discover(client).catch(() => {});
  watchResults(client).catch(() => {});
  console.log(`[Pickem] Running for ${guilds.length} guild(s): cards open in fight week, results every ${POLL_MINUTES}m once one is under way.`);
}

module.exports = {
  schedulePickem,
  isPickemButton,
  handleButton,
  standingsEmbed,
  openNext,
  currentSeason,
  // For tests and scripts.
  parseBouts,
  readCard,
  isContender,
  titleFor,
  mergeBouts,
  recordPick,
  scoreCard,
  ranked,
  blocksOf,
  panelsOf,
  panelView,
  mineView,
  cardMessage,
  lockPost,
  resultPost,
  isLocked,
  syncLive,
  pollCard,
  discover,
  moveCard,
  stateOf,
  verdictOn,
};
