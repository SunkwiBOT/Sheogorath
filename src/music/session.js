'use strict';
/**
 * Shared playback session logic.
 *
 * This used to live inside commands/play.js, which meant it could only be
 * driven by a slash command. The music player channel's buttons (panel.js)
 * need the same queue advancement, autoplay and now-playing behaviour, and
 * playback outlives any one interaction, so it lives here and both call in.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const {
  play,
  players,
  getQueue,
  addToQueue,
  getNextSong,
  connectToChannel,
  getConnection,
  fetchRelatedSong,
  endPlayback,
  playbackEpoch,
  abandonPlayback,
  emitState,
} = require('./player');
const { createNowPlayingEmbed } = require('./embeds');
const { channelId } = require('../config/guilds');
const { hasPanel, refreshPanel, panelNotice } = require('./panel');

// Track last now playing message to keep channel clean
const lastNowPlayingMessages = new Map(); // guildId -> messageId

/** The pause/skip/stop/remove control row attached to every now-playing post. */
function buildControlRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_pause')
      .setLabel('⏯️ Pause/Resume')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('music_skip')
      .setLabel('⏭️ Skip')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_stop')
      .setLabel('⏹️ Stop')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('music_remove')
      .setLabel('🗑️ Remove')
      .setStyle(ButtonStyle.Danger)
  );
}

/**
 * Note on the playing song who queued it and the name it was queued under.
 * play() only sees the URL. The player shows the first, and its Drop from
 * radio button needs the second: the radio list's "Artist - Track", which
 * YouTube's own title for the video rarely matches.
 */
function markNowPlaying(guildId, song) {
  const nowPlaying = getQueue(guildId).nowPlaying;
  if (!nowPlaying || !song) return;
  nowPlaying.addedBy = song.addedBy || null;
  nowPlaying.entryTitle = song.title || song.query || null;
  emitState(guildId);
}

/**
 * Post the now-playing embed to the music channel, clearing prior messages so
 * the channel stays a single live "player" rather than a scrolling log. A guild
 * with a music player channel has that redrawn instead.
 */
async function postNowPlaying(client, guildId, fallbackSong, addedBy) {
  if (hasPanel(guildId)) {
    refreshPanel(guildId);
    return;
  }
  const musicChannelId = channelId(guildId, 'music');
  if (!musicChannelId) return;
  const channel = await client.channels.fetch(musicChannelId).catch(() => null);
  if (!channel) return;

  const queue = getQueue(guildId);
  try {
    try {
      const messages = await channel.messages.fetch({ limit: 100 });
      await channel.bulkDelete(messages, true);
    } catch (err) {
      // bulkDelete refuses messages older than 14 days; not worth failing over.
      console.error('Could not clear music channel:', err.message);
    }

    const embed = await createNowPlayingEmbed(
      {
        ...(queue.nowPlaying || {}),
        url: queue.nowPlaying?.url,
        title: queue.nowPlaying?.title || fallbackSong?.title || fallbackSong?.query,
        query: fallbackSong?.query,
      },
      addedBy || fallbackSong?.addedBy || 'Unknown'
    );

    const msg = await channel.send({ embeds: [embed], components: [buildControlRow()] });
    lastNowPlayingMessages.set(guildId, msg.id);
  } catch (e) {
    console.error('Could not send now playing message:', e);
  }
}

// How many tracks in a row may fail to start before we give up and tell the
// channel. Previously a failure recursed into the next song with no limit, so
// one yt-dlp outage would chew through a 100-song queue in seconds, silently.
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Post a one-off notice to the guild's music channel, if one is configured. A
 * guild with a music player channel shows it on the player instead, which
 * takes no new messages.
 */
async function sendToMusicChannel(client, guildId, content) {
  if (hasPanel(guildId)) {
    panelNotice(guildId, content);
    return;
  }
  const musicChannelId = channelId(guildId, 'music');
  if (!musicChannelId) return;
  const channel = await client.channels.fetch(musicChannelId).catch(() => null);
  if (!channel) return;
  try {
    await channel.send(content);
  } catch (e) {
    console.error('Could not send music channel message:', e);
  }
}

/**
 * Advance to the next queued track, falling back to autoplay when the queue
 * empties. Uses channel.send rather than interaction.followUp because an
 * interaction token expires after 15 minutes and playback outlives that.
 *
 * The caller (the Idle handler, or a claim from beginPlayback) hands this the
 * guild already claimed; releasing that claim on every exit path is this
 * function's job.
 */
async function playNextInQueue(client, connection, guildId) {
  const queue = getQueue(guildId);
  const epoch = playbackEpoch(guildId);
  let failures = 0;

  try {
    // Loops rather than recursing so a run of dead tracks can't blow the stack
    // or drain the queue unbounded.
    while (true) {
      // stop/clear ran while we were resolving — the queue we were draining is
      // gone, and playing now would be resurrecting it.
      if (playbackEpoch(guildId) !== epoch) return;

      if (queue.songs.length === 0) {
        if (!queue.autoplay || !queue.lastVideoId) {
          queue.isPlaying = false;
          queue.nowPlaying = null;
          return;
        }
        let related = null;
        try {
          related = await fetchRelatedSong(guildId);
        } catch (err) {
          console.error('Autoplay error:', err);
        }
        if (playbackEpoch(guildId) !== epoch) return;
        if (!related) {
          queue.isPlaying = false;
          queue.nowPlaying = null;
          return;
        }
        console.log(`Autoplay: Queuing related song: ${related.title}`);
        addToQueue(guildId, related);
        await sendToMusicChannel(client, guildId, `🔄 **Autoplay:** Queuing **${related.title}**`);
        if (playbackEpoch(guildId) !== epoch) return;
      }

      const nextSong = getNextSong(guildId);
      if (!nextSong) {
        queue.isPlaying = false;
        queue.nowPlaying = null;
        return;
      }

      try {
        const player = await play(connection, nextSong.query, guildId, async () => {
          await playNextInQueue(client, connection, guildId);
        });
        // A stop that landed mid-resolve wins: drop what we just started.
        if (playbackEpoch(guildId) !== epoch) {
          abandonPlayback(guildId);
          return;
        }
        players.set(guildId, player);
        markNowPlaying(guildId, nextSong);
        await postNowPlaying(client, guildId, nextSong, nextSong.addedBy);
        return;
      } catch (err) {
        console.error('Error playing next song in queue:', err);
        failures += 1;
        const label = nextSong.title || nextSong.query;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          queue.isPlaying = false;
          queue.nowPlaying = null;
          await sendToMusicChannel(
            client,
            guildId,
            `⚠️ Gave up after ${failures} tracks failed to start (last: **${label}**). ` +
              `${queue.songs.length} still queued — \`/play\` anything to pick the queue back up.`
          );
          return;
        }
        await sendToMusicChannel(client, guildId, `⚠️ Skipping **${label}** — it failed to start.`);
      }
    }
  } finally {
    // Whatever happened, the guild is no longer mid-start: either a track is
    // playing (isPlaying carries it from here) or we stopped.
    endPlayback(guildId);
  }
}

/**
 * Begin playing a track immediately, wiring the finish handler that keeps the
 * queue draining.
 */
async function startPlayback(client, connection, guildId, song) {
  const epoch = playbackEpoch(guildId);
  try {
    const player = await play(connection, song.query, guildId, async () => {
      await playNextInQueue(client, connection, guildId);
    });
    // Someone hit stop while this was resolving; don't undo them.
    if (playbackEpoch(guildId) !== epoch) {
      abandonPlayback(guildId);
      return null;
    }
    players.set(guildId, player);
    markNowPlaying(guildId, song);
    await postNowPlaying(client, guildId, song, song.addedBy);
    return player;
  } finally {
    // Releases the claim taken by the caller's beginPlayback(). On success
    // play() has already set isPlaying, so the guild stays covered.
    endPlayback(guildId);
  }
}

/**
 * Resolve a voice connection to the guild's default voice channel, for the
 * music player's buttons when the presser is not in voice. Prefers an existing
 * connection so we never yank the bot out of a channel people are already
 * listening in.
 */
async function ensureVoiceConnection(client, guildId) {
  const existing = getConnection({ id: guildId });
  if (existing) return existing;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) throw new Error('Guild not found.');

  const voiceChannelId = channelId(guildId, 'defaultVoice');
  if (!voiceChannelId) throw new Error('No default voice channel configured for this guild.');

  const channel = await guild.channels.fetch(voiceChannelId).catch(() => null);
  if (!channel) throw new Error('Configured voice channel not found.');
  if (channel.type !== ChannelType.GuildVoice) {
    throw new Error('Configured channel is not a voice channel.');
  }

  return connectToChannel(channel);
}

module.exports = {
  buildControlRow,
  postNowPlaying,
  playNextInQueue,
  startPlayback,
  ensureVoiceConnection,
  lastNowPlayingMessages,
};
