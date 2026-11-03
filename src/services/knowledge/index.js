'use strict';
/**
 * What Sheogorath knows, assembled into something the model can be handed.
 *
 * The problem this solves: the persona is instructed never to break character
 * and to answer with confidence, which is exactly the wrong disposition for
 * "what port do I connect on". Told nothing, he does not say he doesn't know —
 * he makes up a port, in character, and it sounds as convincing as a real
 * answer. The fix is not to sand the character down; it is to make sure the
 * true answer is in front of him, and to be explicit that invention is the one
 * liberty he isn't allowed.
 *
 * So the block this builds has two halves: the facts, and one paragraph saying
 * what he may do with them. He keeps every bit of the voice. He loses only the
 * freedom to make the substance up.
 */
const { aiTitles, hasFeature } = require('../../config/guilds');
const { allDocs } = require('./sources');
const { selfFacts } = require('./self');
const { recentDeeds, deedLine, roleLines } = require('./deeds');

/** Words too common to tell one document from another. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'with', 'this', 'that',
  'have', 'has', 'was', 'were', 'can', 'cant', 'how', 'what', 'when', 'where', 'why',
  'who', 'does', 'did', 'get', 'got', 'any', 'all', 'its', 'his', 'her', 'they',
  'there', 'here', 'from', 'about', 'would', 'could', 'should', 'been', 'into',
  'just', 'like', 'know', 'need', 'want', 'help', 'please', 'someone', 'anyone',
  // His own names. Nearly every message to him contains one, so they match the
  // lore pages on every turn and tell retrieval nothing about the question.
  'sheogorath', 'sheogorathapp', 'sheo', 'uncle', 'mad', 'god',
]);

/** Total characters of retrieved documents allowed into one prompt. */
const DEFAULT_DOC_BUDGET = 1500;
const HELP_DOC_BUDGET = 4000;

function terms(question) {
  return [...new Set(
    String(question)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  )];
}

/**
 * Score one document against the question.
 *
 * A hit in the title is worth more than a hit in the body, because a document
 * called "Connecting to the server" matching the word "connect" is a much
 * stronger signal than the same word appearing once in a wall of rules. Body
 * hits are counted but capped per term, so a long document can't win purely by
 * repeating itself.
 */
function score(doc, queryTerms) {
  const title = doc.title.toLowerCase();
  const tags = (doc.tags || []).join(' ').toLowerCase();
  const body = doc.body.toLowerCase();

  let total = 0;
  for (const term of queryTerms) {
    if (title.includes(term)) total += 3;
    if (tags.includes(term)) total += 2;
    const hits = body.split(term).length - 1;
    if (hits) total += Math.min(hits, 3);
  }
  return total;
}

/**
 * Pick the documents worth spending prompt on.
 *
 * Reference channels are floored at a minimum score rather than ranked purely
 * on keyword overlap: the rules are relevant to a question about the rules even
 * when the person asking hasn't used any of the same words, which is most of
 * the time — people describe a problem, not the section that covers it.
 */
function retrieve(docs, question, budget) {
  const queryTerms = terms(question);
  const ranked = docs
    .map((doc) => ({ doc, score: score(doc, queryTerms) }))
    .filter(({ doc, score: s }) => s > 0 || doc.id.startsWith('channel:'))
    .sort((a, b) => b.score - a.score);

  const picked = [];
  let spent = 0;
  for (const { doc } of ranked) {
    const cost = doc.body.length;
    if (spent + cost > budget) {
      // Truncate rather than drop: half of #rules beats none of it, and the
      // budget exists to bound cost, not to insist on whole documents.
      const room = budget - spent;
      if (room > 300) {
        picked.push({ ...doc, body: doc.body.slice(0, room), truncated: true });
        spent = budget;
      }
      continue;
    }
    picked.push(doc);
    spent += cost;
  }
  return picked;
}

/**
 * The rule that lets the character and the facts coexist.
 *
 * Deliberately gives him the whole of the voice and none of the substance. The
 * failure this is written against is not him being too mad — it is him being
 * helpfully, fluently wrong, which a new player cannot tell from being right.
 *
 * Built per guild, because the sentence that sends someone to a human names a
 * rank, and the rank is not the same everywhere. It said "Ask a Sheriff" in a
 * server that has never had one — which is its own kind of confidently wrong,
 * and sends a person looking for a role that does not exist. aiTitles() already
 * knows what each guild calls its tiers, and falls back to the Owner where no
 * staff role is configured to hold a title at all.
 */
function groundingRule(guildConfig) {
  const { approver } = aiTitles(guildConfig);
  const an = /^[aeiou]/i.test(approver) ? 'an' : 'a';
  return `
HOW TO USE WHAT IS ABOVE

Everything above is true as of this moment, and it is the whole of what you know
about THIS SERVER — its state, its rules, its people, and what you
yourself are permitted to do here. Answer from it.

It does not govern who you are. Your name, your nature, your opinions and your
manner are yours, and questions about them are not "not covered" — answer those
freely, as yourself. A question about your own powers IS covered: it is answered
above, so answer it, rather than sending someone off to ask ${an} ${approver}
what you are.

Where it does not cover what was asked, say so and send them to ${an} ${approver}.
Do it in your own voice — be as insufferable about it as you like — but say it
plainly enough that they understand you don't know. "Even the Mad God's memory
has holes, mortal. Ask ${an} ${approver}." is a fine answer. A made-up one is
not. Never invent a rank: ${approver} is what the people above you are called
here, whatever they are called anywhere else.

Never invent a port, an address, a password, a rule, a mod name, a command, a
player count or a restart time. If it is not written above, you do not know it,
however obvious a guess feels. Being wrong in an entertaining way still leaves
someone unable to connect.

Your madness is in HOW you say things. WHAT you say comes from the facts above.
`.trim();
}

/**
 * Build the knowledge block for one question.
 *
 * @param {object} opts
 * @param {string} opts.guildId
 * @param {import('discord.js').Guild} [opts.guild]
 * @param {string} opts.question   what was asked, for retrieval
 * @param {boolean} [opts.isHelp]  a help-channel question gets a larger budget
 * @returns {Promise<string>} the block, or '' when there is nothing to say
 */
async function knowledgeFor({ guildId, guild, question, isHelp = false, guildConfig = null, requester = null }) {
  const sections = [];

  try {
    const lines = selfFacts({ guildConfig, requester, isHelp, guildName: guild?.name || null });
    if (lines.length) sections.push(`WHAT YOU CAN DO HERE, AND WHO YOU ARE TALKING TO\n${lines.join('\n')}`);
  } catch (err) {
    console.warn('[Knowledge] Self facts failed:', err?.message || err);
  }

  try {
    const deeds = await recentDeeds(guildId);
    if (deeds.length) {
      sections.push(
        'WHAT YOU HAVE DONE IN THE LAST FEW HOURS (your own actions, in order)\n' +
        `${deeds.map(deedLine).join('\n')}\n` +
        'Asked whether you did something, answer from this and nothing else. ' +
        'Note the difference between what you DID and what you were REFUSED or only ASKED PERMISSION FOR — ' +
        'saying you did a thing that was refused is a lie told to someone who trusted you.',
      );
    }
  } catch (err) {
    console.warn('[Knowledge] Own deeds failed:', err?.message || err);
  }

  try {
    const roles = roleLines(guild);
    if (roles.length) {
      sections.push(
        `THE ROLES IN THIS SERVER (highest first)\n${roles.join('\n')}\n` +
        'These are what people mean when they name a role at you. You may talk about them freely; ' +
        'the ones you hand out as titles are the ones with no powers.',
      );
    }
  } catch (err) {
    console.warn('[Knowledge] Roles failed:', err?.message || err);
  }

  if (guild && hasFeature(guildId, 'events')) {
    try {
      // Required here rather than at the top: the calendar pulls in Discord's
      // event types, which guilds without the feature never need.
      const { calendarFacts } = require('../events');
      const lines = await calendarFacts(guild);
      if (lines.length) sections.push(`THE CLOCK AND THE CALENDAR (measured just now)\n${lines.join('\n')}`);
    } catch (err) {
      console.warn('[Knowledge] Calendar failed:', err?.message || err);
    }
  }

  if (guild && hasFeature(guildId, 'activity')) {
    try {
      const { activityFacts } = require('../activity');
      const lines = await activityFacts(guild, question);
      if (lines.length) {
        sections.push(
          'WHO HAS BEEN AROUND (your own record of chat, voice and games, measured just now)\n'
          + `${lines.join('\n')}\n`
          + 'Answer questions about who is active, who has gone quiet, the busiest days and who plays '
          + 'what from this. It is yours: you keep it, so never say these things are not tracked. '
          + 'Where it only goes back a short way, say how far.',
        );
      }
    } catch (err) {
      console.warn('[Knowledge] Activity failed:', err?.message || err);
    }
  }

  if (hasFeature(guildId, 'drops')) {
    try {
      const { dropsFacts } = require('../drops');
      const lines = dropsFacts(guildId);
      if (lines.length) sections.push(`TWITCH AND KICK DROPS (as of the last check, every half hour)\n${lines.join('\n')}`);
    } catch (err) {
      console.warn('[Knowledge] Drops failed:', err?.message || err);
    }
  }

  if (hasFeature(guildId, 'ledger')) {
    try {
      // Required here for the same reason as the calendar: only guilds that
      // keep a Ledger need it.
      const { ledgerFacts } = require('../ledger');
      const lines = ledgerFacts(guildId, { question, requester });
      if (lines.length) sections.push(`THE LEDGER (the group's book, which you keep)\n${lines.join('\n')}`);
    } catch (err) {
      console.warn('[Knowledge] Ledger failed:', err?.message || err);
    }
  }

  try {
    const docs = await allDocs(guild, guildId);
    const picked = retrieve(docs, question, isHelp ? HELP_DOC_BUDGET : DEFAULT_DOC_BUDGET);
    for (const doc of picked) {
      sections.push(
        `${doc.title.toUpperCase()} (from ${doc.source})\n${doc.body}` +
        (doc.truncated ? '\n[...truncated]' : ''),
      );
    }
  } catch (err) {
    console.warn('[Knowledge] Document retrieval failed:', err?.message || err);
  }

  if (!sections.length) return '';

  return `--- WHAT YOU ACTUALLY KNOW ---\n\n${sections.join('\n\n')}\n\n${groundingRule(guildConfig)}\n--- END ---\n`;
}

module.exports = { knowledgeFor, retrieve, score, terms, groundingRule, HELP_DOC_BUDGET, DEFAULT_DOC_BUDGET };
