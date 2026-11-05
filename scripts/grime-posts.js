#!/usr/bin/env node
'use strict';
/**
 * Posts the rules and the about-the-game note in Grime and Punishment.
 *
 * Both are channels Sheogorath reads before answering (`channels.rules` and
 * `channels.serverInfo`), so what is written here is what he tells people about
 * the server and the game. Keep it true, and keep anything under the NDA out:
 * these channels are public.
 *
 * Edits its own last post in each channel rather than adding another, so a
 * re-run fixes a typo instead of stacking copies. REST only, no gateway login.
 *
 *   node scripts/grime-posts.js            # print what would be posted
 *   node scripts/grime-posts.js --apply
 */
require('dotenv').config();
const { REST, Routes, EmbedBuilder } = require('discord.js');
const { getGuildConfig } = require('../src/config/guilds');

const GUILD_ID = '1560039768845328394';
const APPLY = process.argv.includes('--apply');
const TEAL = 0x3fbfb0;

const RULES = {
  title: 'Grime & Punishment: the rules',
  // Reports go to the Developers: nobody holds Moderator yet, so pinging it reaches no one. Name it again here
  // once someone does.
  intro: 'Short version: be someone people are glad to see. The developers read reports and act on them.',
  fields: [
    ['1. Be decent',
      'No harassment, slurs, bigotry or sexual content. Banter is fine; **if someone asks you to drop it, drop it.**'],
    ['2. Keep it safe for work',
      'No porn and no gore. Swearing and dark humour are fine.'],
    ['3. What happens in the playtest stays in the playtest',
      'Testers agreed to keep the game to themselves. Builds, screenshots, clips and anything said in the testers\' channels stay there: not in the public channels, not in other servers, not on stream or social media. Breaking that costs you the Tester role.'],
    ['4. No spam, no advertising',
      'No unsolicited DMs and no dropping invite links. Talking about other games you like is fine.'],
    ['5. Bugs go in the bug reports',
      'Testers: one post per bug in the playtest-bugs forum, with what happened, what you expected and which build you have.'],
    ['6. Sheogorath is a bot',
      'He answers to his name and speaks unprompted in <#CHAN_HELP>. He does not read the testers\' channels. Anything that matters goes to a **@Developer**, not to him.'],
    ['7. Discord\'s own rules apply',
      '13 or older, nothing illegal, and no second account to get round a removal.'],
    ['Reporting',
      'Ping a **@Developer** in <#CHAN_HELP>, or DM one. Say who and roughly when.'],
  ],
};

const ABOUT = {
  title: 'Grime & Punishment',
  intro:
    '*Wash it. Fold it. ~~Steal it.~~ Launder it.*\n\n' +
    'A first-person co-op game for 1 to 4 friends, set in a medieval town. You are the worst adventuring ' +
    'party in the realm: hired to slay a dragon, you woke it up instead, and it burned down half the ' +
    'King\'s castle. Your punishment is to run **Suds & Duds**, the royal washhouse, scrubbing the filthy ' +
    'gear of *real* heroes for coin that barely pays the rent. So you go through every customer\'s pockets, ' +
    'sell the loot at your own black market out the back, and launder the dirty coin. In the wash tubs. ' +
    'Miss the rent and it\'s the dungeon. Pay off the King\'s fine and he comes in person to pardon you, ' +
    'if you can keep your hands out of his pockets while he\'s there.',
  fields: [
    // The date and the plan are the ones Billy announced in #announcements on 2026-11-03. Sheogorath gives no date
    // he doesn't read here, so change them together.
    ['Where to get it',
      'It\'s coming to **Steam** in Early Access, for Windows, Mac and Linux, aimed at **July 2027**. Dates may move; news comes first in <#CHAN_ANNOUNCEMENTS>.'],
    ['What\'s next',
      'The washhouse learns to run itself, then you take over the smithy, the tavern and a fishing hut, hire workers to run them, and keep robbing your customers blind. The stables, a farm and a guard post come after Early Access launches.'],
    ['Playing it early',
      'The game is in playtesting. Press the button in <#CHAN_JOIN>, agree to keep what you see to yourself, and the testers\' channels open to you, downloads included.'],
    ['Questions',
      'Ask in <#CHAN_HELP>.'],
  ],
};

function build(spec, ids) {
  const fill = (text) => text
    .replace(/CHAN_HELP/g, ids.help)
    .replace(/CHAN_ANNOUNCEMENTS/g, ids.announcements)
    .replace(/CHAN_JOIN/g, ids.join);
  return new EmbedBuilder()
    .setColor(TEAL)
    .setTitle(spec.title)
    .setDescription(fill(spec.intro))
    .addFields(spec.fields.map(([name, value]) => ({ name, value: fill(value) })))
    .toJSON();
}

(async () => {
  const cfg = getGuildConfig(GUILD_ID);
  if (!cfg) return console.log(`No config for ${GUILD_ID}: run scripts/grime-setup.js first.`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const me = await rest.get(Routes.user());
  const channels = await rest.get(Routes.guildChannels(GUILD_ID));
  const byName = (n) => channels.find((c) => c.name === n)?.id;
  const ids = {
    help: cfg.channels.help,
    announcements: byName('announcements'),
    join: cfg.playtest?.post,
  };
  const missing = Object.entries(ids).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return console.log(`Missing channel(s): ${missing.join(', ')}`);

  for (const [label, where, spec] of [['#rules', cfg.channels.rules, RULES], ['#about-the-game', cfg.channels.serverInfo, ABOUT]]) {
    const embed = build(spec, ids);
    const recent = await rest.get(Routes.channelMessages(where), { query: new URLSearchParams({ limit: '25' }) });
    const mine = recent.find((m) => m.author.id === me.id && m.embeds.length);
    console.log(`\n===== ${label}: ${mine ? `edit ${mine.id}` : 'new post'} =====\n${embed.title}\n${embed.description}`);
    for (const f of embed.fields) console.log(`\n  * ${f.name}\n    ${f.value}`);
    if (!APPLY) continue;
    if (mine) {
      await rest.patch(Routes.channelMessage(where, mine.id), { body: { embeds: [embed] } });
    } else {
      const sent = await rest.post(Routes.channelMessages(where), { body: { embeds: [embed] } });
      await rest.put(Routes.channelPin(where, sent.id)).catch(() => {});
    }
  }
  if (!APPLY) console.log('\n(dry run: pass --apply to post)');
})().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
