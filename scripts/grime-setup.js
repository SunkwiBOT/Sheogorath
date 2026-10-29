#!/usr/bin/env node
'use strict';
/**
 * Stands up the Grime and Punishment guild, the game's own server: roles,
 * categories, channels, a few server settings, and the config/guilds.json entry
 * that wires the bot to all of it.
 *
 * The server is public. Anyone may join for news and chat; everything about the
 * build sits in PLAYTEST, which only the Tester role sees, and that role is
 * given by the playtest agreement button (services/playtest.js) in
 * #join-the-playtest. TEAM is for the Developers alone.
 *
 * Sheogorath holds Administrator here, so permissions cannot hide a channel from
 * him. PLAYTEST and TEAM go in `ai.offLimits` instead, which is what keeps talk
 * under the NDA from ever reaching the model.
 *
 * Same contract as community-setup.js: a dry run unless --apply, idempotent
 * (roles and channels are adopted by name, and their permissions reconciled on
 * every run), and config written as raw JSON. Restart the service afterwards.
 *
 *   node scripts/grime-setup.js            # dry run
 *   node scripts/grime-setup.js --apply
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  PermissionFlagsBits,
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
  GuildVerificationLevel,
} = require('discord.js');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'guilds.json');
const APPLY = process.argv.includes('--apply');
const GUILD_ID = '1560039768845328394';
const REASON = 'Grime and Punishment setup';

// The game's own icon colours (game/icon.svg in the game repo).
const GOLD = 0xffd36e;
const PINK = 0xff5fa2;
const TEAL = 0x3fbfb0;
const LILAC = 0xb39dff;
const BRONZE = 0xe8a33d;
const MUTED = 0x6e7480;

const MODERATE = [
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.MoveMembers,
];

/**
 * Highest first, and created in that order: Discord puts each new role at the
 * bottom, so the first one made ends up on top. `key` is where its ID goes in
 * config: `admin` is the bot-admin tier, `staff` the one below, `tester` the
 * playtest role. `audio` is a title on the team, not a tier: it carries no
 * powers, and only opens #team-chat.
 */
const ROLES = [
  { key: 'admin', name: 'Developer', color: GOLD, hoist: true, mentionable: true,
    perms: [...MODERATE, PermissionFlagsBits.ManageEvents] },
  { key: 'audio', name: 'Audio Engineer', color: LILAC, hoist: true, mentionable: true, perms: [] },
  { key: 'staff', name: 'Moderator', color: PINK, hoist: true, mentionable: true, perms: MODERATE },
  { key: 'tester', name: 'Tester', color: TEAL, hoist: true, mentionable: false, perms: [] },
  // Sheogorath's own title here, and what colours his name: his managed role
  // has no colour. Below the testers, so the member list shows him after the
  // people. No powers; he has those from his managed role.
  { key: 'crier', name: 'Town Crier', color: BRONZE, hoist: true, mentionable: false, perms: [] },
  { key: 'member', name: 'Member', color: MUTED, hoist: false, mentionable: false, perms: [] },
];

/**
 * `access` — who can see it: everyone, the testers (and staff), or the team.
 * `locked` — everyone who can see it reads it; only staff post.
 * `id` — the name this script knows the channel by, for wiring config.
 */
const TREE = [
  { category: 'WELCOME', access: 'public', channels: [
      { id: 'rules', name: 'rules', locked: true,
        topic: 'How this place works. Sheogorath quotes this channel when asked, so keep it true.' },
      // An Announcement channel, which other servers can follow, once Community is on:
      // until then Discord has no such type here, and it stays a text channel.
      { id: 'announcements', name: 'announcements', locked: true, announcement: true,
        topic: 'News about the game, from the developers.' },
      { id: 'about', name: 'about-the-game', locked: true,
        topic: 'What Grime & Punishment is. Sheogorath answers questions about the game from this channel.' },
      { id: 'join', name: 'join-the-playtest', locked: true,
        topic: 'Press the button to join the playtest.' },
    ] },
  { category: 'THE TAVERN', access: 'public', channels: [
      { id: 'general', name: 'general', topic: 'Talk. Events are announced here too.' },
      { id: 'help', name: 'help', topic: 'Ask here. Sheogorath answers in this channel without being called by name.' },
    ] },
  { category: 'PLAYTEST', access: 'testers', channels: [
      { id: 'downloads', name: 'downloads', locked: true,
        topic: 'Get the newest build here. Everything in PLAYTEST is under the NDA.' },
      { id: 'playtestChat', name: 'playtest-chat', topic: 'Testers talk. Under the NDA, like everything in PLAYTEST.' },
      { id: 'feedback', name: 'feedback', topic: 'What you liked, what you did not, and what you wish it had.' },
      // #bug-reports' twin, but the testers' to post in.
      { id: 'suggestions', name: 'suggestions', type: ChannelType.GuildForum, alsoSee: ['audio'],
        topic: 'One post per idea: what you would add or change, and why. Search first, and if someone has already suggested it, add to their post.',
        tags: [['Gameplay', '🎮'], ['Visual', '🎨'], ['Audio', '🔊'], ['Multiplayer', '🌐'], ['Planned', '📌'], ['Added', '✅']] },
      { id: 'playtestVoice', name: 'Playtest', type: ChannelType.GuildVoice },
    ] },
  { category: 'VOICE', access: 'public', channels: [
      { id: 'voice', name: 'General', type: ChannelType.GuildVoice },
    ] },
  { category: 'TEAM', access: 'team', channels: [
      { id: 'teamChat', name: 'team-chat', alsoSee: ['audio'], topic: 'The team.' },
      // Moved here from PLAYTEST, so the testers no longer see it.
      { id: 'bugs', name: 'bug-reports', type: ChannelType.GuildForum, alsoSee: ['audio'],
        topic: 'One post per bug: what happened, what you expected, and your build. Attach the crash log if there is one.',
        tags: [['Bug', '🐛'], ['Crash', '💥'], ['Multiplayer', '🌐'], ['Visual', '🎨'], ['Fixed', '✅']] },
      { id: 'commandLog', name: 'command-log', topic: 'Privileged commands, and what Sheogorath asks permission to do.' },
      // Discord's own notices for moderators, which a Community server must have a
      // channel for. Kept apart from command-log, which the team acts on.
      { id: 'modUpdates', name: 'mod-updates', topic: 'Discord posts its notices for moderators here. Not the bot.' },
      { id: 'signatures', name: 'nda-signatures',
        topic: 'Every playtest agreement and download, and the NDA each copy of the game signs.' },
    ] },
];

// The categories Discord makes for a new server. Removed once emptied.
const DEFAULT_CATEGORIES = ['Text Channels', 'Voice Channels'];

// What every member may do server-wide, less what a public server should not
// hand a stranger: pinging everyone, uploading emoji, and Discord's own event
// button (events go through /event, which anyone may still use).
const EVERYONE_DENY = [
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.CreateGuildExpressions,
  PermissionFlagsBits.CreateEvents,
];

// Who holds the team roles, beyond the owner (who is always a Developer).
const TEAM_MEMBERS = {
  '355959472834871298': 'admin', // Fisher, co-developer
  '1332485520684617769': 'audio', // cookie
};

const FEATURES = ['ai', 'moderation', 'events'];

// The game's own YouTube channel. New uploads are announced in #announcements.
const YOUTUBE_FEEDS = [
  { channelId: 'UCoK3ZBClJbb65L4YR21z12g', name: 'Grime & Punishment', handle: '@Grime_N_Punishment' },
];

const STANDING =
  'This is the Discord of Grime & Punishment, a co-op game in the making: the worst adventuring ' +
  'party in the realm, sentenced to run the royal washhouse, scrubbing heroes’ laundry and robbing ' +
  'its pockets. You are the house madman here, a Daedric Prince who finds the whole sorry affair ' +
  'delightful: you greet newcomers, needle the regulars and keep the room civil. The Developers hold ' +
  'the authority. What you know of the game is what #about-the-game says and nothing more, so never ' +
  'invent features, dates or prices, and say nothing about builds or the playtest beyond sending ' +
  'people to #join-the-playtest.';

// Everything except kick, as in the community server: a room of strangers
// does not need him reaching for the door on his own.
const POWERS = ['note', 'memory', 'clearnotes', 'flag', 'delete', 'timeout', 'title',
  'untitle', 'dm', 'say', 'react', 'pin', 'thread', 'poll', 'nick', 'channel'];

// The same release the main hall's buttons handed out, until this server took
// the playtest over.
const DOWNLOADS = {
  repo: 'bjmcallister/dirty-laundry',
  tag: 'latest-build',
  files: [
    { label: 'Windows', emoji: '🪟', asset: 'GrimeAndPunishment-Windows.zip',
      how: 'Unzip it and run GrimeAndPunishment.exe, keeping the files next to it. If Windows warns about an unknown publisher, click More info, then Run anyway.' },
    { label: 'Mac', emoji: '🍎', asset: 'GrimeAndPunishment-macOS.zip',
      how: 'Unzip it and drag Grime & Punishment into Applications. The first time, macOS blocks it: open System Settings, Privacy & Security, scroll down and click Open Anyway.' },
    { label: 'Linux', emoji: '🐧', asset: 'GrimeAndPunishment-Linux.zip',
      how: 'Unzip it and run GrimeAndPunishment.x86_64. It needs Vulkan graphics drivers.' },
  ],
};

const REQUIRED = [
  ['ManageRoles', PermissionFlagsBits.ManageRoles],
  ['ManageChannels', PermissionFlagsBits.ManageChannels],
  ['ManageGuild', PermissionFlagsBits.ManageGuild],
];

const lower = (s) => String(s).toLowerCase();
const findRole = (guild, name) => guild.roles.cache.find((r) => lower(r.name) === lower(name)) || null;
const findChannel = (guild, name, type) =>
  guild.channels.cache.find((c) => lower(c.name) === lower(name) && [].concat(type).includes(c.type)) || null;
// The types a channel of ours may already be: an announcement channel starts
// as text, and a forum Discord refused was made as text.
const typesOf = (ch) => ch.announcement ? [ChannelType.GuildAnnouncement, ChannelType.GuildText]
  : ch.type === ChannelType.GuildForum ? [ChannelType.GuildForum, ChannelType.GuildText]
    : [ch.type ?? ChannelType.GuildText];
const hasNews = (guild) => guild.features.includes('NEWS');

/**
 * Overwrites for a channel or category: who sees it, and whether only staff
 * post. Children always get theirs set explicitly rather than inherited, so a
 * locked channel in a hidden category stays hidden.
 */
function overwritesFor(guild, roleIds, access, locked, alsoSee = []) {
  const rows = new Map();
  const add = (id, allow = [], deny = []) => {
    const row = rows.get(id) || { id, allow: [], deny: [] };
    row.allow.push(...allow);
    row.deny.push(...deny);
    rows.set(id, row);
  };
  const V = PermissionFlagsBits.ViewChannel;
  if (access === 'testers') {
    add(guild.roles.everyone.id, [], [V]);
    for (const k of ['tester', 'staff', 'admin']) add(roleIds[k], [V]);
  } else if (access === 'team') {
    add(guild.roles.everyone.id, [], [V]);
    add(roleIds.admin, [V]);
  }
  for (const k of alsoSee) add(roleIds[k], [V]);
  if (locked) {
    add(guild.roles.everyone.id, [], [
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.CreatePrivateThreads,
    ]);
    for (const k of ['staff', 'admin']) add(roleIds[k], [PermissionFlagsBits.SendMessages]);
  }
  return [...rows.values()];
}

function plan(guild) {
  const steps = [];
  const blocked = REQUIRED.filter(([, f]) => !guild.members.me?.permissions.has(f)).map(([n]) => n);

  for (const spec of ROLES) {
    const existing = findRole(guild, spec.name);
    steps.push(`[${existing ? 'adopt' : 'create'}] role ${spec.name}${existing ? ` (${existing.id})` : ''}`);
  }
  for (const cat of TREE) {
    const existingCat = findChannel(guild, cat.category, ChannelType.GuildCategory);
    steps.push(`[${existingCat ? 'adopt' : 'create'}] category ${cat.category} (${cat.access})`);
    for (const ch of cat.channels) {
      const type = ch.type ?? ChannelType.GuildText;
      const existing = findChannel(guild, ch.name, typesOf(ch));
      const move = existing && (!existingCat || existing.parentId !== existingCat.id);
      const news = !ch.announcement ? ''
        : existing?.type === ChannelType.GuildAnnouncement ? ', announcement'
          : hasNews(guild) ? ', make it an announcement channel' : ', announcement once Community is on';
      steps.push(`    [${existing ? (move ? 'adopt+move' : 'adopt') : 'create'}] ${type === ChannelType.GuildVoice ? '🔊 ' : '#'}${ch.name}` +
        `${ch.locked ? ', staff post only' : ''}${type === ChannelType.GuildForum ? ', forum' : ''}${news}`);
    }
  }
  for (const name of DEFAULT_CATEGORIES) {
    if (findChannel(guild, name, ChannelType.GuildCategory)) steps.push(`[remove once empty] Discord's default category "${name}"`);
  }
  steps.push('[set] @everyone may not mention everyone, upload emoji or make Discord events');
  steps.push('[set] notifications default to mentions only; explicit media scanned for everyone; verified email to talk');
  if (guild.features.includes('COMMUNITY')) steps.push("[set] Community: rules in #rules, Discord's notices in #mod-updates");
  steps.push(`[give] Developer to the server owner (${guild.ownerId})`);
  steps.push(`[give] Town Crier to me (${guild.members.me.user.username})`);
  for (const [id, key] of Object.entries(TEAM_MEMBERS)) steps.push(`[give] ${ROLES.find((r) => r.key === key).name} to ${id}`);
  return { steps, blocked };
}

async function apply(guild) {
  const roleIds = {};
  const ladder = [];
  for (const spec of ROLES) {
    let role = findRole(guild, spec.name);
    if (!role) {
      role = await guild.roles.create({
        name: spec.name, color: spec.color, hoist: spec.hoist, mentionable: spec.mentionable,
        permissions: spec.perms, reason: REASON,
      });
    } else if (role.editable && (role.color !== spec.color || role.hoist !== spec.hoist || role.mentionable !== spec.mentionable)) {
      await role.edit({ color: spec.color, hoist: spec.hoist, mentionable: spec.mentionable, reason: REASON });
    }
    roleIds[spec.key] = role.id;
    ladder.push(role);
  }

  // Positions are explicit so a re-run repairs a ladder someone dragged about.
  // One call per role: the bulk endpoint touches the bot's own managed role and
  // is refused (see community-setup.js).
  await guild.roles.fetch();
  const ceiling = guild.members.me.roles.highest.position;
  for (let i = 0; i < ladder.length; i++) {
    const want = ladder.length - i;
    if (want >= ceiling) {
      console.warn(`  ! cannot order the roles: my own role sits at position ${ceiling}, level with or under them. ` +
        `Drag "${guild.members.me.roles.highest.name}" to the top in Server Settings, Roles, and re-run.`);
      break;
    }
    const role = guild.roles.cache.get(ladder[i].id);
    if (role.position !== want) await role.setPosition(want, { reason: REASON });
  }

  const ids = {};
  for (const cat of TREE) {
    const catOverwrites = overwritesFor(guild, roleIds, cat.access, false);
    let parent = findChannel(guild, cat.category, ChannelType.GuildCategory);
    if (!parent) {
      parent = await guild.channels.create({
        name: cat.category, type: ChannelType.GuildCategory, permissionOverwrites: catOverwrites, reason: REASON,
      });
    } else {
      await parent.permissionOverwrites.set(catOverwrites, REASON);
    }
    ids[`cat:${cat.category}`] = parent.id;

    for (const ch of cat.channels) {
      let type = ch.type ?? ChannelType.GuildText;
      const overwrites = overwritesFor(guild, roleIds, cat.access, ch.locked, ch.alsoSee);
      if (ch.announcement && hasNews(guild)) type = ChannelType.GuildAnnouncement;
      let channel = findChannel(guild, ch.name, typesOf(ch));
      if (channel) {
        if (ch.announcement && hasNews(guild) && channel.type === ChannelType.GuildText) {
          channel = await channel.setType(ChannelType.GuildAnnouncement, REASON);
        }
        if (channel.parentId !== parent.id) await channel.setParent(parent.id, { lockPermissions: false, reason: REASON });
        await channel.permissionOverwrites.set(overwrites, REASON);
        if (ch.topic && 'topic' in channel && !channel.topic) await channel.setTopic(ch.topic, REASON);
      } else {
        const base = { name: ch.name, parent: parent.id, topic: ch.topic, permissionOverwrites: overwrites, reason: REASON };
        if (type === ChannelType.GuildForum) {
          try {
            channel = await guild.channels.create({
              ...base, type,
              availableTags: ch.tags.map(([name, emoji]) => ({ name, emoji: { id: null, name: emoji } })),
            });
          } catch (err) {
            console.warn(`  ! #${ch.name} could not be a forum (${err.message}); made it a text channel.`);
            type = ChannelType.GuildText;
          }
        }
        if (!channel) channel = await guild.channels.create({ ...base, type });
      }
      ids[ch.id] = channel.id;
    }
  }

  await guild.channels.fetch();
  for (const name of DEFAULT_CATEGORIES) {
    const cat = findChannel(guild, name, ChannelType.GuildCategory);
    if (cat && !guild.channels.cache.some((c) => c.parentId === cat.id)) await cat.delete(REASON);
  }

  const everyone = guild.roles.everyone;
  if (EVERYONE_DENY.some((p) => everyone.permissions.has(p))) {
    await everyone.setPermissions(everyone.permissions.remove(EVERYONE_DENY), REASON);
  }
  await guild.edit({
    defaultMessageNotifications: GuildDefaultMessageNotifications.OnlyMentions,
    explicitContentFilter: GuildExplicitContentFilter.AllMembers,
    verificationLevel: GuildVerificationLevel.Low,
    // Only a Community server has these.
    ...(guild.features.includes('COMMUNITY') ? { rulesChannel: ids.rules, publicUpdatesChannel: ids.modUpdates } : {}),
    reason: REASON,
  });

  const owner = await guild.members.fetch(guild.ownerId).catch(() => null);
  if (owner && !owner.roles.cache.has(roleIds.admin)) await owner.roles.add(roleIds.admin, REASON);
  if (!guild.members.me.roles.cache.has(roleIds.crier)) await guild.members.me.roles.add(roleIds.crier, REASON);
  for (const [id, key] of Object.entries(TEAM_MEMBERS)) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (!member) { console.warn(`  ! ${id} is not in the server; no ${key} role for them.`); continue; }
    if (!member.roles.cache.has(roleIds[key])) await member.roles.add(roleIds[key], REASON);
  }

  const raw = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
  const prev = raw[guild.id] || {};
  raw[guild.id] = {
    ...prev,
    name: 'grime-and-punishment',
    timeZone: prev.timeZone || 'America/Chicago',
    features: FEATURES,
    // What he posts here is published to the servers that follow the channel.
    autoPublish: [ids.announcements],
    channels: {
      ...(prev.channels || {}),
      rules: ids.rules,
      serverInfo: ids.about,
      help: ids.help,
      commandLog: ids.commandLog,
      defaultVoice: ids.voice,
    },
    roles: {
      ...(prev.roles || {}),
      admin: roleIds.admin,
      staff: roleIds.staff,
      member: roleIds.member,
      onJoin: roleIds.member,
    },
    ai: {
      ...(prev.ai || {}),
      // Kept once set: the mode is a decision taken later, with /sheo mode.
      mode: prev.ai?.mode || 'shadow',
      standing: STANDING,
      powers: POWERS,
      titles: { admin: 'Developer', staff: 'Moderator' },
      offLimits: [ids['cat:PLAYTEST'], ids['cat:TEAM']],
    },
    // Only for the calendar for now. Once the game has its own Steam App ID it
    // goes in steamApps, and its Steam announcements land in #announcements.
    gameNews: {
      steamApps: [],
      ...(prev.gameNews || {}),
      channel: ids.announcements,
      eventsChannel: ids.general,
    },
    youtube: {
      ...(prev.youtube || {}),
      channel: ids.announcements,
      // No ping: an upload is not the interrupt going live is.
      pingRole: prev.youtube?.pingRole || null,
      pollMinutes: prev.youtube?.pollMinutes || 15,
      feeds: YOUTUBE_FEEDS,
    },
    playtest: {
      ...(prev.playtest || {}),
      role: roleIds.tester,
      channel: ids.downloads,
      log: ids.signatures,
      post: ids.join,
      game: 'Grime & Punishment',
      // Kept once set, like the AI mode: the cap is a decision taken later.
      limit: prev.playtest?.limit || 20,
      // The team tests too, without using up a tester's place.
      uncounted: [roleIds.admin, roleIds.audio, roleIds.staff],
      downloads: { ...DOWNLOADS, ...(prev.playtest?.downloads || {}), channel: ids.downloads },
    },
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return { roleIds, ids };
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild) return console.log(`Not in ${GUILD_ID}. Invite the bot first.`);
    await guild.channels.fetch();
    await guild.roles.fetch();
    await guild.members.fetchMe();

    const p = plan(guild);
    console.log(`PLAN for ${guild.name} (${guild.id})`);
    console.log(`  blocked: ${p.blocked.length ? p.blocked.join(' | ') : 'nothing'}`);
    for (const s of p.steps) console.log(`  ${s}`);

    if (!APPLY) return console.log('\n(dry run: pass --apply to execute)');
    if (p.blocked.length) return console.log('\nRefusing to apply while blocked.');

    const r = await apply(guild);
    console.log('\nAPPLIED');
    console.log(`  roles:    ${JSON.stringify(r.roleIds)}`);
    console.log(`  channels: ${JSON.stringify(r.ids)}`);
    console.log(`  wrote ${CONFIG_FILE}`);
    console.log('\nRestart the service for the bot to pick this up.');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
});

client.login(process.env.DISCORD_TOKEN);
