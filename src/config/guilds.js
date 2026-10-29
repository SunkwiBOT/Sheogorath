'use strict';
/**
 * Per-guild configuration.
 *
 * Guild, channel and role IDs are not secrets, so they live in a committed
 * JSON file rather than .env. That keeps .env to credentials only, and makes
 * onboarding a second guild an edit to one file instead of a pile of new
 * env vars that would have had to be named per-guild anyway.
 *
 * On first run the file is seeded from the legacy env vars and the constants
 * that used to be inlined across the codebase, so an existing single-guild
 * deployment keeps behaving identically without anyone touching anything.
 */
const fs = require('fs');
const path = require('path');
const { validTimeZone } = require('../utils/time');
const { writeFileAtomic } = require('../storage/jsonFile');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'guilds.json');

// Placeholder keys (e.g. "REPLACE_WITH_GUILD_ID") are intentionally
// tolerated in the file so the shape is self-documenting — they're skipped
// everywhere rather than being registered against or looked up.
const SNOWFLAKE = /^[0-9]{17,20}$/;

/**
 * Every feature that can be switched on per guild. A guild only runs what it
 * lists — a server with no streamers has no use for the stream watcher or the Instagram
 * downloader, and gating beats scattering null-checks through the handlers.
 */
const FEATURES = [
  'ai',           // mention/keyword replies from the persona
  'music',        // playback, queue, radio — admin-only wherever it's enabled
  'moderation',   // /mod and /stats
  'instagram',    // auto-download of posted Instagram links
  'twitter',      // auto-download of video from posted X/Twitter links
  'tiktok',       // auto-download of video from posted TikTok links
  'reddit',       // auto-download of Reddit-hosted video from posted Reddit links
  'textImageMod', // Ollama-backed ASCII/Unicode explicit-art filter
  'automod',      // Discord native AutoMod rule management, /automod
  'pickem',       // UFC pick'em in the `ufc.channel`, /pickem
  'events',       // /event, events added by telling him, and reminders before each one
  'ledger',       // the group's book: /bet, /ledger, rulings and kept quotes
  'wardogs',      // /wardogs: WARDOGS stats by Steam sign-in (needs WARDOGS_PUBLIC_URL)
  'wardogsGold',  // /gold, and the WARDOGS gold bar price posted each day it moves (needs a wardogsGold block)
  'wardogsPlayers', // /players: how many are playing WARDOGS on Steam, read every 10 minutes, with a graph
  'clips',        // his commentary over clips, and the Wabbajack (needs ffmpeg; commentary needs ELEVENLABS_*)
  'drops',        // /drops, and Twitch and Kick drops posted for the games we play (needs a gameNews block)
  'voiceLog',     // who joined, left and moved between voice channels, and when; /vclog (staff)
];

let cache = null;

function normalizeGuild(id, raw) {
  const channels = raw.channels || {};
  const roles = raw.roles || {};
  const features = Array.isArray(raw.features) ? raw.features.filter(f => FEATURES.includes(f)) : [];

  return {
    id,
    name: raw.name || id,
    // The zone the people here live in: what "Friday 8pm" means when they say
    // it, and the clock he is told the time by.
    timeZone: validTimeZone(raw.timeZone) || 'America/Chicago',
    features,
    // Announcement channels whose posts by him are published to the servers
    // that follow them (services/autopublish.js).
    autoPublish: Array.isArray(raw.autoPublish) ? raw.autoPublish.map(String).filter((id) => SNOWFLAKE.test(id)) : [],
    channels: {
      // Where now-playing cards are posted.
      music: channels.music || null,
      // Voice channel the companion app joins when the bot isn't already
      // connected. Unused by the slash commands, which follow the caller.
      defaultVoice: channels.defaultVoice || null,
      // Where privileged command invocations are mirrored, so admins can see
      // what staff did without reading logs/commands.jsonl on the host. Every
      // command is recorded to that file regardless of this setting.
      commandLog: channels.commandLog || null,
      // Where Sheogorath posts what he wants permission to do, and what he did
      // on his own. Falls back to `commandLog` when unset — a guild that
      // already has one private staff channel shouldn't be made to create a
      // second just to turn the moderator on.
      modApprovals: channels.modApprovals || null,
      // The one channel he answers in without being called by name. Unset means
      // he waits to be addressed there like anywhere else.
      help: channels.help || null,
      // Reference channels Sheogorath reads before answering questions, so the
      // rules and the connection details he quotes are the ones players can see
      // rather than a second copy that drifts. Left unset, he looks for
      // channels literally named `rules` and `server-info`.
      //
      // Whatever is posted in these becomes what he tells people, so they
      // should be channels only staff can write to.
      rules: channels.rules || null,
      serverInfo: channels.serverInfo || null,
      // The Mad God's parlour: the one room where the persona's "1-2 sentences"
      // cap is lifted and he carries a real conversation. Created by
      // `/sheo parlour`, which writes this key itself.
      parlour: channels.parlour || null,
      // Where the self-assign button message lives. Only the poster script
      // needs it; the buttons themselves carry their own role IDs.
      selfRoles: channels.selfRoles || null,
    },
    roles: {
      // The guild's role ladder, highest first. Only `admin` and `staff` gate
      // anything; `veteran` and `member` are recorded so the rename tooling and
      // any future perk checks have one place to look rather than re-deriving
      // IDs from role names, which people rename.

      // Grants bot admin without granting Discord Administrator.
      admin: roles.admin || null,
      // One rung below admin: the staff tier (Sheriff), who rule on what
      // Sheogorath asks permission for.
      staff: roles.staff || null,
      veteran: roles.veteran || null,
      member: roles.member || null,
      // Handed to everyone who joins, by services/autorole.js. Its own key
      // rather than a reuse of `member`: what a guild records for perk checks
      // and what it wants given away unattended are different questions, and a
      // guild that wants no autorole should say so by leaving this unset rather
      // than by clearing a role it relies on elsewhere.
      onJoin: roles.onJoin || null,
    },
    // How much rope the AI moderator gets in this guild. See ai/capabilities.js
    // for what each mode means. Absent means `shadow`: a guild that has never
    // been thought about should watch rather than act.
    ai: {
      mode: typeof raw.ai?.mode === 'string' ? raw.ai.mode : null,
      // One sentence about what he *is* in this guild, handed to him verbatim.
      // The same bot is the figurehead of the main hall and the host of the
      // community room, and nothing else in this file says so — features
      // describe what the bot runs, not what he is to the people in the room.
      standing: typeof raw.ai?.standing === 'string' ? raw.ai.standing.trim() : null,
      // Which of his powers this guild wants him to have, by capability name
      // (see ai/capabilities.js). Absent means all of them that this guild's
      // features support — the existing behaviour — so only a guild that wants
      // him narrower has to say anything.
      powers: Array.isArray(raw.ai?.powers) ? raw.ai.powers.filter(p => typeof p === 'string') : null,
      // What this guild calls its two tiers. Defaults live in aiTitles() rather
      // than here so a guild that has never set them still reads correctly.
      titles: {
        admin: typeof raw.ai?.titles?.admin === 'string' ? raw.ai.titles.admin.trim() : null,
        staff: typeof raw.ai?.titles?.staff === 'string' ? raw.ai.titles.staff.trim() : null,
        veteran: typeof raw.ai?.titles?.veteran === 'string' ? raw.ai.titles.veteran.trim() : null,
      },
      // Whether the local voice (ai/voice.js) may speak here. On unless a guild
      // says `false` — and nowhere at all unless LOCAL_VOICE_MODEL is set.
      localVoice: raw.ai?.localVoice !== false,
      // Channels he never reads: channel, forum or category IDs, so a category
      // covers every channel and thread in it. For rooms whose talk must not
      // reach the model, like a playtest under NDA. He holds Administrator, so
      // hiding a channel from him with permissions does nothing.
      offLimits: Array.isArray(raw.ai?.offLimits)
        ? raw.ai.offLimits.map(String).filter((id) => SNOWFLAKE.test(id))
        : [],
    },
    // Roles members may give themselves from a button, and the only roles a
    // self-assign button is ever allowed to grant. Anything not on this list is
    // refused by services/selfroles.js — the button's custom_id comes from the
    // client, so this file, not the button, is what decides.
    selfRoles: Array.isArray(raw.selfRoles)
      ? raw.selfRoles
          .filter((r) => r && SNOWFLAKE.test(String(r.role || '')))
          .map((r) => ({
            role: String(r.role),
            label: typeof r.label === 'string' ? r.label : 'Role',
            emoji: typeof r.emoji === 'string' ? r.emoji : null,
            description: typeof r.description === 'string' ? r.description : null,
            // Roles sharing a group are mutually exclusive: taking one drops the
            // others. Null means the role stands alone and toggles freely.
            group: typeof r.group === 'string' && r.group.trim() ? r.group.trim() : null,
            // A sticky role cannot be taken off, or swapped for a sibling in its
            // group, once it is on. The buttons refuse; changing it afterwards
            // takes someone with Manage Roles.
            sticky: r.sticky === true,
          }))
      : [],
    // The playtest (services/playtest.js): the role its agreement button gives,
    // the testers' channel that role opens, the private channel each agreement
    // and download is recorded in, and where scripts/post-playtest.js posts the
    // button. `downloads` is the GitHub release (`repo`, `tag`) the testers'
    // download buttons hand out, the channel they are posted in, and one entry
    // per button: its `label`, `emoji`, the release `asset` and `how` to start
    // it. Absent means no playtest here; only the role is required.
    playtest: raw.playtest && SNOWFLAKE.test(String(raw.playtest.role || '')) ? {
      role: String(raw.playtest.role),
      channel: raw.playtest.channel || null,
      log: raw.playtest.log || null,
      post: raw.playtest.post || null,
      game: typeof raw.playtest.game === 'string' && raw.playtest.game.trim() ? raw.playtest.game.trim() : 'The game',
      // How many testers the agreement button lets in; absent means no cap. A
      // place is held by anyone with the role and none of the `uncounted` roles
      // (the team, who test alongside), so taking the role off frees it.
      limit: Number.isInteger(raw.playtest.limit) && raw.playtest.limit > 0 ? raw.playtest.limit : null,
      uncounted: Array.isArray(raw.playtest.uncounted)
        ? raw.playtest.uncounted.map(String).filter((id) => SNOWFLAKE.test(id))
        : [],
      downloads: raw.playtest.downloads && /^[\w.-]+\/[\w.-]+$/.test(String(raw.playtest.downloads.repo || '')) ? {
        repo: String(raw.playtest.downloads.repo),
        tag: typeof raw.playtest.downloads.tag === 'string' && raw.playtest.downloads.tag ? raw.playtest.downloads.tag : 'latest',
        channel: raw.playtest.downloads.channel || null,
        // Five buttons to a row is Discord's limit, and one row is plenty.
        files: (Array.isArray(raw.playtest.downloads.files) ? raw.playtest.downloads.files : [])
          .filter((f) => f && typeof f.label === 'string' && typeof f.asset === 'string')
          .slice(0, 5)
          .map((f) => ({
            label: f.label,
            emoji: typeof f.emoji === 'string' ? f.emoji : null,
            asset: f.asset,
            how: typeof f.how === 'string' ? f.how : null,
          })),
      } : null,
    } : null,
    // Twitch live announcements. Absent means the watcher skips this guild —
    // the credentials are global (one app, in .env) but who gets announced,
    // and where, is per-guild.
    twitch: raw.twitch && typeof raw.twitch === 'object' ? {
      channel: raw.twitch.channel || null,
      // Role pinged on each announcement. Null pings nobody, which is the right
      // default for a room people have not opted into.
      pingRole: raw.twitch.pingRole || null,
      pollMinutes: Number(raw.twitch.pollMinutes) > 0 ? Number(raw.twitch.pollMinutes) : 3,
      streamers: Array.isArray(raw.twitch.streamers)
        ? raw.twitch.streamers
            .filter((x) => x && typeof x.login === 'string' && x.login.trim())
            .map((x) => ({
              login: x.login.trim().toLowerCase(),
              name: typeof x.name === 'string' && x.name.trim() ? x.name.trim() : x.login.trim(),
            }))
        : [],
    } : null,
    // New-upload announcements. Same shape as `twitch` and the same reasoning:
    // the feed needs no credentials, so there is nothing global to configure —
    // only who is watched, and where it lands.
    youtube: raw.youtube && typeof raw.youtube === 'object' ? {
      channel: raw.youtube.channel || null,
      pingRole: raw.youtube.pingRole || null,
      pollMinutes: Number(raw.youtube.pollMinutes) > 0 ? Number(raw.youtube.pollMinutes) : 15,
      feeds: Array.isArray(raw.youtube.feeds)
        ? raw.youtube.feeds
            .filter((f) => f && typeof f.channelId === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(f.channelId.trim()))
            .map((f) => ({
              channelId: f.channelId.trim(),
              name: typeof f.name === 'string' && f.name.trim() ? f.name.trim() : f.channelId.trim(),
              handle: typeof f.handle === 'string' ? f.handle.trim() : null,
            }))
        : [],
    } : null,
    // Steam announcements into `channel`, plus hand-listed dates (a wipe, a
    // season launch) as scheduled events (services/gameNews.js). An event with
    // no `voiceChannel` is External, and Discord then needs `location` and an
    // end, so `hours` defaults to 4.
    gameNews: raw.gameNews && typeof raw.gameNews === 'object' && raw.gameNews.channel ? {
      channel: raw.gameNews.channel,
      // Where a new event's link is posted. Defaults to the news channel.
      eventsChannel: raw.gameNews.eventsChannel || raw.gameNews.channel,
      pingRole: raw.gameNews.pingRole || null,
      pollMinutes: Number(raw.gameNews.pollMinutes) > 0 ? Number(raw.gameNews.pollMinutes) : 30,
      steamApps: Array.isArray(raw.gameNews.steamApps)
        ? raw.gameNews.steamApps
            .filter((a) => a && /^\d+$/.test(String(a.appId || '')))
            .map((a) => ({ appId: String(a.appId), name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : `App ${a.appId}` }))
        : [],
      events: Array.isArray(raw.gameNews.events)
        ? raw.gameNews.events
            .filter((e) => e && typeof e.key === 'string' && typeof e.name === 'string'
              && !Number.isNaN(new Date(e.start).getTime()))
            .map((e) => {
              const start = new Date(e.start);
              const hours = Number(e.hours) > 0 ? Number(e.hours) : 4;
              return {
                key: e.key,
                name: e.name.slice(0, 100),
                description: typeof e.description === 'string' ? e.description.slice(0, 1000) : null,
                start,
                end: new Date(start.getTime() + hours * 3600 * 1000),
                location: typeof e.location === 'string' && e.location.trim() ? e.location.trim().slice(0, 100) : 'Online',
                voiceChannel: e.voiceChannel || null,
                // Steam app whose header art becomes the event's cover.
                appId: /^\d+$/.test(String(e.appId || '')) ? String(e.appId) : null,
                // Cover image address for a game not on Steam; wins over appId.
                image: typeof e.image === 'string' && /^https:\/\//.test(e.image) ? e.image : null,
              };
            })
        : [],
      // Rare sales. Absent means none are posted. `stores` are CheapShark ids
      // (1 Steam, 7 GOG, 25 Epic); default Steam only.
      deals: raw.gameNews.deals && typeof raw.gameNews.deals === 'object' ? (() => {
        const d = raw.gameNews.deals;
        const num = (v, dflt) => (Number(v) >= 0 && v !== null && v !== '' ? Number(v) : dflt);
        return {
          stores: Array.isArray(d.stores) && d.stores.length ? d.stores.map(String) : ['1'],
          pollMinutes: num(d.pollMinutes, 180) || 180,
          minSavings: num(d.minSavings, 60),
          minNormalPrice: num(d.minNormalPrice, 20),
          minRating: num(d.minRating, 85),
          minReviews: num(d.minReviews, 2000),
          maxPerDay: num(d.maxPerDay, 4),
        };
      })() : null,
      // Twitch and Kick drops (services/drops.js), where the `drops` feature is
      // on. The `steamApps` are followed already; `games` names any more, for a
      // game not on Steam. Posted in `channel`, the news channel when unset.
      drops: (() => {
        const d = raw.gameNews.drops && typeof raw.gameNews.drops === 'object' ? raw.gameNews.drops : {};
        return {
          channel: SNOWFLAKE.test(String(d.channel || '')) ? d.channel : null,
          pingRole: SNOWFLAKE.test(String(d.pingRole || '')) ? d.pingRole : null,
          games: Array.isArray(d.games)
            ? d.games.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim().slice(0, 80))
            : [],
        };
      })(),
    } : null,
    // Weekly UFC and Contender Series events (services/ufc.js). `voiceChannel`
    // is where the event is held; `channel` gets a link when one is created, and
    // word when the post-fight press conference goes live (services/ufcPresser.js).
    ufc: raw.ufc && typeof raw.ufc === 'object' ? {
      channel: raw.ufc.channel || null,
      voiceChannel: raw.ufc.voiceChannel || null,
      // Pinged when the post-fight press conference goes live. Null pings nobody.
      pingRole: raw.ufc.pingRole || null,
      // DMed `dmMinutes` before each card's first bout (services/ufcReminders.js).
      // Null DMs nobody. Contender Series nights only with `dmContender`.
      dmRole: SNOWFLAKE.test(String(raw.ufc.dmRole || '')) ? raw.ufc.dmRole : null,
      dmMinutes: Number.isInteger(raw.ufc.dmMinutes) && raw.ufc.dmMinutes > 0 ? raw.ufc.dmMinutes : 30,
      dmContender: raw.ufc.dmContender === true,
      // Pick'em (services/pickem.js), where the `pickem` feature is on: its own
      // channel (the ufc channel when unset), the title the week's best picker
      // wears, and whether Contender Series nights are played. Those are scored
      // in a table of their own, with `contenderTitle` for their best, so five
      // fights on a Tuesday cannot decide the UFC season. Off by default.
      pickem: {
        channel: SNOWFLAKE.test(String(raw.ufc.pickem?.channel || '')) ? raw.ufc.pickem.channel : null,
        title: typeof raw.ufc.pickem?.title === 'string' && raw.ufc.pickem.title.trim()
          ? raw.ufc.pickem.title.trim()
          : null,
        contender: raw.ufc.pickem?.contender === true,
        contenderTitle: typeof raw.ufc.pickem?.contenderTitle === 'string' && raw.ufc.pickem.contenderTitle.trim()
          ? raw.ufc.pickem.contenderTitle.trim()
          : null,
      },
      // Every result as the fight ends, and the whole card once it is over
      // (services/ufcResults.js), Contender Series nights included. Unset, no
      // results are posted.
      results: {
        channel: SNOWFLAKE.test(String(raw.ufc.results?.channel || '')) ? raw.ufc.results.channel : null,
      },
    } : null,
    // DMs to the bot, read out in `channel` with a line mocking the sender
    // (services/dmRelay.js). Unset, DMs are ignored.
    dmRelay: raw.dmRelay && SNOWFLAKE.test(String(raw.dmRelay.channel || '')) ? { channel: raw.dmRelay.channel } : null,
    // Join-to-create voice rooms. `lobby` is the channel joining which makes
    // you one; absent, services/voicerooms.js ignores the guild entirely.
    voiceRooms: raw.voiceRooms && typeof raw.voiceRooms === 'object' && raw.voiceRooms.lobby ? {
      lobby: raw.voiceRooms.lobby,
      // Where rooms are created. Null means alongside the lobby, which is
      // usually right — a room should inherit the lobby's own visibility.
      category: raw.voiceRooms.category || null,
      maxPerUser: Number(raw.voiceRooms.maxPerUser) > 0 ? Number(raw.voiceRooms.maxPerUser) : 2,
      maxTotal: Number(raw.voiceRooms.maxTotal) > 0 ? Number(raw.voiceRooms.maxTotal) : 10,
      namePattern: typeof raw.voiceRooms.namePattern === 'string' ? raw.voiceRooms.namePattern : null,
    } : null,
    // The WARDOGS gold bar price (services/wardogsGold.js), where the
    // `wardogsGold` feature is on: posted in `channel` on each day it moves,
    // pinging `pingRole`. Unset channel, only /gold works.
    wardogsGold: {
      channel: SNOWFLAKE.test(String(raw.wardogsGold?.channel || '')) ? raw.wardogsGold.channel : null,
      pingRole: SNOWFLAKE.test(String(raw.wardogsGold?.pingRole || '')) ? raw.wardogsGold.pingRole : null,
    },
    // Voice log (services/voiceLog.js), where the `voiceLog` feature is on.
    // Every join, leave and move is kept for `keepDays` and read back with
    // /vclog; `channel`, when set, also gets each one posted as it happens.
    voiceLog: {
      channel: SNOWFLAKE.test(String(raw.voiceLog?.channel || '')) ? raw.voiceLog.channel : null,
      keepDays: Number.isInteger(raw.voiceLog?.keepDays) && raw.voiceLog.keepDays > 0 ? raw.voiceLog.keepDays : 90,
    },
    // Gameplay clips (services/clips.js). Every clip posted in `channel` gets
    // his commentary on its own unless `commentary` is false; the Apps menu
    // works on clips anywhere. `game` and `about` tell him what he is watching
    // in that channel, since a still of a shooter does not say which one.
    clips: raw.clips && typeof raw.clips === 'object' ? {
      channel: SNOWFLAKE.test(String(raw.clips.channel || '')) ? raw.clips.channel : null,
      commentary: raw.clips.commentary !== false,
      game: typeof raw.clips.game === 'string' ? raw.clips.game.trim() : null,
      about: typeof raw.clips.about === 'string' ? raw.clips.about.trim() : null,
    } : null,
  };
}

/**
 * Build a starting skeleton for the primary guild when no config file exists,
 * so a fresh install boots and registers commands. The channel and role IDs
 * still have to be filled in by hand afterwards.
 */
function seedFromEnv() {
  const primaryId = process.env.GUILD_ID;
  if (!primaryId || !SNOWFLAKE.test(primaryId)) return {};

  return {
    [primaryId]: {
      name: 'primary',
      features: ['ai', 'music', 'moderation', 'instagram', 'textImageMod', 'automod'],
      channels: { music: null, defaultVoice: null },
      roles: { admin: null },
    },
  };
}

function load() {
  if (cache) return cache;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // A malformed config is worth shouting about — silently falling back to
      // a seed would quietly detach the bot from its real channel wiring.
      console.error(`[Config] ${CONFIG_FILE} is unreadable: ${err.message}`);
      console.error('[Config] Falling back to env-derived defaults.');
      raw = seedFromEnv();
      cache = normalizeAll(raw);
      return cache;
    }
    raw = seedFromEnv();
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n', 'utf8');
      console.log(`[Config] Seeded ${CONFIG_FILE} from environment.`);
    } catch (writeErr) {
      console.warn('[Config] Could not write seed config:', writeErr.message);
    }
  }

  cache = normalizeAll(raw);

  const ids = Object.keys(cache);
  if (ids.length === 0) {
    console.warn('[Config] No guilds configured — the bot will ignore every message.');
  } else {
    console.log(`[Config] Loaded ${ids.length} guild(s): ${ids.map(id => cache[id].name).join(', ')}`);
  }

  return cache;
}

function normalizeAll(raw) {
  const out = {};
  for (const [id, entry] of Object.entries(raw || {})) {
    if (!SNOWFLAKE.test(id)) {
      // Template entries live in the file on purpose; don't treat them as real.
      console.log(`[Config] Skipping placeholder guild entry "${id}".`);
      continue;
    }
    out[id] = normalizeGuild(id, entry || {});
  }
  return out;
}

/** @returns {object|null} config for a guild, or null if it isn't configured. */
function getGuildConfig(guildId) {
  if (!guildId) return null;
  return load()[guildId] || null;
}

/** @returns {string[]} configured guild IDs, placeholders excluded. */
function guildIds() {
  return Object.keys(load());
}

/** @returns {boolean} whether `feature` is enabled for this guild. */
function hasFeature(guildId, feature) {
  const cfg = getGuildConfig(guildId);
  return !!cfg && cfg.features.includes(feature);
}

/**
 * "a Sheriff" / "an Owner". The tier names are per-guild configuration, so the
 * article has to be worked out rather than written into the sentence.
 * @param {string} word
 * @returns {string}
 */
function withArticle(word) {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}

/**
 * What this guild calls the people above Sheogorath.
 *
 * Written against the *role ladder that actually exists here*, not against the
 * vocabulary the bot grew up with. The community server has a staff role
 * between its owners and its members and calls them Wardens; the main hall has
 * no such rung at all, and telling its members that something has "gone to the
 * Sheriffs" names a tier they have never heard of and cannot go and find. Where
 * there is no staff role, `isStaff()` already collapses to `isAdmin()`, so the
 * words collapse the same way.
 *
 * @param {object|null} guildConfig
 * @returns {{admin: string, staff: string|null, approver: string, approvers: string}}
 */
function aiTitles(guildConfig) {
  const admin = guildConfig?.ai?.titles?.admin || 'Owner';
  // A staff title is only real when a staff role is configured to hold it.
  const staff = guildConfig?.roles?.staff
    ? (guildConfig?.ai?.titles?.staff || 'Sheriff')
    : null;
  // Same rule one rung lower: only real where a veteran role exists to hold it.
  const veteran = guildConfig?.roles?.veteran
    ? (guildConfig?.ai?.titles?.veteran || 'Veteran')
    : null;
  return {
    admin,
    staff,
    veteran,
    // Who a held action is waiting on, singular and plural.
    approver: staff || admin,
    approvers: staff ? `${staff}s and ${admin}s` : `${admin}s`,
  };
}

/**
 * Look up a configured channel ID.
 * @returns {string|null}
 */
function channelId(guildId, key) {
  const cfg = getGuildConfig(guildId);
  return cfg ? cfg.channels[key] || null : null;
}

/**
 * Whether `channel` is one of the guild's `ai.offLimits`: listed itself, or
 * inside a listed channel (a thread, a forum post) or category.
 * @param {string} guildId
 * @param {import('discord.js').Channel|null} channel
 */
function aiOffLimits(guildId, channel) {
  const list = getGuildConfig(guildId)?.ai.offLimits;
  if (!list?.length || !channel) return false;
  return [channel.id, channel.parentId, channel.parent?.parentId].some((id) => id && list.includes(id));
}

/**
 * The guild the control API and other single-guild surfaces act on.
 * Explicit override first, then the legacy env var, then the only configured
 * guild if there happens to be exactly one.
 */
function primaryGuildId() {
  const explicit = process.env.CONTROL_API_GUILD_ID || process.env.GUILD_ID;
  if (explicit && SNOWFLAKE.test(explicit)) return explicit;
  const ids = guildIds();
  return ids.length === 1 ? ids[0] : null;
}

/** Drop the cache so the next read re-reads the file. */
function reload() {
  cache = null;
  return load();
}

/** Plain-object deep merge. Arrays and scalars in `patch` replace wholesale. */
function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v)
      ? merge(out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? out[k] : {}, v)
      : v;
  }
  return out;
}

/**
 * Persist a patch into one guild's entry in config/guilds.json.
 *
 * Written against the raw file rather than the normalized cache so that keys
 * this module doesn't know about — and the placeholder entries the file keeps
 * on purpose — survive the round-trip. Used by `/sheo mode` and `/sheo parlour`
 * to record what they change, which otherwise would have to be copied in by
 * hand.
 *
 * @param {string} guildId
 * @param {object} patch deep-merged into the existing entry
 * @throws if the file cannot be read or written — callers report it rather
 *   than silently leaving created channels unwired.
 */
function updateGuildConfig(guildId, patch) {
  if (!SNOWFLAKE.test(guildId)) throw new Error(`"${guildId}" is not a guild ID.`);

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Could not read ${CONFIG_FILE}: ${err.message}`);
    raw = {};
  }

  raw[guildId] = merge(raw[guildId] || {}, patch);

  writeFileAtomic(CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n');
  reload();
  return getGuildConfig(guildId);
}

module.exports = {
  FEATURES,
  CONFIG_FILE,
  getGuildConfig,
  guildIds,
  hasFeature,
  aiTitles,
  withArticle,
  channelId,
  aiOffLimits,
  primaryGuildId,
  reload,
  updateGuildConfig,
};
