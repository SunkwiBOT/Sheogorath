'use strict';
/**
 * The playtest: an agreement button that lets someone into the testers'
 * channel once they agree to keep the game to themselves, and download buttons
 * in that channel for the newest build.
 *
 * Agreeing gives the guild's `playtest.role` (which opens `playtest.channel`)
 * and writes who agreed, and when, in `playtest.log`: a private channel, where
 * the game posts its own NDA signatures too, so the two records of a tester sit
 * side by side. It only ever grants. Taking a tester out is done by hand, by
 * taking the role off.
 *
 * A download button answers, to that tester alone, with the link to their
 * platform's build on the GitHub release in `playtest.downloads`: the public
 * builds repo the game updates itself from. The release is re-made under the
 * same tag for every build, so the link never changes and always gets the
 * newest build, and no key is needed. The button is still there, rather than a
 * plain link, so it can check the role (the button is in their channel, but
 * the role is checked anyway), say how to start it, and log the download.
 *
 * No button carries a role ID or a file name. A download button carries an
 * index into config, and the agreement button nothing at all, so a crafted
 * custom_id has nothing to name.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { getGuildConfig } = require('../config/guilds');

const AGREE = 'playtest:agree';
const DL = 'playtest:dl:';
const TEAL = 0x3fbfb0;   // the game's own teal

const isPlaytestButton = (interaction) =>
  interaction.customId === AGREE || (typeof interaction.customId === 'string' && interaction.customId.startsWith(DL));
const configFor = (guildId) => getGuildConfig(guildId)?.playtest || null;
const channelOf = (cfg) => (cfg.channel ? `<#${cfg.channel}>` : 'the testers\' channel');

/** The agreement post: the terms, and the one button. Posted by scripts/post-playtest.js. */
function buildMessage(guildId) {
  const cfg = configFor(guildId);
  if (!cfg) return null;
  const embed = new EmbedBuilder()
    .setColor(TEAL)
    .setTitle(`🔒 ${cfg.game} playtest`)
    .setDescription(
      `${cfg.game} is not out yet, so everything in the playtest channels, starting with ${channelOf(cfg)}, is confidential.\n\n` +
      'Press **I agree** to confirm you will not share, stream, post or talk about the game, its builds, ' +
      'screenshots, or anything from those channels with anyone outside the test group, and that you will ' +
      'sign the NDA in the game when you first open it. The channels open to you straight away.' +
      (cfg.limit ? `\n\nThere are **${cfg.limit} places**, first come, first served.` : '')
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(AGREE).setLabel('I agree, let me in').setEmoji('✅').setStyle(ButtonStyle.Success)
  );
  return { embeds: [embed], components: [row] };
}

/** The download post, in the testers' channel: a button per build. Posted by scripts/post-playtest.js --downloads. */
function buildDownloadsMessage(guildId) {
  const cfg = configFor(guildId);
  if (!cfg?.downloads?.files.length) return null;
  const notes = getGuildConfig(guildId)?.changelog?.channel;
  const embed = new EmbedBuilder()
    .setColor(TEAL)
    .setTitle(`⬇️ Get ${cfg.game}`)
    .setDescription(
      'Press the button for your computer: you get the download link, and where to put the game.\n\n' +
      'You only download it once: the game updates itself to the newest build every time it starts' +
      (notes ? `, and what is new goes in the patch notes in <#${notes}> each evening. ` : '. ') +
      'The first time it opens, the game asks you to sign its NDA, with Steam running.\n\n' +
      'The link never changes and always gets the newest build, so you can keep it. It is for the test group ' +
      'only: anyone else who wants to play joins' + (cfg.post ? ` in <#${cfg.post}>.` : ' the playtest first.')
    );
  const row = new ActionRowBuilder().addComponents(
    cfg.downloads.files.map((f, i) => {
      const b = new ButtonBuilder().setCustomId(`${DL}${i}`).setLabel(f.label).setStyle(ButtonStyle.Primary);
      if (f.emoji) b.setEmoji(f.emoji);
      return b;
    })
  );
  return { embeds: [embed], components: [row] };
}

async function handleButton(interaction) {
  const cfg = configFor(interaction.guild.id);
  if (!cfg) {
    await interaction.reply({ content: 'That button is not wired to anything any more.', ephemeral: true });
    return;
  }
  if (interaction.customId === AGREE) await handleAgree(interaction, cfg);
  else await handleDownload(interaction, cfg);
}

/** Writes a line in the private log channel. Never throws: the record must not cost anyone what they pressed for. */
async function record(interaction, cfg, line) {
  if (!cfg.log) return;
  try {
    const log = await interaction.guild.channels.fetch(cfg.log);
    await log.send({ content: line, allowedMentions: { parse: [] } });
  } catch (err) {
    console.warn(`[Playtest] ${interaction.guild.name}: could not write to the log: ${err?.message || err}`);
  }
}

async function handleAgree(interaction, cfg) {
  const role = interaction.guild.roles.cache.get(cfg.role)
    || await interaction.guild.roles.fetch(cfg.role).catch(() => null);
  if (!role) {
    await interaction.reply({ content: 'The tester role has been deleted. Tell an admin.', ephemeral: true });
    return;
  }

  const me = interaction.guild.members.me;
  if (!me || role.comparePositionTo(me.roles.highest) >= 0) {
    console.warn(`[Playtest] ${interaction.guild.name}: "${role.name}" sits at or above my highest role.`);
    await interaction.reply({ content: 'I am not allowed to hand that role out. Tell an admin.', ephemeral: true });
    return;
  }

  const member = interaction.member;
  if (member.roles.cache.has(role.id)) {
    await interaction.reply({ content: `You are already in: ${channelOf(cfg)}.`, ephemeral: true });
    return;
  }

  // Counting the testers means fetching the member list, which can outlast the
  // three seconds Discord gives a reply.
  await interaction.deferReply({ ephemeral: true });
  const outcome = await oneAtATime(interaction.guild.id, () => admit(interaction, cfg, role, member));
  if (outcome.error) {
    console.warn(`[Playtest] ${interaction.guild.name}: could not give "${role.name}": ${outcome.error}`);
    await interaction.editReply('That did not work. Tell an admin.');
    return;
  }

  const stamp = `<t:${Math.floor(Date.now() / 1000)}:f>`;
  if (outcome.full) {
    await interaction.editReply(
      `All ${cfg.limit} places in the playtest are taken. If one opens up, pressing the button again will let you in.`
    );
    await record(interaction, cfg, `🚫 <@${member.id}> (**${member.user.username}**, ${member.id}) pressed I agree, ` +
      `but all ${cfg.limit} places are taken, ${stamp}.`);
    return;
  }

  await interaction.editReply(
    `You are in: ${channelOf(cfg)}. Nothing about the game leaves the test group. ` +
    'The game will ask you to sign its NDA the first time you open it.'
  );
  await record(interaction, cfg, `✅ <@${member.id}> (**${member.user.username}**, ${member.id}) agreed to the playtest terms in Discord, ` +
    `${stamp}${outcome.place ? ` (place ${outcome.place} of ${cfg.limit})` : ''}.`);
}

/**
 * Gives the role if there is a place for it. A place is held by anyone with
 * the role who has none of `uncounted` (the team, testing alongside), so taking
 * the role off a tester frees theirs.
 * @returns {Promise<{full?: boolean, place?: number, error?: string}>}
 */
async function admit(interaction, cfg, role, member) {
  try {
    let place = null;
    if (cfg.limit) {
      await interaction.guild.members.fetch();
      const held = role.members.filter((m) => !cfg.uncounted.some((id) => m.roles.cache.has(id))).size;
      const counts = !cfg.uncounted.some((id) => member.roles.cache.has(id));
      if (counts && held >= cfg.limit) return { full: true };
      if (counts) place = held + 1;
    }
    await member.roles.add(role, 'agreed to the playtest terms');
    return { place };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

// One agreement at a time in each guild, so two presses for the last place
// cannot both be counted before either is given the role.
const queues = new Map();
function oneAtATime(guildId, fn) {
  const run = (queues.get(guildId) || Promise.resolve()).then(fn);
  queues.set(guildId, run.catch(() => {}));
  return run;
}

async function handleDownload(interaction, cfg) {
  const dl = cfg.downloads;
  const file = dl?.files[Number(interaction.customId.slice(DL.length))];
  if (!file) {
    await interaction.reply({ content: 'That button is not wired to anything any more.', ephemeral: true });
    return;
  }
  if (!interaction.member.roles.cache.has(cfg.role)) {
    await interaction.reply({
      content: `The builds are for testers.${cfg.post ? ` Agree to the playtest terms in <#${cfg.post}> first.` : ''}`,
      ephemeral: true,
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const link = `https://github.com/${dl.repo}/releases/download/${encodeURIComponent(dl.tag)}/${encodeURIComponent(file.asset)}`;
  const asset = await assetInfo(dl, file.asset);
  if (asset === MISSING) {
    // The release is deleted and made again for each build, so for a few seconds there is none.
    await interaction.editReply('A new build is going up right now. Press the button again in a minute.');
    return;
  }
  const built = asset ? Math.floor(new Date(asset.created_at).getTime() / 1000) : null;

  await interaction.editReply(
    `**[Download ${cfg.game} for ${file.label}](${link})**` +
    (asset ? ` (${Math.round(asset.size / 1048576)} MB, built <t:${built}:R>)` : '') + '\n' +
    (file.how ? `${file.how}\n` : '') +
    '\nYou only need it once: the game updates itself every time it starts. The link never changes, ' +
    'so you can keep it, but keep it to the test group.'
  );
  await record(interaction, cfg, `⬇️ <@${interaction.member.id}> (**${interaction.member.user.username}**) downloaded the ` +
    `${file.label} build${built ? ` (built <t:${built}:f>)` : ''}.`);
}

const MISSING = Symbol('missing');

/**
 * The asset's size and upload time, from GitHub's public API (no key: the repo
 * is public). Only for show, so a GitHub that does not answer costs nothing but
 * those two (null); MISSING means the release answered without that file.
 */
async function assetInfo(dl, name) {
  try {
    const res = await fetch(`https://api.github.com/repos/${dl.repo}/releases/tags/${encodeURIComponent(dl.tag)}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Sheogorath' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return MISSING;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).assets.find((a) => a.name === name) || MISSING;
  } catch (err) {
    console.warn(`[Playtest] Could not read the ${dl.tag} release of ${dl.repo}: ${err?.message || err}`);
    return null;
  }
}

module.exports = { isPlaytestButton, handleButton, buildMessage, buildDownloadsMessage };
