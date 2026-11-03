'use strict';
/**
 * Discord, as one of the places he can be spoken to.
 *
 * Everything in here is true of Discord and of nowhere else: mentions written
 * as `<@id>`, a typing indicator, a 2000-character ceiling, subtext written
 * with `-#`, and actions that mean something because there is a Guild behind
 * them. The conversation itself lives in ./respond.js, which has never heard of
 * any of that.
 *
 * Read this as the worked example. A Twitch or Kick or YouTube surface is the
 * same five members — persona, context, executeActions, resultNotes, remember —
 * filled in with that platform's answers, and most of them are much smaller
 * than these: no mention syntax to unpick, no transcript to fetch, and, at
 * least to begin with, no powers at all.
 */
const { respond, coolingDown, CHAT_HISTORY } = require('./respond');
const { conversationalPersona } = require('../ai/persona');
const { executeActions } = require('../ai/actions');
const { isBudgetError } = require('../ai/budget');
const { getGuildConfig, channelId, aiTitles } = require('../config/guilds');
const {
  isParlour, parlourPersona, PARLOUR_PROMPT, PARLOUR_HISTORY, PARLOUR_MAX_TOKENS,
} = require('../services/parlour');
const { notifyError } = require('../utils/errorNotify');

/** Discord's hard limit on one message. */
const MESSAGE_LIMIT = 2000;

/**
 * Names come in readable and go out as pings, if he wants them to.
 *
 * "Tell @Fisher to stop" is a request to get Fisher's attention, and a plain
 * @Fisher in his reply is just text — the man never hears it. He cannot guess
 * the syntax without the ID, so the IDs of the people this message named are
 * handed over with it. Only those: he is given the means to answer the summons
 * in front of him, not a directory to shout into.
 */
async function resolveMentions(client, sourceContent) {
  let cleanedContent = sourceContent;
  const mentioned = [];
  const mentionRegex = /<@!?(\d+)>/g;
  let match;
  while ((match = mentionRegex.exec(sourceContent)) !== null) {
    try {
      const user = await client.users.fetch(match[1]);
      cleanedContent = cleanedContent.replace(match[0], `@${user.username}`);
      if (user.id !== client.user.id && !mentioned.some((m) => m.id === user.id)) {
        mentioned.push({ id: user.id, name: user.username });
      }
    } catch (e) { /* keep original mention */ }
  }

  const ping = mentioned.length
    ? `[People named in this message, and how to make their name light up if you want their `
      + `attention — write it exactly, including the angle brackets: `
      + `${mentioned.map((m) => `${m.name} = <@${m.id}>`).join(', ')}. `
      + `Optional. A ping is for when you actually want them to look]:\n`
    : '';

  return { cleanedContent, ping };
}

/** Everything the room can tell him, gathered per turn and never stored. */
async function gatherContext(userMessage, { cleanedContent, ping, isHelpChannel, inParlour, imageSources }) {
  const guildId = userMessage.guildId;
  const blocks = { ping };
  let deepRecall = false;

  // What this server actually is, plus whichever reference material matches the
  // question. Prefixed onto this turn rather than pushed into history, so a
  // fact true a minute ago isn't still being quoted as current five exchanges
  // later.
  try {
    const { knowledgeFor } = require('../services/knowledge');
    blocks.knowledge = await knowledgeFor({
      guildId,
      guild: userMessage.guild,
      question: cleanedContent,
      isHelp: isHelpChannel,
      // His own authority, and the asker's verified role tier. Both are looked
      // up rather than taken from anything the message said.
      guildConfig: getGuildConfig(guildId),
      requester: userMessage.member,
    });
  } catch (err) {
    // He answers from the persona alone rather than not answering. The
    // grounding rule goes with the block, so this is the one path where he can
    // still invent — logged loudly for that reason.
    console.error('[Knowledge] Could not build context, answering ungrounded:', err?.message || err);
  }

  // The conversation happening around him, which is not the same thing as the
  // conversation he has been having with this one person.
  try {
    const {
      transcriptFor, replyTargetFor, wantsRecall, PARLOUR_TRANSCRIPT, RECALL_TRANSCRIPT,
    } = require('../services/transcript');

    // Three windows, and the question picks which. "What's going on" wants the
    // room; "what happened yesterday" wants four times as much and is asked
    // about once a day, so it is bought per question rather than carried on
    // every reply.
    deepRecall = wantsRecall(cleanedContent);
    const window = deepRecall ? RECALL_TRANSCRIPT : (inParlour ? PARLOUR_TRANSCRIPT : {});
    if (deepRecall) console.log(`[Transcript] Deep recall for ${userMessage.author.username}`);

    // Only a question that reaches back makes the log the subject. Everywhere
    // else it is background he happens to have, and saying so is the difference
    // between a bot that knows the room and one that cannot stop reciting it.
    blocks.chat = await transcriptFor(userMessage, { ...window, asSubject: deepRecall });

    // Kept apart from the room, because the two belong at opposite ends of the
    // prompt. The room is background; the message somebody is replying to is
    // the thing their words are about, and when it travelled with the room to
    // the far end he answered a reply by repeating his own last message.
    blocks.reply = await replyTargetFor(userMessage);
  } catch (err) {
    console.warn('[Transcript] Skipped:', err?.message || err);
  }

  // What was taken back, and only when somebody is asking about it.
  try {
    const { deletionsFor } = require('../services/deletions');
    blocks.deletions = deletionsFor(guildId, cleanedContent, userMessage.channelId);
  } catch (err) {
    console.warn('[Deletions] Skipped:', err?.message || err);
  }

  // The pictures this turn is about. After the transcript on purpose: its fetch
  // fills the channel cache, which is where "what they posted just before" is
  // looked for, so that costs nothing extra.
  let images = [];
  let lookup = false;
  try {
    const { picturesFor, wantsLookup } = require('../services/vision');
    const seen = await picturesFor(userMessage, { sources: imageSources, text: cleanedContent });
    images = seen.images;
    blocks.attachments = seen.note;
    lookup = wantsLookup(cleanedContent);
    if (lookup && images.length) console.log(`[Vision] Reverse lookup for ${userMessage.author.username}`);
  } catch (err) {
    console.warn('[Vision] Skipped:', err?.message || err);
  }

  return { blocks, deepRecall, images, lookup };
}

/**
 * The footnotes: held, refused, and tried-and-broke.
 *
 * Told twice, in two different places, to say "I have asked" rather than "it is
 * done" for anything held for approval, he kept announcing held actions as
 * completed — "restarting in five minutes!" for a restart no Sheriff had
 * approved yet. The gate already knows the verdict, so there is no reason to be
 * asking the model to remember it. Appended as Discord subtext so it reads as a
 * note rather than as him talking.
 */
function resultNotes(actionResults, guildId) {
  const titles = aiTitles(getGuildConfig(guildId));
  const notes = [];

  const proposed = actionResults.filter(r => r.verdict === 'propose');
  if (proposed.length) {
    notes.push(
      `-# ⏳ Sent to the ${titles.approver}s for approval — **nothing has happened yet**. `
      + `${proposed.length === 1 ? 'It runs' : 'They run'} only once ${
        titles.approver.match(/^[aeiou]/i) ? 'an' : 'a'} ${titles.approver} approves in the log channel.`,
    );
  }

  const refused = actionResults.filter(r => r.verdict === 'deny');
  if (refused.length) {
    notes.push(`-# ⛔ Refused: ${refused.map(r => r.reason).join('; ')}.`);
  }

  // Allowed, attempted, and then it threw. Left unsaid, a member is told they
  // have been given something they have not, and goes looking for it — which is
  // precisely how a failed title turned into four minutes of being told to
  // reload Discord.
  const failed = actionResults.filter(r => r.error);
  if (failed.length) {
    notes.push(`-# ⚠️ That did not work: ${failed.map(r => r.error).join('; ')}.`);
  }

  return notes;
}

/** Send, splitting at the platform's ceiling on a space or a newline if we can. */
async function sendReply(userMessage, reply) {
  const chunks = [];
  let remaining = reply;
  while (remaining.length > 0) {
    if (remaining.length <= MESSAGE_LIMIT) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', MESSAGE_LIMIT);
    if (splitAt < 1000) splitAt = remaining.lastIndexOf(' ', MESSAGE_LIMIT);
    if (splitAt < 1000) splitAt = MESSAGE_LIMIT;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  for (let i = 0; i < chunks.length; i++) {
    // People can be pinged; @everyone and role pings cannot. He is handed user
    // IDs so he can answer "tell so-and-so..." properly, and talking him into a
    // mass ping should not be one line of chat away.
    const mentions = { allowedMentions: { parse: ['users'] } };
    if (i === 0) {
      await userMessage.reply({ content: chunks[i], ...mentions });
    } else {
      await userMessage.channel.send({ content: chunks[i], ...mentions });
    }
  }
}

/**
 * Answer a Discord message.
 *
 * @param {import('discord.js').Message} userMessage the message to reply to
 * @param {object} [opts]
 * @param {string} [opts.contentOverride] text to answer instead of that
 *   message's own content — used by the help debounce, which has several
 *   messages' worth of question to hand and one message to reply to.
 * @param {number} [opts.maxTokens] override the reply ceiling. Left undefined
 *   everywhere but #help, so ordinary chat keeps the shared default.
 * @param {import('discord.js').Message[]} [opts.imageSources] every message
 *   whose pictures belong to the question — the whole burst, for #help.
 *   Defaults to the message being answered.
 */
async function askChatGPT(userMessage, { contentOverride = null, maxTokens = undefined, imageSources = [userMessage] } = {}) {
  const guildId = userMessage.guildId;
  const client = userMessage.client;

  // Nothing visible happens for a turn that is about to be dropped — respond()
  // still makes the real decision, and logs it.
  const dropped = coolingDown(guildId, userMessage.author.id);

  let typingInterval = null;
  if (!dropped) {
    // Keep the "is typing" indicator alive every 8s until we're done.
    userMessage.channel.sendTyping().catch(() => {});
    typingInterval = setInterval(() => {
      userMessage.channel.sendTyping().catch(() => {});
    }, 8000);
  }
  const stopTyping = () => { if (typingInterval) clearInterval(typingInterval); };

  try {
    const isHelpChannel = userMessage.channelId === channelId(guildId, 'help');
    const inParlour = isParlour(guildId, userMessage.channelId);
    const { cleanedContent, ping } = await resolveMentions(
      client, contentOverride || userMessage.content,
    );

    const turn = {
      spaceId: guildId,
      roomId: userMessage.channelId,
      userId: userMessage.author.id,
      username: userMessage.author.username,
      text: cleanedContent,
    };

    const surface = {
      // The persona's own "1-2 sentences max" is cut either way and replaced
      // with the right length for the room: none at all in the parlour, a few
      // sentences everywhere else. Someone who has gone to the trouble of
      // addressing him deserves more than a punchline.
      persona: () => ({
        systemBase: inParlour ? parlourPersona() : conversationalPersona(),
        systemSuffix: inParlour ? PARLOUR_PROMPT : '',
        guildId,
        // The parlour is the only place either is raised.
        historyDepth: inParlour ? PARLOUR_HISTORY : CHAT_HISTORY,
        maxTokens: inParlour ? PARLOUR_MAX_TOKENS : maxTokens,
        // #help stays on Grok: it is where a wrong answer costs someone the
        // most, and the local voice invented facts in testing.
        localVoice: !isHelpChannel && getGuildConfig(guildId)?.ai?.localVoice !== false,
      }),
      context: () => gatherContext(userMessage, { cleanedContent, ping, isHelpChannel, inParlour, imageSources }),
      executeActions: (actions, { followUps }) => executeActions(actions, {
        guild: userMessage.guild,
        message: userMessage,
        guildId,
        followUps,
        // Who Sheogorath is replying to, and their roles. The gate needs both:
        // the first bounds who he may act on unasked, the second decides
        // whether this person can point him at anyone else.
        authorId: userMessage.author.id,
        requester: userMessage.member,
      }),
      resultNotes: (results) => resultNotes(results, guildId),
      // Skipped in #help: it is a second billed request on every single
      // message, and a troubleshooting channel is the least likely place for
      // someone to reveal a fact worth keeping. Halves the cost of the busiest
      // channel.
      remember: !isHelpChannel,
    };

    const answer = await respond(turn, surface);
    stopTyping();
    if (!answer) return;

    await sendReply(userMessage, answer.text);

    // Anything an action produced for the channel goes out after he has spoken,
    // so the introduction reads as an introduction.
    // A part may be a function of the channel, for a post whose message has to
    // be kept (a bet's card, which is edited as the bet moves).
    for (const part of answer.followUps) {
      const post = typeof part === 'function' ? part(userMessage.channel) : userMessage.channel.send(part);
      await Promise.resolve(post).catch(err =>
        console.warn('[Actions] Could not post follow-up:', err.message));
    }
  } catch (error) {
    stopTyping();

    // Out of allowance is a decision, not a fault. It gets a straight answer in
    // his own voice rather than an error card, and it is not reported as a
    // crash — the owner already knows, having been told at 50, 80 and 95%.
    if (isBudgetError(error)) {
      console.log(`[AI] Refused — monthly budget spent: ${error.message}`);
      const { approvers } = aiTitles(getGuildConfig(guildId));
      await userMessage.reply(
        "The Mad God's coffers are empty for this month, mortal. Even madness runs on coin. "
        + `Go and pester the ${approvers} about my allowance.`,
      ).catch(() => {});
      return;
    }

    console.error('Error in askChatGPT:', error.message);
    notifyError(`askChatGPT failed for ${userMessage.author.username}`, error);
    await userMessage.reply('❌ An error occurred while trying to fetch the AI response. The Mad King is... temporarily indisposed.')
      .catch(() => {});
  }
}

module.exports = { askChatGPT };
