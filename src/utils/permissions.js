'use strict';
const { PermissionFlagsBits } = require('discord.js');
const { getGuildConfig, hasFeature } = require('../config/guilds');

/**
 * Which feature each command belongs to. Commands absent from this map are
 * unconditional and register everywhere.
 *
 * One map drives both halves of the policy — which commands a guild gets
 * registered, and whether an invocation is allowed — so registration and the
 * runtime gate can't drift apart.
 */
const COMMAND_FEATURES = {
  play: 'music',
  pause: 'music',
  resume: 'music',
  skip: 'music',
  stop: 'music',
  queue: 'music',
  clear: 'music',
  remove: 'music',
  nowplaying: 'music',
  playlist: 'music',
  radio: 'music',
  autoplay: 'music',

  mod: 'moderation',
  stats: 'moderation',
  automod: 'automod',

  sheo: 'ai',
  settledebate: 'ai',

  pickem: 'pickem',

  event: 'events',

  drops: 'drops',

  bet: 'ledger',
  ledger: 'ledger',

  wardogs: 'wardogs',
  gold: 'wardogsGold',
  players: 'wardogsPlayers',

  vclog: 'voiceLog',
  // The message menu's commands, which Discord names by their labels.
  'Keep in the Ledger': 'ledger',
  'Mad God commentary': 'clips',
  Wabbajack: 'clips',
};

/** Music additionally requires admin, not just the feature. */
const MUSIC_COMMANDS = new Set(
  Object.keys(COMMAND_FEATURES).filter((name) => COMMAND_FEATURES[name] === 'music')
);

/**
 * Commands that need full bot admin for every subcommand.
 *
 * `/sheo` sets how much Sheogorath may do unsupervised. A Sheriff is trusted to
 * use his judgement and to rule on what he asks for — the whole approval flow
 * rests on that — but deciding whether he needs to ask at all is a rung above,
 * because a Sheriff who could move him to `enforce` could widen their own
 * reach by proxy.
 */
const ADMIN_COMMANDS = new Set(['sheo']);

/**
 * Commands for staff and up. `/vclog` reads back who was in voice and when,
 * which is the staff's business and not the room's.
 */
const STAFF_COMMANDS = new Set(['vclog']);

/** Subcommands that need full admin even though their parent command doesn't. */
const ADMIN_SUBCOMMANDS = {
  pickem: new Set(['open']),
};

/** Why each entry above is restricted, shown verbatim in the refusal. */
const ADMIN_SUBCOMMAND_REASONS = {
  'pickem open': 'it posts a card to the whole server ahead of fight week',
};

/**
 * Whether a member counts as an admin in their guild.
 *
 * Three independent grants, any of which is enough: Discord's own Administrator
 * permission, the bot owner, or a per-guild role named in config/guilds.json.
 * The configured role exists so a guild can hand out bot admin without handing
 * out Administrator on the whole server — a guild whose admin roles already
 * carry Administrator doesn't need to set it.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */
function isAdmin(member) {
  if (!member || !member.guild) return false;

  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (member.id === process.env.ADMIN_USER_ID) return true;

  const adminRoleId = getGuildConfig(member.guild.id)?.roles.admin;
  return !!adminRoleId && member.roles.cache.has(adminRoleId);
}

/**
 * Whether a member holds the staff tier — the rung between admin and VIP whose
 * holders rule on what Sheogorath asks permission for.
 *
 * Admins are staff by definition, so the ladder stays a ladder: anything a
 * Sheriff can do, an Owner can do. Kept separate from isAdmin() because the
 * grants are different in kind — a Sheriff is trusted to rule on what he asks
 * for, not with the bot's moderation and automod surfaces.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */
function isStaff(member) {
  if (isAdmin(member)) return true;
  if (!member || !member.guild) return false;

  const staffRoleId = getGuildConfig(member.guild.id)?.roles.staff;
  return !!staffRoleId && member.roles.cache.has(staffRoleId);
}

/**
 * Gate for the music surfaces that aren't slash commands — the now-playing
 * buttons and reactions, which anyone who can see the card can trigger.
 * @returns {string|null} a refusal message, or null when allowed.
 */
function musicDenialReason(guildId, member) {
  if (!hasFeature(guildId, 'music')) return '❌ Music is not enabled in this server.';
  if (!isAdmin(member)) return '❌ Music controls are admin-only.';
  return null;
}

/**
 * Gate for slash commands. Filtering at registration should mean a disabled
 * command is never invokable, so the feature branch here is defence in depth
 * against a stale registration.
 *
 * @param {string|null} [subcommand] the invoked subcommand, for the entries in
 *   ADMIN_SUBCOMMANDS. Checked here rather than inside the command so a refusal
 *   is still recorded as one in the audit log.
 * @returns {string|null} a refusal message, or null when allowed.
 */
function commandDenialReason(commandName, guildId, member, subcommand = null) {
  const required = COMMAND_FEATURES[commandName];
  if (required && !hasFeature(guildId, required)) {
    return '❌ That command is not enabled in this server.';
  }
  if (MUSIC_COMMANDS.has(commandName) && !isAdmin(member)) {
    return '❌ Music controls are admin-only.';
  }
  if (ADMIN_COMMANDS.has(commandName) && !isAdmin(member)) {
    return `❌ \`/${commandName}\` is Owners-only.`;
  }
  if (STAFF_COMMANDS.has(commandName) && !isStaff(member)) {
    return `❌ \`/${commandName}\` is staff-only.`;
  }
  if (subcommand && ADMIN_SUBCOMMANDS[commandName]?.has(subcommand) && !isAdmin(member)) {
    const why = ADMIN_SUBCOMMAND_REASONS[`${commandName} ${subcommand}`]
      || 'it is not bounded the way the rest of the staff commands are';
    return `❌ \`/${commandName} ${subcommand}\` is Owners-only — ${why}.`;
  }
  return null;
}

/**
 * The command list a given guild should have registered. Feature-gated commands
 * are withheld entirely from guilds without the feature, so they don't clutter
 * the picker with entries that would only ever be refused.
 *
 * @param {Array<{name: string}>} allCommands
 * @param {string} guildId
 */
function commandsForGuild(allCommands, guildId) {
  return allCommands.filter((c) => {
    const required = COMMAND_FEATURES[c.name];
    return !required || hasFeature(guildId, required);
  });
}

/**
 * Whether a member is at least Veteran — the rung below staff.
 *
 * A ladder, like isStaff: anything a Veteran may do, a Sheriff and an Owner may
 * do too, so this answers true for all three. It gates nothing on the Discord
 * side; it exists so a capability can be opened to the people who have been
 * around a while without being opened to everyone who can type.
 *
 * A guild that has not named a veteran role has no such rung, and everyone
 * below staff falls outside it.
 */
function isVeteran(member) {
  if (!member || !member.guild) return false;
  if (isStaff(member)) return true;

  const veteranRoleId = getGuildConfig(member.guild.id)?.roles.veteran;
  return !!veteranRoleId && member.roles.cache.has(veteranRoleId);
}

module.exports = {
  isAdmin,
  isStaff,
  isVeteran,
  COMMAND_FEATURES,
  MUSIC_COMMANDS,
  ADMIN_COMMANDS,
  STAFF_COMMANDS,
  ADMIN_SUBCOMMANDS,
  musicDenialReason,
  commandDenialReason,
  commandsForGuild,
};
