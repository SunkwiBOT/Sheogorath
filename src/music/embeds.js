'use strict';
const { EmbedBuilder } = require('discord.js');
const ytdlexec = require('youtube-dl-exec');
const { youtubeOptions } = require('./player');

/**
 * Create a rich embed for now playing music
 * @param {Object} song - Song object with url, title, query
 * @param {string} addedBy - User tag who queued the song
 * @returns {Promise<EmbedBuilder>} Discord embed
 */
async function createNowPlayingEmbed(song, addedBy = 'Unknown') {
  const embed = new EmbedBuilder()
    .setColor(0x1DB954) // Spotify green
    .setTimestamp();

  try {
    // player.resolveVideoUrl already dumped this JSON when it resolved the
    // track, so reuse what it captured rather than spawning yt-dlp a second
    // time per song. Fall back to fetching only if we weren't handed metadata.
    const info = song.duration != null || song.thumbnail
      ? {
          title: song.title,
          uploader: song.uploader,
          thumbnail: song.thumbnail,
          duration: song.duration,
          view_count: song.viewCount,
          webpage_url: song.url,
        }
      : await ytdlexec(song.url || song.query, {
          ...youtubeOptions(),
          dumpSingleJson: true,
          noWarnings: true,
          noCheckCertificates: true,
        });

    const title = info.title || song.title || 'Unknown Track';
    const artist = info.uploader || info.channel || 'Unknown Artist';
    const thumbnail = info.thumbnail || null;
    const duration = info.duration ? formatDuration(info.duration) : '?:??';
    const views = info.view_count ? formatNumber(info.view_count) : null;

    embed
      .setTitle('🎵 Now Playing')
      .setDescription(`**${title}**\n${artist}`)
      .addFields(
        { name: '⏱️ Duration', value: duration, inline: true },
        { name: '👤 Queued by', value: addedBy, inline: true }
      );

    if (views) {
      embed.addFields({ name: '👁️ Views', value: views, inline: true });
    }

    if (thumbnail) {
      embed.setThumbnail(thumbnail);
    }

    if (info.webpage_url) {
      embed.setURL(info.webpage_url);
    }
  } catch (err) {
    console.error('Error fetching song metadata:', err.message);
    // Fallback to simple embed
    embed
      .setTitle('🎵 Now Playing')
      .setDescription(`**${song.title || song.query}**`)
      .addFields({ name: '👤 Queued by', value: addedBy, inline: true });
  }

  return embed;
}

/**
 * Format seconds into MM:SS or HH:MM:SS
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format large numbers with commas
 * @param {number} num
 * @returns {string}
 */
function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

module.exports = {
  createNowPlayingEmbed
};
