'use strict';
/**
 * Turning what Sheogorath said he wants to do into what actually happens.
 *
 * Three steps, deliberately separate files:
 *
 *   parseActions()    here — pull the tags out of the model's reply
 *   decide()          ai/capabilities.js — is he allowed to?
 *   runAction()       ai/executors.js — do it
 *
 * Nothing in this file judges an action on its merits. It resolves who the
 * target is, hands the decision to the gate, and routes the answer. That
 * ordering is the point: before the gate existed, every tag the model emitted
 * was performed, which meant anyone who could get a sentence in front of him
 * could aim him. Now the parse is untrusted input all the way through.
 *
 * Action tag format:
 *   [ACTION:timeout:userId:durationMinutes:reason]
 *   [ACTION:warn:userId:reason]
 *   [ACTION:kick:userId:reason]
 *   [ACTION:ban:userId:deleteDays:reason]
 *   [ACTION:delete:reason]
 *   [ACTION:flag:userId:reason]
 *   [ACTION:note:userId:note text]
 *   [ACTION:clearnotes:userId]
 *   [ACTION:memory:userId:memory text]
 *   [ACTION:ruling:question|verdict]
 *   [ACTION:bet:who|terms|stakes|settle by]
 *   [ACTION:quote:reason]
 */
const { decide, recordExecution, BREAKER_LIMIT } = require('./capabilities');
const { runAction } = require('./executors');
const { proposeAction } = require('./approvals');
const { logAiAction, notifyStaff } = require('../utils/aiAudit');
const { getGuildConfig } = require('../config/guilds');

const ACTION_TYPES = 'timeout|warn|kick|ban|delete|flag|note|clearnotes|memory|'
  + 'title|untitle|dm|nudge|say|react|pin|thread|poll|nick|channel|event|ruling|bet|quote';

/**
 * Pull action tags out of a reply and strip them from the visible text.
 *
 * The scrubbing is belt-and-braces because a tag that survives into a Discord
 * message is worse than one that never parsed: it teaches every reader the exact
 * syntax to try in their next message. Truncated tags matter for the same
 * reason — `max_tokens` regularly cuts one in half.
 *
 * @returns {{cleanResponse: string, actions: object[]}}
 */
function parseActions(response) {
  const actionRegex = new RegExp(`\\[ACTION:(${ACTION_TYPES}):([^\\]]+)\\]`, 'g');
  const actions = [];
  let cleanResponse = response;

  let match;
  while ((match = actionRegex.exec(response)) !== null) {
    const [fullMatch, type, params] = match;
    const parts = params.split(':');

    switch (type) {
      case 'timeout': {
        const [userId, duration, ...reasonParts] = parts;
        actions.push({
          type: 'timeout',
          userId,
          duration: parseInt(duration, 10) || 5,
          reason: reasonParts.join(':') || 'AI-initiated timeout',
        });
        break;
      }
      case 'warn': {
        const [userId, ...reasonParts] = parts;
        actions.push({ type: 'warn', userId, reason: reasonParts.join(':') || 'AI-initiated warning' });
        break;
      }
      case 'kick': {
        const [userId, ...reasonParts] = parts;
        actions.push({ type: 'kick', userId, reason: reasonParts.join(':') || 'AI-initiated kick' });
        break;
      }
      case 'ban': {
        const [userId, days, ...reasonParts] = parts;
        actions.push({
          type: 'ban',
          userId,
          deleteDays: parseInt(days, 10) || 0,
          reason: reasonParts.join(':') || 'AI-initiated ban',
        });
        break;
      }
      case 'delete':
        actions.push({ type: 'delete', reason: parts.join(':') || 'AI-initiated deletion' });
        break;
      case 'flag': {
        const [userId, ...reasonParts] = parts;
        actions.push({ type: 'flag', userId, reason: reasonParts.join(':') || 'unspecified' });
        break;
      }
      case 'note': {
        const [userId, ...noteParts] = parts;
        actions.push({ type: 'note', userId, note: noteParts.join(':') });
        break;
      }
      case 'clearnotes':
        actions.push({ type: 'clearnotes', userId: parts[0] });
        break;

      case 'untitle': {
        const [userId, ...titleParts] = parts;
        const text = titleParts.join(':').trim();
        if (userId && text) actions.push({ type: 'untitle', userId, title: text });
        break;
      }

      case 'react': {
        // One emoji, aimed at the message he is answering.
        const emoji = parts.join(':').trim();
        if (emoji) actions.push({ type: 'react', emoji });
        break;
      }

      case 'pin':
        actions.push({ type: 'pin', reason: parts.join(':').trim() || 'worth keeping' });
        break;

      case 'thread': {
        const name = parts.join(':').trim();
        if (name) actions.push({ type: 'thread', name });
        break;
      }

      case 'poll': {
        // question:option|option|option — the pipe keeps options apart without
        // stealing the colon, which people put inside questions.
        const [question, ...rest] = parts;
        const options = rest.join(':').split('|').map((o) => o.trim()).filter(Boolean);
        if (question && options.length >= 2) {
          actions.push({ type: 'poll', question: question.trim(), options });
        }
        break;
      }

      case 'nick': {
        const [userId, ...nameParts] = parts;
        const name = nameParts.join(':').trim();
        if (userId && name) actions.push({ type: 'nick', userId, name });
        break;
      }

      case 'channel': {
        const [name, ...topicParts] = parts;
        if (name) actions.push({ type: 'channel', name: name.trim(), topic: topicParts.join(':').trim() });
        break;
      }

      case 'event': {
        // name|when|hours|where, or name|cancel. Pipes rather than colons,
        // as with a poll: a time has colons in it.
        const [name, when, hours, where] = parts.join(':').split('|').map((p) => p.trim());
        if (!name) break;
        if (/^cancel(led)?$/i.test(when || '')) actions.push({ type: 'event', name, cancel: true });
        else actions.push({ type: 'event', name, when: when || null, hours: Number(hours) || null, where: where || null });
        break;
      }

      case 'ruling': {
        // question|verdict. Pipes, since either may have a colon in it.
        const [question, ...rest] = parts.join(':').split('|');
        const verdict = rest.join('|').trim();
        if (question?.trim() && verdict) actions.push({ type: 'ruling', question: question.trim(), verdict });
        break;
      }

      case 'bet': {
        // who|what the asker is betting|stakes|settle by. "who" empty or
        // "anyone" means the room. Always the asker's own bet.
        const [who, terms, stakes, settleBy] = parts.join(':').split('|').map((p) => p.trim());
        if (!terms) break;
        const open = !who || /^(anyone|anybody|everyone|the room)$/i.test(who);
        actions.push({ type: 'bet', userId: open ? null : who, terms, stakes: stakes || null, settleBy: settleBy || null });
        break;
      }

      case 'quote':
        // Keeps the message the asker replied to; the text is only his reason.
        actions.push({ type: 'quote', reason: parts.join(':').trim() || 'worth keeping' });
        break;

      case 'dm': {
        const [userId, ...textParts] = parts;
        const text = textParts.join(':').trim();
        if (userId && text) actions.push({ type: 'dm', userId, text });
        break;
      }

      case 'nudge': {
        // [ACTION:nudge:userId:times:minutes:what to say]
        const [userId, times, every, ...textParts] = parts;
        const text = textParts.join(':').trim();
        if (userId && text) {
          actions.push({
            type: 'nudge',
            userId,
            times: parseInt(times, 10) || 3,
            every: parseInt(every, 10) || 3,
            text,
          });
        }
        break;
      }

      case 'say': {
        // The channel may be named or given by ID; the executor resolves it.
        const [channel, ...textParts] = parts;
        const text = textParts.join(':').trim();
        if (channel && text) actions.push({ type: 'say', channel: channel.trim(), text });
        break;
      }

      case 'title': {
        const [userId, ...titleParts] = parts;
        const text = titleParts.join(':').trim();
        // A title with no words is not a title. Dropped rather than passed on,
        // so the gate never rules on an action that could not be carried out.
        if (userId && text) actions.push({ type: 'title', userId, title: text });
        break;
      }
      case 'memory': {
        const [userId, ...memoryParts] = parts;
        actions.push({ type: 'memory', userId, memory: memoryParts.join(':') });
        break;
      }
    }

    cleanResponse = cleanResponse.replace(fullMatch, '').trim();
  }

  cleanResponse = scrub(cleanResponse);

  if (actions.length > 0) {
    console.log(`[Actions] Parsed ${actions.length} action tag(s): ${actions.map(a => a.type).join(', ')}`);
  }

  return { cleanResponse, actions };
}

/** Strip complete, truncated and half-eaten action tags from visible text. */
function scrub(text) {
  return String(text)
    .replace(/\[ACTION:[^\]]*\]/gs, '')  // complete tags
    .replace(/\[ACTION:[^\]]*$/gm, '')   // truncated at end of line
    .replace(/\[ACTION:.*/gs, '')        // any leftover prefix
    .trim();
}

/**
 * Resolve the member an action is aimed at, if any.
 *
 * A miss is not an error — the model invents IDs, and an ID that isn't a member
 * of this guild is exactly the case the gate refuses on.
 */
async function resolveTarget(guild, ref) {
  if (!guild || !ref) return null;
  const raw = String(ref).trim();

  const mention = /^<@!?(\d{17,20})>$/.exec(raw);
  const id = mention ? mention[1] : (/^\d{17,20}$/.test(raw) ? raw : null);
  if (id) {
    try {
      return await guild.members.fetch(id);
    } catch {
      return null;
    }
  }

  // A name rather than an id. The model writes what it sees in the channel,
  // which is a username — so `[ACTION:title:the_grey:...]` is the normal case,
  // not a malformed one, and left unresolved it reaches Discord as a member id
  // and comes back "Invalid Form Body".
  //
  // Resolved only on an unambiguous match. The same tag shape drives timeout
  // and kick as easily as it drives title, so guessing between two similar
  // names is not a convenience, it is acting on the wrong person.
  const needle = raw.replace(/^@/, '').toLowerCase();
  if (!needle) return null;
  let members;
  try {
    members = guild.members.cache.size >= guild.memberCount
      ? guild.members.cache
      : await guild.members.fetch();
  } catch {
    return null;
  }
  const names = (m) => [m.user.username, m.displayName, m.nickname].filter(Boolean);
  let hits = members.filter((m) => names(m).some((n) => n.toLowerCase() === needle));

  // Discord usernames may end in a dot, and the model drops trailing
  // punctuation when it writes one into a tag — "the_grey." comes back as
  // "the_grey". Fall back to comparing letters and digits only, which closes
  // that gap without loosening the rule that matters: still exactly one match,
  // or nobody.
  if (hits.size === 0) {
    const flatten = (v) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
    const flat = flatten(needle);
    if (flat) hits = members.filter((m) => names(m).some((n) => flatten(n) === flat));
  }
  return hits.size === 1 ? hits.first() : null;
}

/**
 * Put every parsed action through the gate and route the verdict.
 *
 * @param {object[]} actions from parseActions
 * @param {object} context
 * @param {import('discord.js').Guild} context.guild
 * @param {import('discord.js').Message} [context.message] the triggering message
 * @param {string} [context.guildId]
 * @returns {Promise<object[]>} one result per action
 */
async function executeActions(actions, context) {
  const { guild, message } = context;
  const guildId = context.guildId || guild?.id;
  const guildConfig = getGuildConfig(guildId);
  const authorId = context.authorId || message?.author?.id || null;
  const requester = context.requester || message?.member || null;
  const botMember = guild?.members?.me || null;

  const results = [];

  for (const rawAction of actions) {
    const targetMember = await resolveTarget(guild, rawAction.userId);

    // Carry the resolved id forward. The gate compares userId against the
    // author's to decide whether something is aimed at a third party, and a
    // username never equals a snowflake — so without this, an action aimed at
    // the person asking looks like one aimed at a stranger.
    const action = targetMember && rawAction.userId && rawAction.userId !== targetMember.id
      ? { ...rawAction, userId: targetMember.id }
      : rawAction;

    const { verdict, reason, action: gated } = decide(action, {
      guildId,
      guildConfig,
      authorId,
      requester,
      targetMember,
      botMember,
      // Needed by the help-channel rule in capabilities.js.
      channelId: message?.channelId,
    });

    const base = {
      guildId,
      action: gated,
      reason,
      authorId,
      channelId: message?.channelId,
      messageUrl: message?.url,
    };

    if (verdict === 'deny' || verdict === 'shadow') {
      logAiAction({ ...base, verdict });
      results.push({ ...gated, verdict, reason, success: false });
      continue;
    }

    if (verdict === 'propose') {
      await proposeAction(gated, { guild, guildId, message, authorId, reason })
        .catch((err) => console.warn('[Actions] Could not post approval card:', err.message));
      results.push({ ...gated, verdict, reason, success: false });
      continue;
    }

    // --- execute ---
    try {
      const summary = await runAction(gated, { guild, guildId, message, requester, followUps: context.followUps });
      const { justTripped, count } = recordExecution(guildId, gated.type);
      logAiAction({ ...base, verdict: 'execute', summary });
      results.push({ ...gated, verdict, reason, success: true });

      if (justTripped) {
        // Staff hear about this once, on the way past the limit — after this
        // the gate quietly turns everything into proposals, and a channel full
        // of "brake still tripped" would be noise.
        await notifyStaff(
          guildId,
          `🛑 **Sheogorath has been put on a leash.** ${count} actions in the last hour ` +
          `(limit ${BREAKER_LIMIT}). Everything he wants to do now comes here for approval ` +
          `until the hour is out. Worth a look at what set him off.`
        ).catch(() => {});
      }
    } catch (err) {
      logAiAction({ ...base, verdict: 'error', summary: err.message });
      results.push({ ...gated, verdict, reason, success: false, error: err.message });
    }
  }

  return results;
}

module.exports = { parseActions, executeActions, scrub, ACTION_TYPES, resolveTarget };
