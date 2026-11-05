'use strict';
/**
 * The playtest's feedback form, in Discord: a button on a post in the testers'
 * #feedback opens the questions as Discord forms, a page at a time (a form
 * holds five), and each page's answers go to a private channel the team reads
 * the moment it is sent, so someone who stops after the first page still
 * counts. Billy wanted the feedback in Discord rather than on a web form; it
 * also means nobody has to sign in anywhere, and the answers sit next to who
 * gave them, for a follow-up.
 *
 * The questions are config (`playtest.feedback.pages`), so the next round's
 * changes are an edit and a restart. A `file` question takes one upload (the
 * host's playstats.txt), which is copied into the answers post: Discord's own
 * link to an upload lapses.
 *
 * Only someone holding the Tester role (or one of the team's `uncounted`
 * roles) gets the form. No custom ID names anything but a page number, which
 * is checked against config.
 */
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, LabelBuilder, TextInputBuilder,
  TextInputStyle, StringSelectMenuBuilder, FileUploadBuilder, AttachmentBuilder,
} = require('discord.js');
const { getGuildConfig } = require('../config/guilds');

const PREFIX = 'feedback:';
const START = `${PREFIX}start`;
const PAGE = `${PREFIX}page:`;   // + n: the button that opens page n
const FORM = `${PREFIX}form:`;   // + n: page n's form
const TEAL = 0x3fbfb0;
const FILE_MAX = 512 * 1024;     // bytes: play stats are a few lines
const KEEP_MS = 3 * 60 * 60 * 1000;

const isFeedbackInteraction = (interaction) =>
  typeof interaction.customId === 'string' && interaction.customId.startsWith(PREFIX);
const configFor = (guildId) => {
  const playtest = getGuildConfig(guildId)?.playtest;
  return playtest?.feedback ? { playtest, fb: playtest.feedback } : null;
};
const mayAnswer = (member, playtest) =>
  member.roles.cache.has(playtest.role) || playtest.uncounted.some((id) => member.roles.cache.has(id));

/** The post in #feedback: what it is, and the button. Posted by scripts/post-feedback.js. */
function buildFeedbackPost(guildId) {
  const c = configFor(guildId);
  if (!c) return null;
  const n = c.fb.pages.length;
  const embed = new EmbedBuilder()
    .setColor(TEAL)
    .setTitle(`📝 ${c.fb.title}`)
    .setDescription(
      `${c.fb.intro}\n\n` +
      `Press **Give feedback** once you've played: ${n === 1 ? 'one page' : `${n} short pages`}, about three minutes. ` +
      'Only the developers see your answers. Hosts, the last page takes your playstats.txt ' +
      '(Settings, Open logs folder): a few lines on how far you got, nothing else.\n\n' +
      'Talk about the game here as much as you like, too.'
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(START).setLabel('Give feedback').setEmoji('📝').setStyle(ButtonStyle.Success)
  );
  return { embeds: [embed], components: [row] };
}

/** Page n as a Discord form; without `files`, its upload questions are left out. */
function pageForm(fb, n, files = true) {
  const pages = fb.pages.length;
  const modal = new ModalBuilder()
    .setCustomId(`${FORM}${n}`)
    .setTitle(pages > 1 ? `${fb.title} (${n + 1} of ${pages})`.slice(0, 45) : fb.title.slice(0, 45));
  for (const q of fb.pages[n]) {
    if (q.type === 'file' && !files) continue;
    const label = new LabelBuilder().setLabel(q.label);
    if (q.description) label.setDescription(q.description);
    if (q.type === 'choice' || q.type === 'multi') {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(q.id)
        .setRequired(q.required)
        .setMinValues(q.required ? 1 : 0)
        .setMaxValues(q.type === 'multi' ? q.options.length : 1)
        .addOptions(q.options.map((o) => ({ label: o, value: o })));
      if (q.placeholder) menu.setPlaceholder(q.placeholder);
      label.setStringSelectMenuComponent(menu);
    } else if (q.type === 'file') {
      label.setFileUploadComponent(new FileUploadBuilder().setCustomId(q.id).setMinValues(0).setMaxValues(1).setRequired(false));
    } else {
      const input = new TextInputBuilder()
        .setCustomId(q.id)
        .setStyle(q.type === 'long' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(q.required)
        .setMaxLength(q.type === 'long' ? 1000 : 200);
      if (q.placeholder) input.setPlaceholder(q.placeholder);
      label.setTextInputComponent(input);
    }
    modal.addLabelComponents(label);
  }
  return modal;
}

async function handleFeedback(interaction) {
  const c = configFor(interaction.guildId);
  if (!c) {
    await interaction.reply({ content: 'That button is not wired to anything any more.', ephemeral: true });
    return;
  }
  if (!mayAnswer(interaction.member, c.playtest)) {
    await interaction.reply({
      content: `The feedback form is for testers.${c.playtest.post ? ` Join the playtest in <#${c.playtest.post}> first.` : ''}`,
      ephemeral: true,
    });
    return;
  }
  if (interaction.isButton()) await openPage(interaction, c.fb);
  else if (interaction.isModalSubmit()) await takePage(interaction, c.fb);
}

async function openPage(interaction, fb) {
  const n = interaction.customId === START ? 0 : Number(interaction.customId.slice(PAGE.length));
  if (!Number.isInteger(n) || n < 0 || n >= fb.pages.length) {
    await interaction.reply({ content: 'That button is not wired to anything any more.', ephemeral: true });
    return;
  }
  try {
    await interaction.showModal(pageForm(fb, n));
  } catch (err) {
    // A form Discord will not take (an upload question it does not offer here) is refused before it is shown,
    // so the press is still unanswered and the page can go without it.
    if (!fb.pages[n].some((q) => q.type === 'file')) throw err;
    console.warn(`[Feedback] Page ${n + 1} refused with its upload (${err?.message || err}); showing it without.`);
    await interaction.showModal(pageForm(fb, n, false));
  }
}

// Who is part-way through: guild:user -> { first: the first page's post, at }, so later pages reply to it.
const sessions = new Map();

function answerOf(fields, q) {
  try {
    if (q.type === 'choice' || q.type === 'multi') return fields.getStringSelectValues(q.id).join(', ');
    if (q.type === 'file') return fields.getUploadedFiles(q.id)?.first() || null;
    return fields.getTextInputValue(q.id).trim();
  } catch {
    return q.type === 'file' ? null : '';   // (left out of the form, or not answered)
  }
}

async function takePage(interaction, fb) {
  const n = Number(interaction.customId.slice(FORM.length));
  if (!Number.isInteger(n) || n < 0 || n >= fb.pages.length) {
    await interaction.reply({ content: 'That form is not wired to anything any more.', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const pages = fb.pages.length;
  const member = interaction.member;
  const key = `${interaction.guildId}:${member.id}`;
  for (const [k, s] of sessions) if (Date.now() - s.at > KEEP_MS) sessions.delete(k);
  const earlier = n > 0 ? sessions.get(key) : null;

  const embed = new EmbedBuilder()
    .setColor(TEAL)
    .setAuthor({ name: member.displayName, iconURL: member.displayAvatarURL() })
    .setTitle(pages > 1 ? `📝 Feedback, page ${n + 1} of ${pages}` : '📝 Feedback')
    .setDescription(`<@${member.id}> (**${member.user.username}**)`)
    .setFooter({ text: `user ${member.id} · page ${n + 1}/${pages}${earlier ? ` · first ${earlier.first}` : ''}` })
    .setTimestamp(new Date());
  const files = [];
  for (const q of fb.pages[n]) {
    const a = answerOf(interaction.fields, q);
    if (q.type === 'file') {
      if (!a) continue;
      const file = await copyUpload(a);
      embed.addFields({ name: q.label, value: file ? `\`${a.name}\`, attached` : `\`${a.name}\` (too big or unreadable, not kept)` });
      if (file) files.push(new AttachmentBuilder(file, { name: `playstats-${member.user.username}.txt` }));
    } else {
      embed.addFields({ name: q.label, value: a ? a.slice(0, 1024) : '(skipped)' });
    }
  }

  try {
    const channel = await interaction.guild.channels.fetch(fb.answers);
    const posted = await channel.send({
      embeds: [embed], files, allowedMentions: { parse: [] },
      reply: earlier ? { messageReference: earlier.first, failIfNotExists: false } : undefined,
    });
    if (n === 0) sessions.set(key, { first: posted.id, at: Date.now() });
  } catch (err) {
    console.warn(`[Feedback] ${interaction.guild.name}: could not save page ${n + 1} from ${member.user.username}: ${err?.message || err}`);
    await interaction.editReply('That did not save, sorry. Try again in a minute, or tell a developer.');
    return;
  }

  if (n + 1 < pages) {
    await interaction.editReply({
      content: `Thanks, page ${n + 1} is saved. ${fb.pages[n + 1].length > 1 ? 'One more page' : 'One more question'}` +
        `${n + 2 < pages ? ` of ${pages - n - 1}` : ''}: ${fb.next?.[n] || 'press below when you are ready.'}`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PAGE}${n + 1}`).setLabel(`Page ${n + 2} of ${pages}`).setStyle(ButtonStyle.Primary)
      )],
    });
  } else {
    sessions.delete(key);
    await interaction.editReply(
      'Thank you, that is all of it. Only the developers read these.' +
      (fb.bugs ? ` If something broke, a post in <#${fb.bugs}> helps us fix it, one post per bug.` : '')
    );
  }
}

/** The upload's bytes, if it is a small text file, so the answers post keeps its own copy. */
async function copyUpload(attachment) {
  try {
    if (attachment.size > FILE_MAX) return null;
    const res = await fetch(attachment.url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length <= FILE_MAX ? bytes : null;
  } catch {
    return null;
  }
}

module.exports = { isFeedbackInteraction, handleFeedback, buildFeedbackPost, pageForm };
