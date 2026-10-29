'use strict';
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { isStaff } = require('../utils/permissions');
const { nowLines, recentLines, userSummary, leaderboard, duration, fit, clean } = require('../services/voiceLog');

const COLOR = 0x5865F2;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('vclog')
    .setDescription('Who has been in voice, and when (staff only)')
    // Not setDefaultMemberPermissions: that would hide it from staff who hold
    // the configured staff role without a matching Discord permission. Access
    // is checked in utils/permissions.js (STAFF_COMMANDS) and again below.
    .addSubcommand((sub) =>
      sub.setName('now').setDescription('Who is in voice right now, and since when'))
    .addSubcommand((sub) =>
      sub.setName('recent')
        .setDescription('Every join, leave and move, newest last')
        .addIntegerOption((opt) =>
          opt.setName('hours').setDescription('How far back (default 24)').setMinValue(1).setMaxValue(168)))
    .addSubcommand((sub) =>
      sub.setName('user')
        .setDescription("One person's time in voice")
        .addUserOption((opt) => opt.setName('user').setDescription('Who').setRequired(true))
        .addIntegerOption((opt) =>
          opt.setName('days').setDescription('How far back (default 7)').setMinValue(1).setMaxValue(90)))
    .addSubcommand((sub) =>
      sub.setName('top')
        .setDescription('Who has spent the most time in voice')
        .addIntegerOption((opt) =>
          opt.setName('days').setDescription('How far back (default 7)').setMinValue(1).setMaxValue(90))),

  async execute(interaction) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: '❌ `/vclog` is staff-only.', flags: 64 });
    }

    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const embed = new EmbedBuilder().setColor(COLOR);

    if (sub === 'now') {
      const lines = nowLines(guild);
      embed.setTitle('🔊 In voice now').setDescription(lines.length ? fit(lines) : 'Nobody is in voice.');
    } else if (sub === 'recent') {
      const hours = interaction.options.getInteger('hours') || 24;
      const lines = recentLines(guild.id, hours);
      embed
        .setTitle(`📜 Voice log · last ${hours === 1 ? 'hour' : `${hours} hours`}`)
        .setDescription(lines.length ? fit(lines) : 'Nobody came or went.');
    } else if (sub === 'user') {
      const user = interaction.options.getUser('user');
      const days = interaction.options.getInteger('days') || 7;
      const member = await guild.members.fetch(user.id).catch(() => null);
      const name = member?.displayName || user.username;
      const { sessions, total, lines } = userSummary(guild.id, user.id, days);
      const span = days === 1 ? 'the last day' : `the last ${days} days`;
      embed
        .setTitle(`🎧 ${name} in voice`)
        .setDescription(sessions
          ? `**${duration(total)}** across ${sessions} session${sessions === 1 ? '' : 's'} in ${span}.\n\n${fit(lines, 3700)}`
          : `Not in voice in ${span}.`);
    } else if (sub === 'top') {
      const days = interaction.options.getInteger('days') || 7;
      const rows = leaderboard(guild.id, days).slice(0, 20);
      const lines = rows.map((r, i) =>
        `${i + 1}. **${clean(r.name)}** · ${duration(r.total)} (${r.sessions} session${r.sessions === 1 ? '' : 's'})`);
      embed
        .setTitle(`🏆 Most time in voice · last ${days === 1 ? 'day' : `${days} days`}`)
        .setDescription(lines.length ? lines.join('\n') : 'Nobody has been in voice.');
    }

    embed.setFooter({ text: '~ marks a time that is approximate: it fell while I was offline.' });
    return interaction.reply({ embeds: [embed], flags: 64 });
  },
};
