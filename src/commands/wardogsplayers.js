'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { getGuildConfig } = require('../config/guilds');
const players = require('../services/wardogsPlayers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('wardogsplayers')
    .setDescription('How many are playing WARDOGS on Steam right now, with a graph')
    .addStringOption((o) => o
      .setName('range')
      .setDescription('How far back the graph goes (7 days if unset)')
      .addChoices(
        { name: '24 hours', value: 'day' },
        { name: '7 days', value: 'week' },
        { name: '30 days', value: 'month' },
        { name: 'Since launch', value: 'all' },
      )),

  async execute(interaction) {
    await interaction.deferReply();
    const range = interaction.options.getString('range') || 'week';
    const timeZone = getGuildConfig(interaction.guildId)?.timeZone || 'UTC';
    try {
      const message = await players.playersMessage({ range, timeZone });
      return interaction.editReply({ ...message, allowedMentions: { parse: [] } });
    } catch (err) {
      console.warn(`[WardogsPlayers] /wardogsplayers failed: ${err?.message || err}`);
      return interaction.editReply("❌ Steam isn't answering just now. Try again in a bit.");
    }
  },
};
