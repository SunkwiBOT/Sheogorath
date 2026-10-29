'use strict';
const { SlashCommandBuilder } = require('discord.js');
const gold = require('../services/wardogsGold');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('gold')
    .setDescription("Today's WARDOGS gold bar price, with a graph")
    .addIntegerOption((o) => o
      .setName('days')
      .setDescription('How far back the graph goes (30 days if unset)')
      .addChoices(
        { name: '7 days', value: 7 },
        { name: '14 days', value: 14 },
        { name: '30 days', value: 30 },
        { name: 'Since launch', value: 0 },
      ))
    .addIntegerOption((o) => o
      .setName('bars')
      .setDescription('What this many bars cost today')
      .setMinValue(1)
      .setMaxValue(100000)),

  async execute(interaction) {
    await interaction.deferReply();
    const days = interaction.options.getInteger('days') ?? 30;
    const bars = interaction.options.getInteger('bars');
    let read;
    try {
      read = await gold.readGold({ allowStale: true });
    } catch (err) {
      console.warn(`[WardogsGold] /gold failed: ${err?.message || err}`);
      return interaction.editReply("❌ Neither gold tracker could be reached. Try again in a bit.");
    }
    return interaction.editReply({ ...gold.goldMessage(read, { days, bars }), allowedMentions: { parse: [] } });
  },
};
