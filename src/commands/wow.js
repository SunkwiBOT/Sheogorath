'use strict';
const { SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const battlenet = require('../services/battlenet');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('wow')
    .setDescription('World of Warcraft: Forever: link Battle.net and find each other')
    .addSubcommand((sub) => sub
      .setName('link')
      .setDescription('Sign in with Battle.net to link your account (or refresh your characters)'))
    .addSubcommand((sub) => sub
      .setName('whois')
      .setDescription('Someone\'s BattleTag and WoW Forever characters')
      .addUserOption((o) => o.setName('who').setDescription('Someone who has linked (default: you)')))
    .addSubcommand((sub) => sub
      .setName('friends')
      .setDescription('Everyone here who has linked, with their BattleTags')
      .addBooleanOption((o) => o.setName('post').setDescription('Post it in the channel for everyone (default: just you)')))
    .addSubcommand((sub) => sub
      .setName('unlink')
      .setDescription('Forget your Battle.net account')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'link') {
      const url = battlenet.createLink(interaction);
      if (!url) {
        return interaction.reply({
          content: `❌ Battle.net linking is not set up on this bot yet (${battlenet.missingSetup().join(', ')}).`,
          flags: MessageFlags.Ephemeral,
        });
      }
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Sign in with Battle.net').setURL(url),
      );
      return interaction.reply({
        content: 'Sign in on Battle.net\'s own page; your password never reaches this bot. '
          + 'It reads your BattleTag and your WoW Forever characters once, then throws the login away. '
          + 'Everyone in this server will be able to see your BattleTag through `/wow whois` and `/wow friends`. '
          + 'This link works once, for 10 minutes, and the result will appear here when you are done.',
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'whois') {
      const user = interaction.options.getUser('who') || interaction.user;
      const entry = battlenet.getLink(user.id);
      if (!entry) {
        return interaction.reply({
          content: user.id === interaction.user.id
            ? 'You have not linked a Battle.net account. `/wow link` to do it.'
            : `${user.username} has not linked a Battle.net account.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.reply({ embeds: [battlenet.profileEmbed(entry, user)], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'friends') {
      const post = interaction.options.getBoolean('post') === true;
      await interaction.deferReply(post ? {} : { flags: MessageFlags.Ephemeral });
      const embed = await battlenet.friendsEmbed(interaction.guild);
      return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    }

    if (sub === 'unlink') {
      const removed = battlenet.unlink(interaction.user.id);
      return interaction.reply({
        content: removed ? '🗑️ Your Battle.net account is forgotten.' : 'You had nothing linked.',
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({ content: '❌ That is not something /wow does.', flags: MessageFlags.Ephemeral });
  },
};
