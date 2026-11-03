'use strict';
/**
 * Whispers read aloud: somebody who DMs Sheogorath has it posted to the hall's
 * `dmRelay.channel`, with a line from him mocking them for it.
 *
 * Only members of a guild that sets `dmRelay` are heard; a stranger who shares
 * no such guild is ignored. The bot's owner is never relayed, because error
 * notices go to them by DM and their replies are not for the hall.
 *
 * The sender is told, in character, that the hall has heard it. Nobody should
 * find out from somebody else that their private message went public.
 *
 * Text only. An attachment is mentioned, never reposted: whatever somebody
 * sends a bot privately is not always fit for a channel. Nobody is pinged, and
 * one person gets one relay a minute, so a flood of DMs is not a flood in the
 * channel.
 */
const { getGuildConfig, guildIds } = require('../config/guilds');
const { getAIResponse } = require('../ai/grok');
const { conversationalPersona } = require('../ai/persona');
const { scrub } = require('../ai/actions');

const COOLDOWN_MS = 60 * 1000;
const lastRelay = new Map(); // userId -> ms

/** The first configured guild this person is a member of, with its relay settings. */
async function hallFor(client, userId) {
  for (const guildId of guildIds()) {
    const cfg = getGuildConfig(guildId)?.dmRelay;
    const guild = cfg?.channel && client.guilds.cache.get(guildId);
    if (!guild) continue;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) return { guild, cfg, member };
  }
  return null;
}

async function mockery(name, text, hadFile) {
  const said = text ? `"${text.slice(0, 500)}"` : 'nothing in words';
  const prompt = `${name} sent you a private message, thinking it was between the two of you. `
    + `They said ${said}${hadFile ? ' and sent a file with it' : ''}. You are reading it out to the whole hall. `
    + 'In one or two short sentences, in character, mock them for it. Playful, never cruel. '
    + 'Use their name as written — no @ mentions, no action tags.';
  const line = await getAIResponse(prompt, { rawSystemPrompt: conversationalPersona(), maxTokens: 120 });
  return scrub(line || '').replace(/[ \t]{2,}/g, ' ').trim() || null;
}

async function handleDirectMessage(message) {
  if (message.guild || message.author.bot) return;
  if (message.author.id === process.env.ADMIN_USER_ID) return;
  const text = (message.content || '').trim();
  const hadFile = message.attachments.size > 0;
  if (!text && !hadFile) return;

  const now = Date.now();
  if (now - (lastRelay.get(message.author.id) || 0) < COOLDOWN_MS) return;

  const hall = await hallFor(message.client, message.author.id);
  if (!hall) return;
  const channel = await message.client.channels.fetch(hall.cfg.channel).catch(() => null);
  if (!channel) {
    console.warn(`[DmRelay] ${hall.guild.id}: channel ${hall.cfg.channel} is unreachable.`);
    return;
  }
  lastRelay.set(message.author.id, now);

  const name = hall.member.displayName;
  const line = await mockery(name, text, hadFile).catch((err) => {
    console.warn(`[DmRelay] No line for ${name}: ${err?.message || err}`);
    return null;
  });
  const quote = text ? text.slice(0, 1500).split('\n').map((l) => `> ${l}`).join('\n') : '> *(no words)*';
  const file = hadFile ? '\n-# …and a file, which the hall is spared.' : '';
  await channel.send({
    content: `📜 **${name}** whispered to me in private:\n${quote}${file}${line ? `\n\n${line}` : ''}`,
    allowedMentions: { parse: [] },
  });
  await message.reply(`Whispers? In *my* realm? The whole of <#${channel.id}> has heard it now.`).catch(() => {});
  console.log(`[DmRelay] ${hall.guild.id}: read out a DM from ${message.author.tag}.`);
}

module.exports = { handleDirectMessage };
