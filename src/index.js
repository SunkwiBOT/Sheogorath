'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');

// Single-instance lock — exit immediately if another process holds the lock
const LOCK_FILE = path.join(__dirname, '..', 'sheogorath.lock');
try {
  const existing = fs.existsSync(LOCK_FILE) && parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
  if (existing) {
    try { process.kill(existing, 0); } catch { fs.unlinkSync(LOCK_FILE); /* stale lock */ }
    if (fs.existsSync(LOCK_FILE)) {
      console.error(`[Lock] Another instance is already running (PID ${existing}). Exiting.`);
      process.exit(1);
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
} catch (e) {
  console.error('[Lock] Could not acquire lock:', e.message);
  process.exit(1);
}
process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE); } catch {} });
process.on('SIGTERM', () => process.exit(0));
const { Client, GatewayIntentBits, Events, Partials, MessageReferenceType } = require('discord.js');
const { getVoiceConnection } = require('@discordjs/voice');
const { setUserActivity } = require('./storage/state');
const { handleInstagramLinks } = require('./services/instagram');
const { handleTwitterLinks } = require('./services/twitter');
const { handleTikTokLinks } = require('./services/tiktok');
const { handleRedditLinks } = require('./services/reddit');
const { handleClipMessage } = require('./services/clips');
const { stopPlaying } = require('./music/player');
const { isApprovalButton, handleApprovalButton } = require('./ai/approvals');
const { setNotifier: setBudgetNotifier, status: budgetStatus } = require('./ai/budget');
const { isParlour } = require('./services/parlour');
const { checkCooldown, setCooldown } = require('./utils/cooldowns');
const { setClient, notifyError, notifyOwner } = require('./utils/errorNotify');
const { isSexualizedTextImage } = require('./services/textImageMod');
const { trackCommand } = require('./commands/stats');
const { onGuildMemberAdd, onGuildMemberUpdate } = require('./services/autorole');
const { isSelfRoleButton, handleButton: handleSelfRoleButton } = require('./services/selfroles');
const { isPlaytestButton, handleButton: handlePlaytestButton, watchBuildNotices } = require('./services/playtest');
const { watchOwnPosts } = require('./services/autopublish');
const { scheduleStreamWatch } = require('./services/twitch');
const { scheduleVideoWatch } = require('./services/youtube');
const { scheduleUfcEvents } = require('./services/ufc');
const { scheduleGameNews } = require('./services/gameNews');
const { scheduleWardogsGold } = require('./services/wardogsGold');
const { scheduleWardogsPlayers } = require('./services/wardogsPlayers');
const { schedulePresserWatch } = require('./services/ufcPresser');
const { schedulePickem, isPickemButton, handleButton: handlePickemButton } = require('./services/pickem');
const { scheduleUfcResults } = require('./services/ufcResults');
const { scheduleUfcReminders } = require('./services/ufcReminders');
const { scheduleEvents } = require('./services/events');
const { scheduleLedger, isLedgerButton, handleButton: handleLedgerButton } = require('./services/ledger');
const { onVoiceStateUpdate: onVoiceRoomUpdate, sweepOrphans } = require('./services/voicerooms');
const { onVoiceStateUpdate: onVoiceLogUpdate, startVoiceLog } = require('./services/voiceLog');
const { startControlApi } = require('./api/server');
const { getGuildConfig, guildIds, hasFeature, channelId, aiOffLimits } = require('./config/guilds');
const {
  musicDenialReason,
  commandDenialReason,
  commandsForGuild,
  isAdmin,
} = require('./utils/permissions');
const { logCommand, setClient: setAuditClient } = require('./utils/auditLog');
const { setClient: setAiAuditClient } = require('./utils/aiAudit');
const { watchDeletions } = require('./services/deletions');
const { handleDirectMessage } = require('./services/dmRelay');
const { askChatGPT } = require('./chat/discord');
const { trimHistories } = require('./chat/respond');

// Commands that send the model something from the channel they are used in.
const AI_COMMANDS = new Set(['ai', 'ask', 'imagine', 'fact-check', 'settledebate']);

let lastInteractionTime = Date.now();
// Per-user timers for the help channel — see queueHelpReply().
const helpTimers = new Map();

/**
 * How long to wait for someone to finish talking in #help before answering.
 *
 * People ask for help across three messages — "hey", "quick question", then the
 * actual question — and answering each one separately is both noise and a reply
 * to the wrong text. Every message resets the timer and its content is kept, so
 * he answers the whole thought once.
 */
const HELP_DEBOUNCE_MS = 4000;

/**
 * Answers in #help get more room than banter does. A troubleshooting reply is
 * steps, not a one-liner, and the persona keeps him brief enough that this is a
 * ceiling he rarely reaches rather than an invitation to ramble.
 */
const HELP_MAX_TOKENS = 800;

const requiredEnv = [
  'GROK_API_KEY',
  'CLIENT_NAME',
  'CLIENT_INSTRUCTIONS',
  'CLIENT_MODEL',
  'DISCORD_TOKEN',
  'GUILD_ID',
];

const missingEnv = requiredEnv.filter((envVar) => !process.env[envVar]);

if (missingEnv.length > 0) {
  console.error(
    `Missing required environment variables: ${missingEnv.join(', ')}`
  );
  process.exit(1);
}


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
  // DM channels arrive uncached; without this their messages never fire.
  partials: [Partials.Channel],
});

client.commands = new Map();

// Export client for other modules
module.exports = { client };


// Dynamically load commands from src/commands
const commandFiles = fs.readdirSync('./src/commands').filter((file) => file.endsWith('.js'));
const commandDataArray = [];
for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  if (command && command.data && command.data.name) {
    client.commands.set(command.data.name, command);
    commandDataArray.push(command.data.toJSON ? command.data.toJSON() : command.data);
  }
}


client.once(Events.ClientReady, async () => {
  setClient(client); // Enable error notifications
  setAuditClient(client); // Enable the command-log channel mirror
  setAiAuditClient(client); // Enable the AI action trail's staff-channel mirror

  // Start watching what gets deleted. Has to be armed at startup rather than
  // lazily on the first question about it: by the time somebody asks what was
  // removed, the only record is the one we were already keeping.
  watchDeletions(client);
  watchBuildNotices(client);
  watchOwnPosts(client);

  // Spend warnings go to the owner by DM, and nowhere else. The budget is one
  // ceiling over one API key, and only the owner can raise it; a server's own
  // channels are no place for the bot's bills.
  setBudgetNotifier((message) => notifyOwner(message));
  {
    const b = budgetStatus();
    console.log(`[Budget] ${b.month}: $${b.spentUsd.toFixed(4)} of $${b.limitUsd.toFixed(2)} spent over ${b.calls} call(s).`);
  }

  // Control API for the companion app. Started after ready so it never reports
  // healthy before the client can actually act on a request. Failure here must
  // not take the bot down, so it's isolated.
  try {
    startControlApi(client);
  } catch (err) {
    console.error('[API] Failed to start control API:', err?.message || err);
  }

  // Register per-guild rather than globally: propagation is instant, and the
  // commands stay out of any guild the bot happens to be in but isn't
  // configured for. One guild failing must not stop the others registering.
  for (const guildId of guildIds()) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      console.error(`[Commands] Configured guild ${guildId} not found — is the bot a member?`);
      continue;
    }
    try {
      const commands = commandsForGuild(commandDataArray, guildId);
      await guild.commands.set(commands);
      console.log(`[Commands] Registered ${commands.length} command(s) in ${guild.name}.`);
    } catch (error) {
      console.error(`[Commands] Error registering in ${guild.name}:`, error);
    }
  }

  // Who was in voice: log what changed while we were down, then follow it live.
  startVoiceLog(client).catch(err =>
    console.error('[VoiceLog] Startup failed:', err?.message || err));

  // Clear away voice rooms that emptied while we were down.
  try {
    sweepOrphans(client).catch(err =>
      console.error('[VoiceRooms] Startup sweep failed:', err?.message || err));
  } catch (err) {
    console.error('[VoiceRooms] Startup sweep failed:', err?.message || err);
  }

  // Announce new uploads. Isolated like the rest — a feed being unreachable
  // must not stop the bot booting.
  try {
    scheduleVideoWatch(client);
  } catch (err) {
    console.error('[YouTube] Failed to schedule video watch:', err?.message || err);
  }

  // Game news, rare sales and hand-listed game dates for #game-updates.
  try {
    scheduleGameNews(client);
  } catch (err) {
    console.error('[GameNews] Failed to schedule game news:', err?.message || err);
  }

  // The WARDOGS gold bar price, posted each day it moves.
  try {
    scheduleWardogsGold(client);
  } catch (err) {
    console.error('[WardogsGold] Failed to schedule the gold price:', err?.message || err);
  }

  // The WARDOGS player count, read from Steam every ten minutes for /players.
  try {
    scheduleWardogsPlayers();
  } catch (err) {
    console.error('[WardogsPlayers] Failed to schedule the player count:', err?.message || err);
  }

  // Weekly UFC card events. Same isolation: ESPN being down is not a boot failure.
  try {
    scheduleUfcEvents(client);
  } catch (err) {
    console.error('[UFC] Failed to schedule card events:', err?.message || err);
  }

  // Say when the post-fight press conference goes live. Fight nights only.
  try {
    schedulePresserWatch(client);
  } catch (err) {
    console.error('[UFC] Failed to schedule presser watch:', err?.message || err);
  }

  // UFC pick'em: open each card in fight week, score it from ESPN's results.
  try {
    schedulePickem(client);
  } catch (err) {
    console.error("[Pickem] Failed to schedule pick'em:", err?.message || err);
  }

  // Every UFC result as the fight ends, Contender Series included, in a channel of its own.
  try {
    scheduleUfcResults(client);
  } catch (err) {
    console.error('[UFC] Failed to schedule results:', err?.message || err);
  }

  // A DM to the UFC role before each card starts.
  try {
    scheduleUfcReminders(client);
  } catch (err) {
    console.error('[UFC] Failed to schedule reminders:', err?.message || err);
  }

  // The nudge before each scheduled event: its interested people, pinged.
  try {
    scheduleEvents(client);
  } catch (err) {
    console.error('[Events] Failed to schedule reminders:', err?.message || err);
  }

  // The Ledger: offers lapse, settle-by dates are chased, UFC bets settle.
  try {
    scheduleLedger(client);
  } catch (err) {
    console.error('[Ledger] Failed to schedule:', err?.message || err);
  }

  // Announce the house streamers going live. Isolated like the rest — Twitch
  // being down or a credential being wrong must not stop the bot booting.
  try {
    scheduleStreamWatch(client);
  } catch (err) {
    console.error('[Twitch] Failed to schedule stream watch:', err?.message || err);
  }

  // Clean up old temp files on startup (older than 1 hour)
  try {
    const tempDir = path.join(__dirname, '..', 'temp');
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir);
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      let cleaned = 0;
      for (const file of files) {
        const filePath = path.join(tempDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < oneHourAgo) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      }
      if (cleaned > 0) console.log(`[Cleanup] Removed ${cleaned} old temp file(s)`);
    }
  } catch (err) {
    console.error('[Cleanup] Failed to clean temp directory:', err.message);
  }

  // Memory monitoring - log every 30 minutes, clear old history if high
  setInterval(() => {
    const mem = process.memoryUsage();
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
    console.log(`[Memory] ${heapUsedMB}MB / ${heapTotalMB}MB`);
    
    // If using >400MB, aggressively clear old conversation history
    if (heapUsedMB > 400) {
      const cleared = trimHistories(10);
      if (cleared > 0) {
        console.log(`[Memory] High usage detected, cleared history for ${cleared} users`);
      }
    }
  }, 30 * 60 * 1000); // 30 minutes

});


client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  // Discord's own notices (a pin, a join, a boost) are authored by whoever
  // caused them, and a pin notice references the pinned message, so pinning one
  // of his read as a reply to him: a billed call, then an answer Discord
  // refuses, because nothing may reply to a system message.
  if (message.system) return;
  lastInteractionTime = Date.now();

  // A DM is read out to the hall (services/dmRelay.js), and that is all.
  if (!message.guildId) {
    await handleDirectMessage(message).catch((err) =>
      console.error('[DmRelay] Failed:', err?.message || err));
    return;
  }

  // Everything below is guild-scoped. Guilds absent from config/guilds.json
  // are ignored outright rather than half-handled.
  const guildId = message.guildId;
  const config = getGuildConfig(guildId);
  if (!config) return;

  // --- Text-image moderation (ASCII/Unicode sexualized art) ---
  if (hasFeature(guildId, 'textImageMod') && await isSexualizedTextImage(message.content)) {
    console.log(`[TextImageMod] Flagged message from ${message.author.username}: ${message.content.slice(0, 80)}`);
    try {
      await message.delete();
      const warn = await message.channel.send(
        `🔞 <@${message.author.id}> — text-based explicit images aren't allowed here. ` +
        `The Mad King sees all, mortal. Consider this a warning.`
      );
      // Auto-delete the warning after 10 seconds
      setTimeout(() => warn.delete().catch(() => {}), 10_000);
    } catch (err) {
      console.error('[TextImageMod] Failed to delete or warn:', err.message);
    }
    return;
  }

  // Track last chat time for this user
  setUserActivity(guildId, message.author.id, { lastChat: new Date().toISOString() });

  // Instagram video downloader
  if (hasFeature(guildId, 'instagram')) {
    await handleInstagramLinks(message);
  }

  // X/Twitter video downloader
  if (hasFeature(guildId, 'twitter')) {
    await handleTwitterLinks(message);
  }

  // TikTok video downloader
  if (hasFeature(guildId, 'tiktok')) {
    await handleTikTokLinks(message);
  }

  // Reddit video downloader
  if (hasFeature(guildId, 'reddit')) {
    await handleRedditLinks(message);
  }

  // A clip in the clips channel: he narrates it. Not awaited — it takes a
  // minute, and he should still answer the room while he watches.
  handleClipMessage(message);

  if (!hasFeature(guildId, 'ai')) return;

  // A room whose talk must not reach the model (`ai.offLimits`): he does not
  // read it, so naming him there wakes nothing.
  if (aiOffLimits(guildId, message.channel)) return;

  // Answering him counts as addressing him.
  //
  // Every trigger below reads the TEXT of the message, and a Discord reply
  // carries its target in `reference` rather than in what was typed — so
  // replying to something he said and asking "why?" woke nobody, and the
  // conversation died on his own last word. Nobody types a name at somebody
  // they are already looking at.
  if (await isReplyToMe(message)) {
    console.log(`Reply to me in channel ${message.channelId} by ${message.author.username}: ${message.content}`);
    clearPendingHelp(message);
    askChatGPT(message);
    return;
  }

  if (
    message.content.includes(`<@!${client.user.id}>`) ||
    message.content.includes(`<@${client.user.id}>`) ||
    message.content.toLowerCase().includes('@sheogorath') ||
    message.content.toLowerCase().includes('@sherogorath')
  ) {
    console.log(`Mention detected in channel ${message.channelId} by ${message.author.username}: ${message.content}`);
    clearPendingHelp(message);
    askChatGPT(message);
    return; // Prevent conversational triggers from also firing
  }

  // Conversational triggers - any channel, whole-word matches only.
  // Skip if the message already contains a direct bot mention (handled above)
  const isMention = message.content.includes(`<@!${client.user.id}>`) ||
                    message.content.includes(`<@${client.user.id}>`);
  if (!isMention) {
    const content = message.content.toLowerCase();
    // The names he actually answers to. "mad god" and "uncle sheo" are what the
    // persona calls itself throughout CLIENT_INSTRUCTIONS, so leaving them out
    // meant the two names he uses most for himself were the two that did not
    // wake him. "mad king" stays because the server says it out of habit.
    //
    // Bare "sheo" is the short form people actually type, and it is the loosest
    // entry here — every match is a billed call, so it is the first thing to cut
    // if the channel starts waking him by accident. Word boundaries keep it off
    // "sheogorath" itself, which the first alternative already covers.
    const triggerPattern = /\b(sheogorath|sheo|mad king|mad god|uncle sheo)\b/i;
    
    if (triggerPattern.test(content)) {
      clearPendingHelp(message);
      askChatGPT(message);
      return;
    }
  }

  // The help channel is the one place he doesn't wait to be called. Somebody
  // asking a question there has already said what they want; making them say
  // his name as well is a step that only exists because of how the bot is
  // built. Reached last so a direct mention or a "Sheogorath" above still
  // answers straight away rather than sitting through the debounce.
  if (message.channelId === channelId(guildId, 'help')) {
    if (await isAnsweringSomebodyElse(message)) return;
    queueHelpReply(message);
    return;
  }

  // His own hall. Answered without being called, and without the help
  // channel's debounce — someone talking to him here is having a conversation,
  // and holding each line for four seconds to see if they'll add another makes
  // it feel like talking to a form.
  if (isParlour(guildId, message.channelId)) {
    askChatGPT(message);
  }
});

/**
 * Whether a #help message is one person answering another, rather than asking.
 *
 * WHY THIS EXISTS
 * help is the one channel he speaks in uninvited, and that rule was written for
 * the person with the problem. It caught everybody: a regular who steps in to
 * say "verify your files" got answered too, which is noise at best and talking
 * over somebody at worst. The channel works better when the people helping are
 * left alone to help.
 *
 * WHY THESE TWO SIGNALS AND NOT THE MODEL
 * Both are structural facts about the message rather than readings of its text.
 * Asking the model "is this person helping?" would be a judgement call made on
 * input written by the person being judged, it would cost a call on every line
 * in the channel, and it would be wrong often enough to be worse than silence.
 * A Discord reply and an @ are things somebody DID, not things they claimed.
 *
 * A REPLY TO SHEOGORATH IS STILL A QUESTION FOR HIM. Replying to his own
 * message is how a follow-up looks, so that case falls through and is answered.
 * An unresolvable reference is treated as a reply to a person: staying quiet
 * when we cannot tell is the recoverable mistake, since the asker can still say
 * his name, while answering over a helper cannot be taken back.
 */
async function isAnsweringSomebodyElse(message) {
  if (message.reference?.messageId) {
    let target = null;
    try {
      target = await message.fetchReference();
    } catch {
      // Deleted, too old to fetch, or a cross-post. Assume it was a person.
      return true;
    }
    if (target?.author?.id && target.author.id !== client.user.id) return true;
  }

  // Addressing another member by name is the same act as replying to them.
  // His own mention is excluded because that is the one case that means the
  // message is FOR him, and the mention branch above has already handled it.
  const others = message.mentions?.users?.filter?.(
    (u) => u.id !== client.user.id && u.id !== message.author.id,
  );
  if (others?.size > 0) return true;

  return false;
}

/**
 * Answer someone in #help once they've stopped typing.
 *
 * Keyed per person, so two people asking at once get two answers rather than
 * one merged into the other. The reply is attached to their latest message —
 * that's where the conversation is — but carries everything they said in the
 * burst, so the "hey / are you there / my game won't launch" pattern is
 * answered on the last part instead of the first.
 */
function queueHelpReply(message) {
  // He can see screenshots now, so one with no words is a question too — the
  // error dialog is usually the whole of it. A message with neither words nor
  // anything attached is still nothing to answer.
  if (!message.content.trim() && !message.attachments?.size) return;

  const key = `${message.channelId}:${message.author.id}`;
  const pending = helpTimers.get(key);
  if (pending) clearTimeout(pending.timer);

  const lines = [...(pending?.lines || []), message.content].filter(Boolean);
  // Every message of the burst, so a screenshot sent before the words that
  // explain it is still looked at.
  const burst = [...(pending?.burst || []), message];
  const timer = setTimeout(() => {
    helpTimers.delete(key);
    askChatGPT(message, { contentOverride: lines.join('\n'), maxTokens: HELP_MAX_TOKENS, imageSources: burst });
  }, HELP_DEBOUNCE_MS);

  helpTimers.set(key, { timer, lines, burst });
}

/**
 * Drop a queued help reply because something more direct took over.
 *
 * Without this, saying his name partway through a burst in #help gets two
 * answers: the immediate one, and the debounced one still counting down.
 */
function clearPendingHelp(message) {
  const key = `${message.channelId}:${message.author.id}`;
  const pending = helpTimers.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  helpTimers.delete(key);
}

client.on(Events.GuildMemberAdd, async (member) => {
  await onGuildMemberAdd(member).catch(err =>
    console.error('[AutoRole] Join handling failed:', err?.message || err));
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  await onGuildMemberUpdate(oldMember, newMember).catch(err =>
    console.error('[AutoRole] Update handling failed:', err?.message || err));
});

client.on(Events.InteractionCreate, async (interaction) => {
  lastInteractionTime = Date.now();

  try {
    // Handle button interactions for music controls
    if (interaction.isButton()) {
      // Sheogorath's Approve/Deny cards are routed first and return early.
      // They carry their own Sheriff check, and the music gate below would
      // refuse them out of hand — every button under it is a music control.
      if (isApprovalButton(interaction)) {
        await handleApprovalButton(interaction);
        return;
      }

      // Self-assign buttons are routed here for the same reason the approval
      // cards are: everything past this point is a music control behind a
      // music gate, which would refuse them.
      if (isSelfRoleButton(interaction)) {
        await handleSelfRoleButton(interaction);
        return;
      }

      // The playtest agreement: open to everyone, like the self-assign buttons.
      if (isPlaytestButton(interaction)) {
        await handlePlaytestButton(interaction);
        return;
      }

      // Pick'em buttons, likewise: open to everyone, so they must not reach
      // the music gate.
      if (isPickemButton(interaction)) {
        await handlePickemButton(interaction);
        return;
      }

      // The Ledger's bet cards: open to everyone, with the rules in the service.
      if (isLedgerButton(interaction)) {
        await handleLedgerButton(interaction);
        return;
      }

      const { pausePlayer, resumePlayer, skipSong, stopPlayer } = require('./music/player');
      const { removeTrackFromRadio } = require('./commands/radio');
      const guildId = interaction.guild.id;

      // The now-playing card is visible to everyone, so its buttons need the
      // same gate as the commands rather than trusting who can see them.
      const denied = musicDenialReason(guildId, interaction.member);
      if (denied) {
        await interaction.reply({ content: denied, ephemeral: true });
        return;
      }

      switch (interaction.customId) {
        case 'music_pause':
          const player = require('./music/player').players.get(guildId);
          if (player) {
            if (player.state.status === 'playing') {
              pausePlayer(guildId);
              await interaction.reply({ content: '⏸️ Paused', ephemeral: true });
            } else {
              resumePlayer(guildId);
              await interaction.reply({ content: '▶️ Resumed', ephemeral: true });
            }
          } else {
            await interaction.reply({ content: '❌ No music playing', ephemeral: true });
          }
          break;

        case 'music_skip':
          await skipSong(guildId);
          await interaction.reply({ content: '⏭️ Skipped', ephemeral: true });
          break;

        case 'music_stop':
          stopPlayer(guildId);
          await interaction.reply({ content: '⏹️ Stopped', ephemeral: true });
          break;

        case 'music_remove':
          // Extract song title from embed
          const embed = interaction.message.embeds[0];
          if (embed && embed.description) {
            const trackTitle = embed.description.split('\n')[0].replace(/\*\*/g, '');
            const removed = removeTrackFromRadio(trackTitle);
            if (removed) {
              await skipSong(guildId);
              await interaction.reply({ content: `🗑️ Removed **${trackTitle}** from radio playlist and skipped`, ephemeral: true });
            } else {
              await interaction.reply({ content: `❌ Could not find **${trackTitle}** in radio playlist`, ephemeral: true });
            }
          } else {
            await interaction.reply({ content: '❌ Could not identify track', ephemeral: true });
          }
          break;
      }
      return;
    }

    // Autocomplete arrives as its own interaction type and must be answered
    // within 3s with respond() — it has no reply()/deferReply(), so it is routed
    // before the chat-command path and skips the denial, cooldown and audit
    // steps below, none of which can express themselves in a picker.
    if (interaction.isAutocomplete()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (command?.autocomplete) {
        try {
          await command.autocomplete(interaction);
        } catch (error) {
          console.error(`Autocomplete for /${interaction.commandName} failed:`, error);
        }
      }
      return;
    }

    // Modal submits arrive as their own interaction type and carry no command
    // name, so they are routed by the namespace on their customId. Like
    // autocomplete above, this skips the denial and cooldown steps — the modal
    // was only reachable through a command that already passed both.
    if (interaction.isModalSubmit()) {
      const [namespace] = interaction.customId.split(':');
      const command = interaction.client.commands.get(namespace);
      if (command?.handleModal) {
        try {
          await command.handleModal(interaction);
        } catch (error) {
          console.error(`Modal ${interaction.customId} failed:`, error);
        }
      }
      return;
    }

    // Slash commands, and commands from a message's Apps menu ("Keep in the
    // Ledger"), which go through the same gate, cooldown and audit.
    if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) return;

    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
      console.error(`No command matching ${interaction.commandName} was found.`);
      return;
    }

    // Privileged commands are mirrored to the guild's log channel; everything
    // is written to logs/commands.jsonl either way.
    const privileged = isAdmin(interaction.member);

    const denied = commandDenialReason(
      interaction.commandName,
      interaction.guildId,
      interaction.member,
      interaction.options?.getSubcommand?.(false) || null,
    );
    if (denied) {
      // Refused attempts are the ones most worth having a record of.
      logCommand(interaction, { status: 'denied', detail: denied, privileged });
      return interaction.reply({ content: denied, flags: 64 });
    }

    // The same rooms are off limits to the commands that hand the model what
    // was said there, or what is asked there.
    if (AI_COMMANDS.has(interaction.commandName) && aiOffLimits(interaction.guildId, interaction.channel)) {
      logCommand(interaction, { status: 'denied', detail: 'ai off limits here', privileged });
      return interaction.reply({ content: 'I do not listen in this channel. Ask me somewhere else.', flags: 64 });
    }

    // Check cooldown
    const cooldown = checkCooldown(interaction.user.id, interaction.commandName);
    if (cooldown) {
      return interaction.reply({
        content: `⏳ Please wait ${cooldown}s before using \`/${interaction.commandName}\` again.`,
        flags: 64
      });
    }

    // Set cooldown
    setCooldown(interaction.user.id, interaction.commandName);

    // Track command usage
    trackCommand(interaction.commandName);

    try {
      await command.execute(interaction);
      logCommand(interaction, { privileged });
    } catch (error) {
      // Logged here, where the arguments are still to hand, then rethrown so
      // the outer handler still owns telling the user.
      logCommand(interaction, {
        status: 'error',
        detail: error?.message || String(error),
        privileged,
      });
      throw error;
    }

  } catch (error) {
    console.error('Interaction error:', error);
    notifyError(`Command /${interaction.commandName} failed for ${interaction.user.username}`, error);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: '❌ An error occurred while processing this interaction. Please try again.',
          flags: 64
        });
      } else {
        await interaction.reply({
          content: '❌ An error occurred while processing this interaction. Please try again.',
          flags: 64
        });
      }
    } catch (followUpError) {
      console.error('Failed to send error response:', followUpError);
    }
  }
});

// Idle check - stop music after 1 hour of inactivity
setInterval(async () => {
  const currentTime = Date.now();
  const oneHour = 60 * 60 * 1000;

  if (currentTime - lastInteractionTime > oneHour) {
    // Active playback counts as activity — people listening to the radio
    // without chatting shouldn't have it killed under them
    const { players } = require('./music/player');
    const anyPlaying = [...players.values()].some(p => p.state.status === 'playing');
    if (anyPlaying) {
      lastInteractionTime = currentTime;
      return;
    }
    // Nothing is playing — nothing to stop, just reset the timer quietly
    const anyPlayers = players.size > 0;
    lastInteractionTime = currentTime;
    if (!anyPlayers) return;

    console.log('Bot has been idle for 1 hour. Stopping all music playback.');

    // Stop music in all guilds
    try {
      client.guilds.cache.forEach(guild => {
        stopPlaying(guild.id);
      });
      console.log('✅ Stopped all music playback due to inactivity.');
    } catch (error) {
      console.error('Error stopping music:', error);
    }

    lastInteractionTime = Date.now();
  }
}, 60 * 1000); // Check every minute

// The voice log. Registered before the voice rooms handler: an empty room is
// deleted the moment its last person leaves, and the log wants its name first.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  try {
    onVoiceLogUpdate(oldState, newState);
  } catch (err) {
    console.error('[VoiceLog] Voice state handling failed:', err?.message || err);
  }
});

// Registered separately from the music handler below rather than folded into
// it: they share an event and nothing else, and a fault in one must not stop
// the other running.
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  await onVoiceRoomUpdate(oldState, newState).catch(err =>
    console.error('[VoiceRooms] Voice state handling failed:', err?.message || err));
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  // Track when a user joins a voice channel (was not in one, now is)
  if (!oldState.channelId && newState.channelId && newState.member && !newState.member.user.bot) {
    setUserActivity(newState.guild.id, newState.member.id, { lastVoiceJoin: new Date().toISOString() });
  }

  const voiceChannel = oldState.channel || newState.channel;

  if (voiceChannel) {
    const botVoiceState = voiceChannel.guild.members.me.voice;

    if (
      botVoiceState &&
      botVoiceState.channelId === voiceChannel.id &&
      voiceChannel.members.size === 1
    ) {
      const connection = getVoiceConnection(voiceChannel.guild.id);
      if (connection) {
        connection.destroy();
        console.log('Bot disconnected due to empty voice channel.');
      } else {
        console.log('No active connection found.');
      }
    }
  }
});

// Entrance announcements disabled.

// Music reaction controls
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (err) {
      console.error('Error fetching reaction:', err);
      return;
    }
  }

  const message = reaction.message;
  if (message.author.id !== client.user.id) return;
  // Check if message has embeds with "Now Playing" title
  const isNowPlaying = message.embeds.length > 0 && 
    (message.embeds[0].title === '🎵 Now Playing' || 
     message.content.startsWith('🎵 Now playing:') || 
     message.content.startsWith('📻 Radio started:'));
  if (!isNowPlaying) return;

  const { pausePlayer, resumePlayer, skipSong } = require('./music/player');
  const { removeTrackFromRadio } = require('./commands/radio');
  const guildId = message.guild.id;

  // Same gate as the buttons — anyone can add a reaction to a visible message.
  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (musicDenialReason(guildId, member)) {
    await reaction.users.remove(user.id).catch(() => {});
    return;
  }

  try {
    switch (reaction.emoji.name) {
      case '⏯️':
        const player = require('./music/player').players.get(guildId);
        if (player) {
          if (player.state.status === 'playing') {
            pausePlayer(guildId);
            await message.channel.send('⏸️ Paused').then(m => setTimeout(() => m.delete().catch(() => {}), 3000));
          } else {
            resumePlayer(guildId);
            await message.channel.send('▶️ Resumed').then(m => setTimeout(() => m.delete().catch(() => {}), 3000));
          }
        }
        break;

      case '⏭️':
        await skipSong(guildId);
        await message.channel.send('⏭️ Skipped').then(m => setTimeout(() => m.delete().catch(() => {}), 3000));
        break;

      case '⏹️':
        const { stopPlayer } = require('./music/player');
        stopPlayer(guildId);
        await message.channel.send('⏹️ Stopped').then(m => setTimeout(() => m.delete().catch(() => {}), 3000));
        break;

      case '🗑️':
        // Extract song title from message (either content or embed description)
        let trackTitle = null;
        const contentMatch = message.content.match(/\*\*(.+?)\*\*/);
        if (contentMatch) {
          trackTitle = contentMatch[1];
        } else if (message.embeds.length > 0) {
          const description = message.embeds[0].description;
          if (description) {
            // Extract first line (title) from embed description
            trackTitle = description.split('\n')[0].replace(/\*\*/g, '');
          }
        }
        
        if (trackTitle) {
          const removed = removeTrackFromRadio(trackTitle);
          if (removed) {
            await message.channel.send(`🗑️ Removed **${trackTitle}** from radio playlist, skipping...`).then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
            // Skip the current song
            await skipSong(guildId);
          } else {
            await message.channel.send(`❌ Could not find **${trackTitle}** in radio playlist`).then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
          }
        }
        break;
    }
  } catch (err) {
    console.error('Error handling music reaction:', err);
  }

  // Remove the user's reaction
  try {
    await reaction.users.remove(user.id);
  } catch (err) {
    console.error('Error removing reaction:', err);
  }
});

/**
 * Is this message a reply to one of his own?
 *
 * Only the reference is trusted: a quoted line can be forged by typing it, and
 * the reference cannot. Costs one cache hit, or one fetch when the target has
 * aged out — and only on messages that are replies at all.
 */
async function isReplyToMe(message) {
  const id = message.reference?.messageId;
  if (!id) return false;
  // A forward carries a reference too, but nobody is talking to him in one.
  if (message.reference.type === MessageReferenceType.Forward) return false;
  try {
    const target =
      message.channel.messages.cache.get(id) ||
      (await message.channel.messages.fetch(id));
    return target?.author?.id === client.user.id;
  } catch {
    // Deleted, or beyond what he may read. Not a reply to him as far as
    // anyone can prove, so he stays quiet rather than guessing.
    return false;
  }
}


// Clean shutdown handler
process.on('SIGINT', () => {
  console.log('Bot is shutting down...');
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
