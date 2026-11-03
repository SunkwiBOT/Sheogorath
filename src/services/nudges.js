'use strict';
/**
 * "Send Allister messages until he responds."
 *
 * He could send one DM, said he would keep an eye out, and then had no way to
 * send another. A nudge is a short chain of DMs: the first goes now, the rest
 * at an interval, and the chain stops the moment the person is heard from —
 * a message in any server he shares with them, joining voice, or a DM back.
 *
 * Kept in memory. A chain is minutes long, and one cut short by a restart
 * costs a reminder, not anything that matters.
 */

/** Most DMs in one chain, the first included. */
const MAX_TIMES = 5;
/** Interval bounds, in minutes. */
const MIN_EVERY = 1;
const MAX_EVERY = 30;
const DEFAULT_TIMES = 3;
const DEFAULT_EVERY = 3;

/** userId → { timer, sent, times, asker, guildName } */
const chains = new Map();

function stop(userId) {
  const c = chains.get(userId);
  if (!c) return null;
  clearTimeout(c.timer);
  chains.delete(userId);
  return c;
}

/** They were heard from: any chain on them is done. */
function heardFrom(userId) {
  const c = stop(userId);
  if (c) console.log(`[Nudges] ${userId} answered after ${c.sent} nudge(s) for ${c.asker || 'nobody'}.`);
}

/**
 * Start a chain on `member`. Replaces any chain already running on them, so
 * asking twice does not double the messages.
 *
 * @param {object} opts
 * @param {import('discord.js').GuildMember} opts.member
 * @param {string} opts.text        what each DM says
 * @param {number} [opts.times]     how many DMs in all
 * @param {number} [opts.every]     minutes between them
 * @param {string|null} [opts.asker] whose errand it is, for the signature
 * @returns {Promise<{times: number, every: number}>}
 */
async function startNudge({ member, text, times = DEFAULT_TIMES, every = DEFAULT_EVERY, asker = null }) {
  const n = Math.max(1, Math.min(MAX_TIMES, Math.round(times) || DEFAULT_TIMES));
  const gap = Math.max(MIN_EVERY, Math.min(MAX_EVERY, Math.round(every) || DEFAULT_EVERY));
  stop(member.id);

  const chain = { timer: null, sent: 0, times: n, asker };
  const send = async () => {
    chain.sent += 1;
    const count = n > 1 ? ` (${chain.sent} of ${n})` : '';
    await member.send({
      content: `${text}${count}\n\n-# — Sheogorath, ${asker ? `at ${asker}'s bidding` : 'of his own accord'}, out of ${member.guild.name}. `
        + 'Say anything in the server, hop in voice, or answer here and these stop.',
      allowedMentions: { parse: ['users'] },
    });
  };

  // The first one goes now, and its failure is the asker's answer.
  await send().catch((err) => {
    throw new Error(`<@${member.id}> will not take letters from me (${err.message})`);
  });

  if (n > 1) {
    chains.set(member.id, chain);
    const next = () => {
      if (chains.get(member.id) !== chain) return;
      send().then(() => {
        if (chain.sent >= n) stop(member.id);
        else chain.timer = setTimeout(next, gap * 60 * 1000);
      }).catch((err) => {
        console.warn(`[Nudges] Could not nudge ${member.id}: ${err.message}`);
        stop(member.id);
      });
    };
    chain.timer = setTimeout(next, gap * 60 * 1000);
  }
  return { times: n, every: gap };
}

module.exports = { startNudge, heardFrom, stop, MAX_TIMES, MAX_EVERY, MIN_EVERY };
