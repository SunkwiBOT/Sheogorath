'use strict';
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { mirrorLinks } = require('./mediaMirror');
const { notifyOwner } = require('../utils/errorNotify');

// A Netscape-format cookies export from a browser logged in to Reddit. Since
// mid-October 2026 Reddit only serves the post data yt-dlp reads to logged-in
// sessions (yt-dlp issue #17856), so without this every download fails.
// yt-dlp writes refreshed cookies back into the file after each run.
const COOKIES_FILE = path.join(__dirname, '..', '..', 'www.reddit.com_cookies.txt');

// The owner hears about a missing or expired login at most once a day, and
// again sooner if a download works in between and then it breaks.
const LOGIN_NOTICE_MS = 24 * 60 * 60 * 1000;
let loginNoticeAt = 0;

// Post links, in any of Reddit's hosts (www, old, new, sh, ...). The subdomain
// has to end in a dot, so vxreddit/rxddit — which people use to get a working
// embed — don't match and aren't posted twice.
const POST_REGEX = /https?:\/\/(?:\w+\.)?reddit\.com\/(?:(?:r|u|user)\/[\w-]+\/)?comments\/([a-z0-9]+)/gi;
// redd.it/<post id> is the old short link; the id is all we need.
const SHORT_REGEX = /https?:\/\/redd\.it\/([a-z0-9]+)/gi;
// App share links (/r/sub/s/<code>) and bare video links (v.redd.it/<media
// id>). Neither carries the post id, so they're resolved by following
// Reddit's redirects.
const REDIRECT_REGEX = /https?:\/\/(?:(?:\w+\.)?reddit\.com\/(?:r|u|user)\/[\w-]+\/s\/\w+|v\.redd\.it\/\w+)/gi;

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';

/**
 * Download video from posted Reddit links with yt-dlp.
 *
 * Only Reddit-hosted video is mirrored; Discord's Reddit embed shows a still
 * of it and nothing more. Text, image and gallery posts embed fine, and link
 * posts are left alone — a post linking to YouTube should get YouTube's embed,
 * not a re-encoded copy.
 */
async function handleRedditLinks(message) {
  const urls = new Map();
  for (const [, id] of message.content.matchAll(POST_REGEX)) {
    urls.set(id.toLowerCase(), `https://www.reddit.com/comments/${id}`);
  }
  for (const [, id] of message.content.matchAll(SHORT_REGEX)) {
    urls.set(id.toLowerCase(), `https://www.reddit.com/comments/${id}`);
  }
  for (const [url] of message.content.matchAll(REDIRECT_REGEX)) {
    urls.set(url, url);
  }
  if (urls.size === 0) return;

  console.log(`[Reddit] Detected ${urls.size} Reddit link(s) in message from ${message.author.username}`);

  await mirrorLinks(message, {
    tag: 'Reddit',
    urls: [...urls.values()],
    labels: { video: '🎬 Reddit video', photo: '📸 Reddit photo' },
    download: downloadVideo,
  });
}

/**
 * Follow a share or v.redd.it link to the post it belongs to.
 *
 * Reddit answers these with "403 Blocked" unless the request carries the
 * session cookies its own pages hand out, so fetch a page first to get them —
 * the same step yt-dlp's Reddit extractor takes before calling the API.
 * Returns null when the link doesn't lead to a post.
 */
async function resolvePostUrl(url) {
  const session = await fetch(
    'https://www.reddit.com/svc/shreddit/r/popular?seeker-session=false&render-mode=partial',
    { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) }
  );
  const cookie = session.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

  // v.redd.it → /video/<id> → the post: two hops. A few spare for safety.
  for (let hop = 0; hop < 5; hop++) {
    const post = url.match(/reddit\.com\/(?:(?:r|u|user)\/[\w-]+\/)?comments\/([a-z0-9]+)/i);
    if (post) return `https://www.reddit.com/comments/${post[1]}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Cookie: cookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    const next = res.headers.get('location');
    if (!next) return null;
    url = new URL(next, url).href;
  }
  return null;
}

async function downloadVideo(url, dlDir) {
  if (!/\/comments\//.test(url)) {
    try {
      url = await resolvePostUrl(url);
    } catch (err) {
      console.error('[Reddit] Could not resolve link:', err.message);
      url = null;
    }
    // Deleted posts, and share links to comments or subreddits.
    if (!url) return null;
  }

  const args = [
    '--no-warnings',
    // Reddit's own extractor only. Without this, a link post hands off to
    // whatever it links to and we'd download the YouTube video or news page.
    '--use-extractors', 'reddit',
    // Reddit video is DASH with audio separate; some clips have no audio
    // track at all, hence the video-only fallback.
    '-f', 'bv*+ba/b/bv*',
    '--merge-output-format', 'mp4',
    '-o', path.join(dlDir, '%(id)s.%(ext)s'),
  ];
  const haveCookies = fs.existsSync(COOKIES_FILE);
  if (haveCookies) args.push('--cookies', COOKIES_FILE);
  args.push(url);

  try {
    await execFile('yt-dlp', args, { timeout: 90000 });
    loginNoticeAt = 0;
    return '❌ Nothing was downloaded from that Reddit link.';
  } catch (err) {
    const detail = String(err.stderr || err.message);
    // Text posts ("No media found") and link, image and gallery posts (handed
    // off to an extractor we disabled). Most Reddit links; stay quiet.
    if (/No media found|No suitable extractor/i.test(detail)) return null;
    console.error('[Reddit] yt-dlp failed:', detail.trim().split('\n').pop());
    // Reddit refused the post data for want of a login. That happens before
    // yt-dlp can tell a video from a text post, so a reply here would land on
    // every Reddit link. Stay quiet in the channel and tell the owner instead.
    // With a login loaded, yt-dlp words it as the IP being unable to access the
    // API; an expired login is the likely cause of that.
    if (/Account authentication is required|unable to access the Reddit API/i.test(detail)) {
      warnOwnerAboutLogin(haveCookies);
      return null;
    }
    return '❌ Reddit download failed — the post may be private, removed, or yt-dlp needs updating.';
  }
}

function warnOwnerAboutLogin(haveCookies) {
  if (Date.now() - loginNoticeAt < LOGIN_NOTICE_MS) return;
  loginNoticeAt = Date.now();
  const file = `\`${path.basename(COOKIES_FILE)}\``;
  notifyOwner(haveCookies
    ? `🔑 Reddit videos aren't downloading even with ${file} — the Reddit login in it has probably expired. ` +
      'Export cookies again from a browser logged in to Reddit and replace the file in the bot folder.'
    : '🔑 Reddit videos aren\'t downloading: Reddit now only gives post data to logged-in accounts. ' +
      `Export cookies from a browser logged in to Reddit and save them as ${file} in the bot folder.`);
}

module.exports = { handleRedditLinks };
