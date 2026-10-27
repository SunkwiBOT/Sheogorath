'use strict';
/**
 * Gameplay clips, and the two things he does to them.
 *
 * Commentary (services/commentary.js): he watches the clip and talks over it in
 * his own voice. In the guild's clips channel that happens to every clip on its
 * own; anywhere else it is asked for from a message's Apps menu.
 *
 * The Wabbajack (services/wabbajack.js): the clip comes back as something else,
 * picked at random. Apps menu only — it is a thing you do to a clip, not a thing
 * that happens to every one.
 *
 * This module is what they share: finding the video on a message, fetching it,
 * measuring it, re-encoding to fit the guild's upload cap, running one job at a
 * time, and posting the result as a reply to the clip.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { MessageFlags } = require('discord.js');
const { uploadBudgetMB } = require('./mediaMirror');
const { getGuildConfig, hasFeature } = require('../config/guilds');

const TEMP_DIR = path.join(__dirname, '..', '..', 'temp');
const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.mkv'];

/** Nitro's own upload cap. Anything bigger was not posted by a person. */
const MAX_SOURCE_BYTES = 500 * 1024 * 1024;

/**
 * Jobs allowed to wait behind the one running. Each is a minute or so of
 * ffmpeg, so past this the last in line would wait long enough to think it
 * had been ignored — better told now.
 */
const MAX_WAITING = 5;

/** What each kind does, and how it says it is working on it. */
const KINDS = {
  commentary: { service: () => require('./commentary'), working: '🎙️ He is watching it…' },
  wabbajack: { service: () => require('./wabbajack'), working: '🌀 Pointing the Wabbajack at it…' },
};

// --- Running ffmpeg --------------------------------------------------------

/** Run a program without a shell, so a filename can never be read as syntax. */
function run(cmd, args, { timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || '').trim().split('\n').slice(-3).join(' | ');
        reject(new Error(`${cmd} failed: ${tail || err.message}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** Seconds, size, frame rate and whether there is sound, from ffprobe. */
async function probe(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height,avg_frame_rate,sample_rate',
    '-of', 'json', file,
  ], { timeout: 30000 });
  const info = JSON.parse(stdout);
  const video = info.streams.find((s) => s.codec_type === 'video');
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new Error('that file has no picture in it');

  const [num, den] = String(video.avg_frame_rate || '30/1').split('/').map(Number);
  return {
    duration: Number(info.format.duration) || 0,
    width: video.width,
    height: video.height,
    fps: den ? num / den : 30,
    hasAudio: !!audio,
    sampleRate: Number(audio?.sample_rate) || 48000,
  };
}

/**
 * Whether this box's NVIDIA encoder works. Learned from the first encode and
 * kept, so a machine without one pays for the failed attempt once, not on
 * every clip.
 */
let nvenc = null;

/**
 * Encode to H.264 + AAC under the guild's upload cap.
 *
 * The bitrate is worked out from how long the result runs, aiming a little
 * under the cap because a VBR encode lands near its target, not on it.
 * `videoKbps` pins it lower for an effect that wants to look bad.
 *
 * @param {object} job
 * @param {string[]} job.inputs     ffmpeg arguments up to and including every -i
 * @param {string}   job.filter     a -filter_complex graph ending in [v] (and [a])
 * @param {boolean}  job.audio      whether the graph has an [a]
 * @param {number}   job.seconds    how long the result runs
 * @param {number}   job.budgetMB   the upload cap to fit under
 * @param {string}   job.out
 */
async function encode({ inputs, filter, audio, seconds, budgetMB, out, videoKbps = null, maxVideoKbps = 12000 }) {
  const audioKbps = audio ? 160 : 0;
  const fits = Math.floor((budgetMB * 0.9 * 8 * 1024) / Math.max(seconds, 1) - audioKbps);
  const kbps = Math.min(videoKbps || maxVideoKbps, fits);
  if (kbps < 400) throw new Error(`too long to fit under ${budgetMB.toFixed(0)}MB here`);

  const common = [
    '-y', '-hide_banner', '-loglevel', 'error',
    ...inputs,
    '-filter_complex', filter,
    '-map', '[v]', ...(audio ? ['-map', '[a]'] : ['-an']),
    '-t', seconds.toFixed(3),
  ];
  const rate = ['-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.25)}k`, '-bufsize', `${kbps * 2}k`];
  const tail = [
    '-pix_fmt', 'yuv420p',
    ...(audio ? ['-c:a', 'aac', '-b:a', `${audioKbps}k`] : []),
    '-movflags', '+faststart', out,
  ];

  if (nvenc !== false) {
    try {
      await run('ffmpeg', [...common, '-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', ...rate, ...tail]);
      nvenc = true;
    } catch (err) {
      if (nvenc === true) throw err;
      console.warn('[Clips] NVENC unavailable, encoding on the CPU from now on:', err.message);
      nvenc = false;
    }
  }
  if (nvenc === false) {
    await run('ffmpeg', [...common, '-c:v', 'libx264', '-preset', 'veryfast', ...rate, ...tail], { timeout: 600000 });
  }

  const mb = fs.statSync(out).size / (1024 * 1024);
  if (mb > budgetMB) throw new Error(`came out at ${mb.toFixed(1)}MB, over the ${budgetMB.toFixed(0)}MB cap`);
  return out;
}

// --- Finding and fetching the clip ----------------------------------------

/** The first video attached to a message, or null. */
function videoAttachment(message) {
  for (const a of message.attachments?.values?.() || []) {
    if (a.contentType?.startsWith('video/')) return a;
    if (VIDEO_EXTS.includes(path.extname(a.name || '').toLowerCase())) return a;
  }
  return null;
}

async function download(attachment, file) {
  if (attachment.size > MAX_SOURCE_BYTES) throw new Error('that clip is bigger than Discord allows anyone to post');
  const res = await fetch(attachment.url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`could not fetch the clip (${res.status})`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
  return file;
}

/**
 * The message the video is on, and the message of whoever it belongs to.
 *
 * A clip uploaded straight to Discord is both. A posted Instagram, X, TikTok or
 * Reddit link is neither: the video is on his own mirrored copy, which the
 * mirror posts as a reply to the link. So the menu used on a link finds that
 * copy, and the menu used on anything he posted — a mirror, or a clip he has
 * already narrated or wabbajacked — credits whoever's clip it was, not him.
 *
 * @returns {Promise<{clip: import('discord.js').Message, owner: import('discord.js').Message}|null>}
 */
async function locate(message) {
  const me = message.client.user.id;

  if (videoAttachment(message)) {
    let owner = message;
    for (let hops = 0; owner.author.id === me && owner.reference?.messageId && hops < 3; hops++) {
      const above = await owner.fetchReference().catch(() => null);
      if (!above) break;
      owner = above;
    }
    return { clip: message, owner };
  }

  if (!/https?:\/\//.test(message.content || '')) return null;
  const after = await message.channel.messages.fetch({ after: message.id, limit: 20 }).catch(() => null);
  const mirror = after?.find((m) => m.author.id === me && m.reference?.messageId === message.id && videoAttachment(m));
  return mirror ? { clip: mirror, owner: message } : null;
}

/**
 * Who posted it, as the room knows them, and as he can say out loud: the main
 * hall's nicknames carry a clan tag ("Allister [WBJK]"), which ElevenLabs would
 * read out letter by letter.
 */
function posterName(message) {
  const name = message.member?.displayName || message.author.globalName || message.author.username;
  return name.replace(/\s*[[(][^\])]*[\])]\s*/g, ' ').trim() || message.author.username;
}

/**
 * What the poster said about the clip, in their own words, for him to go on.
 *
 * Stills miss things — a tank in the second before it blows up, a voice saying
 * what just happened — and the person who clipped it knows. They tend to say it
 * in a message of its own just before the upload ("Drill Time", then the clip),
 * or in the file's name when they gave it one ("Fob_takedown.mp4"); a recorder's
 * automatic name ("Clip_-_10272026_82335_AM.mp4") says nothing and is left out.
 * Mentions come through as names, so "<@…> I feel like I pulled a you" reads.
 */
async function postedWith(owner, attachment) {
  const words = [];
  const textOf = (m) => (m.content || '')
    .replace(/<@!?(\d+)>/g, (_, id) => {
      const member = m.mentions?.members?.get(id);
      const user = m.mentions?.users?.get(id);
      return member ? posterName({ member, author: user || member.user }) : user?.globalName || user?.username || '';
    })
    .replace(/<@&\d+>|<#\d+>/g, '')
    .replace(/<a?:(\w+):\d+>/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const before = await owner.channel?.messages?.fetch({ before: owner.id, limit: 3 }).catch(() => null);
  const lead = before?.find((m) => m.author.id === owner.author.id
    && owner.createdTimestamp - m.createdTimestamp < 2 * 60 * 1000
    && !videoAttachment(m) && textOf(m));
  if (lead) words.push(textOf(lead));
  if (textOf(owner)) words.push(textOf(owner));

  const base = path.basename(attachment?.name || '', path.extname(attachment?.name || ''));
  if (/[a-z]{3}/i.test(base) && !/^(clip|video|vid|img|replay|recording|screen|untitled|sheogorath)\b/i.test(base.replace(/[_-]+/g, ' '))) {
    words.push(`file named ${base.replace(/[_-]+/g, ' ').trim()}`);
  }
  return words.join(' / ').slice(0, 300);
}

// --- One at a time ---------------------------------------------------------

let chain = Promise.resolve();
let waiting = 0;
/** `${kind}:${messageId}` already queued or running, so a double click is one job. */
const inFlight = new Set();

function enqueue(key, job) {
  if (inFlight.has(key)) throw new Error('already on it');
  if (waiting >= MAX_WAITING) throw new Error('there are already clips waiting; try again in a few minutes');
  inFlight.add(key);
  waiting++;
  const result = chain.then(job).finally(() => { waiting--; inFlight.delete(key); });
  chain = result.catch(() => {});
  return result;
}

/**
 * Fetch the clip, hand it to the kind's service, post what comes back.
 *
 * The service gets the clip on disk and returns `{ file, content }`: a finished
 * video and the line to post it with. It never sees Discord.
 *
 * @param {{clip: import('discord.js').Message, owner: import('discord.js').Message}} found from locate()
 * @returns {Promise<import('discord.js').Message>} the posted reply
 */
async function make({ clip, owner }, kind, { by = null } = {}) {
  const attachment = videoAttachment(clip);
  const key = `${kind}:${clip.id}`;
  return enqueue(key, async () => {
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    const dir = await fsp.mkdtemp(path.join(TEMP_DIR, `${kind}_`));
    const started = Date.now();
    try {
      const source = await download(attachment, path.join(dir, `source${path.extname(attachment.name || '.mp4') || '.mp4'}`));
      const info = await probe(source);
      const clips = getGuildConfig(clip.guildId)?.clips || {};
      const inClips = owner.channelId === clips.channel;

      const { file, content, name } = await KINDS[kind].service().make({
        source, info, dir,
        guildId: clip.guildId,
        said: await postedWith(owner, clip === owner ? attachment : null).catch(() => ''),
        poster: posterName(owner),
        posterId: owner.author.id,
        by,
        game: inClips ? clips.game : null,
        about: inClips ? clips.about : null,
        budgetMB: uploadBudgetMB(clip.guild),
      });

      const reply = await clip.reply({
        content,
        files: [{ attachment: file, name }],
        allowedMentions: { parse: [], repliedUser: false },
      });
      console.log(`[Clips] ${kind} for ${clip.id} posted in ${((Date.now() - started) / 1000).toFixed(0)}s`);
      return reply;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- Discord entry points --------------------------------------------------

/**
 * A message in the clips channel: if it carries a video, or links to one he has
 * just mirrored, he narrates it.
 *
 * Not awaited by the message handler — it is a minute of work, and he should
 * still answer the room while he watches. 👀 on the clip says he is. The
 * mirrors run before this and are awaited, so a linked video's copy is already
 * posted by the time this looks for it.
 */
function handleClipMessage(message) {
  if (!hasFeature(message.guildId, 'clips')) return;
  const clips = getGuildConfig(message.guildId)?.clips;
  if (!clips?.channel || message.channelId !== clips.channel || !clips.commentary) return;
  if (!videoAttachment(message) && !/https?:\/\//.test(message.content || '')) return;

  (async () => {
    const found = await locate(message).catch(() => null);
    if (!found) return;
    const eyes = await found.clip.react('👀').catch(() => null);
    try {
      await make(found, 'commentary');
    } catch (err) {
      console.warn(`[Clips] Commentary on ${found.clip.id} skipped:`, err.message);
    } finally {
      await eyes?.users.remove(message.client.user.id).catch(() => {});
    }
  })();
}

/**
 * The Apps menu: "Mad God commentary" and "Wabbajack" both land here.
 *
 * Answers before looking for the video, because finding a link's mirrored copy
 * is a fetch, and Discord gives a menu command three seconds to say anything.
 */
async function fromMenu(interaction, kind) {
  const message = interaction.targetMessage;
  await interaction.reply({ content: KINDS[kind].working, flags: MessageFlags.Ephemeral });

  try {
    const found = await locate(message);
    if (!found) throw new Error('there is no video on that message, or mirrored from its link');
    const posted = await make(found, kind, { by: interaction.user.id });
    await interaction.editReply(`Done: ${posted.url}`).catch(() => {});
  } catch (err) {
    console.warn(`[Clips] ${kind} on ${message.id} failed:`, err.message);
    const why = err.message.charAt(0).toUpperCase() + err.message.slice(1);
    await interaction.editReply(`❌ ${why}${/[.!?]$/.test(why) ? '' : '.'}`).catch(() => {});
  }
}

module.exports = { handleClipMessage, fromMenu, locate, make, run, probe, encode, videoAttachment, postedWith };
