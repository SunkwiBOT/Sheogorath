const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, getVoiceConnection } = require('@discordjs/voice');
const { EventEmitter } = require('events');
const ytdl = require('@distube/ytdl-core');
const ytdlexec = require('youtube-dl-exec');

const players = new Map();
const queues = new Map();
// Track the yt-dlp/ffmpeg child processes per guild so we can tear them down
// on stop/skip. Without this they keep writing to a dead pipe → EPIPE → crash.
const processes = new Map();
// Retain the live AudioResource per guild. Without this we can't reach the
// inlineVolume transformer to change volume, or read playbackDuration for the
// elapsed position the music player renders as a progress bar.
const resources = new Map();
// Volume persists across songs — each new resource is created mid-playback, so
// we re-apply the guild's stored level rather than resetting to 1.0 every track.
const volumes = new Map();

const DEFAULT_VOLUME = 1.0;

// Emits 'state' (guildId) whenever playback or the queue changes, so the
// music player channel (panel.js) redraws itself instead of polling.
const musicEvents = new EventEmitter();
// Slash commands and the player's buttons can both drive playback; a listener
// per guild per connection would otherwise pile up warnings.
musicEvents.setMaxListeners(50);

function emitState(guildId) {
  try {
    musicEvents.emit('state', guildId);
  } catch (err) {
    console.error('Error emitting music state:', err?.message || err);
  }
}

// Kill any running yt-dlp/ffmpeg processes for a guild and swallow their errors.
function killProcesses(guildId) {
  const procs = processes.get(guildId);
  if (!procs) return;
  for (const proc of [procs.ytdlpProcess, procs.ffmpeg]) {
    if (!proc) continue;
    try {
      // Detach listeners and ignore any late errors from the dying pipe.
      proc.removeAllListeners();
      if (proc.stdout) proc.stdout.removeAllListeners();
      if (proc.stdin) proc.stdin.removeAllListeners();
      proc.on('error', () => {});
      if (proc.stdout) proc.stdout.on('error', () => {});
      if (proc.stdin) proc.stdin.on('error', () => {});
      if (!proc.killed) proc.kill('SIGKILL');
    } catch (err) {
      console.error('Error killing media process:', err?.message || err);
    }
  }
  processes.delete(guildId);
}

// Queue management functions
function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, {
      songs: [],
      nowPlaying: null,
      isPlaying: false,
      // Set while a track is being resolved but is not yet audible. isPlaying
      // alone leaves a multi-second hole between one song ending and the next
      // starting, during which a second caller would think nothing was playing
      // and start its own track on top of ours.
      isStarting: false,
      // Bumped by stop/clear. A resolve in flight compares the epoch it started
      // with against this before it plays, so a track that was still loading
      // when someone hit stop doesn't come blasting out afterwards.
      epoch: 0,
      autoplay: true,
      lastVideoId: null,
      playedHistory: new Set()
    });
  }
  return queues.get(guildId);
}

function addToQueue(guildId, song) {
  const queue = getQueue(guildId);
  queue.songs.push(song);
  emitState(guildId);
  return queue.songs.length;
}

function clearQueue(guildId) {
  const queue = getQueue(guildId);
  queue.songs = [];
  queue.nowPlaying = null;
  queue.isPlaying = false;
  queue.isStarting = false;
  queue.epoch += 1;
  queue.lastVideoId = null;
  queue.playedHistory = new Set();
  emitState(guildId);
}

function removeFromQueue(guildId, index) {
  const queue = getQueue(guildId);
  if (index >= 0 && index < queue.songs.length) {
    const removed = queue.songs.splice(index, 1)[0];
    emitState(guildId);
    return removed;
  }
  return null;
}

function getNextSong(guildId) {
  const queue = getQueue(guildId);
  return queue.songs.shift();
}

/**
 * Claim the right to start playback for a guild, returning false if a track is
 * already playing or is mid-resolve.
 *
 * /play, /radio and the music player all used to test `queue.isPlaying` and set
 * it themselves. Resolving a track takes a yt-dlp round trip, and for that whole
 * window the flag reads false — so two callers could both decide nothing was
 * playing, and the second `player.play()` would swap out the first one's
 * resource with no Idle event, silently eating a song. The check and the set
 * have to happen together, here.
 */
function beginPlayback(guildId) {
  const queue = getQueue(guildId);
  if (queue.isPlaying || queue.isStarting) return false;
  queue.isStarting = true;
  return true;
}

/** Release a claim from beginPlayback. Safe to call more than once. */
function endPlayback(guildId) {
  getQueue(guildId).isStarting = false;
}

/**
 * The guild's current playback generation. Capture it before an await and
 * re-check it after; a change means stop/clear ran and the work is stale.
 */
function playbackEpoch(guildId) {
  return getQueue(guildId).epoch;
}

/**
 * Pull the fields both the Discord embed and the music player need out of a
 * yt-dlp JSON dump. Kept in one place so the two consumers can't drift.
 */
function extractMetadata(entry) {
  if (!entry) return {};
  return {
    duration: typeof entry.duration === 'number' ? entry.duration : null,
    thumbnail: entry.thumbnail || null,
    uploader: entry.uploader || entry.channel || null,
    viewCount: typeof entry.view_count === 'number' ? entry.view_count : null,
  };
}

async function resolveVideoUrl(url) {
  if (!url || typeof url !== 'string' || url.trim() === '') {
    throw new Error('No URL or search term provided.');
  }

  // If valid video URL, use directly; else search via yt-dlp
  let videoUrl = url;
  let title = url;
  let metadata = {};

  if (!ytdl.validateURL(url)) {
    try {
      const raw = await ytdlexec(`ytsearch1:${url}`, {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificates: true,
        preferFreeFormats: true,
        addHeader: [
          'referer:youtube.com',
          'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ],
      });
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const entry = data?.entries?.[0] || data;
      const id = entry?.id;
      title = entry?.title || url;
      metadata = extractMetadata(entry);
      const webpageUrl = entry?.webpage_url || (id ? `https://www.youtube.com/watch?v=${id}` : null);
      if (!webpageUrl) throw new Error('No results found for your search.');
      videoUrl = webpageUrl;
    } catch (err) {
      console.error('Error searching YouTube via yt-dlp:', err?.stderr || err?.message || err);
      throw new Error('Failed to search YouTube for your query.');
    }
  } else {
    // Try to get title for URL
    try {
      const raw = await ytdlexec(url, {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificates: true,
      });
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      title = data?.title || url;
      metadata = extractMetadata(data);
    } catch (err) {
      console.log('Could not fetch title for URL:', err.message);
    }
  }

  console.log('DEBUG: resolveVideoUrl() using videoUrl:', videoUrl);
  return { url: videoUrl, title, ...metadata };
}

async function play(connection, url, guildId, onFinish) {
  const { url: videoUrl, title, duration, thumbnail, uploader, viewCount } = await resolveVideoUrl(url);
  const queue = getQueue(guildId);
  // Carry the resolved metadata on nowPlaying so the embed builder and the
  // music player can both read duration/artwork without re-invoking yt-dlp.
  queue.nowPlaying = { url: videoUrl, title, duration, thumbnail, uploader, viewCount };
  queue.isPlaying = true;
  
  // Track video ID for autoplay related songs
  const videoIdMatch = videoUrl.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (videoIdMatch) {
    queue.lastVideoId = videoIdMatch[1];
    queue.playedHistory.add(videoIdMatch[1]);
    // Cap history at 50 entries to avoid memory bloat
    if (queue.playedHistory.size > 50) {
      const first = queue.playedHistory.values().next().value;
      queue.playedHistory.delete(first);
    }
  }
  
  console.log('DEBUG: play() using videoUrl:', videoUrl);

  // Pipe yt-dlp directly into ffmpeg — avoids 403 on signed stream URLs
  const { spawn } = require('child_process');

  // Tear down any leftover processes from a previous song before starting.
  killProcesses(guildId);

  // Deliberately the `yt-dlp` on PATH, not youtube-dl-exec's bundled copy: with
  // YOUTUBE_DL_DIR pointed at the system install they are the same binary, and
  // one upgrade keeps playback and search from drifting to different versions.
  const ytdlpProcess = spawn('yt-dlp', [
    '--no-playlist',
    '-f', 'bestaudio/best',
    '-o', '-',
    '--quiet',
    '--no-warnings',
    videoUrl
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const ffmpeg = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-analyzeduration', '0',
    '-loglevel', 'warning',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  // Track these so stop/skip can kill them.
  processes.set(guildId, { ytdlpProcess, ffmpeg });

  // Attach error handlers to EVERY pipe end. When playback is stopped mid-song
  // the reader disappears and these writes fail with EPIPE; an unhandled 'error'
  // event on any of these streams would crash the whole process.
  ytdlpProcess.on('error', (err) => console.error('[yt-dlp] process error:', err?.message || err));
  ffmpeg.on('error', (err) => console.error('[ffmpeg] process error:', err?.message || err));
  ytdlpProcess.stdout.on('error', () => {});
  ytdlpProcess.stdin.on('error', () => {});
  ffmpeg.stdin.on('error', () => {});
  ffmpeg.stdout.on('error', () => {});

  ytdlpProcess.stdout.pipe(ffmpeg.stdin);

  let ffmpegError = '';
  ffmpeg.stderr.on('data', (data) => { ffmpegError += data.toString(); });
  ffmpeg.on('exit', (code) => {
    if (code !== 0 && ffmpegError) {
      console.error('[ffmpeg] exited with code', code, ':', ffmpegError.substring(0, 300));
    }
    // ffmpeg is done — yt-dlp has nowhere to write, make sure it dies too.
    // Without this a finished track can leave yt-dlp resident.
    try {
      if (ytdlpProcess.exitCode === null && !ytdlpProcess.killed) ytdlpProcess.kill('SIGKILL');
    } catch { /* already gone */ }
  });

  ytdlpProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.trim()) console.error('[yt-dlp]', msg.trim().substring(0, 200));
  });

  console.log('Piping yt-dlp → ffmpeg for audio');
  // Create audio resource from ffmpeg output
  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: require('@discordjs/voice').StreamType.Raw,
    inlineVolume: true
  });

  // Retain it so setVolume/getPlaybackState can reach the volume transformer
  // and playbackDuration, and re-apply the guild's persisted level — a fresh
  // resource always starts at 1.0 otherwise.
  resources.set(guildId, resource);
  const storedVolume = volumes.get(guildId);
  if (typeof storedVolume === 'number' && resource.volume) {
    resource.volume.setVolume(storedVolume);
  }

  // Reuse existing player or create new one
  let player = players.get(guildId);
  if (!player) {
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    players.set(guildId, player);
  }
  
  // Add error handler for the resource
  resource.playStream.on('error', error => {
    console.error('Stream error:', error);
  });
  
  player.play(resource);
  connection.subscribe(player);
  
  // Add error recovery for connection issues
  connection.on('stateChange', (oldState, newState) => {
    if (newState.status === 'disconnected') {
      console.log('Voice connection disconnected, attempting to reconnect...');
      setTimeout(() => {
        try {
          connection.rejoin();
          console.log('Successfully rejoined voice channel');
        } catch (err) {
          console.error('Failed to rejoin voice channel:', err);
        }
      }, 1000);
    }
  });
  
  connection.on('error', (error) => {
    console.error('Voice connection error:', error);
    try {
      connection.rejoin();
    } catch (err) {
      console.error('Failed to recover from connection error:', err);
    }
  });
  
  // Clear old listeners to avoid duplicates
  player.removeAllListeners(AudioPlayerStatus.Idle);
  player.removeAllListeners('error');
  
  player.on(AudioPlayerStatus.Idle, () => {
    console.log('Player went idle for guild:', guildId);
    const queue = getQueue(guildId);
    queue.isPlaying = false;
    queue.nowPlaying = null;
    // Keep the guild claimed while onFinish resolves the next track, so a
    // /play landing in that gap queues up instead of starting a rival stream.
    // playNextInQueue releases this on every one of its exit paths.
    if (onFinish) queue.isStarting = true;
    resources.delete(guildId);
    emitState(guildId);

    if (onFinish) onFinish();
  });

  // No queue advance here on purpose: @discordjs/voice emits 'error' and then
  // drops the player to Idle, so the Idle handler above already moves us on.
  // Advancing here too would skip a song for every stream error.
  player.on('error', error => {
    console.error('Audio player error:', error);
    const queue = getQueue(guildId);
    queue.isPlaying = false;
    queue.nowPlaying = null;
    resources.delete(guildId);
    emitState(guildId);
  });

  // Pause/resume can be driven from a command or the player's buttons; either way the
  // other surface needs to see the new status.
  player.removeAllListeners(AudioPlayerStatus.Paused);
  player.removeAllListeners(AudioPlayerStatus.Playing);
  player.on(AudioPlayerStatus.Paused, () => emitState(guildId));
  player.on(AudioPlayerStatus.Playing, () => emitState(guildId));

  emitState(guildId);
  return player;
}

/**
 * Tear down a track that only became audible after a stop/clear made it stale:
 * silence the player and kill its yt-dlp/ffmpeg pair, leaving the queue and the
 * voice connection alone — whoever invalidated us already dealt with those.
 */
function abandonPlayback(guildId) {
  const player = players.get(guildId);
  if (player) {
    // Drop the Idle handler first, or tearing this down would advance the queue.
    player.removeAllListeners(AudioPlayerStatus.Idle);
    player.stop(true);
    players.delete(guildId);
  }
  killProcesses(guildId);
  resources.delete(guildId);
  const queue = getQueue(guildId);
  queue.isPlaying = false;
  queue.nowPlaying = null;
  emitState(guildId);
}

function stopPlaying(guildId) {
  const player = players.get(guildId);
  if (player) {
    // Remove the Idle handler first so force-stopping doesn't trigger autoplay.
    player.removeAllListeners(AudioPlayerStatus.Idle);
    player.stop(true);
    players.delete(guildId);
  }
  // Kill the media processes so they stop writing to the now-dead pipe.
  killProcesses(guildId);
  resources.delete(guildId);
  clearQueue(guildId);

  const connection = getVoiceConnection(guildId);
  if (connection) {
    connection.destroy();
  }
  emitState(guildId);
}

function pausePlaying(guildId) {
  const player = players.get(guildId);
  if (player) {
    player.pause();
    return true;
  }
  return false;
}

function resumePlaying(guildId) {
  const player = players.get(guildId);
  if (player) {
    player.unpause();
    return true;
  }
  return false;
}

function skipSong(guildId) {
  const player = players.get(guildId);
  if (player) {
    player.stop(); // This will trigger the Idle event and play next song
    return true;
  }
  return false;
}

/**
 * Set playback volume. `level` is 0.0–2.0, where 1.0 is unmodified — above 1.0
 * amplifies and will clip on already-loud sources, so the player stops its buttons
 * at 2.0. Stored per guild and re-applied to each subsequent track.
 */
function setVolume(guildId, level) {
  const clamped = Math.max(0, Math.min(2, Number(level)));
  if (!Number.isFinite(clamped)) return false;
  volumes.set(guildId, clamped);

  const resource = resources.get(guildId);
  if (resource?.volume) {
    resource.volume.setVolume(clamped);
  }
  emitState(guildId);
  // Report success even with nothing playing — the level is stored and will
  // apply to the next track.
  return true;
}

function getVolume(guildId) {
  const stored = volumes.get(guildId);
  return typeof stored === 'number' ? stored : DEFAULT_VOLUME;
}

/**
 * Full snapshot of playback for the music player. Position comes from the
 * resource's playbackDuration, which counts only audio actually streamed, so it
 * stays correct across pauses without us tracking wall-clock time.
 */
function getPlaybackState(guildId) {
  const queue = getQueue(guildId);
  const player = players.get(guildId);
  const resource = resources.get(guildId);
  const status = player?.state?.status || 'idle';

  return {
    status,
    isPlaying: status === AudioPlayerStatus.Playing,
    isPaused: status === AudioPlayerStatus.Paused,
    volume: getVolume(guildId),
    autoplay: queue.autoplay,
    connected: Boolean(getVoiceConnection(guildId)),
    nowPlaying: queue.nowPlaying
      ? {
          ...queue.nowPlaying,
          // playbackDuration is milliseconds; the player works in seconds.
          position: resource ? Math.floor(resource.playbackDuration / 1000) : 0,
        }
      : null,
    queue: queue.songs.map((song, index) => ({
      index,
      title: song.title || song.query,
      query: song.query,
      addedBy: song.addedBy || 'Unknown',
    })),
    queueLength: queue.songs.length,
  };
}

function setAutoplay(guildId, enabled) {
  const queue = getQueue(guildId);
  queue.autoplay = Boolean(enabled);
  emitState(guildId);
  return queue.autoplay;
}

function connectToChannel(voiceChannel) {
  return joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
  });
}

function getConnection(guild) {
  return getVoiceConnection(guild.id);
}

// Fetch a related song using YouTube's auto-mix playlist (RD prefix)
async function fetchRelatedSong(guildId) {
  const queue = getQueue(guildId);
  const videoId = queue.lastVideoId;
  if (!videoId) return null;

  try {
    const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
    console.log(`Autoplay: Fetching related songs from mix: ${mixUrl}`);
    
    const raw = await ytdlexec(mixUrl, {
      flatPlaylist: true,
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
    });
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const entries = data?.entries || [];
    
    // Filter out songs we've already played
    const candidates = entries.filter(e => e?.id && !queue.playedHistory.has(e.id));
    
    if (candidates.length === 0) {
      console.log('Autoplay: No unplayed candidates found in mix, picking any entry');
      // Fall back to any entry that isn't the current song
      const fallback = entries.find(e => e?.id && e.id !== videoId);
      if (!fallback) return null;
      return {
        query: `https://www.youtube.com/watch?v=${fallback.id}`,
        title: fallback.title || 'Unknown',
        addedBy: 'Autoplay'
      };
    }
    
    // Pick a random song from the top 5 candidates for variety
    const pick = candidates[Math.floor(Math.random() * Math.min(5, candidates.length))];
    return {
      query: `https://www.youtube.com/watch?v=${pick.id}`,
      title: pick.title || 'Unknown',
      addedBy: 'Autoplay'
    };
  } catch (err) {
    console.error('Autoplay: Failed to fetch related songs:', err?.message || err);
    return null;
  }
}

// Expand a YouTube playlist URL into an array of individual video entries
async function expandPlaylist(playlistUrl) {
  try {
    console.log(`Expanding playlist: ${playlistUrl}`);
    const raw = await ytdlexec(playlistUrl, {
      flatPlaylist: true,
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
    });
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const entries = data?.entries || [];
    
    // Cap at 100 songs
    const capped = entries.slice(0, 100);
    
    return {
      title: data?.title || 'Unknown Playlist',
      songs: capped.map(e => ({
        query: e?.webpage_url || `https://www.youtube.com/watch?v=${e?.id}`,
        title: e?.title || 'Unknown',
        id: e?.id
      })),
      totalCount: entries.length
    };
  } catch (err) {
    console.error('Playlist expansion failed:', err?.message || err);
    return null;
  }
}

module.exports = {
  play,
  connectToChannel,
  getConnection,
  players,
  resolveVideoUrl,
  getQueue,
  addToQueue,
  clearQueue,
  removeFromQueue,
  getNextSong,
  beginPlayback,
  endPlayback,
  playbackEpoch,
  abandonPlayback,
  stopPlaying,
  pausePlaying,
  resumePlaying,
  skipSong,
  setVolume,
  getVolume,
  setAutoplay,
  getPlaybackState,
  musicEvents,
  emitState,
  fetchRelatedSong,
  expandPlaylist,
  stopPlayer: stopPlaying,
  pausePlayer: pausePlaying,
  resumePlayer: resumePlaying
};
