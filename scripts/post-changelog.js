#!/usr/bin/env node
'use strict';
/**
 * The patch notes (services/changelog.js): shows what the next daily post will
 * say, from what has gathered in state. Nothing is posted; the bot posts it at
 * the guild's `changelog.hour`.
 *
 * --seed <file> replaces what has gathered with the builds in a JSON file
 * ([{ sha, at, lines: [newest first], more }], oldest build first) and takes
 * the last one as the build up now. It writes the state file, so stop the bot
 * first (sudo systemctl stop sheogorath) and start it again after.
 *
 *   node scripts/post-changelog.js <guildId>
 *   node scripts/post-changelog.js <guildId> --seed builds.json
 */
const fs = require('fs');
const { getGuildConfig } = require('../src/config/guilds');
const { getGuildState, setGuildState } = require('../src/storage/state');
const { buildPost, dayName } = require('../src/services/changelog');

const GUILD = process.argv.find((a) => /^\d{17,20}$/.test(a));
const SEED = process.argv.includes('--seed') ? process.argv[process.argv.indexOf('--seed') + 1] : null;

(() => {
  if (!GUILD) return console.log('Which guild? node scripts/post-changelog.js <guildId> [--seed builds.json]');
  const cfg = getGuildConfig(GUILD);
  if (!cfg?.changelog) return console.log(`No changelog block for ${GUILD} in config/guilds.json.`);
  if (SEED) {
    const builds = JSON.parse(fs.readFileSync(SEED, 'utf8'));
    if (!Array.isArray(builds) || !builds.length || !builds.every((b) => b.sha && Array.isArray(b.lines))) {
      return console.log('The seed file needs a list of { sha, at, lines, more } builds.');
    }
    const st = getGuildState(GUILD).changelog || { lastPosted: null };
    setGuildState(GUILD, { changelog: { ...st, lastBuild: builds[builds.length - 1].sha, pending: builds } });
    console.log(`Seeded ${builds.length} build(s), up to ${builds[builds.length - 1].sha}.`);
  }
  const st = getGuildState(GUILD).changelog;
  if (!st) return console.log('Nothing gathered yet: the bot starts gathering from the build that is up when it first runs.');
  console.log(`Last build seen: ${st.lastBuild}. Last posted: ${st.lastPosted || 'never'}. Posts daily at ${cfg.changelog.hour}:00 ${cfg.timeZone} in ${cfg.changelog.channel}.`);
  if (!st.pending.length) return console.log('Nothing to post yet.');
  const e = buildPost(st.pending, dayName(new Date(), cfg.timeZone)).toJSON();
  console.log(`\n${e.title}\n${e.description}\n\n(${e.footer.text})\n${e.description.length} characters.`);
})();
