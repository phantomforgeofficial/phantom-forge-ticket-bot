import 'dotenv/config';
import http from 'node:http';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  OverwriteType,
  Partials,
  PermissionsBitField,
  REST,
  Routes
} from 'discord.js';

// === ENVIRONMENT VARS ===
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const DEFAULT_SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID ? BigInt(process.env.SUPPORT_ROLE_ID) : null;
const DEFAULT_CATEGORY_ID = process.env.TICKETS_CATEGORY_ID ? BigInt(process.env.TICKETS_CATEGORY_ID) : null;
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID || ''; // e.g. "1429121620194234478"

if (!TOKEN) {
  console.error('❌ Please set DISCORD_TOKEN in your environment variables');
  process.exit(1);
}

// === DISCORD CLIENT ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// Prevent duplicates
const creatingTicketFor = new Set();
const processingInteraction = new Set();

// === HELPERS ===
function topicMetaToObj(topic) {
  const meta = { user: null, claimed_by: null };
  if (!topic) return meta;
  try {
    for (const kv of topic.split(';')) {
      const [k, v] = kv.split(':');
      if (k === 'ticket_user') meta.user = v || null;
      if (k === 'claimed_by') meta.claimed_by = v || null;
    }
  } catch {}
  return meta;
}
function makeTopic(userId, claimedBy) { return `ticket_user:${userId};claimed_by:${claimedBy ?? ''}`; }
function panelFooterText(supportRoleId, categoryId) { return `support_role:${supportRoleId || ''};category:${categoryId || ''}`; }
function parseFooter(embed) {
  const out = { supportRoleId: null, categoryId: null };
  const text = embed?.footer?.text ?? '';
  if (!text) return out;
  try {
    for (const kv of text.split(';')) {
      const [k, v] = kv.split(':');
      if (k === 'support_role' && v) out.supportRoleId = BigInt(v);
      if (k === 'category' && v) out.categoryId = BigInt(v);
    }
  } catch {}
  return out;
}
async function findExistingPanelMessage(channel, supportRoleId, categoryId) {
  const targetFooter = panelFooterText(supportRoleId, categoryId);
  const msgs = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!msgs) return null;
  for (const m of msgs.values()) {
    if (m.author?.id !== channel.client.user.id) continue;
    const emb = m.embeds?.[0];
    if (emb?.footer?.text === targetFooter) return m;
  }
  return null;
}
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
function escapeHtml(str) {
  return (str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function toHexColor(num) {
  if (typeof num !== 'number') return null;
  return '#' + num.toString(16).padStart(6, '0');
}
function formatDate(d) {
  try { return new Date(d).toLocaleString('en-US'); } catch { return new Date(d).toISOString(); }
}

// === SLASH COMMANDS ===
const commands = [
  {
    name: 'panel',
    description: 'Send a ticket panel in this channel',
    options: [
      { name: 'support_role', description: 'Support role that can access tickets', type: 8, required: false },
      { name: 'category', description: 'Category to create ticket channels in', type: 7, channel_types: [4], required: false },
      { name: 'title', description: 'Panel title', type: 3, required: false },
      { name: 'description', description: 'Panel description', type: 3, required: false }
    ]
  },
  { name: 'claim', description: 'Claim this ticket (support only)' },
  {
    name: 'add',
    description: 'Add a user to this ticket',
    options: [{ name: 'user', description: 'User to add', type: 6, required: true }]
  },
  { name: 'close', description: 'Close this ticket' },
  { name: 'uptime', description: 'Show bot uptime and status' }
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    const app = await client.application?.fetch();
    if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(app.id, GUILD_ID), { body: commands });
    else await rest.put(Routes.applicationCommands(app.id), { body: commands });
    console.log('✅ Slash commands synced');
  } catch (e) { console.error('Command sync error:', e); }
}

// === READY ===
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setPresence({ status: 'online', activities: [{ name: 'Phantom Forge Tickets', type: 0 }] });
  await registerCommands();

  // Status-loop (log channel)
  postStatus().catch(() => {});
  setInterval(() => postStatus().catch(() => {}), 10 * 60 * 1000);
});

async function postStatus() {
  if (!STATUS_CHANNEL_ID) return;
  const ch = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) return;
  const active = client.isReady();
  const uptimeStr = formatUptime(client.uptime ?? 0);
  const content = ['Phantom Forge Ticket Bot', `active: ${active ? 'true' : 'false'}`, `uptime: ${uptimeStr}`].join('\n');
  await ch.send({ content }).catch(() => {});
}

// === INTERACTIONS ===
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      if (commandName === 'panel') await handlePanel(interaction);
      if (commandName === 'claim') await handleClaim(interaction);
      if (commandName === 'add') await handleAdd(interaction);
      if (commandName === 'close') await handleClose(interaction);
      if (commandName === 'uptime') await handleUptime(interaction);
    } else if (interaction.isButton()) {
      if (interaction.customId === 'open_ticket_btn') await handleOpenTicket(interaction);
      if (interaction.customId === 'claim_ticket_btn') await handleClaim(interaction);
      if (interaction.customId === 'close_ticket_btn') await handleClose(interaction);
    }
  } catch (e) {
    console.error(e);
    if (!interaction.replied)
      await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
  }
});

// === /uptime ===
async function handleUptime(interaction) {
  const active = client.isReady();
  const uptimeStr = formatUptime(client.uptime ?? 0);
  const embed = new EmbedBuilder()
    .setColor('#8000ff')
    .setTitle('Phantom Forge Ticket Bot')
    .setDescription(`**Active:** ${active ? '✅ true' : '❌ false'}\n**Uptime:** ${uptimeStr}`);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// === PANEL / TICKETS ===
async function handlePanel(interaction) {
  if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild) &&
      !interaction.memberPermissions.has(PermissionsBitField.Flags.ManageChannels))
    return interaction.reply({ content: 'You need Manage Server/Channels to use this.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  const supportRole = interaction.options.getRole('support_role');
  const category = interaction.options.getChannel('category');
  const title = interaction.options.getString('title') ?? 'Phantom Forge Support';
  const description = interaction.options.getString('description') ?? 'Click the button to open a private ticket.';

  const supportRoleId = supportRole?.id ? BigInt(supportRole.id) : DEFAULT_SUPPORT_ROLE_ID;
  const categoryId = category?.id ? BigInt(category.id) : DEFAULT_CATEGORY_ID;

  const embed = new EmbedBuilder()
    .setTitle(title).setDescription(description).setColor('#8000ff')
    .setFooter({ text: panelFooterText(supportRoleId, categoryId) });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open_ticket_btn').setLabel('🎟️ Open Ticket').setStyle(ButtonStyle.Secondary)
  );

  const existingPanel = await findExistingPanelMessage(interaction.channel, supportRoleId, categoryId);
  if (existingPanel) {
    await existingPanel.edit({ embeds: [embed], components: [row] }).catch(() => {});
    await interaction.editReply('Updated existing ticket panel ✅');
  } else {
    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.editReply('Ticket panel posted ✅');
  }
}

async function handleOpenTicket(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ content: 'This can only be used in a server.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  const userId = interaction.user.id;

  if (creatingTicketFor.has(userId)) return interaction.editReply({ content: 'Your ticket is already being created… ⏳' });
  creatingTicketFor.add(userId);

  try {
    const allChannels = await guild.channels.fetch();
    const existing = allChannels.find(
      ch => ch?.type === ChannelType.GuildText && ch.topic && topicMetaToObj(ch.topic).user === String(userId)
    );
    if (existing) return interaction.editReply({ content: `You already have an open ticket: ${existing}` });

    const emb = interaction.message.embeds?.[0];
    const { supportRoleId, categoryId } = parseFooter(emb);

    const baseName = `ticket-${interaction.user.username}`.toLowerCase().replace(/\s+/g, '-').slice(0, 90);

    const overwrites = [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel], type: OverwriteType.Role },
      { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles], type: OverwriteType.Member },
      { id: guild.members.me.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles], type: OverwriteType.Member }
    ];
    if (supportRoleId) {
      overwrites.push({
        id: supportRoleId.toString(),
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles],
        type: OverwriteType.Role
      });
    }

    const channel = await guild.channels.create({
      name: baseName,
      type: ChannelType.GuildText,
      parent: categoryId ? categoryId.toString() : undefined,
      topic: makeTopic(userId, null),
      permissionOverwrites: overwrites
    });

    await interaction.editReply({ content: `✅ Ticket created: ${channel}` });

    const welcomeEmbed = new EmbedBuilder()
      .setColor('#8000ff')
      .setTitle('🎟️ Thanks for opening a ticket!')
      .setDescription('Support will be with you shortly 💜')
      .setFooter({ text: 'Phantom Forge Support' });

    const ticketButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('claim_ticket_btn').setLabel('🟣 Claim Ticket').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('close_ticket_btn').setLabel('🟪 Close Ticket').setStyle(ButtonStyle.Primary)
    );

    const contentParts = [`${interaction.user}`];
    if (supportRoleId) contentParts.push(`<@&${supportRoleId}>`);

    await channel.send({
      content: contentParts.join(' '),
      allowedMentions: { parse: [], users: [userId], roles: supportRoleId ? [supportRoleId.toString()] : [] },
      embeds: [welcomeEmbed],
      components: [ticketButtons]
    });
  } catch (err) {
    console.error('Open ticket error:', err);
    try { await interaction.editReply({ content: 'Something went wrong creating your ticket.' }); } catch {}
  } finally { creatingTicketFor.delete(userId); }
}

async function handleClaim(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;
  if (!guild || channel?.type !== ChannelType.GuildText)
    return interaction.reply({ content: 'Use this inside a ticket channel.', ephemeral: true });

  const meta = topicMetaToObj(channel.topic);
  if (!meta.user) return interaction.reply({ content: 'This channel is not a ticket.', ephemeral: true });

  await channel.setTopic(makeTopic(meta.user, interaction.user.id));
  await interaction.reply({ content: 'Ticket claimed ✅', ephemeral: true });
  await channel.send(`Hello <@${meta.user}> — I am ${interaction.user} from the **Phantom Forge** support team. Happy to help!`);
}

async function handleAdd(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;
  if (!guild || channel?.type !== ChannelType.GuildText)
    return interaction.reply({ content: 'Use this inside a ticket channel.', ephemeral: true });

  const meta = topicMetaToObj(channel.topic);
  if (!meta.user) return interaction.reply({ content: 'This channel is not a ticket.', ephemeral: true });

  const user = interaction.options.getUser('user', true);

  const isOwner = String(interaction.user.id) === meta.user;
  const isSupport =
    interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages) ||
    (DEFAULT_SUPPORT_ROLE_ID && interaction.member.roles.cache.has(DEFAULT_SUPPORT_ROLE_ID.toString()));
  const isAdmin =
    interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
    interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);

  if (!(isOwner || isSupport || isAdmin))
    return interaction.reply({ content: 'You are not allowed to add people to this ticket.', ephemeral: true });

  await channel.permissionOverwrites.edit(user.id, {
    ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true
  });

  await interaction.reply({ content: `${user} has been added to the ticket ✅`, ephemeral: true });
}

// === HTML TRANSCRIPT BUILDER ===
function buildTranscriptHTML({ channelName, closedByTag, closedAt, messages }) {
  const header = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1.0" />
<title>Discord Ticket Transcript - ${escapeHtml(channelName)}</title>
<style>
:root {
  --background-primary: #36393f;
  --background-secondary: #2f3136;
  --background-tertiary: #202225;
  --text-normal: #dcddde;
  --text-muted: #72767d;
  --text-link: #00b0f4;
  --header-primary: #fff;
  --interactive-hover: #dcddde;
  --background-modifier-accent: hsla(0,0%,100%,0.06);
}
*{box-sizing:border-box;margin:0;padding:0}
body{background-color:var(--background-primary);color:var(--text-normal);font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;line-height:1.5}
.container{max-width:1200px;margin:0 auto;padding:20px}
.header{background-color:var(--background-secondary);padding:20px;border-radius:5px 5px 0 0;margin-bottom:20px;box-shadow:0 1px 0 rgba(4,4,5,.2)}
.header h1{color:var(--header-primary);font-size:24px;margin-bottom:10px}
.header-info{display:flex;flex-wrap:wrap;gap:15px;font-size:14px;color:var(--text-muted)}
.header-info strong{color:var(--interactive-hover);margin-right:6px}
.messages-container{background-color:var(--background-primary);border-radius:0 0 5px 5px;padding:0 10px;box-shadow:0 1px 0 rgba(4,4,5,.2)}
.message{padding:15px 10px;border-top:1px solid var(--background-modifier-accent)}
.message:first-child{border-top:none}
.message-header{display:flex;align-items:center;margin-bottom:6px}
.avatar{width:40px;height:40px;border-radius:50%;margin-right:10px}
.user-info{display:flex;flex-direction:column}
.username{color:var(--header-primary);font-weight:600;font-size:16px}
.timestamp{color:var(--text-muted);font-size:12px;margin-top:2px}
.message-content{color:var(--text-normal);font-size:15px;line-height:1.4;white-space:pre-wrap;margin-left:50px}
.attachment{margin-top:8px;margin-left:50px;padding:8px;background-color:var(--background-secondary);border-radius:3px;display:inline-block}
.attachment a{color:var(--text-link);text-decoration:none}
.embed{margin-top:8px;margin-left:50px;padding:8px 12px;background-color:var(--background-secondary);border-radius:4px;max-width:520px;border-left:4px solid #5865f2}
.embed-title{color:var(--header-primary);font-weight:600;font-size:16px;margin-bottom:6px}
.embed-description{color:var(--text-normal);font-size:14px;margin-bottom:6px}
.embed-footer{color:var(--text-muted);font-size:12px;margin-top:6px}
@media (max-width:768px){.container{padding:10px}.header{padding:15px}}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>Ticket Transcript - ${escapeHtml(channelName)}</h1>
    <div class="header-info">
      <div><strong>Channel:</strong> ${escapeHtml(channelName)}</div>
      <div><strong>Closed by:</strong> ${escapeHtml(closedByTag)}</div>
      <div><strong>Date:</strong> ${escapeHtml(closedAt)}</div>
    </div>
  </div>
  <div class="messages-container">
`;

  const items = messages.map((m) => {
    const avatar = m.authorAvatar || '';
    const uname = escapeHtml(m.authorName || 'Unknown');
    const ts = escapeHtml(m.timestamp || '');
    const content = escapeHtml(m.content || '');
    const attachmentsHtml = (m.attachments || []).map(a =>
      `<div class="attachment"><a href="${escapeHtml(a.url)}" target="_blank">${escapeHtml(a.name || 'attachment')}</a></div>`
    ).join('\n');

    const embed = m.embed;
    let embedHtml = '';
    if (embed) {
      const border = embed.colorHex || '#5865f2';
      const title = escapeHtml(embed.title || '');
      const desc = escapeHtml(embed.description || '');
      const footer = escapeHtml(embed.footer || '');
      embedHtml = `<div class="embed" style="border-left: 4px solid ${border}">` +
                  (title ? `<div class="embed-title">${title}</div>` : '') +
                  (desc ? `<div class="embed-description">${desc}</div>` : '') +
                  (footer ? `<div class="embed-footer">${footer}</div>` : '') +
                  `</div>`;
    }

    return `
    <div class="message">
      <div class="message-header">
        <img class="avatar" src="${escapeHtml(avatar)}" alt="${uname}'s avatar">
        <div class="user-info">
          <span class="username">${uname}</span>
          <span class="timestamp">${ts}</span>
        </div>
      </div>
      <div class="message-content">${content}</div>
      ${attachmentsHtml}
      ${embedHtml}
    </div>`;
  }).join('\n');

  const footer = `
  </div>
</div>
</body>
</html>`;

  return header + items + footer;
}

// === /close: HTML transcript + DM ===
async function handleClose(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;
  if (!guild || channel?.type !== ChannelType.GuildText)
    return interaction.reply({ content: 'Use this inside a ticket channel.', ephemeral: true });

  const meta = topicMetaToObj(channel.topic);
  if (!meta.user) return interaction.reply({ content: 'This channel is not a ticket.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });

  // Fetch last 100 messages ascending
  const messages = await channel.messages.fetch({ limit: 100 });
  const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  // Map to renderable objects
  const renderMsgs = sorted.map(m => {
    const author = m.author;
    const authorName = author?.tag ?? author?.username ?? 'Unknown';
    const authorAvatar = author?.displayAvatarURL?.({ extension: 'webp', size: 128 }) ?? '';
    const timestamp = formatDate(m.createdTimestamp);
    const content = m.content ?? '';

    // Attachments
    const attachments = m.attachments?.size
      ? [...m.attachments.values()].map(a => ({ url: a.url, name: a.name }))
      : [];

    // Basic single-embed render (title/description/footer/color)
    let embedObj = null;
    const e = m.embeds?.[0];
    if (e) {
      const colorHex = toHexColor(e.color);
      embedObj = {
        title: e.title ?? '',
        description: e.description ?? '',
        footer: e.footer?.text ?? '',
        colorHex
      };
    }

    return { authorName, authorAvatar, timestamp, content, attachments, embed: embedObj };
  });

  // Build HTML
  const html = buildTranscriptHTML({
    channelName: channel.name,
    closedByTag: interaction.user?.tag ?? interaction.user?.username ?? 'Unknown',
    closedAt: formatDate(Date.now()),
    messages: renderMsgs
  });
  const buffer = Buffer.from(html, 'utf-8');

  // DM to ticket opener
  let dmOk = false;
  try {
    const user = await client.users.fetch(meta.user);
    await user.send({
      content: `🗂️ Here is the transcript for your ticket **#${channel.name}**.`,
      files: [{ attachment: buffer, name: `${channel.name}-transcript.html` }]
    });
    dmOk = true;
  } catch { dmOk = false; }

  if (dmOk) await interaction.editReply({ content: 'Transcript sent via DM ✅ Closing channel…' });
  else await interaction.editReply({ content: 'Could not DM the transcript. Closing channel anyway.' });

  setTimeout(async () => { try { await channel.delete('Ticket closed.'); } catch {} }, 4000);
}

// === HTTP SERVER FOR RENDER ===
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Phantom Forge Ticket Bot is running.\n');
}).listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT} (Render free web service)`);
});

// === KEEP-ALIVE SELF-PING ===
const externalBase =
  process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const KEEPALIVE_URL = `${externalBase.replace(/\/$/, '')}/health`;
setInterval(() => {
  try { http.get(KEEPALIVE_URL, res => { res.on('data', () => {}); res.on('end', () => {}); }).on('error', () => {}); }
  catch {}
}, 4 * 60 * 1000); // every 4 min

// === LOGIN ===
client.login(TOKEN);
