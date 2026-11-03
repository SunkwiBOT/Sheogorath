'use strict';
const https = require('https');
const { assertWithinBudget, record: recordSpend } = require('./budget');
const { actionDocsFor } = require('./actionDocs');
const { getGuildConfig } = require('../config/guilds');
const { basePersona } = require('./persona');

const GROK_API_URL = 'https://api.x.ai/v1/chat/completions';

/**
 * Persona, then powers, then whatever the caller wants after that.
 *
 * The powers half is built per guild, because it is the half that is not the
 * same everywhere: the same character is a warden in one server and a mascot in
 * another, and a fixed block had him describing the first server's staff, tags
 * and game commands to the second one's members.
 *
 * @param {string} [base] overrides CLIENT_INSTRUCTIONS entirely
 * @param {string} [suffix] appended after the action docs. Used by the parlour
 *   to lift the persona's length cap in one channel without maintaining a
 *   second copy of the whole character.
 * @param {string} [guildId] whose powers to describe. Omitted — a DM, or a
 *   surface with no guild — leaves him the powers that need no configuration.
 */
function buildSystemPrompt(base, suffix = '', guildId = null) {
  return (base || basePersona())
    + actionDocsFor(getGuildConfig(guildId))
    + (suffix || '');
}

/**
 * Every xAI request goes through here, which makes it the one place worth
 * metering. Spend is checked before the call and recorded after it, so a call
 * added later is budgeted without anyone remembering to budget it.
 */
function httpsPost(url, body, headers = {}, timeoutMs = 120000) {
  assertWithinBudget();
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers },
      },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            // xAI reports the amount actually billed on every response. Absent
            // on errors, which is correct — a failed call isn't charged.
            if (parsed?.usage) recordSpend(parsed.usage);
            resolve({ status: res.statusCode, data: parsed });
          } catch { resolve({ status: res.statusCode, data }); }
        });
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function getAIResponse(prompt, { systemPrompt, maxTokens, rawSystemPrompt, guildId = null } = {}) {
  try {
    const response = await httpsPost(
      GROK_API_URL,
      {
        model: 'grok-4.3',
        messages: [
          { role: 'system', content: rawSystemPrompt || buildSystemPrompt(systemPrompt, '', guildId) },
          { role: 'user', content: prompt },
        ],
        max_tokens: maxTokens || 50,
        temperature: 0.7,
      },
      { Authorization: `Bearer ${process.env.GROK_API_KEY}` }
    );
    if (response.status !== 200) throw new Error(`Grok API Error: ${response.status} - ${JSON.stringify(response.data)}`);
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Grok API Error:', error.message);
    if (error.message.includes('timeout')) throw new Error('AI response timed out.');
    throw error;
  }
}

/**
 * Get AI response with conversation history for multi-turn chat.
 *
 * The cap is a truncation ceiling, not a target — how long he actually talks is
 * set by the persona, which tells him to stay short. It used to be 80 tokens,
 * which was below what he was routinely trying to say: replies stopped
 * mid-sentence, and action tags got cut in half on the way out, which is most of
 * why the tag scrubbing has to handle truncated tags at all. Room to finish the
 * thought costs nothing when he doesn't use it.
 *
 * A turn's content may be an array of parts rather than a string, in the chat
 * completions shape — text, and `image_url` for a picture he is being shown.
 *
 * With `search`, the same conversation goes to the Responses API instead, with
 * web search switched on: that is how he traces a picture to where it came
 * from. Same persona, same history, same reply shape; only the endpoint and the
 * part names differ.
 *
 * @param {Array<{role: string, content: string|Array}>} messages - Conversation history
 * @param {number} [maxTokens=500] - Max response tokens
 * @returns {Promise<string>} AI response
 */
async function getAIResponseWithHistory(messages, maxTokens = 500, { systemSuffix = '', systemBase = null, guildId = null, search = false } = {}) {
  const makeRequest = async (msgs, timeout) => {
    if (search) {
      return searchWithHistory(buildSystemPrompt(systemBase, systemSuffix, guildId), msgs, timeout);
    }
    const response = await httpsPost(
      GROK_API_URL,
      {
        model: 'grok-4.3',
        messages: [
          { role: 'system', content: buildSystemPrompt(systemBase, systemSuffix, guildId) },
          ...msgs,
        ],
        max_tokens: maxTokens,
        temperature: 0.7,
      },
      { Authorization: `Bearer ${process.env.GROK_API_KEY}` },
      timeout
    );
    if (response.status !== 200) throw new Error(`Grok API Error: ${response.status} - ${JSON.stringify(response.data)}`);
    return response.data.choices[0].message.content.trim();
  };

  try {
    return await makeRequest(messages, 120000);
  } catch (error) {
    const isTimeout = error.message?.includes('timeout');

    if (isTimeout && messages.length > 1) {
      console.log('Grok timed out with history, retrying with last message only...');
      try {
        return await makeRequest(messages.slice(-1), 120000);
      } catch (retryError) {
        console.error('Grok API retry also failed:', retryError.message);
        throw new Error('AI response timed out after retry.');
      }
    }

    console.error('Grok API Error (history):', error.message);
    throw error;
  }
}

/**
 * Extract a memorable fact from a single user message.
 * Returns a short string to save, or null if nothing notable.
 * @param {string} username - User's display name
 * @param {string} message - The raw user message
 * @returns {Promise<string|null>}
 */
async function extractMemoryFromMessage(username, message) {
  try {
    const response = await httpsPost(
      GROK_API_URL,
      {
        model: 'grok-4.3',
        messages: [
          {
            role: 'system',
            content: 'You extract durable personal facts from chat messages. ' +
              'If the message reveals a personal fact, preference, event, hobby, job, relationship, goal, or opinion about the user, ' +
              'reply with ONE short sentence (max 15 words) stating that fact, written in third-person about "the user". ' +
              'If there is nothing worth remembering, reply with exactly: NONE\n\n' +
              'Only keep what the user is genuinely telling you about themselves and what would ' +
              'still be true and worth knowing weeks from now. Crude or sexual subject matter is ' +
              'not itself a reason to reject a fact — someone stating a real preference counts. ' +
              'But a line that is a move in a bit the room is currently running — a ranking, a ' +
              'dare, a punchline, playing along with a joke premise, a claim about their own body ' +
              'made mid-banter — is not a fact about the person, however sincerely it is phrased. ' +
              'Those read as biography and are replayed back at the user forever, long after the ' +
              'joke is dead. When a line only makes sense as part of the joke around it: NONE'
          },
          { role: 'user', content: `User "${username}" said: ${message}` }
        ],
        max_tokens: 30,
        temperature: 0.3,
      },
      { Authorization: `Bearer ${process.env.GROK_API_KEY}` },
      15000
    );
    if (response.status !== 200) return null;
    const text = response.data.choices[0].message.content.trim();
    if (!text || text.toUpperCase() === 'NONE' || text.toUpperCase().startsWith('NONE')) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * One reply about some pictures, for when he has to look at something.
 *
 * Each image goes in with the caption it was given — for a clip, the second it
 * was taken at — so the model can say *when* something happens, not just what.
 *
 * @param {string} prompt - What to do with them, after the images
 * @param {Array<{caption: string, jpeg: Buffer}>} images
 * @returns {Promise<string>}
 */
async function getAIResponseWithImages(prompt, images, { rawSystemPrompt, maxTokens = 600, temperature = 0.9, model = 'grok-4.3', timeoutMs = 120000 } = {}) {
  const content = [];
  for (const { caption, jpeg } of images) {
    content.push({ type: 'text', text: caption });
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, detail: 'high' } });
  }
  content.push({ type: 'text', text: prompt });

  const response = await httpsPost(
    GROK_API_URL,
    {
      model,
      messages: [
        { role: 'system', content: rawSystemPrompt },
        { role: 'user', content },
      ],
      max_tokens: maxTokens,
      temperature,
    },
    { Authorization: `Bearer ${process.env.GROK_API_KEY}` },
    timeoutMs
  );
  if (response.status !== 200) throw new Error(`Grok API Error: ${response.status} - ${JSON.stringify(response.data).slice(0, 300)}`);
  return response.data.choices[0].message.content.trim();
}

/**
 * One reply that may look things up on the web first, for when a wrong number
 * would be worse than a slow one.
 *
 * Chat completions have no search; xAI's Responses API does, as a server-side
 * tool. Each search is billed on top of the tokens, and the usage block reports
 * both in `cost_in_usd_ticks`, so httpsPost meters it like any other call. The
 * cap covers his reasoning as well as the reply, which is why it is generous.
 *
 * The model cites its sources inline as `[[1]](url)`. Those are dropped: a
 * Discord message full of links unfurls into a wall of previews.
 *
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function getAIResponseWithSearch(prompt, { rawSystemPrompt, maxTokens = 6000 } = {}) {
  const response = await httpsPost(
    'https://api.x.ai/v1/responses',
    {
      model: 'grok-4.3',
      input: [
        { role: 'system', content: rawSystemPrompt },
        { role: 'user', content: prompt },
      ],
      tools: [{ type: 'web_search' }],
      max_output_tokens: maxTokens,
      store: false,
    },
    { Authorization: `Bearer ${process.env.GROK_API_KEY}` },
    180000
  );
  if (response.status !== 200) throw new Error(`Grok API Error: ${response.status} - ${JSON.stringify(response.data).slice(0, 300)}`);
  const text = (response.data.output || [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text)
    .join('\n');
  return text.replace(/\s*\[\[\d+\]\]\([^)\s]*\)/g, '').trim();
}

/** A chat-completions content part, renamed for the Responses API. */
function toResponsesPart(part) {
  if (part.type === 'image_url') {
    return { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail || 'high' };
  }
  return { type: 'input_text', text: part.text };
}

/**
 * A whole conversation through the Responses API with web search on.
 *
 * Kept separate from getAIResponseWithSearch, which answers a lone prompt: this
 * one carries history and pictures, and its cap is raised to the same 6000 for
 * the same reason — reasoning and searching are spent from it before he says a
 * word.
 */
async function searchWithHistory(system, messages, timeoutMs = 180000) {
  const input = [
    { role: 'system', content: system },
    ...messages.map((m) => (
      Array.isArray(m.content) && m.role === 'user'
        ? { role: 'user', content: m.content.map(toResponsesPart) }
        : m
    )),
  ];
  const response = await httpsPost(
    'https://api.x.ai/v1/responses',
    {
      model: 'grok-4.3',
      input,
      tools: [{ type: 'web_search' }],
      max_output_tokens: 6000,
      store: false,
    },
    { Authorization: `Bearer ${process.env.GROK_API_KEY}` },
    Math.max(timeoutMs, 180000),
  );
  if (response.status !== 200) throw new Error(`Grok API Error: ${response.status} - ${JSON.stringify(response.data).slice(0, 300)}`);
  const text = (response.data.output || [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text)
    .join('\n');
  // Inline citations dropped for the same reason as above. The links he chose
  // to write are the point of a lookup, so those stay — wrapped in <> so
  // Discord shows them as links rather than unfurling each into a preview.
  return text
    .replace(/\s*\[\[\d+\]\]\([^)\s]*\)/g, '')
    .replace(/\]\((https?:\/\/[^)\s]+)\)/g, '](<$1>)')
    .replace(/(^|[\s(])(https?:\/\/[^\s<>()]*[^\s<>().,!?;:'"])/g, '$1<$2>')
    .trim();
}

function httpsGetBuffer(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Image download failed: ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/**
 * Generate an image from a text prompt using Grok Imagine.
 * xAI hands back a temporary URL, so the bytes are pulled down here and
 * uploaded to Discord as an attachment rather than hotlinked.
 * @param {string} prompt - Text description of the image
 * @returns {Promise<Buffer>} - PNG bytes of the generated image
 */
async function generateImage(prompt) {
  const response = await httpsPost(
    'https://api.x.ai/v1/images/generations',
    {
      model: 'grok-imagine-image-quality',
      prompt,
      n: 1,
      response_format: 'url',
    },
    { Authorization: `Bearer ${process.env.GROK_API_KEY}` },
    60000
  );
  if (response.status !== 200) {
    throw new Error(`Image generation failed: ${response.status} - ${JSON.stringify(response.data)}`);
  }
  const url = response.data?.data?.[0]?.url;
  if (!url) {
    throw new Error(`Image generation returned no URL: ${JSON.stringify(response.data)}`);
  }
  console.log('[Grok Imagine] Image ready, downloading');
  return await httpsGetBuffer(url);
}

module.exports = { buildSystemPrompt, getAIResponse, getAIResponseWithHistory, getAIResponseWithImages, getAIResponseWithSearch, extractMemoryFromMessage, generateImage };
