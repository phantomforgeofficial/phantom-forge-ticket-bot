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

const creatingTicketFor = new Set();

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
function escapeHtml(str) {
  return (str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function formatDate(d) {
  try { return new Date(d).toLocaleString('en-US'); } catch { return new Date(d).toISOString(); }
}
function toHexColor(num) {
  if (typeof num !== 'number') return null;
  return '#' + num.toString(16).padStart(6, '0');
}
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// === SLASH COMMANDS ===
const commands = [
  {
    name: 'panel',
    description: 'Send a ticket panel in this channel',
    options: [
      { name: 'support_role', description: 'Support role', type: 8, required: false },
      { name: 'category', description: 'Ticket category', type: 7, channel_types: [4], required: false },
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
    if (GUILD_ID)
      await rest.put(Routes.applicationGuildCommands(app.id, GUILD_ID), { body: commands });
    else
      await rest.put(Routes.applicationCommands(app.id), { body: commands });
    console.log('✅ Slash commands synced');
  } catch (e) { console.error('Command sync error:', e); }
}

// === READY ===
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setPresence({ status: 'online', activities: [{ name: 'Phantom Forge Tickets', type: 0 }] });
  await registerCommands();
  postStatus().catch(() => {});
  setInterval(() => postStatus().catch(() => {}), 10 * 60 * 1000);
});

async function postStatus() {
  if (!STATUS_CHANNEL_ID) return;
  const ch = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) return;
  const active = client.isReady();
  const uptimeStr = formatUptime(client.uptime ?? 0);
  const content = `Phantom Forge Ticket Bot\nactive: ${active ? 'true' : 'false'}\nuptime: ${uptimeStr}`;
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

// === PANEL ===
async function handlePanel(interaction) {
  if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild))
    return interaction.reply({ content: 'You need Manage Server permissions.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  const supportRole = interaction.options.getRole('support_role');
  const category = interaction.options.getChannel('category');
  const title = interaction.options.getString('title') ?? 'Phantom Forge Support';
  const description = interaction.options.getString('description') ?? 'Click below to open a ticket.';

  const supportRoleId = supportRole?.id ? BigInt(supportRole.id) : DEFAULT_SUPPORT_ROLE_ID;
  const categoryId = category?.id ? BigInt(category.id) : DEFAULT_CATEGORY_ID;

  const embed = new EmbedBuilder()
    .setTitle(title).setDescription(description).setColor('#8000ff')
    .setFooter({ text: panelFooterText(supportRoleId, categoryId) });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open_ticket_btn').setLabel('🎟️ Open Ticket').setStyle(ButtonStyle.Secondary)
  );

  await interaction.channel.send({ embeds: [embed], components: [row] });
  await interaction.editReply('✅ Ticket panel posted');
}

// === OPEN TICKET ===
async function handleOpenTicket(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ content: 'Server only.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  const userId = interaction.user.id;
  if (creatingTicketFor.has(userId)) return interaction.editReply('Ticket already being created…');
  creatingTicketFor.add(userId);

  try {
    const emb = interaction.message.embeds?.[0];
    const { supportRoleId, categoryId } = parseFooter(emb);
    const baseName = `ticket-${interaction.user.username}`.toLowerCase().replace(/\s+/g, '-').slice(0, 90);

    const overwrites = [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel], type: OverwriteType.Role },
      { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles], type: OverwriteType.Member },
      { id: guild.members.me.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory], type: OverwriteType.Member }
    ];
    if (supportRoleId) {
      overwrites.push({
        id: supportRoleId.toString(),
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
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

    const embed = new EmbedBuilder()
      .setColor('#8000ff')
      .setTitle('🎟️ Thanks for opening a ticket!')
      .setDescription('Support will be with you shortly 💜');

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('claim_ticket_btn').setLabel('🟣 Claim Ticket').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('close_ticket_btn').setLabel('🟪 Close Ticket').setStyle(ButtonStyle.Primary)
    );

    await channel.send({
      content: `${interaction.user}${supportRoleId ? ` <@&${supportRoleId}>` : ''}`,
      embeds: [embed],
      components: [buttons]
    });

    await interaction.editReply({ content: `✅ Ticket created: ${channel}` });
  } catch (e) {
    console.error(e);
    await interaction.editReply('Error creating ticket.');
  } finally {
    creatingTicketFor.delete(userId);
  }
}

// === CLAIM ===
async function handleClaim(interaction) {
  const ch = interaction.channel;
  const meta = topicMetaToObj(ch.topic);
  if (!meta.user) return interaction.reply({ content: 'Not a ticket.', ephemeral: true });
  await ch.setTopic(makeTopic(meta.user, interaction.user.id));
  await interaction.reply({ content: '✅ Ticket claimed', ephemeral: true });
  await ch.send(`Hello <@${meta.user}>, I am ${interaction.user} from the **Phantom Forge** support team.`);
}

// === ADD ===
async function handleAdd(interaction) {
  const user = interaction.options.getUser('user', true);
  await interaction.channel.permissionOverwrites.edit(user.id, {
    ViewChannel: true, SendMessages: true, ReadMessageHistory: true
  });
  await interaction.reply({ content: `${user} added ✅`, ephemeral: true });
}

// === CLOSE / TRANSCRIPT ===
async function handleClose(interaction) {
  const channel = interaction.channel;
  const meta = topicMetaToObj(channel.topic);
  if (!meta.user) return interaction.reply({ content: 'Not a ticket.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });

  const messages = await channel.messages.fetch({ limit: 100 });
  const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const renderMsgs = sorted.map(m => ({
    authorName: m.author?.tag ?? 'Unknown',
    authorAvatar: m.author?.displayAvatarURL({ extension: 'webp', size: 128 }) ?? '',
    timestamp: formatDate(m.createdTimestamp),
    content: m.content ?? '',
    attachments: [...m.attachments.values()].map(a => ({ url: a.url, name: a.name })),
    embed: m.embeds[0]
      ? {
          title: m.embeds[0].title ?? '',
          description: m.embeds[0].description ?? '',
          footer: m.embeds[0].footer?.text ?? '',
          colorHex: toHexColor(m.embeds[0].color)
        }
      : null
  }));

  const html = buildTranscriptHTML({
    channelName: channel.name,
    closedByTag: interaction.user.tag,
    closedAt: formatDate(Date.now()),
    messages: renderMsgs
  });
  const buffer = Buffer.from(html, 'utf-8');

  try {
    const user = await client.users.fetch(meta.user);
    await user.send({
      content: `🗂️ Transcript for your ticket **#${channel.name}**`,
      files: [{ attachment: buffer, name: `${channel.name}-transcript.html` }]
    });
    await interaction.editReply('Transcript sent ✅ Closing in 5s');
  } catch {
    await interaction.editReply('Could not DM transcript, closing anyway.');
  }

  setTimeout(() => channel.delete('Ticket closed.'), 5000);
}

// === BUILD TRANSCRIPT HTML ===
function buildTranscriptHTML({ channelName, closedByTag, closedAt, messages }) {
  const LOGO_URL = 'https://i.postimg.cc/HkfVrFF8/Schermafbeelding-2025-10-16-170745-removebg-preview.png';
  const header = `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1.0" />
<title>${escapeHtml(channelName)}</title>
<style>
:root{--accent:#8000ff;--bg:#0f001f;--text:#e9dcff;--muted:#b7a8d9}
body{background:url('https://i.postimg.cc/zvsvYJGs/Schermafbeelding-2025-10-05-022559.png') center/cover fixed;
color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;line-height:1.5;margin:0}
.container{max-width:1200px;margin:0 auto;padding:20px}
.header{background:rgba(25,0,53,0.8);padding:20px;border-radius:10px 10px 0 0;box-shadow:0 0 15px rgba(128,0,255,.4);border:1px solid var(--accent);margin-bottom:20px}
.header-top{display:flex;align-items:center;gap:14px;margin-bottom:10px}
.logo{width:56px;height:56px;object-fit:contain;filter:drop-shadow(0 0 10px rgba(128,0,255,.6))}
h1{color:#fff;margin:0;text-shadow:0 0 10px var(--accent);font-size:24px}
.header-info{display:flex;flex-wrap:wrap;gap:15px;font-size:14px;color:var(--muted)}
.header-info strong{color:var(--accent)}
.messages-container{background:rgba(20,0,40,.7);border-radius:0 0 10px 10px;padding:0 10px;box-shadow:0 0 15px rgba(128,0,255,.3);border:1px solid rgba(128,0,255,.4)}
.message{padding:15px 10px;border-top:1px solid rgba(128,0,255,.3)}
.message:first-child{border-top:none}
.message-header{display:flex;align-items:center;margin-bottom:6px}
.avatar{width:40px;height:40px;border-radius:50%;margin-right:10px;box-shadow:0 0 10px rgba(128,0,255,.5)}
.username{font-weight:600;font-size:16px;text-shadow:0 0 8px rgba(128,0,255,.5);color:#fff}
.timestamp{color:var(--muted);font-size:12px}
.message-content{margin-left:50px;font-size:15px;white-space:pre-wrap}
.attachment{margin-left:50px;margin-top:8px;display:inline-block;background:rgba(40,0,80,.6);border:1px solid rgba(128,0,255,.4);border-radius:5px;padding:8px}
.attachment a{color:#cdb5ff;text-decoration:none}
.embed{margin-left:50px;margin-top:8px;padding:8px 12px;background:rgba(30,0,60,.6);border-left:4px solid var(--accent);border-radius:6px;box-shadow:0 0 10px rgba(128,0,255,.3)}
.embed-title{color:#fff;font-weight:600;margin-bottom:6px}
.embed-description{color:#e9dcff;margin-bottom:6px}
.embed-footer{color:#b7a8d9;font-size:12px;margin-top:6px}
.footer-watermark{text-align:center;color:#c8aaff;margin-top:25px;font-size:13px;text-shadow:0 0 6px rgba(128,0,255,.6)}
.footer-watermark a{color:#c8aaff;text-decoration:none;font-weight:600}
.footer-watermark a:hover{color:#fff;text-shadow:0 0 10px var(--accent)}
</style></head><body><div class="container">
  <div class="header">
    <div class="header-top">
      <img class="logo" src="${escapeHtml(LOGO_URL)}" alt="Phantom Forge logo" onerror="this.style.display='none'">
      <h1>Ticket Transcript - ${escapeHtml(channelName)}</h1>
    </div>
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
      const border = embed.colorHex || '#8000ff';
      const title = escapeHtml(embed.title || '');
      const desc = escapeHtml(embed.description || '');
      const footer = escapeHtml(embed.footer || '');
      embedHtml = `<div class="embed" style="border-left: 4px solid ${border}">
        ${title ? `<div class="embed-title">${title}</div>` : ''}
        ${desc ? `<div class="embed-description">${desc}</div>` : ''}
        ${footer ? `<div class="embed-footer">${footer}</div>` : ''}
      </div>`;
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
  <div class="footer-watermark">
    ──────────────────────────────<br>
    Generated by <a href="https://discord.gg/phantomforge" target="_blank">Phantom Forge Ticket Bot</a><br>
    <span style="font-size:11px;opacity:0.8;">© 2025 Phantom Forge</span>
  </div>
</div></body></html>`;

  return header + items + footer;
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
  try {
    http.get(KEEPALIVE_URL, res => {
      res.on('data', () => {});
      res.on('end', () => {});
    }).on('error', () => {});
  } catch {}
}, 4 * 60 * 1000);

// === LOGIN ===
client.login(TOKEN);
