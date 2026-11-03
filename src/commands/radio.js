'use strict';
const { SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { connectToChannel, getConnection, getQueue, addToQueue, getNextSong, beginPlayback, endPlayback } = require('../music/player');
const { playNextInQueue, startPlayback } = require('../music/session');

const CSV_PATH = path.join(__dirname, '../../radio.csv');

/** Parse the radio.csv into an array of { title, artist, query } */
function loadRadioTracks() {
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());
  const header = lines[0].split(',').map(h => h.trim());
  const nameIdx   = header.indexOf('Track Name');
  const artistIdx = header.indexOf('Artist Name(s)');

  const tracks = [];
  for (let i = 1; i < lines.length; i++) {
    // Handle quoted fields containing commas
    const cols = lines[i].match(/(".*?"|[^,]+)(?=,|$)/g) || [];
    const name   = (cols[nameIdx]   || '').replace(/^"|"$/g, '').trim();
    const artist = (cols[artistIdx] || '').replace(/^"|"$/g, '').trim().split(';')[0]; // first artist only
    if (!name || !artist) continue;
    tracks.push({ title: `${artist} - ${name}`, query: `${artist} - ${name}` });
  }
  return tracks;
}

/** Remove a track from radio.csv by matching the query */
function removeTrackFromRadio(trackQuery) {
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = raw.split('\n');
  const header = lines[0].split(',').map(h => h.trim());
  const nameIdx   = header.indexOf('Track Name');
  const artistIdx = header.indexOf('Artist Name(s)');

  // Filter out the matching track
  const filtered = [lines[0]]; // Keep header
  let removed = false;

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].match(/(".*?"|[^,]+)(?=,|$)/g) || [];
    const name   = (cols[nameIdx]   || '').replace(/^"|"$/g, '').trim();
    const artist = (cols[artistIdx] || '').replace(/^"|"$/g, '').trim().split(';')[0];
    const trackTitle = `${artist} - ${name}`;

    if (trackTitle.toLowerCase() === trackQuery.toLowerCase()) {
      removed = true;
      continue; // Skip this line
    }
    filtered.push(lines[i]);
  }

  if (removed) {
    fs.writeFileSync(CSV_PATH, filtered.join('\n'));
  }

  return removed;
}

/** Fisher-Yates shuffle */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('radio')
    .setDescription('Queue songs from the radio playlist')
    .addStringOption(o =>
      o.setName('filter')
        .setDescription('Filter by artist or song name (optional)')
        .setRequired(false))
    .addIntegerOption(o =>
      o.setName('limit')
        .setDescription('How many songs to queue (default: 25, max: 100)')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(false)),

  async execute(interaction) {
    try { await interaction.deferReply({ flags: 64 }); } catch { return; }

    const member = interaction.member;
    if (!member.voice.channel) {
      return interaction.editReply('❌ Join a voice channel first!');
    }

    let tracks;
    try { tracks = loadRadioTracks(); }
    catch (err) {
      console.error('Radio: failed to load CSV:', err.message);
      return interaction.editReply('❌ Could not load radio.csv.');
    }

    const filter = interaction.options.getString('filter')?.toLowerCase();
    const limit  = interaction.options.getInteger('limit') || 25;

    if (filter) {
      tracks = tracks.filter(t => t.title.toLowerCase().includes(filter));
      if (tracks.length === 0) {
        return interaction.editReply(`❌ No tracks found matching **${filter}**.`);
      }
    }

    const selected = shuffle(tracks).slice(0, limit);

    let connection = getConnection(interaction.guild);
    if (!connection) connection = connectToChannel(member.voice.channel);

    const guildId = interaction.guild.id;
    const queue = getQueue(guildId);

    for (const track of selected) {
      addToQueue(guildId, { query: track.query, title: track.title, addedBy: interaction.user.tag });
    }

    const filterNote = filter ? ` matching **${filter}**` : '';
    await interaction.editReply(`📻 Queued **${selected.length}** random tracks${filterNote} from the radio playlist!`);

    if (beginPlayback(guildId)) {
      const first = getNextSong(guildId);
      if (first) {
        await startPlayback(interaction.client, connection, guildId, {
          ...first,
          addedBy: first.addedBy || 'Radio',
        });
      } else {
        endPlayback(guildId);
      }
    }
  },

  // Helpers for the music player's Radio and Drop from radio buttons.
  removeTrackFromRadio,
  loadRadioTracks,
  shuffle,
};
