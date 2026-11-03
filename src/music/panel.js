'use strict';
/**
 * The music player channel: one message he keeps editing, in a channel only he
 * can write in. It replaced the companion web page (shut down 2026-11-03), so
 * it shows what that page did: the song's picture, how far in it is, the
 * volume, autoplay and the queue, with the buttons that run them underneath.
 *
 * Nothing new is posted for a song. The one message is edited when playback
 * changes, and every few seconds while a song plays so the progress bar moves.
 * Anything else that lands in the channel is deleted, and if the message
 * itself goes, a new one is posted in its place.
 *
 * Switched on per guild by `channels.musicPlayer` in config/guilds.json. A
 * guild without it keeps the old now-playing cards in `channels.music`.
 */
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  LabelBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  ModalBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} = require('discord.js');
const { AudioPlayerStatus, getVoiceConnection } = require('@discordjs/voice');
const {
  players,
  getQueue,
  addToQueue,
  removeFromQueue,
  resolveVideoUrl,
  expandPlaylist,
  beginPlayback,
  pausePlaying,
  resumePlaying,
  skipSong,
  stopPlaying,
  setVolume,
  getVolume,
  setAutoplay,
  getPlaybackState,
  emitState,
  musicEvents,
  connectToChannel,
  getConnection,
} = require('./player');
const { guildIds, hasFeature, channelId } = require('../config/guilds');
const { musicPlayerDenialReason } = require('../utils/permissions');
const { jsonFile } = require('../storage/jsonFile');

const PREFIX = 'mplayer:';

// Which message is the player, per guild, so a restart edits the same one
// instead of posting another.
const store = jsonFile(path.join(__dirname, '../../data/music-player.json'), { empty: () => ({ guilds: {} }) });

/** How long after a change the message is edited, so a burst of changes is one edit. */
const DEBOUNCE_MS = 800;
/** How often the message is looked at while a song plays, for the progress bar. */
const TICK_MS = 10_000;
/** How long the line under the status ("billy skipped …") stays up. */
const NOTICE_MS = 3 * 60_000;
/** How many of the queue are written out; the rest are counted. */
const QUEUE_SHOWN = 5;
const VOLUME_STEP = 0.1;
const RADIO_COUNT = 25;
const BULK_DELETE_MAX_AGE_MS = 13 * 24 * 60 * 60 * 1000;

// The web page's amber, dimmed while paused and darker still while silent.
const ACCENT = { playing: 0xd9a441, paused: 0x8a6a2c, idle: 0x3a2b12 };

const PLAYLIST_URL = /^https?:\/\/.*(youtube\.com|youtu\.be).*[?&]list=/;
const PURE_PLAYLIST = /^https?:\/\/.*youtube\.com\/playlist\?list=/;

/** guildId -> { channelId, message, lastKey, timer, editing, again, ensuring, notice } */
const panels = new Map();
let client = null;

// Queue entries are plain objects with no id, and their positions shift as
// songs end, so the remove menu names them by an id handed out here instead.
const entryIds = new WeakMap();
let nextEntryId = 1;
function entryId(entry) {
  if (!entryIds.has(entry)) entryIds.set(entry, (nextEntryId++).toString(36));
  return entryIds.get(entry);
}

/** The guild's player channel, when music is on there and one is configured. */
function panelChannelId(guildId) {
  if (!guildId || !hasFeature(guildId, 'music')) return null;
  return channelId(guildId, 'musicPlayer');
}

function hasPanel(guildId) {
  return Boolean(panelChannelId(guildId));
}

/** Whether a channel is one of the player channels, where only the player belongs. */
function isPanelChannel(id) {
  if (!id) return false;
  return guildIds().some((guildId) => panelChannelId(guildId) === id);
}

function isPanelInteraction(interaction) {
  return typeof interaction.customId === 'string' && interaction.customId.startsWith(PREFIX);
}

// ---------------------------------------------------------------------------
// Drawing the player
// ---------------------------------------------------------------------------

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function progressBar(position, duration, width = 16) {
  if (!duration) return '▱'.repeat(width);
  const filled = Math.round(Math.min(1, Math.max(0, position / duration)) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Text from YouTube, made safe to drop into markdown (and into a link's text). */
function plain(text, max = 200) {
  return escapeMarkdown(clip(String(text ?? '').replace(/[[\]]/g, ''), max));
}

/** The picture for a song: YouTube's own artwork, as a JPEG where there is one. */
function artFor(nowPlaying) {
  const thumb = nowPlaying?.thumbnail;
  if (typeof thumb === 'string' && /^https?:\/\//.test(thumb)) {
    // yt-dlp tends to pick the WebP copy; the JPEG beside it is the same picture.
    return thumb.replace(/\/vi_webp\/([\w-]{11})\/(\w+)\.webp(\?.*)?$/, '/vi/$1/$2.jpg');
  }
  const id = nowPlaying?.url?.match(/[?&]v=([\w-]{11})/)?.[1];
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

function idleArt() {
  return client?.user?.displayAvatarURL({ extension: 'png', size: 1024 }) || null;
}

function voiceChannelName(guildId) {
  const id = getVoiceConnection(guildId)?.joinConfig?.channelId;
  if (!id) return null;
  return client?.guilds.cache.get(guildId)?.channels.cache.get(id)?.name || null;
}

function button(action, emoji, label, style, disabled = false) {
  const b = new ButtonBuilder().setCustomId(PREFIX + action).setEmoji(emoji).setStyle(style).setDisabled(Boolean(disabled));
  if (label) b.setLabel(label);
  return b;
}

/** The whole player message for a guild, as it should look right now. */
function buildPanel(guildId) {
  const state = getPlaybackState(guildId);
  const queue = getQueue(guildId);
  const np = state.nowPlaying;
  const panel = panels.get(guildId);
  const starting = !np && queue.isStarting;

  const container = new ContainerBuilder()
    .setAccentColor(np ? (state.isPaused ? ACCENT.paused : ACCENT.playing) : ACCENT.idle);

  const art = np ? artFor(np) : idleArt();
  if (art) {
    container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(art).setDescription(clip(np ? np.title || 'Now playing' : 'Sheogorath', 1000)),
    ));
  }

  // What is playing, and how far in.
  let head;
  if (np) {
    const title = plain(np.title || 'Unknown track');
    const lines = [`## ${np.url ? `[${title}](${np.url})` : title}`];
    if (np.uploader) lines.push(plain(np.uploader, 100));
    lines.push(`\`${formatTime(np.position)}\` ${progressBar(np.position, np.duration)} \`${np.duration ? formatTime(np.duration) : '?:??'}\``);
    head = lines.join('\n');
  } else if (starting) {
    head = '## Tuning the lute…\nThe next song is on its way.';
  } else {
    head = '## Silence in the halls\nNothing plays. Press **Add song** or **Radio** to wake the band.';
  }
  container.addTextDisplayComponents((t) => t.setContent(head));

  const status = [];
  if (np) status.push(state.isPaused ? '⏸️ Paused' : state.isPlaying ? '▶️ Playing' : '⏳ Loading');
  status.push(`🔊 ${Math.round(state.volume * 100)}%`);
  status.push(`🔁 Autoplay ${state.autoplay ? 'on' : 'off'}`);
  const room = voiceChannelName(guildId);
  if (room) status.push(`🎧 ${plain(room, 50)}`);
  if (np?.addedBy) status.push(`Queued by ${plain(np.addedBy, 50)}`);
  container.addTextDisplayComponents((t) => t.setContent(`-# ${status.join(' · ')}`));

  if (panel?.notice && Date.now() - panel.notice.at < NOTICE_MS) {
    container.addTextDisplayComponents((t) => t.setContent(`-# ${panel.notice.text}`));
  }

  // The queue.
  container.addSeparatorComponents((s) => s.setSpacing(SeparatorSpacingSize.Small));
  const songs = queue.songs;
  let line;
  if (songs.length === 0) {
    line = `**The Waiting Line**\nThe line is empty.${state.autoplay && np ? ' Autoplay will pick what comes next.' : ''}`;
  } else {
    const shown = songs.slice(0, QUEUE_SHOWN).map((s, i) =>
      `${i + 1}. ${plain(s.title || s.query, 90)} — ${plain(s.addedBy || 'Unknown', 40)}`);
    const more = songs.length > QUEUE_SHOWN ? `\n-# …and ${songs.length - QUEUE_SHOWN} more` : '';
    line = `**The Waiting Line** · ${songs.length}\n${shown.join('\n')}${more}`;
  }
  container.addTextDisplayComponents((t) => t.setContent(line));
  container.addSeparatorComponents((s) => s.setSpacing(SeparatorSpacingSize.Small));

  // The buttons.
  const nothing = !np && !starting && songs.length === 0 && !state.connected;
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      button('stop', '⏹️', 'Stop', ButtonStyle.Danger, nothing),
      button('toggle', state.isPaused ? '▶️' : '⏸️', state.isPaused ? 'Resume' : 'Pause', ButtonStyle.Primary, !np),
      button('skip', '⏭️', 'Skip', ButtonStyle.Secondary, !np),
      button('voldown', '🔉', null, ButtonStyle.Secondary, state.volume <= 0),
      button('volup', '🔊', null, ButtonStyle.Secondary, state.volume >= 2),
    ),
    new ActionRowBuilder().addComponents(
      button('add', '➕', 'Add song', ButtonStyle.Success),
      button('radio', '📻', 'Radio', ButtonStyle.Secondary),
      button('autoplay', '🔁', state.autoplay ? 'Autoplay on' : 'Autoplay off',
        state.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary),
      button('clear', '🧹', 'Clear line', ButtonStyle.Secondary, songs.length === 0),
      button('drop', '🗑️', 'Drop from radio', ButtonStyle.Secondary, !np),
    ),
  );

  if (songs.length > 0) {
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${PREFIX}remove`)
        .setPlaceholder('Take a song out of the line…')
        .addOptions(songs.slice(0, 25).map((s, i) => ({
          label: clip(s.title || s.query || 'Unknown', 100),
          value: entryId(s),
          description: clip(`#${i + 1} · queued by ${s.addedBy || 'Unknown'}`, 100),
        }))),
    ));
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] },
  };
}

// ---------------------------------------------------------------------------
// Keeping the one message up to date
// ---------------------------------------------------------------------------

function panelFor(guildId) {
  let panel = panels.get(guildId);
  if (!panel) {
    panel = { channelId: panelChannelId(guildId), message: null, lastKey: null, timer: null, editing: false, again: false, ensuring: null, notice: null };
    panels.set(guildId, panel);
  }
  return panel;
}

/** Ask for the player to be redrawn. Changes close together become one edit. */
function refreshPanel(guildId, { now = false } = {}) {
  const panel = panels.get(guildId);
  if (!panel?.message) return;
  if (now && panel.timer) {
    clearTimeout(panel.timer);
    panel.timer = null;
  }
  if (panel.timer) return;
  panel.timer = setTimeout(() => {
    panel.timer = null;
    flush(guildId).catch((err) => console.error('[MusicPanel] Redraw failed:', err?.message || err));
  }, now ? 0 : DEBOUNCE_MS);
}

async function flush(guildId) {
  const panel = panels.get(guildId);
  if (!panel?.message) return;
  // One edit at a time per message; a change during one gets its own after.
  if (panel.editing) {
    panel.again = true;
    return;
  }
  panel.editing = true;
  try {
    const payload = buildPanel(guildId);
    const key = JSON.stringify(payload.components.map((c) => c.toJSON()));
    if (key === panel.lastKey) return;
    await panel.message.edit(payload);
    panel.lastKey = key;
  } catch (err) {
    if (err?.code === 10008) {
      // Unknown Message: someone deleted it. Post a new one.
      panel.message = null;
      ensurePanel(guildId).catch(() => {});
    } else {
      console.error('[MusicPanel] Could not edit the player:', err?.message || err);
    }
  } finally {
    panel.editing = false;
    if (panel.again) {
      panel.again = false;
      refreshPanel(guildId);
    }
  }
}

/** Put a line under the status for a few minutes: who did what, or what went wrong. */
function panelNotice(guildId, text) {
  if (!hasPanel(guildId)) return;
  panelFor(guildId).notice = { text: clip(String(text), 300), at: Date.now() };
  refreshPanel(guildId);
}

/** Delete everything in the channel except the player. */
async function sweep(channel, keepId) {
  try {
    const recent = await channel.messages.fetch({ limit: 100 });
    const stray = recent.filter((m) => m.id !== keepId);
    if (stray.size === 0) return;
    const young = stray.filter((m) => Date.now() - m.createdTimestamp < BULK_DELETE_MAX_AGE_MS);
    const old = stray.filter((m) => !young.has(m.id));
    if (young.size) await channel.bulkDelete(young, true);
    for (const m of old.values()) await m.delete().catch(() => {});
  } catch (err) {
    console.error('[MusicPanel] Could not clear the channel:', err?.message || err);
  }
}

/**
 * Find the guild's player message, or post one, and clear anything else out of
 * the channel. Safe to call again at any time; overlapping calls share one run.
 */
function ensurePanel(guildId) {
  const panel = panelFor(guildId);
  if (panel.ensuring) return panel.ensuring;
  panel.ensuring = (async () => {
    const id = panelChannelId(guildId);
    if (!id || !client) return;
    panel.channelId = id;
    const channel = await client.channels.fetch(id).catch(() => null);
    if (!channel?.isTextBased?.()) {
      console.error(`[MusicPanel] Player channel ${id} not found in guild ${guildId}.`);
      return;
    }

    let message = null;
    const saved = store.read().guilds?.[guildId];
    if (saved?.channelId === id && saved.messageId) {
      message = await channel.messages.fetch(saved.messageId).catch(() => null);
    }
    if (!message) {
      message = await channel.send(buildPanel(guildId));
      store.update((db) => {
        db.guilds = db.guilds || {};
        db.guilds[guildId] = { channelId: id, messageId: message.id };
      });
      console.log(`[MusicPanel] Posted the player in #${channel.name}.`);
    }
    panel.message = message;
    panel.lastKey = null;
    await sweep(channel, message.id);
    refreshPanel(guildId, { now: true });
  })()
    .catch((err) => console.error('[MusicPanel] Could not set up the player:', err?.message || err))
    .finally(() => { panel.ensuring = null; });
  return panel.ensuring;
}

/** Put up every configured player and keep them current. Call once, on ready. */
function startMusicPanels(discordClient) {
  client = discordClient;
  const guilds = guildIds().filter(hasPanel);
  if (guilds.length === 0) return;

  for (const guildId of guilds) ensurePanel(guildId);

  musicEvents.on('state', (guildId) => {
    if (hasPanel(guildId)) refreshPanel(guildId);
  });

  // The progress bar and an expiring notice change with no event to say so.
  // An unchanged player is never sent, so a paused or silent one costs nothing.
  setInterval(() => {
    for (const guildId of panels.keys()) refreshPanel(guildId);
  }, TICK_MS).unref();

  // Only the player belongs in the channel. His own messages are left alone
  // while a player is being posted, since that one is about to become it.
  client.on('messageCreate', (message) => {
    const panel = panels.get(message.guildId);
    if (!panel || message.channelId !== panel.channelId) return;
    if (panel.message && message.id === panel.message.id) return;
    if (!panel.message && message.author?.id === client.user.id) return;
    message.delete().catch(() => {});
  });

  const onGone = (guildId, ids) => {
    const panel = panels.get(guildId);
    if (!panel?.message || !ids.includes(panel.message.id)) return;
    panel.message = null;
    ensurePanel(guildId);
  };
  client.on('messageDelete', (message) => onGone(message.guildId, [message.id]));
  client.on('messageDeleteBulk', (messages, channel) => onGone(channel.guildId, [...messages.keys()]));
}

// ---------------------------------------------------------------------------
// The buttons
// ---------------------------------------------------------------------------

function who(interaction) {
  return interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
}

/** How long a reply only the presser can see stays up. */
const TELL_MS = 20_000;

/** A reply only the presser sees, cleared away after a while. */
async function tell(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) {
    const message = await interaction.followUp(payload);
    setTimeout(() => interaction.deleteReply(message).catch(() => {}), TELL_MS).unref();
  } else {
    await interaction.reply(payload);
    setTimeout(() => interaction.deleteReply().catch(() => {}), TELL_MS).unref();
  }
}

/**
 * The voice connection to play into: the one he is already in, else the
 * presser's channel, else the guild's default voice channel.
 */
async function voiceFor(interaction) {
  const existing = getConnection(interaction.guild);
  if (existing) return existing;
  const theirs = interaction.member?.voice?.channel;
  if (theirs) return connectToChannel(theirs);
  const { ensureVoiceConnection } = require('./session');
  try {
    return await ensureVoiceConnection(interaction.client, interaction.guildId);
  } catch {
    throw new Error('Join a voice channel first, and I will follow you in.');
  }
}

/** Start the head of the queue if nothing is playing or starting. */
async function startIfIdle(interaction, connection) {
  if (!beginPlayback(interaction.guildId)) return;
  // playNextInQueue takes the claim from here, skips past a song that will not
  // start, and posts what it is doing to the player.
  const { playNextInQueue } = require('./session');
  await playNextInQueue(interaction.client, connection, interaction.guildId);
}

/** Queue a search phrase, a video link or a playlist link. */
async function addSong(interaction, query) {
  const guildId = interaction.guildId;
  const name = who(interaction);
  const addedBy = interaction.user.tag;
  const connection = await voiceFor(interaction);

  if (PLAYLIST_URL.test(query)) {
    panelNotice(guildId, `📋 ${plain(name, 50)} is loading a playlist…`);
    const playlist = await expandPlaylist(query);
    if (!playlist || playlist.songs.length === 0) throw new Error('I could not load that playlist, or it is empty.');
    // A watch link inside a playlist starts at that video, as /play does.
    let start = 0;
    if (!PURE_PLAYLIST.test(query)) {
      const id = query.match(/[?&]v=([\w-]{11})/)?.[1];
      const at = id ? playlist.songs.findIndex((s) => s.id === id) : -1;
      if (at >= 0) start = at;
    }
    const songs = playlist.songs.slice(start);
    for (const s of songs) addToQueue(guildId, { query: s.query, title: s.title, addedBy });
    panelNotice(guildId, `📋 ${plain(name, 50)} added ${songs.length} songs from **${plain(playlist.title, 100)}**`);
    await startIfIdle(interaction, connection);
    return;
  }

  panelNotice(guildId, `🔍 ${plain(name, 50)} is looking for **${plain(query, 100)}**…`);
  // Queued before it is resolved, so songs keep the order they were asked for.
  const entry = { query, addedBy };
  addToQueue(guildId, entry);
  try {
    const resolved = await resolveVideoUrl(query);
    entry.query = resolved.url;
    entry.title = resolved.title;
    emitState(guildId);
  } catch (err) {
    const at = getQueue(guildId).songs.indexOf(entry);
    if (at >= 0) removeFromQueue(guildId, at);
    panelNotice(guildId, `⚠️ Found nothing for **${plain(query, 100)}**`);
    throw new Error(`I found nothing for **${plain(query, 100)}**. Try other words, or a YouTube link.`);
  }
  panelNotice(guildId, `➕ ${plain(name, 50)} added **${plain(entry.title, 100)}**`);
  await startIfIdle(interaction, connection);
}

async function queueRadio(interaction) {
  const guildId = interaction.guildId;
  const { loadRadioTracks, shuffle } = require('../commands/radio');
  const tracks = shuffle(loadRadioTracks()).slice(0, RADIO_COUNT);
  if (tracks.length === 0) throw new Error('The radio list is empty.');
  const connection = await voiceFor(interaction);
  for (const t of tracks) addToQueue(guildId, { query: t.query, title: t.title, addedBy: interaction.user.tag });
  panelNotice(guildId, `📻 ${plain(who(interaction), 50)} queued ${tracks.length} from the radio`);
  await startIfIdle(interaction, connection);
}

function addSongModal() {
  return new ModalBuilder()
    .setCustomId(`${PREFIX}add`)
    .setTitle('Add a song')
    .addLabelComponents(new LabelBuilder()
      .setLabel('Song, artist, or YouTube link')
      .setDescription('A playlist link queues the whole playlist.')
      .setTextInputComponent(new TextInputBuilder()
        .setCustomId('query')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('lofi hip hop beats')
        .setRequired(true)
        .setMaxLength(300)));
}

/** Route a press, a pick or a submitted form from the player. */
async function handlePanelInteraction(interaction) {
  const guildId = interaction.guildId;
  const denied = musicPlayerDenialReason(guildId, interaction.member);
  if (denied) return tell(interaction, denied);
  if (!hasPanel(guildId)) return tell(interaction, '❌ There is no music player in this server.');

  const action = interaction.customId.slice(PREFIX.length);
  const queue = getQueue(guildId);
  const np = queue.nowPlaying;
  const name = plain(who(interaction), 50);

  try {
    // Opening the form has to be the reply itself, so it comes before any ack.
    if (action === 'add' && interaction.isButton()) return await interaction.showModal(addSongModal());

    await interaction.deferUpdate();

    switch (action) {
      case 'add': {
        const query = interaction.fields.getTextInputValue('query').trim();
        if (!query) return tell(interaction, 'Give me a song, an artist or a YouTube link.');
        await addSong(interaction, query);
        break;
      }
      case 'radio':
        await queueRadio(interaction);
        break;
      case 'toggle': {
        const player = players.get(guildId);
        if (!player || !np) return tell(interaction, 'Nothing is playing.');
        if (player.state.status === AudioPlayerStatus.Paused) {
          resumePlaying(guildId);
          panelNotice(guildId, `▶️ ${name} resumed`);
        } else {
          pausePlaying(guildId);
          panelNotice(guildId, `⏸️ ${name} paused`);
        }
        break;
      }
      case 'skip':
        if (!np) return tell(interaction, 'Nothing is playing.');
        skipSong(guildId);
        panelNotice(guildId, `⏭️ ${name} skipped **${plain(np.title, 100)}**`);
        break;
      case 'stop':
        stopPlaying(guildId);
        panelNotice(guildId, `⏹️ ${name} stopped the music`);
        break;
      case 'voldown':
      case 'volup': {
        const step = action === 'volup' ? VOLUME_STEP : -VOLUME_STEP;
        setVolume(guildId, Math.round((getVolume(guildId) + step) * 10) / 10);
        break;
      }
      case 'autoplay':
        setAutoplay(guildId, !queue.autoplay);
        panelNotice(guildId, `🔁 ${name} turned autoplay ${queue.autoplay ? 'on' : 'off'}`);
        break;
      case 'clear': {
        const count = queue.songs.length;
        queue.songs = [];
        emitState(guildId);
        panelNotice(guildId, `🧹 ${name} cleared ${count} song${count === 1 ? '' : 's'} from the line`);
        break;
      }
      case 'drop': {
        if (!np) return tell(interaction, 'Nothing is playing.');
        const { removeTrackFromRadio } = require('../commands/radio');
        // The radio list names songs "Artist - Track", which is what a radio
        // entry was queued as; YouTube's title for the video rarely matches it.
        const title = np.entryTitle || np.title;
        if (!removeTrackFromRadio(title)) return tell(interaction, `**${plain(title, 100)}** is not on the radio list.`);
        skipSong(guildId);
        panelNotice(guildId, `🗑️ ${name} dropped **${plain(title, 100)}** from the radio`);
        break;
      }
      case 'remove': {
        const id = interaction.values?.[0];
        const at = queue.songs.findIndex((s) => entryIds.get(s) === id);
        if (at < 0) {
          refreshPanel(guildId, { now: true });
          return tell(interaction, 'That song already left the line.');
        }
        const removed = removeFromQueue(guildId, at);
        panelNotice(guildId, `➖ ${name} took **${plain(removed.title || removed.query, 100)}** out of the line`);
        break;
      }
      default:
        return tell(interaction, 'That button does nothing any more.');
    }
  } catch (err) {
    console.error(`[MusicPanel] ${action} failed:`, err?.message || err);
    await tell(interaction, `❌ ${err?.message || 'That did not work.'}`).catch(() => {});
  } finally {
    // The menu keeps showing what was picked until the message is sent again,
    // so after a pick it is sent even if nothing else changed.
    if (action === 'remove') panelFor(guildId).lastKey = null;
    refreshPanel(guildId, { now: true });
  }
}

module.exports = {
  hasPanel,
  isPanelChannel,
  isPanelInteraction,
  handlePanelInteraction,
  startMusicPanels,
  refreshPanel,
  panelNotice,
  buildPanel,
};
