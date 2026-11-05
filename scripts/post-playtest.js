#!/usr/bin/env node
'use strict';
/**
 * Posts the playtest agreement (services/playtest.js) in the guild's
 * `playtest.post` channel and pins it; with --downloads, the download buttons
 * in `playtest.downloads.channel` instead, and with --feedback, the feedback
 * form's button (services/feedback.js) in `playtest.feedback.channel`.
 *
 * Once is enough: the buttons carry no message ID and nothing is kept in
 * memory, so a posted message keeps working across restarts. Run it again only
 * to replace a deleted post, or after changing its wording: --edit with the
 * posted message's ID rewrites that one in place, keeping its pin and its spot.
 *
 * REST only, no gateway login: posting needs nothing the live bot is doing.
 *
 *   node scripts/post-playtest.js <guildId> [--downloads|--feedback]  # what would be posted, and where
 *   node scripts/post-playtest.js <guildId> [--downloads] --apply
 *   node scripts/post-playtest.js <guildId> [--downloads] --edit <messageId> [--apply]
 */
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { getGuildConfig } = require('../src/config/guilds');
const { buildMessage, buildDownloadsMessage } = require('../src/services/playtest');
const { buildFeedbackPost } = require('../src/services/feedback');

const GUILD = process.argv.find((a) => /^\d{17,20}$/.test(a));
const APPLY = process.argv.includes('--apply');
const DOWNLOADS = process.argv.includes('--downloads');
const FEEDBACK = process.argv.includes('--feedback');
const EDIT = process.argv.includes('--edit') ? process.argv[process.argv.indexOf('--edit') + 1] : null;

(async () => {
  if (!GUILD) return console.log('Which guild? node scripts/post-playtest.js <guildId> [--downloads] [--apply]');
  const cfg = getGuildConfig(GUILD)?.playtest;
  if (!cfg) return console.log(`No playtest block for ${GUILD} in config/guilds.json.`);
  const where = FEEDBACK ? cfg.feedback?.channel : DOWNLOADS ? cfg.downloads?.channel : cfg.post;
  if (!where) return console.log(FEEDBACK ? 'No playtest.feedback to post.' : DOWNLOADS ? 'No playtest.downloads.channel to post in.' : 'No playtest.post channel to post in.');

  const msg = FEEDBACK ? buildFeedbackPost(GUILD) : DOWNLOADS ? buildDownloadsMessage(GUILD) : buildMessage(GUILD);
  if (!msg) return console.log('Nothing to post: check the playtest block.');
  const body = { embeds: msg.embeds.map((e) => e.toJSON()), components: msg.components.map((c) => c.toJSON()) };
  if (EDIT !== null && !/^\d{17,20}$/.test(EDIT || '')) return console.log('--edit needs the ID of the message to rewrite.');
  console.log(`${EDIT ? `Rewriting ${EDIT}` : 'Posting'} in ${where}:\n${JSON.stringify(body, null, 2)}`);
  if (!APPLY) return console.log(`\n(Dry run. Add --apply to ${EDIT ? 'rewrite' : 'post'} it.)`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  if (EDIT) {
    await rest.patch(Routes.channelMessage(where, EDIT), { body });
    return console.log(`Rewritten: ${EDIT}`);
  }
  const posted = await rest.post(Routes.channelMessages(where), { body });
  console.log(`Posted: ${posted.id}`);
  try {
    await rest.put(Routes.channelPin(where, posted.id), { reason: 'The playtest post' });
    console.log('Pinned.');
  } catch (err) {
    console.log(`Not pinned (${err.message}): pin it by hand.`);
  }
})().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
