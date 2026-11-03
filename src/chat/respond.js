'use strict';
/**
 * The part of him that thinks, with nothing in it that knows what Discord is.
 *
 * Everything here used to live inside askChatGPT() in index.js, wrapped around
 * a discord.js Message — it read `.author.username`, called `.channel.send()`,
 * and handed a Guild to the action executors. None of that is thinking; it is
 * the shape of one particular room he happens to speak in. Twitch, Kick and
 * YouTube chat are the same conversation through a different window, and a
 * second copy of this file per window is how a persona ends up behaving like
 * three different characters.
 *
 * So the split is: this module owns the conversation — cooldowns, history,
 * notes, memories, prompt assembly, the repetition retry, the actions he asks
 * for and the record kept afterwards. A *surface* owns everything that is true
 * only of where he is standing: what the room's text looks like once it is
 * cleaned up, what context can be gathered there, which persona length fits,
 * what an action even means on that platform, and how a reply gets sent.
 *
 * A surface is a plain object with these members. Only `persona` is required.
 *
 *   persona()                  -> { systemBase, systemSuffix?, guildId?,
 *                                   historyDepth?, maxTokens? }
 *   context({ turn })          -> { blocks?: {chat, knowledge, deletions,
 *                                   reply, attachments, ping},
 *                                   deepRecall?: boolean,
 *                                   images?: [{caption, mime, data}],
 *                                   lookup?: boolean }
 *   executeActions(acts, ctx)  -> Array<result>   (omitted: he is read-only)
 *   resultNotes(results)       -> Array<string>   (what to append about them)
 *   remember                   -> boolean         (mine this turn for facts?)
 *
 * A `turn` is the message itself, already stripped of whatever markup its
 * platform writes names in:
 *
 *   { spaceId, roomId, userId, username, text }
 *
 * `spaceId` is the server, channel or stream he is being spoken to in — a
 * Discord guild id today, `twitch:allisteras` later. It is the key that notes,
 * memories and conversation history hang off, so two surfaces sharing a
 * spaceId deliberately share a mind, and two that do not, do not.
 */
const { getAIResponseWithHistory, getAIResponse, extractMemoryFromMessage, buildSystemPrompt } = require('../ai/grok');
const { speak } = require('../ai/voice');
const { addMemory, formatMemoriesForContext } = require('../storage/memory');
const {
  getUserNotes, addUserNote, getUserActivity, setUserActivity,
} = require('../storage/state');
const { parseActions, scrub } = require('../ai/actions');
const { isBudgetError } = require('../ai/budget');

/**
 * Said once, above the pictures, so he knows they are his to look at.
 *
 * Both halves are corrections of things he actually said: that he had seen
 * pictures he had not, and that "as a text-based AI" he could not see one he
 * had been sent.
 */
const SEEING =
  '[You can SEE the picture(s) below — this person is showing them to you. Answer about what is '
  + 'actually in them, in your own voice. Never say you cannot see images, and never describe a '
  + 'picture you were not shown]:';

/** The extra instruction for a turn that asks where a picture came from. */
const LOOKUP_SUFFIX =
  '\n\nTHIS TURN they want to know where a picture came from, and you have web search. Trace it: what '
  + 'it is from (a game, film, show, meme, artwork, news story), who made it, and where it first '
  + 'appeared. If a person is in the picture, try to identify them — search for who they are, where '
  + 'the photo appeared, and any profiles or accounts it leads to. Say how sure you are, and give at '
  + 'most two links to the best sources. If you cannot find it, say so plainly rather than inventing '
  + 'a source. Stay in character — the facts are the point, but it is still you saying them.';

/**
 * A question about the world right now, or a plain "look it up". Without
 * search he answered news with "my knowledge cutoff is 2021" (the local voice)
 * or with a confident guess (Grok). Bought per question, like the picture
 * lookup: a search costs more than a reply.
 */
const WEB_PATTERN = /\b(news|headlines?|latest|yesterday|last night|this (?:week|weekend|morning)|what happened|who won|final score|odds|price of|stock price|weather|forecast|look (?:it |that |this |him |her |them )?up|search (?:for|up)|google|find (?:me )?(?:a |an |the |some )?(?:pic|pics|picture|photo|image|article|link|video|clip|source)s?|crash(?:ed)?|died|killed|arrested|shooting|election|announced|released|patch notes|current events|going on in the world)\b/i;

function wantsWeb(text) {
  return WEB_PATTERN.test(text || '');
}

/** The extra instruction for a turn that wants the web. */
const WEB_SUFFIX =
  '\n\nTHIS TURN the question is about something current, or something to look up, and you have web '
  + 'search. Search before you answer, and answer from what you found, not from memory: what happened, '
  + 'when, and who, in plain words. Give one or two links to the best sources. Asked for a picture, link '
  + 'one you found, a direct image link where you can get one, since those show in Discord. Say plainly '
  + 'if you could not find it. Never mention a knowledge cutoff: you just searched. Stay in character.';

/** In place of the pictures, when Grok would not take them. */
const UNOPENED =
  '[They attached picture(s) that would not open for you. Say you could not look, rather than '
  + 'guessing at what was in them]:\n';

/**
 * How many past entries of a conversation he is handed by default.
 *
 * Counted in entries, not exchanges — each turn stores two of them, the user's
 * line and his reply — so four is two exchanges. That is all it needs to be:
 * the room itself is carried by whatever transcript the surface gathers, and
 * what history adds on top is only the thread of what HE said to THIS person,
 * which a busy channel's log alone can lose track of when several conversations
 * are interleaved. A surface that wants more says so in persona().
 */
const CHAT_HISTORY = 4;

/**
 * How long a conversation with him survives silence.
 *
 * History used to keep until a restart. On 2026-10-05 someone asked him at 7pm
 * to explain the Wabbajack, and the local voice answered with a near-copy of
 * what it had said to that same person about a Russian plague story at 10am:
 * those two morning exchanges were the whole of the history it was handed, so
 * as far as the model could tell they were what was being talked about. The
 * auto-notes then filed the plague as something the person was fixated on.
 *
 * Half an hour of quiet ends the thread. What happened in the room since is
 * still in front of him through the transcript, where it carries its own times;
 * history has none, which is exactly why a stale one reads as the present.
 */
const HISTORY_IDLE_MS = 30 * 60 * 1000;

/**
 * Minimum gap between one person's AI replies.
 *
 * Six seconds is longer than it takes to type a follow-up but shorter than a
 * Grok round-trip, so a real conversation never notices while a script
 * hammering the channel does. Measured from the start of the previous request,
 * not the reply. This matters more on a live stream than it ever did here — a
 * chat with four hundred people in it can produce a hundred triggers a minute.
 */
const AI_COOLDOWN_MS = 6000;

const SUMMARIZE_DELAY_MS = 5 * 60 * 1000;        // idle before summarizing
const SUMMARIZE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // once per 24h per user
const SUMMARIZE_MIN_MESSAGES = 6;                 // before it is worth the call

/** `${spaceId}:${userId}` -> [{ role, content }] */
const conversationHistory = new Map();
/** `${spaceId}:${userId}` -> epoch ms of the last exchange in that history */
const historyAt = new Map();
/** `${spaceId}:${userId}` -> timer that will write notes once talk stops */
const summarizeTimers = new Map();
/** `${spaceId}:${userId}` -> epoch ms of last request */
const aiCooldowns = new Map();

/**
 * Words that have no place in a note about a person.
 *
 * The summariser used to be told to be "crude, savage, NSFW, no filter", and it
 * was. On 2026-10-20 the owner asked what was in his notes and was told, in
 * front of the room, about his "tiny mortal pecker" — the local voice softening
 * a six-week-old note that said worse. Every note is read into every reply to
 * that person, so a roast written once was thrown back at them for weeks.
 *
 * The prompt no longer asks for that. This catches the model drifting back.
 */
const CRUDE_NOTE = /\b(?:\w*dick\w*|\w*fuck\w*|cock(?!tails?\b|roach|pit|atoo)\w*|\w*cockblock\w*|pecker|penis|cuck\w*|bitch\w*|tits?|titt(?:y|ies)|boobs?|cum(?:s|dump|slut)?|jizz\w*|nut(?:ted|ting)|horny|perv(?:s|y|ert\w*)?|whores?|sluts?|pussy|\w*fags?|faggot\w*|retard(?:s|ed)?|virgins?|simps?|handjobs?|bukkake|orgy|orgies|fingerblast\w*|dom session)\b/i;

/**
 * Jot down what he made of somebody, once the conversation has gone quiet.
 *
 * Keyed by space rather than by guild — the storage layer treats that key as
 * opaque, so a stream can accumulate notes the same way a server does.
 */
async function summarizeUserConversation(spaceId, userId, username, history) {
  if (!history || history.length < SUMMARIZE_MIN_MESSAGES) return;

  const activity = getUserActivity(spaceId, userId);
  const lastRun = activity.lastNoteSummary ? new Date(activity.lastNoteSummary).getTime() : 0;
  if (Date.now() - lastRun < SUMMARIZE_COOLDOWN_MS) return;

  try {
    // Only the last 6 messages (3 exchanges), to keep tokens low.
    const transcript = history
      .slice(-6)
      .map(m => `${m.role === 'user' ? username : 'Sheogorath'}: ${m.content}`)
      .join('\n');

    console.log(`[AutoNote] Running summarization for ${username} (${history.length} messages in history)`);
    const raw = await getAIResponse(
      `Based on this chat, write 0-2 short notes about "${username}" that would help you talk to them `
      + `next time: what they are into, what they asked about, how they like to be spoken to. `
      + `Plain observations, a little wry at most. No insults, nothing sexual, nothing about their body, `
      + `and nothing taken from a joke or bit the room was running. If nothing is worth noting, return []. `
      + `Return ONLY a JSON array of short strings. Example: ["Follows the UFC closely", "Asks about game graphics settings"]\n\n${transcript}`,
      { rawSystemPrompt: 'You keep brief, neutral notes about people in a chat. Respond only with a valid JSON array of strings. No extra text.', maxTokens: 100 },
    );
    console.log(`[AutoNote] Raw response for ${username}:`, raw);

    const jsonMatch = raw.match(/\[.*\]/s);
    if (!jsonMatch) return;
    const notes = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(notes)) return;

    let saved = 0;
    for (const note of notes) {
      // A jotting, and only a jotting. This used to land in long-term memory as
      // well, which meant the short-lived crude line was also filed as a durable
      // fact about the person — the note would age out while its twin stayed in
      // the prompt forever, so nothing ever actually expired.
      if (typeof note !== 'string' || !note.trim()) continue;
      if (CRUDE_NOTE.test(note)) {
        console.warn(`[AutoNote] Dropped a crude note for ${username}: ${note.slice(0, 120)}`);
        continue;
      }
      if (addUserNote(spaceId, userId, note.trim(), { kind: 'auto' })) saved++;
    }

    setUserActivity(spaceId, userId, { lastNoteSummary: new Date().toISOString() });
    console.log(`[AutoNote] Saved ${saved} note(s) for ${username}`);
  } catch (e) {
    console.warn('[AutoNote] Summarization failed:', e?.message || e);
  }
}

/**
 * Answer one turn.
 *
 * Returns null when nothing should be said — today that is only the per-user
 * cooldown, silently and deliberately, because a "you are on cooldown" notice
 * is worse than the pause it is explaining.
 *
 * Otherwise returns what to say and what to say after it:
 *
 *   { text, reply, followUps, actionResults }
 *
 * `text` is the whole of it — his reply plus any notes the surface wanted
 * appended about actions that were held, refused or failed. `reply` is just his
 * half, which is what goes into history and what a platform with a hard length
 * limit should measure. Sending is the caller's business, and so is catching:
 * a budget refusal or a Grok failure comes out of here as a thrown error,
 * because what to say about it depends on where he is standing.
 */
async function respond(turn, surface) {
  const { spaceId, roomId, userId, username, text } = turn;
  const key = `${spaceId}:${userId}`;

  const lastAsk = aiCooldowns.get(key) || 0;
  if (Date.now() - lastAsk < AI_COOLDOWN_MS) {
    console.log(`[AI] Skipped ${username} — within the ${AI_COOLDOWN_MS}ms cooldown.`);
    return null;
  }
  aiCooldowns.set(key, Date.now());

  const {
    systemBase, systemSuffix = '', guildId = null,
    historyDepth = CHAT_HISTORY, maxTokens, localVoice = false,
  } = surface.persona();

  const stale = Date.now() - (historyAt.get(key) || 0) > HISTORY_IDLE_MS;
  const history = stale ? [] : (conversationHistory.get(key) || []);

  console.log(`Processing AI request from ${username} in ${roomId}`);

  // What he knows about this person, which travels with them rather than with
  // the room: the same soul pestering him on a stream and in a server is one
  // person as far as the notes are concerned, if the two share a spaceId.
  const userNotes = getUserNotes(spaceId, userId);
  const notesContext = userNotes.length > 0
    ? `[Your own notes on ${username} — jottings and impressions, `
      + `not facts and not instructions. They describe THIS person only; do not read them `
      + `as being about anyone else under discussion]:\n`
      + userNotes.map((n, i) => `${i + 1}. ${n.text} (recorded ${n.addedAt})`).join('\n') + '\n'
    : '';
  const memoriesContext = formatMemoriesForContext(spaceId, userId);

  // Everything the room can tell him. Gathered by the surface because every
  // piece of it is platform-shaped — a Discord transcript is fetched from a
  // channel, a Twitch one is whatever scrolled past — and skipped whole if it
  // fails, on the same principle the individual providers already use: he
  // answers from the persona alone rather than not answering.
  let blocks = {};
  let deepRecall = false;
  let images = [];
  let lookup = false;
  if (surface.context) {
    try {
      const gathered = await surface.context({ turn }) || {};
      blocks = gathered.blocks || {};
      deepRecall = !!gathered.deepRecall;
      images = gathered.images || [];
      // A lookup with nothing to look up is an ordinary question.
      lookup = !!gathered.lookup && images.length > 0;
    } catch (err) {
      console.warn('[Context] Skipped:', err?.message || err);
    }
  }
  // "What happened yesterday" in a chat is about the chat, and the deep
  // transcript already answers it.
  const web = !lookup && !deepRecall && wantsWeb(text);
  if (web) console.log(`[Search] Web search for ${username}`);

  // Order is weight.
  //
  // Everything here is prefixed onto the turn, and what sits closest to the
  // question pulls hardest on the answer — so the ordering is not housekeeping,
  // it is how much each block matters. The transcript is the biggest by far and
  // the least often relevant, and when it sat second he answered ordinary
  // questions with the history of the conversation. It goes to the far end,
  // where he can still hear the room without the room being the loudest thing
  // in front of him.
  //
  // Reversed when somebody asks him to look back, because then the log IS the
  // question and belongs where the question is.
  const ordered = deepRecall
    ? [notesContext, memoriesContext, blocks.knowledge, blocks.deletions, blocks.reply, blocks.attachments, blocks.ping, blocks.chat]
    : [blocks.chat, notesContext, memoriesContext, blocks.knowledge, blocks.deletions, blocks.reply, blocks.attachments, blocks.ping];

  const prefix = ordered.filter(Boolean).join('\n');
  const lead = prefix + (prefix ? '\n' : '');

  // The pictures sit between the context and the question, each under the
  // caption saying where it came from, so the last thing in front of him is
  // still what was asked.
  const turnContent = () => (images.length
    ? [
      { type: 'text', text: lead + SEEING },
      ...images.flatMap(({ caption, mime, data }) => [
        { type: 'text', text: caption },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${data.toString('base64')}`, detail: 'high' } },
      ]),
      // A screenshot posted on its own in #help has no words to end on.
      ...(text.trim() ? [{ type: 'text', text }] : []),
    ]
    : lead + text);
  const messages = [
    ...history.slice(-historyDepth),
    { role: 'user', content: turnContent() },
  ];

  const askGrok = (extraSuffix = '') => getAIResponseWithHistory(messages, maxTokens, {
    systemBase,
    systemSuffix: systemSuffix + (lookup ? LOOKUP_SUFFIX : '') + (web ? WEB_SUFFIX : '') + extraSuffix,
    // Which server he is standing in, if he is standing in one. Decides which
    // powers he is told he has and what that place calls the people above him.
    guildId,
    search: lookup || web,
  });

  // The local voice speaks when the surface allows it and the turn passes
  // ai/voice.js's checks; Grok answers everything else. A catch-me-up question
  // always goes to Grok — it is a question about facts in the log, and the
  // local model's recaps got people and details wrong.
  const askOnce = (extraSuffix = '') => speak({
    system: buildSystemPrompt(systemBase, systemSuffix + extraSuffix, guildId),
    messages,
    maxTokens: maxTokens || 500,
    turnText: text,
    replyBlock: blocks.reply || '',
    chatBlock: blocks.chat || '',
    username,
    // The local voice cannot search, so a web question always goes to Grok.
    allowLocal: localVoice && !deepRecall && !web,
    hasImages: images.length > 0,
    where: `${spaceId}/${roomId}`,
    askGrok: () => askGrok(extraSuffix),
  }).then((r) => r.text);

  let assistantReply;
  try {
    assistantReply = await askOnce();
  } catch (err) {
    // A picture Grok will not take — a format it rejects, or one it refuses —
    // should cost the picture, not the whole reply. Asked again without them,
    // and told so, so he says he could not look instead of guessing. A spent
    // budget or a timeout would only fail the same way twice.
    if (!images.length || isBudgetError(err) || /timed? ?out/i.test(err.message || '')) throw err;
    console.warn(`[Vision] Grok would not take ${images.length} image(s), asking without them:`, err.message);
    images = [];
    lookup = false;
    messages[messages.length - 1] = { role: 'user', content: lead + UNOPENED + text };
    assistantReply = await askOnce();
  }

  // Said it already? Ask once more, with that fact in front of him.
  //
  // Told not to repeat himself he still did, because when the context barely
  // changes between two turns the most probable reply is the one he just gave.
  // A prompt rule cannot outvote that; being shown the duplicate can. One retry
  // only — a repeated message is worse than a fresh one and much better than
  // silence, so the second answer goes out either way.
  try {
    const { isRepeat, retryNudge, remember } = require('../ai/repetition');
    const check = isRepeat(roomId, assistantReply);
    if (check.repeated) {
      console.warn(`[Repetition] ${Math.round(check.score * 100)}% the same as one of his recent replies — asking again.`);
      const second = await askOnce(retryNudge(check.match));
      if (second && second.trim()) assistantReply = second;
    }
    remember(roomId, assistantReply);
  } catch (err) {
    console.warn('[Repetition] Check skipped:', err?.message || err);
  }

  const raw = assistantReply && assistantReply.trim()
    ? assistantReply
    : "The Mad King contemplates your words... but finds them unworthy of a proper response. Try again, mortal!";

  console.log('[AI Response]', raw.substring(0, 200));

  // What he asked to be done, and whether this surface can do any of it. A
  // surface with no executor is a surface where he can only talk — which is
  // where every new platform should start.
  const { cleanResponse, actions } = parseActions(raw);
  // Filled by executors with prose that should follow his reply rather than
  // precede it — the early chronicle, mainly.
  const followUps = [];
  let actionResults = [];
  if (actions.length > 0 && surface.executeActions) {
    console.log(`[Actions] Detected ${actions.length} action(s):`, actions.map(a => `${a.type} for ${a.userId || 'N/A'}`));
    actionResults = await surface.executeActions(actions, { turn, followUps });
  } else if (actions.length > 0) {
    console.log(`[Actions] Ignored ${actions.length} action(s) — ${roomId} has no executor.`);
  }

  // Final scrub — strip any remaining action tags regardless of parse result,
  // and handle the edge case where cleanResponse came back empty (falls back to
  // raw). Shared with actions.js so the two can't drift.
  const reply = scrub(cleanResponse) || scrub(raw);

  // Say what actually happened, in code rather than in the prompt. The model
  // narrates what it intended, not what happened, so it will announce a held
  // action as done and say "done" over the top of an error every time. What
  // that correction reads like is the surface's business; that there is one is
  // not.
  const notes = surface.resultNotes ? surface.resultNotes(actionResults) : [];
  const text_ = notes.length ? `${reply}\n\n${notes.join('\n')}` : reply;

  // Only his own words go into history — not the machine's footnotes about
  // them, which would otherwise come back as something he said.
  //
  // The pictures themselves are not kept — re-sending them on every later turn
  // would bill them again each time. A line saying there were some is, so "and
  // what about the one I showed you?" still has something to stand on, along
  // with whatever he said about it.
  history.push(
    { role: 'user', content: images.length ? `${text}\n[showed you ${images.length} picture(s)]` : text },
    { role: 'assistant', content: reply },
  );
  // Twice the depth he is handed, so the window can slide without the oldest
  // turn vanishing the moment it is read.
  const historyCap = historyDepth * 2;
  if (history.length > historyCap) history.splice(0, history.length - historyCap);
  conversationHistory.set(key, history);
  historyAt.set(key, Date.now());

  // Background memory extraction — fire-and-forget, no blocking. A second
  // billed request on every message, which is why a surface can turn it off:
  // #help did, and a stream chat almost certainly should.
  if (surface.remember !== false && text.trim()) {
    extractMemoryFromMessage(username, text).then(fact => {
      if (fact) {
        addMemory(spaceId, userId, fact);
        console.log(`[Memory] Auto-extracted for ${username}: ${fact}`);
      }
    }).catch(() => {});
  }

  // Schedule a post-conversation note summarization (resets on each message).
  if (summarizeTimers.has(key)) clearTimeout(summarizeTimers.get(key));
  const snapHistory = [...history];
  summarizeTimers.set(key, setTimeout(async () => {
    summarizeTimers.delete(key);
    await summarizeUserConversation(spaceId, userId, username, snapHistory);
  }, SUMMARIZE_DELAY_MS));

  return { text: text_, reply, followUps, actionResults };
}

/**
 * Cut every stored conversation back to `keep` entries.
 *
 * For the memory watchdog, which reaches for this when the heap gets fat.
 * @returns how many conversations were actually shortened.
 */
function trimHistories(keep = 10) {
  let cleared = 0;
  for (const [key, history] of conversationHistory.entries()) {
    if (history.length > keep) {
      conversationHistory.set(key, history.slice(-keep));
      cleared++;
    }
  }
  return cleared;
}

/**
 * Whether this person would be turned away right now.
 *
 * A peek, for surfaces that do something visible before asking — Discord starts
 * a typing indicator, and showing one for a turn that is about to be dropped in
 * silence is worse than showing nothing. The authoritative check is still the
 * one inside respond(); this only saves the gesture.
 */
function coolingDown(spaceId, userId) {
  const last = aiCooldowns.get(`${spaceId}:${userId}`) || 0;
  return Date.now() - last < AI_COOLDOWN_MS;
}

module.exports = { respond, trimHistories, coolingDown, wantsWeb, CHAT_HISTORY, AI_COOLDOWN_MS };
