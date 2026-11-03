'use strict';
/**
 * The actual doing. One function per capability, no policy of any kind.
 *
 * Split out from actions.js so that both paths into an action — Sheogorath
 * acting within his own authority, and a Sheriff clicking Approve on a card —
 * end up in the same code, and so that neither module has to require the other.
 * Nothing here checks permissions: by the time a call lands, capabilities.js has
 * either allowed it or a human has clicked the button.
 */
const { timeoutUser, warnUser, deleteMessage } = require('../services/automod');
const { addUserNote, clearUserNotes } = require('../storage/state');
const { addMemory } = require('../storage/memory');
const { CAPABILITIES } = require('./capabilities');
const { PermissionFlagsBits, ChannelType } = require('discord.js');

/**
 * The palette titles are drawn from — bright enough to read against both
 * Discord themes, and deliberately short, so a server full of his titles still
 * looks like it was decorated by one hand.
 */
const TITLE_COLOURS = [
  0x9b59b6, 0xe67e22, 0x1abc9c, 0xe91e63, 0xf1c40f,
  0x3498db, 0x2ecc71, 0xe74c3c, 0x00bcd4, 0xff7043,
];

/** Stable small hash, so one title keeps one colour across servers and restarts. */
function hashOf(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Whether a role is one he could have made: cosmetic, unmanaged, beneath him.
 *
 * The same question is asked when handing a title out and when taking one back,
 * and both answers have to agree — otherwise he can be talked into removing a
 * role that means something by calling it a title.
 */
function isCosmetic(role, ceiling) {
  return role
    && role.permissions.bitfield === 0n
    && !role.managed
    && role.position < ceiling;
}

/**
 * Turn whatever he wrote in a tag's userId slot into a real Discord id.
 *
 * Every action that touches a member already resolves through
 * `guild.members.fetch`, which rejects a username outright — that is why a
 * title aimed at "Funkslice" failed loudly and was visible in the audit. The
 * three storage actions did not, so the same mistake wrote to a record keyed
 * by the literal string instead: a note filed against nobody, and a clearnotes
 * that emptied an imaginary file and reported success. The live data still has
 * an "allisteras" key sitting beside the real snowflakes to show for it.
 *
 * A bare id is taken as-is without a fetch, so notes still work for someone who
 * has since left. Anything else must match a member, or the action fails the
 * way the rest of them do.
 */
async function resolveMemberId(guild, raw) {
  const value = String(raw ?? '').trim().replace(/^<@!?(\d+)>$/, '$1');
  if (/^\d{16,20}$/.test(value)) return value;
  if (!value) throw new Error('that action named nobody');
  if (!guild) throw new Error(`I cannot tell who "${value}" is from here`);

  // The query is a prefix search, so its first result is whoever sorts
  // earliest — not whoever was meant. An exact match on username or display
  // name or nothing: guessing here would file a note against the wrong person,
  // and on a clearnotes it would erase theirs.
  const needle = value.toLowerCase().replace(/^@/, '');
  const members = await guild.members.fetch({ query: needle, limit: 10 }).catch(() => null);
  const hit = members?.find(
    (m) => m.user.username.toLowerCase() === needle
      || m.displayName.toLowerCase() === needle,
  );

  if (!hit) throw new Error(`there is no one here called "${value}"`);
  return hit.id;
}

/**
 * Perform one action.
 *
 * @param {object} action  `{ type, userId?, duration?, reason?, ... }`
 * @param {object} ctx     `{ guild, guildId, message? }`
 * @returns {Promise<string>} a short past-tense description, for the audit line
 */
async function runAction(action, ctx) {
  const { guild, message } = ctx;
  const guildId = ctx.guildId || guild?.id;
  // Whose errand this is. Neither path in passes it — the chat path hands over
  // the message, and an approval card carries the message it was raised from —
  // so without the fallback a letter was signed "of his own accord" and a word
  // said in another room carried no name at all.
  const requester = ctx.requester || message?.member || null;

  /**
   * Post something that belongs *after* Sheogorath's own reply.
   *
   * Actions are performed before the reply is sent — the reply's footer depends
   * on how they were ruled on — so an executor that sent prose directly would
   * have it land above the line introducing it. Anything pushed here is sent by
   * the caller once the reply is out. Approved-from-a-card actions have no
   * reply coming, so those fall back to sending immediately. A part may be a
   * function of the channel, for a post whose message has to be kept.
   */
  const follow = async (parts) => {
    if (Array.isArray(ctx.followUps)) ctx.followUps.push(...parts);
    else {
      for (const part of parts) {
        if (typeof part === 'function') await part(message.channel);
        else await message.channel.send(part);
      }
    }
  };

  switch (action.type) {
    case 'timeout': {
      await timeoutUser(guild, action.userId, action.duration, action.reason, {
        maxMinutes: CAPABILITIES.timeout.hardMaxMinutes,
      });
      return `timed out <@${action.userId}> for ${action.duration}m`;
    }

    case 'warn':
      await warnUser(guild, action.userId, action.reason);
      return `warned <@${action.userId}>`;

    case 'kick': {
      const member = await guild.members.fetch(action.userId);
      await member.kick(`[Sheogorath] ${action.reason}`);
      return `kicked <@${action.userId}>`;
    }

    case 'ban': {
      await guild.bans.create(action.userId, {
        reason: `[Sheogorath] ${action.reason}`,
        deleteMessageSeconds: (action.deleteDays || 0) * 24 * 60 * 60,
      });
      return `banned <@${action.userId}>`;
    }

    case 'delete': {
      // The message is only to hand on the path that started from it. An
      // approved card arriving minutes later has no message to delete, and
      // saying so is better than silently succeeding.
      if (!message) throw new Error('the message this referred to is no longer to hand');
      await deleteMessage(message, action.reason);
      return 'deleted the message';
    }

    case 'dm': {
      // A letter, and whose errand it was.
      //
      // The signature is not decoration and is not optional: it is the entire
      // reason this runs for everybody rather than only for Owners. Anyone can
      // send a message through him; nobody can send one anonymously, so the
      // worst use of it costs the sender their own name.
      const member = await guild.members.fetch(action.userId);
      const asker = requester?.displayName || requester?.user?.username || null;
      const body = String(action.text).trim().slice(0, CAPABILITIES.dm.maxLength);

      await member.send({
        content: `${body}\n\n-# — Sheogorath, ${asker ? `at ${asker}'s bidding` : 'of his own accord'}, out of ${guild.name}`,
        // The same rule his replies follow: people can be pinged, a room cannot.
        allowedMentions: { parse: ['users'] },
      }).catch((err) => {
        // Closed DMs are the usual answer and are not a fault of his. Said
        // plainly so he can tell the asker why the letter came back.
        throw new Error(`<@${action.userId}> will not take letters from me (${err.message})`);
      });

      return `sent <@${action.userId}> a message${asker ? ` for ${asker}` : ''}`;
    }

    case 'nudge': {
      // A dm, repeated until they turn up. Signed the same way, for the same reason.
      const { startNudge } = require('../services/nudges');
      const member = await guild.members.fetch(action.userId);
      const asker = requester?.displayName || requester?.user?.username || null;
      const { times, every } = await startNudge({
        member,
        text: String(action.text).trim().slice(0, CAPABILITIES.nudge.maxLength),
        times: action.times,
        every: action.every,
        asker,
      });
      return times > 1
        ? `sent <@${action.userId}> the first of up to ${times} messages, ${every} minute(s) apart, stopping when they turn up`
        : `sent <@${action.userId}> a message`;
    }

    case 'say': {
      // Speaking in a room he is not standing in.
      //
      // Resolved by name or ID against the guild's own channel list, so a
      // channel he was told about but cannot see does not become a silent
      // failure — and never outside this guild, whatever the tag said.
      const wanted = String(action.channel).replace(/^#/, '').trim();
      const target =
        guild.channels.cache.get(wanted) ||
        guild.channels.cache.find((c) => c.name === wanted && c.isTextBased?.());

      if (!target || !target.isTextBased?.()) {
        throw new Error(`there is no channel called "${action.channel}" that I can speak in`);
      }
      const me = guild.members.me || (await guild.members.fetchMe());
      if (!target.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
        throw new Error(`I am not permitted to speak in ${target.name}`);
      }

      const asker = requester?.displayName || requester?.user?.username || null;
      await target.send({
        content: String(action.text).trim().slice(0, CAPABILITIES.say.maxLength) +
          (asker ? `\n\n-# — carried from elsewhere at ${asker}'s bidding` : ''),
        allowedMentions: { parse: ['users'] },
      });
      return `spoke in #${target.name}${asker ? ` for ${asker}` : ''}`;
    }

    case 'untitle': {
      // Taking a title back, held to exactly the test that gave it out: he can
      // only remove a role that he could have created. Calling a real role a
      // "title" does not make it one.
      const me = guild.members.me || (await guild.members.fetchMe());
      if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        throw new Error('I have no authority over roles in this place — someone must grant me Manage Roles');
      }

      const name = String(action.title).replace(/\s+/g, ' ').trim();
      const member = await guild.members.fetch(action.userId);
      const role = member.roles.cache.find((r) => r.name === name);
      if (!role) throw new Error(`<@${action.userId}> is not carrying anything called "${name}"`);
      if (!isCosmetic(role, me.roles.highest.position)) {
        throw new Error(`"${name}" is not one of my titles — it is a real role, and not mine to take`);
      }

      await member.roles.remove(role, `[Sheogorath] title removed: ${name}`);

      // Swept up when the last wearer puts it down. A server slowly filling
      // with empty roles nobody holds is the litter this power would otherwise
      // leave behind.
      if (role.members.size === 0) {
        await role.delete(`[Sheogorath] nobody left wearing "${name}"`).catch(() => {});
      }
      return `took "${name}" back off <@${action.userId}>`;
    }

    case 'react': {
      if (!message) throw new Error('there is no message here to react to');
      // Discord rejects anything that is not an emoji it knows, and the error
      // is unreadable, so it is said plainly instead.
      await message.react(action.emoji).catch(() => {
        throw new Error(`${action.emoji} is not an emoji I can put on a message here`);
      });
      return `reacted ${action.emoji}`;
    }

    case 'pin': {
      if (!message) throw new Error('there is no message here to pin');
      const me = guild.members.me || (await guild.members.fetchMe());
      if (!message.channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) {
        throw new Error('I am not permitted to pin things in this channel');
      }
      // A full pin list is the usual failure and reads as a bug otherwise.
      await message.pin(`[Sheogorath] ${action.reason}`).catch((err) => {
        throw new Error(`I could not pin it (${err.message}) — the channel's pins may be full`);
      });
      return 'pinned the message';
    }

    case 'thread': {
      if (!message) throw new Error('there is no message here to open a thread on');
      const me = guild.members.me || (await guild.members.fetchMe());
      if (!message.channel.permissionsFor(me)?.has(PermissionFlagsBits.CreatePublicThreads)) {
        throw new Error('I am not permitted to open threads in this channel');
      }
      const name = String(action.name).replace(/\s+/g, ' ').trim().slice(0, CAPABILITIES.thread.maxLength);
      const thread = await message.startThread({ name, reason: '[Sheogorath] a room of its own' });
      return `opened a thread: ${thread.name}`;
    }

    case 'poll': {
      if (!message) throw new Error('there is nowhere here to put a poll');
      const options = action.options.slice(0, CAPABILITIES.poll.maxOptions);
      await message.channel.send({
        poll: {
          question: { text: String(action.question).slice(0, 300) },
          answers: options.map((text) => ({ text: String(text).slice(0, 55) })),
          duration: 24,
          allowMultiselect: false,
        },
      });
      return `put a poll to the room: ${action.question}`;
    }

    case 'nick': {
      const me = guild.members.me || (await guild.members.fetchMe());
      if (!me.permissions.has(PermissionFlagsBits.ManageNicknames)) {
        throw new Error('I cannot rename anyone here — someone must grant me Manage Nicknames');
      }
      const member = await guild.members.fetch(action.userId);

      // Discord refuses this for anyone at or above him anyway; saying so is
      // better than handing back a 50013 nobody can read.
      if (member.roles.highest.comparePositionTo(me.roles.highest) >= 0) {
        throw new Error(`<@${action.userId}> stands too high for me to rename`);
      }
      const name = String(action.name).replace(/\s+/g, ' ').trim().slice(0, CAPABILITIES.nick.maxLength);
      const was = member.displayName;
      await member.setNickname(name, '[Sheogorath] renamed');
      return `renamed ${was} to "${name}"`;
    }

    case 'channel': {
      const me = guild.members.me || (await guild.members.fetchMe());
      if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        throw new Error('I cannot make rooms here — someone must grant me Manage Channels');
      }
      // Discord lowercases and hyphenates text channel names itself; doing it
      // here means the name he reports back is the name people will see.
      const name = String(action.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '').slice(0, CAPABILITIES.channel.maxLength);
      if (!name) throw new Error('that name leaves nothing a channel could be called');
      if (guild.channels.cache.some((c) => c.name === name)) {
        throw new Error(`there is already a #${name}`);
      }
      const channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        topic: action.topic ? String(action.topic).slice(0, 1024) : undefined,
        parent: message?.channel?.parentId || null,
        reason: '[Sheogorath] a new room',
      });
      return `made #${channel.name}`;
    }

    case 'title': {
      // Where the limits on this one actually live.
      //
      // The gate upstream decides WHETHER he may hang a title on somebody; it
      // knows nothing about Discord roles, and a role is the one object here
      // that can carry real power. So every check that keeps a title cosmetic
      // is made at the moment of doing it, against Discord's own answer rather
      // than against anything the model said.
      const me = guild.members.me || (await guild.members.fetchMe());
      if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        throw new Error('I have no authority over roles in this place — someone must grant me Manage Roles');
      }

      const name = String(action.title).replace(/\s+/g, ' ').trim().slice(0, CAPABILITIES.title.maxLength);
      if (!name) throw new Error('that is not a title, it is a silence');

      const member = await guild.members.fetch(action.userId);
      const ceiling = me.roles.highest.position;

      // Reuse a role of that name only when it is as toothless as one he would
      // have made. An existing "Admin" role is a trap: same name, real power,
      // and handing it out would be the whole game lost in one line of chat.
      const existing = guild.roles.cache.find((r) => r.name === name && r.id !== guild.id);
      if (existing && !isCosmetic(existing, ceiling)) {
        throw new Error(
          `there is already a role called "${name}" that carries weight — I hand out titles, not power`,
        );
      }

      const role = existing || await guild.roles.create({
        name,
        // No permissions, ever. Not a default, not a starting point.
        permissions: [],
        mentionable: false,
        // A title nobody can see is half a title. The colour is what puts it in
        // the member list and on the name, which is the whole point of being
        // given one — picked from the name so the same title is the same colour
        // wherever it turns up, rather than a new one each time.
        color: TITLE_COLOURS[hashOf(name) % TITLE_COLOURS.length],
        reason: `[Sheogorath] title granted to ${member.user.username}`,
      });

      // Made at the bottom of the list and left there: a cosmetic role that
      // outranks anything is no longer cosmetic.
      if (!existing) {
        await role.setPosition(1).catch(() => {});
      }

      await member.roles.add(role, `[Sheogorath] title: ${name}`);
      return `gave <@${action.userId}> the title "${name}"`;
    }

    case 'flag':
      // Nothing is done to anyone. The whole effect is the audit record, which
      // mirrors to the staff channel with the reason and a link to the message —
      // so this executor's only job is to say what happened.
      return `flagged a manipulation attempt by <@${action.userId}> — ${action.reason}`;

    case 'note': {
      const userId = await resolveMemberId(guild, action.userId);
      addUserNote(guildId, userId, action.note);
      return `noted against <@${userId}>`;
    }

    case 'clearnotes': {
      const userId = await resolveMemberId(guild, action.userId);
      const cleared = clearUserNotes(guildId, userId);
      // Says the number, not just the deed. A clear that matched nothing used
      // to report success in the same words as one that emptied a full file,
      // which is how someone asking to be forgotten got told they had been.
      return cleared
        ? `cleared ${cleared} note${cleared === 1 ? '' : 's'} for <@${userId}>`
        : `found no notes to clear for <@${userId}>`;
    }

    case 'memory': {
      const userId = await resolveMemberId(guild, action.userId);
      addMemory(guildId, userId, action.memory);
      return `remembered something about <@${userId}>`;
    }

    case 'event': {
      // The rules about who may move what live with the calendar, so this only
      // works out who is asking and says what happened. The follow-up carries
      // the time as Discord renders it, in everyone's own zone — the model
      // narrates what it meant, and this is what it did.
      const events = require('../services/events');
      const member = requester;
      if (!member) throw new Error('I cannot tell who is asking');
      const existing = events.findEvent(guildId, action.name);
      if (action.cancel) {
        if (!existing) throw new Error(`there is no event called "${action.name}" coming up`);
        const gone = await events.removeEvent(guild.client, guild, existing.key, member);
        await follow([`🗑️ **${gone.name}** is off the calendar.`]);
        return `took "${gone.name}" off the calendar`;
      }
      const fields = { when: action.when, hours: action.hours, where: action.where };
      const { ev, discordEvent } = existing
        ? await events.editEvent(guild.client, guild, existing.key, fields, member)
        : await events.addEvent(guild.client, guild, { name: action.name, ...fields }, member);
      const at = Math.floor(ev.start.getTime() / 1000);
      await follow([{
        content: `📅 **${ev.name}** — <t:${at}:F> (<t:${at}:R>)${discordEvent ? `\n${discordEvent.url}` : ''}`,
        allowedMentions: { parse: [] },
      }]);
      return `${existing ? 'moved' : 'put'} "${ev.name}" ${existing ? 'to' : 'on the calendar for'} ${ev.start.toISOString()}`;
    }

    case 'ruling': {
      // His reply is the ruling; the book only needs the question and the gist.
      const ledger = require('../services/ledger');
      const ruling = ledger.addRuling(guildId, {
        question: action.question,
        verdict: action.verdict,
        by: requester?.id || null,
        byName: requester?.displayName || null,
        url: message?.url || null,
      });
      await follow([`-# 📜 ${ruling.replaced ? 'Revised' : 'Entered'} in the Ledger as **${ruling.id}**.`]);
      return `ruled on "${ruling.question}" (${ruling.id})`;
    }

    case 'quote': {
      // Kept from the message the asker replied to, never from anything he
      // wrote: a quote is only worth keeping if it is what was actually said.
      const ledger = require('../services/ledger');
      const refId = message?.reference?.messageId;
      if (!refId) throw new Error('reply to the message you want kept, and ask me again');
      const said = await message.channel.messages.fetch(refId).catch(() => null);
      if (!said) throw new Error('I cannot find the message that was replied to');
      const { quote, already } = ledger.keepMessage(guildId, said, requester?.id || null);
      await follow([`-# 📜 ${already ? 'Already' : 'Kept'} in the Ledger as **${quote.id}**.`]);
      return already ? `found it already kept as ${quote.id}` : `kept <@${quote.authorId}>'s words as ${quote.id}`;
    }

    case 'bet': {
      // Always the asker's bet, put to whoever they named. The card's button is
      // the other person's consent, so nothing here commits anybody but the asker.
      const ledger = require('../services/ledger');
      if (!requester) throw new Error('I cannot tell who is betting');
      let against = null;
      if (action.userId) {
        const id = await resolveMemberId(guild, action.userId);
        against = await guild.members.fetch(id).catch(() => null);
        if (!against) throw new Error('whoever that is, they are not in this server');
        if (against.user.bot) throw new Error('bots do not bet');
      }
      const bet = ledger.offerBet(guildId, {
        by: requester.id,
        byName: requester.displayName,
        against: against?.id || null,
        againstName: against?.displayName || null,
        terms: action.terms,
        stakes: action.stakes,
        settleBy: action.settleBy,
        channelId: message?.channelId || null,
      });
      await follow([async (channel) => {
        const card = await channel.send(ledger.offerMessage(bet));
        ledger.attachCard(guildId, bet.id, card);
      }]);
      return `put ${requester.displayName}'s bet to ${against ? `<@${against.id}>` : 'the room'} (${bet.id})`;
    }

    default:
      throw new Error(`no executor for "${action.type}"`);
  }
}

/** One-line rendering of a pending action, for approval cards and logs. */
function describeAction(action) {
  switch (action.type) {
    case 'timeout':   return `Time out <@${action.userId}> for ${action.duration} minute(s) — ${action.reason}`;
    case 'warn':      return `Warn <@${action.userId}> — ${action.reason}`;
    case 'kick':      return `Kick <@${action.userId}> — ${action.reason}`;
    case 'ban':       return `Ban <@${action.userId}> (deleting ${action.deleteDays || 0}d of messages) — ${action.reason}`;
    case 'delete':    return `Delete the triggering message — ${action.reason}`;
    case 'flag':      return `🚩 Manipulation attempt by <@${action.userId}> — ${action.reason}`;
    case 'note':      return `Note against <@${action.userId}>: ${action.note}`;
    case 'clearnotes':return `Clear all notes for <@${action.userId}>`;
    case 'memory':    return `Remember about <@${action.userId}>: ${action.memory}`;
    case 'title':     return `Give <@${action.userId}> the title "${action.title}"`;
    case 'untitle':   return `Take the title "${action.title}" back off <@${action.userId}>`;
    case 'dm':        return `Send <@${action.userId}> a private message: ${action.text}`;
    case 'nudge':     return `Message <@${action.userId}> up to ${action.times} times, ${action.every}m apart, until they turn up: ${action.text}`;
    case 'say':       return `Speak in ${action.channel}: ${action.text}`;
    case 'react':     return `React ${action.emoji} to the triggering message`;
    case 'pin':       return `Pin the triggering message — ${action.reason}`;
    case 'thread':    return `Open a thread called "${action.name}"`;
    case 'poll':      return `Poll the room — "${action.question}" (${action.options.join(', ')})`;
    case 'nick':      return `Rename <@${action.userId}> to "${action.name}"`;
    case 'channel':   return `Make a channel called #${action.name}`;
    case 'event':     return action.cancel
      ? `Take "${action.name}" off the calendar`
      : `Put "${action.name}" on the calendar${action.when ? ` for ${action.when}` : ''}`;
    case 'ruling':    return `Rule on "${action.question}": ${action.verdict}`;
    case 'quote':     return 'Keep the message being replied to in the Ledger';
    case 'bet':       return `Put a bet to ${action.userId ? `<@${action.userId}>` : 'the room'}: ${action.terms}`;
    default:          return `${action.type} ${JSON.stringify(action)}`;
  }
}

module.exports = { runAction, describeAction };
