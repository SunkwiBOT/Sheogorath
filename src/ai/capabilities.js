'use strict';
/**
 * What Sheogorath may do on his own, and what he has to ask permission for.
 *
 * The model decides *what* it wants to do; this file decides whether that is
 * allowed. Keeping the two apart matters more here than in most places, because
 * the input to the model is chat written by the people it can act against — a
 * player who can phrase a sentence can otherwise phrase an instruction. Nothing
 * in this file consults the model's reasoning; it looks only at who asked, who
 * is being acted on, and how much has already happened this hour.
 *
 * Four verdicts come out of `decide()`:
 *
 *   execute — do it now, and record it
 *   propose — post an Approve/Deny card for a Sheriff, do nothing until clicked
 *   shadow  — record what would have happened, do nothing (see MODES)
 *   deny    — refuse, and record the refusal
 *
 * The rule that does most of the work is the targeting rule. An action aimed at
 * someone other than the person Sheogorath is replying to is *never* executed on
 * the say-so of an ordinary member — it degrades to a proposal a Sheriff has to
 * click. So the worst a member can talk him into is a card in the staff channel,
 * and the only person they can get acted on directly is themselves.
 */
const { isStaff, isAdmin, isVeteran } = require('../utils/permissions');
const { aiTitles, getGuildConfig, withArticle } = require('../config/guilds');
const { staffChannelId } = require('../utils/aiAudit');

/**
 * Per-guild autonomy, set as `ai.mode` in config/guilds.json.
 *
 *   shadow  — nothing is ever executed. Every decision is logged as what it
 *             *would* have been. This is the default for a guild that hasn't
 *             said otherwise: a new deployment should not be able to punish
 *             anyone before someone has read a week of its judgement.
 *   assist  — anything that would execute becomes a proposal instead. Nothing
 *             happens without a human click.
 *   enforce — the auto tier executes; the propose tier still asks.
 */
const MODES = ['shadow', 'assist', 'enforce'];
const DEFAULT_MODE = 'shadow';

/**
 * Targeting rules.
 *
 *   author — may only be aimed at the author of the triggering message, unless
 *            a Sheriff asked. Aimed anywhere else it degrades to a proposal.
 *   member — aimed at any member, subject to immunity. Every capability using
 *            this is already `propose`, so "aim it at anyone" always means
 *            "ask a Sheriff about anyone".
 *   none   — not aimed at a person at all.
 */

/**
 * The capability table. Adding a power to Sheogorath means adding a row here;
 * there is deliberately no way to reach an executor that has no row.
 *
 * `perHour` is a rolling per-guild cap on *executions* — proposals are not
 * rationed, because a proposal costs a Sheriff one glance and nothing else.
 *
 * `requires` names the guild feature a power physically depends on: a guild
 * without `events` has no calendar for him to put things on, so the power does
 * not exist there at all. What a guild *wants* him doing is a
 * separate question, answered by `ai.powers` in config/guilds.json — see
 * availableCapabilities(). Rows with neither work anywhere he can speak.
 */
/**
 * Auto-tier actions that take something away from the person they land on.
 * Used by the help-channel rule below; everything else in the auto tier is
 * bookkeeping and stays automatic everywhere.
 */
const PUNITIVE = new Set(['delete', 'warn', 'timeout']);

const CAPABILITIES = {
  // --- Record-keeping. Nobody is punished by a note, so these run freely. ---
  note:       { tier: 'auto',    targets: 'member', immune: false, perHour: 30 },
  memory:     { tier: 'auto',    targets: 'member', immune: false, perHour: 30 },
  clearnotes: { tier: 'auto',    targets: 'member', immune: false, perHour: 10 },

  // Tells staff someone tried to manipulate him. Punishes nobody, so it runs
  // freely and is not subject to immunity — a Sheriff testing him should show up
  // in the log like anyone else. Rationed loosely: one person probing will
  // usually try several framings in a row, and staff want the whole run.
  flag:       { tier: 'auto',    targets: 'member', immune: false, perHour: 25 },

  // --- Corrective, bounded, and undoable within a few minutes. ---
  delete:     { tier: 'auto',    targets: 'author', immune: true,  perHour: 15 },
  warn:       { tier: 'auto',    targets: 'author', immune: true,  perHour: 10 },

  // A timeout is the one auto-tier action that takes something away for a
  // measurable stretch, so it carries a second threshold: up to ten minutes is
  // his to give, anything longer is a proposal. Ten minutes is short enough to
  // be a cooling-off period rather than a punishment, and it matches the ceiling
  // the action layer already enforced before this gate existed.
  timeout:    { tier: 'auto',    targets: 'author', immune: true,  perHour: 5,
                autoMaxMinutes: 10, hardMaxMinutes: 7 * 24 * 60 },

  // --- Speech. He talks for a living; these are the rooms he can talk in. ---
  //
  // Both run for anybody, which is unusual for a power aimed at a third party,
  // and the reason is that speaking is not punishing. The protection is not a
  // gate but a signature: everything he sends on somebody's behalf says whose
  // behalf it was, so nobody can use him as an anonymous mouthpiece. A card in
  // a staff channel would not add to that — it would only mean "tell Fisher I
  // said hello" fails for everyone but an Owner, which is the wall this pair
  // exists to remove.
  //
  // The per-hour caps are the real brake. Low enough that a room turning him
  // on somebody runs out of him quickly, and every send is in the audit log.
  dm:         { tier: 'auto',    targets: 'member', immune: false, perHour: 12, maxLength: 1200 },
  // A few DMs in a row, stopping when the person turns up (services/nudges.js).
  // Signed like a dm. Rationed harder, because one tag is up to five letters.
  nudge:      { tier: 'auto',    targets: 'member', immune: false, perHour: 4, maxLength: 600 },
  say:        { tier: 'auto',    targets: 'none',   immune: false, perHour: 15, maxLength: 1200 },

  // A title: a cosmetic role, invented on the spot and hung on somebody.
  //
  // The first power he has that GIVES something rather than taking it away,
  // which is why it sits here rather than in the auto tier. It is bounded in
  // the executor rather than in the words: the role it makes carries no
  // permissions at all, is placed below his own, and an existing role is only
  // reused when it is equally toothless — so the worst outcome is a stupid
  // name under somebody's, which any Owner can strip in two clicks.
  //
  // Anyone may title anyone, which is a wider door than it looks and is opened
  // on purpose. This server's favourite thing to do with him is ask for titles
  // — for themselves, for their friends, for a man who has just said something
  // stupid — and behind an approval card that whole game is Owners-only, which
  // is not a server, it is a queue. What makes it affordable is that a title
  // takes nothing away, wears its author in the audit log, and comes off again
  // in one line. Immunity is off for the same reason: a Sheriff can be given a
  // silly name like anybody else.
  // `author` with an `othersNeed` of veteran: your own title is yours to ask
  // for, and titling somebody else is open to anyone who has been here long
  // enough to have earned Veteran. Below that it becomes a card for staff —
  // titles are cosmetic, but being renamed by a stranger is not nothing.
  title:      { tier: 'auto',    targets: 'author', othersNeed: 'veteran',
                immune: false, perHour: 10, maxLength: 90 },

  // Taking one back, which is narrower than giving one — `author` means your
  // own comes off on your say-so, and stripping somebody else's needs staff.
  // The asymmetry is the point: being given a daft name by a friend is the
  // game, and having one quietly removed by a stranger is a slight.
  untitle:    { tier: 'auto',    targets: 'author', immune: false, perHour: 10 },

  // --- Furniture. Small, visible, and undone by hand in seconds. ---
  //
  // All auto, all rationed, none of them able to remove anything from anybody.
  // A reaction is the cheapest thing he can do and the one people expect most
  // from something that behaves like a person in the room.
  react:      { tier: 'auto',    targets: 'none',   immune: false, perHour: 30 },
  pin:        { tier: 'auto',    targets: 'none',   immune: false, perHour: 10 },
  thread:     { tier: 'auto',    targets: 'none',   immune: false, perHour: 5, maxLength: 90 },
  poll:       { tier: 'auto',    targets: 'none',   immune: false, perHour: 5, maxOptions: 8 },

  // Putting something on the server calendar, or moving it. Nobody is acted on,
  // and the line that matters is held in services/events.js rather than here:
  // anyone may add an event, but only whoever added one, or an Owner, may move
  // or cancel it. So the worst a room can talk him into is an event nobody
  // wanted, which the person who asked for it can take off again.
  event:      { tier: 'auto',    targets: 'none',   immune: false, perHour: 6, requires: 'events' },

  // The Ledger: record-keeping for the group rather than for one person, so
  // nobody is acted on. A ruling and a quote are entries in a book. A bet is
  // only an offer until the other person takes it with the button on its card,
  // and it is always the asker's own, so nobody can be put into a wager by
  // somebody else. The consent lives in services/ledger.js, not here.
  ruling:     { tier: 'auto',    targets: 'none',   immune: false, perHour: 10, requires: 'ledger' },
  bet:        { tier: 'auto',    targets: 'none',   immune: false, perHour: 6,  requires: 'ledger' },
  quote:      { tier: 'auto',    targets: 'none',   immune: false, perHour: 10, requires: 'ledger' },

  // Renaming somebody is where "harmless and reversible" stops being obviously
  // true: it changes how a person appears to everyone, and unlike a title it
  // replaces something they chose. Owners rename freely; everyone else's
  // request is a card, and staff are immune, because a room that can rename its
  // moderators through him has been handed the keys sideways.
  nick:       { tier: 'propose', ownerTier: 'auto', targets: 'member', immune: true, perHour: 10,
                maxLength: 32 },

  // A new room is the one piece of furniture that persists whether or not
  // anybody wanted it, so it stays an Owner's to make.
  channel:    { tier: 'propose', ownerTier: 'auto', targets: 'none',   immune: false, perHour: 3,
                maxLength: 90 },

  // --- Everything below always asks, whoever is asking. ---
  //
  // Kick carries the Owner exception now, asked for in as many words: "are you
  // able to kick. You know, for the future?" — then "that needs to change". It
  // is the first power he has that removes a person, and in a guild with no
  // staff channel a proposal is a refusal, so without the exception the answer
  // to an Owner would stay no forever. It stops at Owners for that reason and
  // no further.
  kick:       { tier: 'propose', ownerTier: 'auto', targets: 'member', immune: true,  perHour: 5 },
  // Ban takes the same Owner exception as kick, for the same reason: asked to
  // ban someone by a Creator in a hall with no staff channel, the only answer
  // he could give was no.
  ban:        { tier: 'propose', ownerTier: 'auto', targets: 'member', immune: true,  perHour: 3,
                maxDeleteDays: 7 },
};

/**
 * Guild-wide brake. If Sheogorath executes more than this many actions in an
 * hour, something has gone wrong — a prompt that has talked him into a loop, a
 * raid he is over-reacting to, a bad model day. He drops to proposals only and
 * staff are told once.
 */
const BREAKER_LIMIT = 20;
const BREAKER_WINDOW_MS = 60 * 60 * 1000;
const BREAKER_COOLDOWN_MS = 60 * 60 * 1000;
/**
 * How long execution records are kept. Longer than the breaker's window
 * because some capabilities are rationed per day rather than per hour — an
 * on-demand chronicle costs real money and would be tiresome hourly, so
 * "three a day" has to be expressible.
 */
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** guildId -> timestamps of executed actions, newest last. */
const executions = new Map();
/** guildId -> epoch ms until which the breaker stays tripped. */
const tripped = new Map();

/**
 * Executions inside a window. Prunes to the longest window anyone asks about,
 * so the per-day counters still have their history when the per-hour ones have
 * moved on.
 */
function recentExecutions(guildId, capability = null, windowMs = BREAKER_WINDOW_MS) {
  const kept = (executions.get(guildId) || []).filter((e) => e.at >= Date.now() - HISTORY_WINDOW_MS);
  executions.set(guildId, kept);

  const cutoff = Date.now() - windowMs;
  const inWindow = kept.filter((e) => e.at >= cutoff);
  return capability ? inWindow.filter((e) => e.capability === capability) : inWindow;
}

/**
 * Record that an action actually ran. Called by the dispatcher after a
 * successful execution — not at decision time, so a failed Discord call doesn't
 * eat somebody's hourly budget.
 */
function recordExecution(guildId, capability) {
  const list = recentExecutions(guildId);
  list.push({ at: Date.now(), capability });
  executions.set(guildId, list);

  if (list.length > BREAKER_LIMIT && !isBreakerTripped(guildId)) {
    tripped.set(guildId, Date.now() + BREAKER_COOLDOWN_MS);
    return { justTripped: true, count: list.length };
  }
  return { justTripped: false, count: list.length };
}

function isBreakerTripped(guildId) {
  const until = tripped.get(guildId);
  if (!until) return false;
  if (Date.now() >= until) {
    tripped.delete(guildId);
    return false;
  }
  return true;
}

/** Let staff clear the brake by hand rather than waiting out the hour. */
function resetBreaker(guildId) {
  tripped.delete(guildId);
  executions.set(guildId, []);
}

/**
 * Whether a held action has anywhere to go in this guild.
 *
 * A proposal is a card in a staff channel. Without one there is no card, so
 * `propose` is not a softer verdict than `deny` — it is the same outcome
 * reached more slowly and described to the player as though someone were
 * considering it. Guilds that run him as a mascot have no such channel.
 */
function canAsk(guildId) {
  return !!staffChannelId(guildId);
}

/**
 * The capabilities that exist in one guild.
 *
 * The single source for "what can he do here" — the gate refuses everything
 * outside it, and the prompt is written from it, so what he offers people and
 * what he can deliver cannot drift apart.
 *
 * Three things remove a row:
 *
 *   the missing feature it needs, so a guild with no calendar is never offered
 *   one to put things on;
 *
 *   `ai.powers`, when a guild lists one — the guild saying what it wants him
 *   for. He is the host of one server and the figurehead of another, and not
 *   every job he holds comes with the power to time people out;
 *
 *   for the powers that can only ever be proposed, having nobody to propose to.
 *   A kick in a guild with no staff channel is not a power he has there, and
 *   listing it only teaches him to promise it.
 *
 * @param {object|null} guildConfig
 * @returns {Object<string, object>} the subset of CAPABILITIES available here
 */
function availableCapabilities(guildConfig) {
  const features = guildConfig?.features || [];
  const allowed = guildConfig?.ai?.powers || null;
  const askable = canAsk(guildConfig?.id);
  const out = {};
  for (const [name, cap] of Object.entries(CAPABILITIES)) {
    if (cap.requires && !features.includes(cap.requires)) continue;
    if (allowed && !allowed.includes(name)) continue;
    // `ownerTier` rows survive: an Owner's request executes outright, so they
    // still do something in a guild with nowhere to post a card.
    if (!askable && cap.tier === 'propose' && !cap.ownerTier) continue;
    out[name] = cap;
  }
  return out;
}

function modeFor(guildConfig) {
  const mode = guildConfig?.ai?.mode;
  return MODES.includes(mode) ? mode : DEFAULT_MODE;
}

/**
 * Whether a member is off limits to an AI-initiated action.
 *
 * Staff immunity is not about trust in the member — it is about what a
 * successful injection would be worth. The prize for talking Sheogorath into
 * acting is removing the people who could stop him, so that is the one move
 * that is never available at any tier.
 */
function immunityReason(targetMember, botMember) {
  if (!targetMember) return null; // Not resolvable — handled by the caller.
  if (targetMember.user?.bot) return 'the target is a bot';
  if (botMember && targetMember.id === botMember.id) return 'he cannot act on himself';
  const titles = aiTitles(getGuildConfig(targetMember.guild?.id));
  if (isAdmin(targetMember)) return `the target is ${withArticle(titles.admin)}`;
  if (isStaff(targetMember)) return `the target is ${withArticle(titles.approver)}`;
  return null;
}

/**
 * Decide what happens to one proposed action.
 *
 * @param {object} action        parsed action, `{ type, userId?, duration?, ... }`
 * @param {object} ctx
 * @param {string} ctx.guildId
 * @param {object} ctx.guildConfig    from config/guilds.js
 * @param {string} ctx.authorId       who wrote the message Sheogorath replied to
 * @param {import('discord.js').GuildMember|null} ctx.requester  same person, as a member
 * @param {import('discord.js').GuildMember|null} ctx.targetMember  resolved target, if any
 * @param {import('discord.js').GuildMember|null} ctx.botMember
 * @returns {{verdict: string, reason: string, capability: object|null, action: object}}
 */
function decide(action, ctx) {
  const cap = CAPABILITIES[action.type];
  // What this guild calls the tier that rules on held actions. Every reason
  // below is quoted back to players and written into the staff log, so it has
  // to name a tier that exists in the guild it is quoted in.
  const titles = aiTitles(ctx.guildConfig);
  const out = (verdict, reason, patched = action) =>
    ({ verdict, reason, capability: cap || null, action: patched });
  // Holding something for approval is only a real verdict where there is a
  // staff channel to hold it in. Everywhere else it is a refusal, and is
  // reported as one — index.js tells the player which of the two happened.
  const hold = (reason, patched = action) => canAsk(ctx.guildId)
    ? out('propose', reason, patched)
    : out('deny', `${reason} — and this server has no one to ask`, patched);

  // An action with no row in the table is not a power he has. This is the
  // backstop for a model that invents a tag name.
  if (!cap) return out('deny', `"${action.type}" is not a capability`);

  // ...and a power the guild has not switched on is not one he has *here*.
  // Checked before the mode, so a guild that never wanted a moderator does not
  // even accrue shadow-mode records of punishments it would never have wanted.
  if (!availableCapabilities(ctx.guildConfig)[action.type]) {
    return out('deny', `${action.type} is not something he can do in this server`);
  }

  const mode = modeFor(ctx.guildConfig);
  if (mode === 'shadow') return out('shadow', 'guild is in shadow mode');

  // --- Immunity, before anything else that could let it through. ---
  if (cap.immune && action.userId) {
    if (!ctx.targetMember) {
      return out('deny', 'the target is not a member of this server');
    }
    const immune = immunityReason(ctx.targetMember, ctx.botMember);
    if (immune) return out('deny', immune);
  }

  const requesterIsStaff = isStaff(ctx.requester);
  const requesterIsOwner = isAdmin(ctx.requester);
  const requesterIsVeteran = isVeteran(ctx.requester);

  // A capability may be gentler on an Owner than on everyone else. Computed
  // once here so every branch below agrees on which tier is in force.
  const tier = cap.ownerTier && requesterIsOwner ? cap.ownerTier : cap.tier;

  // --- Targeting: the rule that contains prompt injection. ---
  //
  // Aimed at anyone but the person he is replying to, on the word of an
  // ordinary member, this becomes a card in the staff channel. Members can
  // still *raise* things — that is the point of letting it degrade rather than
  // refusing outright — they just cannot land them.
  if (cap.targets === 'author' && action.userId && action.userId !== ctx.authorId) {
    // Most of these open up only to staff. A capability may name a lower rung
    // with `othersNeed` when the thing being done to a third party is cosmetic
    // rather than punitive.
    const cleared = cap.othersNeed === 'veteran' ? requesterIsVeteran : requesterIsStaff;
    if (!cleared) {
      // With no veteran role in the guild there is no such rung, and isVeteran
      // has already collapsed to isStaff — so say staff, not a tier that does
      // not exist here.
      const needed = cap.othersNeed === 'veteran' && titles.veteran
        ? withArticle(titles.veteran)
        : withArticle(titles.approver);
      return hold(`aimed at someone other than the author, and the requester is not ${needed}`);
    }
  }

  // --- Per-capability thresholds. ---
  let patched = action;
  if (action.type === 'timeout') {
    const requested = Math.max(1, Math.min(action.duration || 5, cap.hardMaxMinutes));
    patched = { ...action, duration: requested };
    if (requested > cap.autoMaxMinutes) {
      return hold(`${requested}m is over the ${cap.autoMaxMinutes}m he may give unasked`, patched);
    }
  }
  if (action.type === 'ban') {
    patched = { ...action, deleteDays: Math.min(action.deleteDays || 0, cap.maxDeleteDays) };
  }
  if (tier === 'propose') {
    return hold(
      requesterIsStaff && titles.staff
        ? `this capability asks ${withArticle(titles.admin)}, or any ${titles.staff}, before it runs`
        : `this capability always asks ${withArticle(titles.approver)}`,
      patched,
    );
  }

  // --- Brakes. Both degrade to a proposal rather than refusing, so a busy
  // hour costs staff a click instead of losing the action entirely. ---
  if (isBreakerTripped(ctx.guildId)) {
    return hold('the hourly action brake is tripped', patched);
  }
  if (cap.perHour && recentExecutions(ctx.guildId, action.type).length >= cap.perHour) {
    return hold(`${action.type} has hit its ${cap.perHour}/hour limit`, patched);
  }
  if (cap.perDay && recentExecutions(ctx.guildId, action.type, HISTORY_WINDOW_MS).length >= cap.perDay) {
    // Refused outright rather than degraded to a proposal: a day's worth of
    // chronicles is a taste question, not a permissions one, and a card asking
    // a Sheriff to approve a fourth would be a worse use of their attention
    // than the word no.
    return out('deny', `${action.type} has already run ${cap.perDay} time(s) today`, patched);
  }

  // --- The help channel keeps its hands where we can see them. ---
  // help is the one channel he answers in uninvited, and the people posting
  // there are by definition confused, new, or having a bad time. Being deleted,
  // warned or timed out for asking a question is a far worse outcome than a
  // Sheriff clicking a card, so in help the punitive tier always asks first.
  //
  // This is a CHANNEL rule rather than a confidence one, and that is deliberate.
  // The header of this file is the reason: nothing here consults the model's
  // reasoning, because the input is written by the people being acted against.
  // "Only act when sure" would be a gate a player can talk through simply by
  // sounding certain; "not in this channel" is a gate they cannot reach at all.
  //
  // Note, memory, clearnotes and flag are untouched — they take
  // nothing away from anybody, and gutting them would leave him answering help
  // with no memory of who he was talking to.
  if (PUNITIVE.has(action.type) && ctx.channelId
      && ctx.channelId === ctx.guildConfig?.channels?.help) {
    return hold(`the help channel never punishes without ${withArticle(titles.approver)}`, patched);
  }

  // `assist` is `enforce` with the auto tier taken away.
  if (mode === 'assist') return hold('guild is in assist mode', patched);

  return out('execute', 'within his own authority', patched);
}

module.exports = {
  CAPABILITIES,
  availableCapabilities,
  canAsk,
  MODES,
  DEFAULT_MODE,
  BREAKER_LIMIT,
  HISTORY_WINDOW_MS,
  decide,
  modeFor,
  immunityReason,
  recordExecution,
  isBreakerTripped,
  resetBreaker,
  recentExecutions,
};
