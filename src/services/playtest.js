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
 * A download button answers, to that tester alone, with a link to the build
 * from the GitHub release in `playtest.downloads` (a private repo, read with
 * GITHUB_DOWNLOADS_TOKEN). The link is GitHub's own signed one and lapses within
 * the hour, so a forwarded link is soon worth nothing, and the button always
 * hands out whatever was built last. Only someone holding the role gets one:
 * the button is in their channel, but the role is checked anyway.
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
      `${cfg.game} is not out yet, so everything in ${channelOf(cfg)} is confidential.\n\n` +
      'Press **I agree** to confirm you will not share, stream, post or talk about the game, its builds, ' +
      'screenshots, or anything from that channel with anyone outside the test group, and that you will ' +
      'sign the NDA in the game when you first open it. The channel opens to you straight away.' +
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
  const embed = new EmbedBuilder()
    .setColor(TEAL)
    .setTitle(`⬇️ Get ${cfg.game}`)
    .setDescription(
      'Press the button for your computer for the newest build. The link you get is yours alone and stops ' +
      'working within the hour, so do not pass it on: anyone who needs the game gets it here.\n\n' +
      'You only download it once: the game updates itself to the newest build every time it starts, and each ' +
      'new build is announced below. ' +
      'The first time it opens, the game asks you to sign its NDA, with Steam running.'
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
  const token = process.env.GITHUB_DOWNLOADS_TOKEN;
  if (!token) {
    console.warn('[Playtest] A download was asked for, but GITHUB_DOWNLOADS_TOKEN is not set.');
    await interaction.reply({ content: 'Downloads are not set up yet. Tell an admin.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Sheogorath',
    };
    const rel = await fetch(`https://api.github.com/repos/${dl.repo}/releases/tags/${encodeURIComponent(dl.tag)}`, { headers });
    if (!rel.ok) throw new Error(`release ${dl.tag}: HTTP ${rel.status}`);
    const asset = (await rel.json()).assets.find((a) => a.name === file.asset);
    if (!asset) throw new Error(`no ${file.asset} in ${dl.tag}`);
    // The asset itself answers with a redirect to a short-lived signed URL: that is the link handed out, unread.
    const res = await fetch(asset.url, { headers: { ...headers, Accept: 'application/octet-stream' }, redirect: 'manual' });
    const link = res.headers.get('location');
    if (!link) throw new Error(`${file.asset}: HTTP ${res.status} and no redirect`);
    const built = Math.floor(new Date(asset.created_at).getTime() / 1000);

    await interaction.editReply(
      `**[Download ${cfg.game} for ${file.label}](${link})** (${Math.round(asset.size / 1048576)} MB, built <t:${built}:R>)\n` +
      (file.how ? `${file.how}\n` : '') +
      '\nThis link is just for you and stops working within the hour. Press the button again for a fresh one.'
    );
    await record(interaction, cfg, `⬇️ <@${interaction.member.id}> (**${interaction.member.user.username}**) downloaded the ` +
      `${file.label} build (built <t:${built}:f>).`);
  } catch (err) {
    console.warn(`[Playtest] ${interaction.guild.name}: download of ${file.asset} failed: ${err?.message || err}`);
    await interaction.editReply('I could not fetch the build just now. Try again in a minute, or tell an admin.');
  }
}

/**
 * Keeps one build notice in the downloads channel: when a webhook posts there
 * (the game's build workflow saying a new build is up), the earlier posts from
 * that same webhook are deleted, so the channel says only what is current.
 * Interaction replies come through the bot's own application webhook and are
 * left alone.
 */
function watchBuildNotices(client) {
  client.on('messageCreate', async (message) => {
    if (!message.webhookId || !message.guildId || message.webhookId === message.client.application?.id) return;
    const channel = configFor(message.guildId)?.downloads?.channel;
    if (!channel || message.channelId !== channel) return;
    try {
      const earlier = await message.channel.messages.fetch({ before: message.id, limit: 50 });
      for (const old of earlier.values()) {
        if (old.webhookId === message.webhookId) await old.delete();
      }
    } catch (err) {
      console.warn(`[Playtest] ${message.guild?.name}: could not clear the old build notices: ${err?.message || err}`);
    }
  });
}

module.exports = { isPlaytestButton, handleButton, buildMessage, buildDownloadsMessage, watchBuildNotices };
