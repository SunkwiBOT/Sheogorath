'use strict';
/**
 * Sheogorath does commentary over a gameplay clip.
 *
 * He cannot watch video — Grok takes pictures, not footage — so he is shown a
 * handful of stills with the second each was taken at, and writes what he would
 * say over it as timed lines. Each line is spoken by ElevenLabs in his voice,
 * laid onto the clip at its time, and the game's own sound is pushed down under
 * him while he talks and comes back up when he stops. If he has more to say than
 * the clip has length, the last frame holds while he finishes.
 *
 * Cost per clip: one Grok call with the stills (metered by ai/budget.js like
 * every other) and a few hundred characters of ElevenLabs (capped per day in
 * ai/elevenlabs.js).
 */
const fs = require('fs');
const path = require('path');
const { getAIResponseWithImages } = require('../ai/grok');
const { speech, remaining } = require('../ai/elevenlabs');
const { withoutLengthRules, LORE } = require('../ai/persona');
const { scrub } = require('../ai/actions');
const { getGuildState, setGuildState } = require('../storage/state');

/** Longest clip worth narrating. Past this it is a VOD, not a clip. */
const MAX_SECONDS = 120;

/**
 * How far past the end he may keep talking, over a frozen last frame.
 *
 * More for a short clip than a long one: four seconds of someone dying is over
 * before a sentence about it is, and the freeze on the moment is the joke.
 */
function overrun(duration) {
  return duration < 12 ? 6 : 4;
}

/**
 * How much he may say over a clip this long, in words.
 *
 * At least enough for a setup, a beat and a verdict, which is what a joke over
 * a nine-second clip needs; sixteen words left him room only to describe it.
 */
function wordBudget(duration) {
  return Math.min(110, Math.max(22, Math.round(duration * 1.8)));
}

/**
 * Roughly how many characters of speech a word costs, spaces and punctuation
 * included, for telling him how much of the day's voice is left.
 */
const CHARS_PER_WORD = 6;

/** Characters he may say over one clip, so one long clip cannot spend a day. */
const MAX_CHARACTERS = 700;

/** A pause between two of his lines, so they read as separate thoughts. */
const LINE_GAP = 0.25;

/**
 * When to take the stills, as fractions of the clip.
 *
 * Bunched toward the end, because a clip is what someone saved *after* the
 * moment happened: the button is pressed when the kill lands, so the first
 * half is usually the walk there and the last few seconds are the point.
 */
function stillCount(duration) {
  return duration < 8 ? 4 : duration < 20 ? 6 : 8;
}

function stillTimes(duration, n = stillCount(duration)) {
  return Array.from({ length: n }, (_, i) => {
    const x = 1 - Math.pow(1 - i / (n - 1), 1.6);
    return Math.min(duration - 0.1, Math.max(0, duration * (0.03 + 0.94 * x)));
  });
}

/**
 * How different two frames look, 0 to 255: the mean gap between their
 * grey thumbnails. A death screen with the camera drifting is a few points;
 * the cut from a road to an explosion is dozens.
 */
function difference(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** Below this, a frame shows him nothing the one before it didn't. */
const SAME_FRAME = 7;

/**
 * Which looks to keep from the candidates: drop each that looks the same as
 * the last one kept, then thin what is left evenly to `n`, first and last
 * always kept.
 *
 * Without this a clip that ends on a death screen spent most of its stills on
 * the death screen. Allister's Humvee clip (2026-10-27) had four of six there,
 * and the two left fell either side of the tank he drove into and blew up, so
 * all he could say was that the Humvee crashed.
 */
function pickStills(candidates, n) {
  const distinct = [];
  for (const c of candidates) {
    const last = distinct[distinct.length - 1];
    if (!last || !c.thumb || !last.thumb || difference(c.thumb, last.thumb) >= SAME_FRAME) distinct.push(c);
  }
  if (distinct.length <= n) return distinct;
  return Array.from({ length: n }, (_, i) => distinct[Math.round((i * (distinct.length - 1)) / (n - 1))]);
}

async function stills(source, duration, dir, run) {
  const n = stillCount(duration);
  const candidates = [];
  for (const [i, at] of stillTimes(duration, n * 2).entries()) {
    const file = path.join(dir, `still${i}.jpg`);
    const thumb = path.join(dir, `still${i}.grey`);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', source, '-frames:v', '1',
      '-filter_complex', "[0:v]split=2[a][b];[a]scale=w='min(1024,iw)':h=-2[full];[b]scale=32:18,format=gray[grey]",
      '-map', '[full]', '-q:v', '4', file,
      '-map', '[grey]', '-f', 'rawvideo', thumb], { timeout: 60000 });
    if (fs.existsSync(file)) {
      candidates.push({ at, jpeg: fs.readFileSync(file), thumb: fs.existsSync(thumb) ? fs.readFileSync(thumb) : null });
    }
  }
  if (!candidates.length) throw new Error('could not take a single still from it');
  return pickStills(candidates, n).map(({ at, jpeg }) => ({ at, jpeg }));
}

// --- His running bits ------------------------------------------------------

/**
 * What carries from one clip to the next, per guild: how often the floor has
 * won this month (a clip that ends with its player down), and what he said over
 * the last few clips, so he can call back to a joke without telling it twice.
 *
 * The month of clips cut together as "The Mad God's Cut" (2026-10-26) was funny
 * largely because of running bits like these, and a single clip has nothing to
 * run them from. They are kept small and short-lived on purpose: a joke read
 * back to him indefinitely becomes a loop (see storage/state.js on notes), so
 * the count starts over each month and only the last few clips are kept.
 */
const RECENT_CLIPS = 5;
const RECENT_DAYS = 14;

function monthOf(now) {
  return now.toISOString().slice(0, 7);
}

/** This guild's bits as they stand, with last month's count and stale lines dropped. */
function bits(guildId, now = new Date()) {
  const saved = guildId ? getGuildState(guildId).commentary || {} : {};
  const thisMonth = saved.month === monthOf(now);
  const cutoff = now.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000;
  return {
    month: monthOf(now),
    floor: thisMonth ? saved.floor || 0 : 0,
    downs: thisMonth ? saved.downs || {} : {},
    recent: (saved.recent || []).filter((r) => Date.parse(r.at) >= cutoff).slice(-RECENT_CLIPS),
  };
}

/** Add one finished commentary to the guild's bits. Only a game clip counts for the floor. */
function remember(guildId, { posterId, poster, script, game }, now = new Date()) {
  if (!guildId) return;
  const b = bits(guildId, now);
  if (game && script.downed) {
    b.floor += 1;
    const was = b.downs[posterId]?.count || 0;
    b.downs[posterId] = { name: poster, count: was + 1 };
  }
  b.recent = [...b.recent, { at: now.toISOString(), title: script.title, lines: script.lines.map((l) => l.text) }]
    .slice(-RECENT_CLIPS);
  setGuildState(guildId, { commentary: b });
}

/** The bits as he is told them. */
function bitsBrief({ floor, downs, recent }, { game, poster }) {
  const parts = [];
  if (game) {
    const who = Object.values(downs).sort((a, b) => b.count - a.count)
      .map((d) => `${d.name} ${d.count}`).join(', ');
    parts.push('THE FLOOR\n\n'
      + `When one of the ${game} players goes down, the floor wins. The floor is their oldest opponent and `
      + 'it has never lost. '
      + (floor
        ? `This month so far it is the floor ${floor}, the players nil${who ? ` (${who})` : ''}. `
        : 'It has not won yet this month. ')
      + `Bring the floor up only if ${poster} ends this clip down; then it is the floor's `
      + `${floor + 1}${ordinal(floor + 1)}. Otherwise leave it out.`);
  }
  if (recent.length) {
    parts.push('WHAT YOU SAID OVER THE LAST FEW CLIPS\n\n'
      + recent.map((r) => `- ${r.title}: ${r.lines.join(' / ')}`).join('\n')
      + '\n\nNever reuse a line, a comparison or a title from these. A callback is fine when it is earned.');
  }
  return parts.join('\n\n');
}

function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
}

// --- What he is told -------------------------------------------------------

/**
 * What he is told about the video and how to talk over it.
 *
 * In the clips channel it is known to be a particular game, with the poster as
 * the player. Anywhere else it could be anything — a mirrored Instagram reel is
 * as likely as a clip — so he is told to work out which, and not to cast whoever
 * shared a stranger's video as the person in it.
 *
 * How to be funny is taken from the Mad God's Cut, whose best lines were short,
 * pinned to one thing on screen and bent by a comparison from his own world,
 * with one-word deadpan beats dropped on the moment. The examples are its lines;
 * he is told not to reuse them.
 */
function brief({ poster, game, about, duration, words, running = '', said = '' }) {
  const what = game ? `a ${game} clip` : 'a video';
  const who = game
    ? `It is ${game} gameplay, and ${poster} is the player.`
    : `If it is gameplay, ${poster} is the player. If it is anything else, ${poster} only shared it: `
      + 'talk about what is in it, and about them only for choosing to show it to everyone.';
  const told = said
    ? `\n\nWhen ${poster} posted it they said: "${said.replace(/"/g, "'")}". They were there and the stills `
      + 'can miss the moment, so where the two seem to disagree, go with what they said. Joke about it in your '
      + 'own words rather than repeating theirs.'
    : '';
  return {
    system: `${withoutLengthRules()}\n\n${LORE}\n\nCOMMENTARY\n\n`
      + `You are doing commentary over ${what} that ${poster} posted in the server. What you write is `
      + 'spoken aloud in your own voice over the footage, with its own sound turned down underneath you. '
      + 'You are a delighted, wry narrator who has watched every mortal fall off every ladder and still '
      + 'enjoys it, with a comedian\'s timing.'
      + (running ? `\n\n${running}` : ''),
    prompt: 'Those are stills from it, in order. '
      + `It lasts ${duration.toFixed(1)} seconds.${about ? ` About the game: ${about}` : ''}${told}\n\n`
      + `First work out what happened. ${who} In a game, read the screen the way a player would: a red or `
      + 'bloody screen is the player being hit, a screen telling them to call for help or bleed out means they '
      + 'went down, a menu or inventory means they stopped to rummage, a kill feed or hit marker means they hit '
      + 'someone (read the names in it: the player\'s own name as a victim means they took themselves out too), '
      + 'a scope means they were aiming at something, so say what. Never invent a kill, an enemy, a '
      + 'name or a scoreline you cannot see; when it is unclear what happened, that is the joke.\n\n'
      + 'Then think of jokes before you write any lines: put what happened in one plain sentence, then five '
      + 'different jokes about it. Then pick the two or three funniest, the boldest rather than the safest, and '
      + 'use them nearly word for word as your lines. Do not write new, tamer lines in their place.\n\n'
      + 'What is funny is the gap between what they meant to do and what happened, or the odd thing they chose '
      + 'to do in the middle of it. Find that, name the concrete detail, and say it vividly, with a twist. A '
      + 'line that only describes the screen ("The rocket finds its mark." "Road stretches, speed climbs." '
      + '"Kill confirmed.") is not a joke, so cut it. Fewer, better lines: two to five '
      + 'for most clips, each a whole spoken sentence, and one deadpan beat of one to three words dropped right '
      + 'as the moment lands, after a gap. A comparison from your own world (cheese, butterflies, bored daedra, '
      + 'Haskill) is welcome now and then, never the same one twice.\n\n'
      + 'Commentary you have already done, with what was on screen. Match the voice; never reuse these lines '
      + 'or copy their shapes:\n'
      + '- Stopped halfway up a ladder to loot a body, then fell off: "Stops to strip a corpse mid-ascent." '
      + '... "Priorities." ... "Then gravity joins the chat and down he goes."\n'
      + '- Drove an armoured car into a hangar: "Fisher rams his APC straight into the hangar like a drunken '
      + 'saint."\n'
      + '- Down on the ground in a town: "Our Fisher\'s down, admiring the bricks." ... "Typical mortal view '
      + 'from the floor."\n'
      + '- Sat in a car aiming a rocket launcher for a minute and a half and never fired: "Eighty seconds later '
      + 'he is still sitting there with the tube aimed at fog and trees." ... "But the trigger stays untouched '
      + 'as the clip ends in peace."\n'
      + '- A Humvee blew up under him: "Goodbye, Hummer."\n'
      + '- A run that started well and ended badly: "Bold start, messy finish. Cheese for the effort '
      + 'though."\n\n'
      + 'The rules:\n'
      + `- Between ${Math.round(words * 0.6)} and ${words} words in all; a short clip can be a setup and a `
      + 'punchline. Each line has a start time in seconds and takes about 0.4 seconds per word to say. Lines '
      + `must not overlap, and the last may run up to ${overrun(duration)} seconds past the end, where the `
      + 'picture freezes on the final moment.\n'
      + '- Leave some gaps. Its own sound is half of it.\n'
      + '- Everything is spoken: no emoji, no asterisks, no stage directions, no action tags, no markdown. '
      + 'Write numbers and abbreviations the way they are said.\n'
      + '- A title for the post, like the name of an episode rather than a summary of it: "The Patient '
      + 'Hunter", "The Floor Remains Undefeated", "Priorities". Never "this then that". Six words at most, '
      + 'no quotation marks.\n'
      + `- "downed": true if ${poster} ends the clip down, dead or bleeding out, otherwise false.\n\n`
      + 'Reply with only JSON: {"happened": "...", "ideas": ["...", "...", "...", "...", "..."], '
      + '"title": "...", "downed": false, "lines": [{"at": 0.5, "text": "..."}]}',
  };
}

/** Make a model's line safe to read aloud. */
function speakable(text) {
  return scrub(text)
    .replace(/\*[^*]*\*/g, ' ')                       // *stage directions*
    .replace(/\([^)]*\)/g, ' ')                       // (asides)
    .replace(/[\p{Extended_Pictographic}️]/gu, '') // emoji
    .replace(/[`#_~>|]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * The model's JSON, checked and trimmed to what we will actually say: no more
 * than `cap` characters (what's left of the day's voice, at most a clip's).
 */
function parseScript(raw, duration, cap = MAX_CHARACTERS) {
  const match = String(raw).match(/\{[\s\S]*\}/);
  if (!match) throw new Error('he had nothing to say about it');
  const data = JSON.parse(match[0]);

  const lines = [];
  let chars = 0;
  for (const line of Array.isArray(data.lines) ? data.lines : []) {
    const text = speakable(line?.text || '');
    const at = Number(line?.at);
    if (!text || !Number.isFinite(at)) continue;
    if (chars + text.length > cap) break;
    chars += text.length;
    lines.push({ at: Math.min(Math.max(0, at), duration), text });
  }
  if (!lines.length) throw new Error('he had nothing to say about it');
  lines.sort((a, b) => a.at - b.at);

  const title = speakable(data.title || '').replace(/["“”]/g, '').slice(0, 80) || 'Commentary';
  return { title, lines, chars, downed: data.downed === true };
}

/**
 * Speak each line, then place it: at its own time, or straight after the line
 * before if that one is still going. Real speech never runs to the model's
 * 0.4-seconds-a-word guess, so the times are a request, not a schedule.
 */
async function voice(lines, dir, probe) {
  const placed = [];
  let free = 0;
  for (const [i, line] of lines.entries()) {
    const file = path.join(dir, `line${i}.mp3`);
    fs.writeFileSync(file, await speech(line.text));
    const { duration } = await probe(file).catch(() => ({ duration: line.text.split(/\s+/).length * 0.4 }));
    const at = Math.max(line.at, free);
    placed.push({ ...line, file, at, seconds: duration });
    free = at + duration + LINE_GAP;
  }
  return placed;
}

/** How long a spoken line runs. clips.probe() insists on a picture; an mp3 has none. */
function audioProbe(run) {
  return async (file) => {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file], { timeout: 30000 });
    return { duration: Number(stdout.trim()) || 0 };
  };
}

/**
 * The filter graph: picture scaled to at most 1080p and frozen at the end if he
 * runs over; his lines delayed to their times and mixed into one track; the
 * game's sound padded to length and compressed whenever that track is speaking.
 */
function graph({ info, placed, seconds }) {
  const freeze = Math.max(0, seconds - info.duration);
  const fps = info.fps > 61 ? ',fps=60' : '';
  const video = `[0:v]scale=w='min(1920,iw)':h=-2,setsar=1${fps}`
    + `${freeze > 0 ? `,tpad=stop_mode=clone:stop_duration=${freeze.toFixed(3)}` : ''}[v]`;

  const lines = placed.map((l, i) =>
    `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,volume=1.6,adelay=${Math.round(l.at * 1000)}:all=1[l${i}]`);
  const together = placed.length > 1
    ? `${placed.map((_, i) => `[l${i}]`).join('')}amix=inputs=${placed.length}:normalize=0:duration=longest,`
    : '[l0]';
  const narration = `${together}apad,atrim=0:${seconds.toFixed(3)},asplit=2[nsc][nmix]`;

  const game = info.hasAudio
    ? `[0:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${seconds.toFixed(3)}[g]`
    : `anullsrc=r=48000:cl=stereo,atrim=0:${seconds.toFixed(3)}[g]`;
  const duck = '[g][nsc]sidechaincompress=threshold=0.015:ratio=14:attack=15:release=450[duck]';
  const mix = '[duck][nmix]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[a]';

  return [video, ...lines, narration, game, duck, mix].join(';');
}

/**
 * Narrate one clip. Called by services/clips.js with the clip already on disk.
 * @returns {Promise<{file: string, name: string, content: string, script: object}>}
 */
async function make({ source, info, dir, guildId, posterId, poster, said, game, about, budgetMB }) {
  const { run, encode } = require('./clips');
  if (info.duration > MAX_SECONDS) throw new Error(`that runs over ${MAX_SECONDS / 60} minutes; he only narrates clips`);
  if (remaining() < 120) throw new Error('his voice is spent for today; try again tomorrow');

  // Written to what is left of the day's voice, so a late clip is a shorter
  // joke rather than a long one with its punchline cut off by the cap.
  const cap = Math.min(MAX_CHARACTERS, remaining());
  const words = Math.min(wordBudget(info.duration), Math.floor(cap / CHARS_PER_WORD));
  const shots = await stills(source, info.duration, dir, run);
  const running = bitsBrief(bits(guildId), { game, poster });
  const { system, prompt } = brief({ poster, game, about, duration: info.duration, words, running, said });
  // More room than the lines need: he writes what happened and his rejected
  // jokes first, and the JSON fails to parse if it is cut off.
  const raw = await getAIResponseWithImages(prompt, shots.map(({ at, jpeg }) => ({
    caption: `Still at ${at.toFixed(1)}s:`, jpeg,
  })), { rawSystemPrompt: system, maxTokens: 1500 });

  const script = parseScript(raw, info.duration, cap);
  console.log(`[Commentary] "${script.title}": ${script.lines.length} line(s), ${script.chars} characters`
    + `${script.downed ? ', downed' : ''}`);

  const placed = await voice(script.lines, dir, audioProbe(run));
  const spoken = placed[placed.length - 1].at + placed[placed.length - 1].seconds;
  const seconds = Math.max(info.duration, Math.min(spoken + 0.6, info.duration + overrun(info.duration) + 3));

  const out = path.join(dir, 'commentary.mp4');
  await encode({
    inputs: ['-i', source, ...placed.flatMap((l) => ['-i', l.file])],
    filter: graph({ info, placed, seconds }),
    audio: true,
    seconds,
    budgetMB,
    out,
  });
  remember(guildId, { posterId, poster, script, game });

  return {
    file: out,
    name: 'sheogorath-commentary.mp4',
    content: `🎙️ **${script.title}**\n-# Sheogorath on ${poster}'s clip`,
    script,
  };
}

module.exports = { make, parseScript, stillTimes, stills, pickStills, speakable, graph, brief, bits, bitsBrief, remember, wordBudget };
