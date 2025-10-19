import 'dotenv/config';
import http from 'node:http';
import url from 'node:url';
import { randomBytes } from 'node:crypto';
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
  Routes,
  ActivityType
} from 'discord.js';

/* =======================
   ENV VARS
======================= */
const TOKEN = process.env.DISCORD_TOKEN;
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID || '';
const DEFAULT_SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID || '';
const DEFAULT_CATEGORY_ID     = process.env.TICKETS_CATEGORY_ID || '';
const PORT = Number(process.env.PORT || 3000);

// Transcript limits / retention
const MAX_TRANSCRIPT_MESSAGES = Number(process.env.MAX_TRANSCRIPT_MESSAGES || 1000);
const TRANSCRIPT_TTL_MS = Number(process.env.TRANSCRIPT_TTL_MS || 7 * 24 * 60 * 60 * 1000); // 7d

if (!TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

/* =======================
   CLIENT
======================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

/* =======================
   HELPERS
======================= */
function formatUptime(ms) {
  const s = Math.floor((ms ?? 0) / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function toHexColor(num) {
  if (typeof num !== 'number') return null;
  return '#' + num.toString(16).padStart(6, '0');
}

function footerMetaText(supportRoleId, categoryId) {
  return `support_role:${supportRoleId || ''};category:${categoryId || ''}`;
}
function parseFooterMeta(embed) {
  const out = { supportRoleId: '', categoryId: '' };
  const text = embed?.footer?.text || '';
  text.split(';').forEach(pair => {
    const [k, v] = pair.split(':');
    if (k === 'support_role') out.supportRoleId = v || '';
    if (k === 'category') out.categoryId = v || '';
  });
  return out;
}

function makeTopic(userId, claimedBy = '') { return `ticket_user:${userId};claimed_by:${claimedBy}`; }
function parseTopic(topic) {
  const out = { userId: '', claimedBy: '' };
  (topic || '').split(';').forEach(kv => {
    const [k, v] = kv.split(':');
    if (k === 'ticket_user') out.userId = v || '';
    if (k === 'claimed_by')  out.claimedBy = v || '';
  });
  return out;
}

function formatDate(d) {
  try { return new Date(d).toLocaleString('en-US'); } catch { return new Date(d).toISOString(); }
}

function resolveMentionsInContent(content, message) {
  if (!content) return '';
  let out = content;

  // users <@123> or <@!123>
  out = out.replace(/<@!?(\d+)>/g, (match, id) => {
    const u = message.mentions?.users?.get(id);
    if (u) return `@${u.tag}`;
    return `@user:${id}`;
  });

  // channels <#123>
  out = out.replace(/<#(\d+)>/g, (match, id) => {
    const c = message.mentions?.channels?.get(id) || message.guild?.channels?.cache.get(id);
    if (c) return `#${c.name}`;
    return `#channel:${id}`;
  });

  // roles <@&123>
  out = out.replace(/<@&(\d+)>/g, (match, id) => {
    const r = message.mentions?.roles?.get(id) || message.guild?.roles?.cache.get(id);
    if (r) return `@${r.name}`;
    return `@role:${id}`;
  });

  return out;
}

/* =======================
   TRANSCRIPT STORE (in-memory, downloadable via /t/:id)
======================= */
const transcripts = new Map(); // id -> { html, filename, ts }
const rnd = (n=12) => randomBytes(n).toString('hex');
function putTranscript(html, filename) {
  const id = rnd(12);
  transcripts.set(id, { html, filename, ts: Date.now() });
  return id;
}
// cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of transcripts) if (now - v.ts > TRANSCRIPT_TTL_MS) transcripts.delete(k);
}, 60 * 60 * 1000);

/* =======================
   STATUS CACHING
======================= */
let lastStatusMessageId = null;
let lastStatusMessageObj = null;
let statusEditing = false;

/* =======================
   COMMANDS
======================= */
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
  { name: 'add', description: 'Add a user to this ticket', options: [{ name: 'user', type: 6, description: 'User', required: true }] },
  { name: 'close', description: 'Close this ticket (saves transcript)' },
  { name: 'uptime', description: 'Show bot uptime and status' }
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const app = await client.application.fetch();
  await rest.put(Routes.applicationCommands(app.id), { body: commands });
  console.log('✅ Slash commands registered');
}

/* =======================
   READY
======================= */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setPresence({
    status: 'online',
    activities: [{ name: client.guilds.cache.first()?.name || 'the server', type: ActivityType.Watching }]
  });
  await registerCommands();
  postStatus().catch(() => {});
  setInterval(() => postStatus().catch(() => {}), 1000);
});

/* =======================
   INTERACTIONS
======================= */
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'panel': return handlePanel(interaction);
        case 'claim': return handleClaim(interaction);
        case 'add':   return handleAdd(interaction);
        case 'close': return handleClose(interaction);
        case 'uptime': {
          const embed = new EmbedBuilder()
            .setColor('#8000ff')
            .setTitle('Phantom Forge Ticket Bot')
            .setDescription(`**Active:** ✅ true\n**Uptime:** \`${formatUptime(client.uptime)}\`\n**Ping:** \`${Math.round(client.ws.ping)} ms\``);
          return interaction.reply({ embeds: [embed], ephemeral: true });
        }
      }
    } else if (interaction.isButton()) {
      if (interaction.customId === 'open_ticket_btn')  return handleOpenTicket(interaction);
      if (interaction.customId === 'claim_ticket_btn') return handleClaim(interaction);
      if (interaction.customId === 'close_ticket_btn') return handleClose(interaction);
    }
  } catch (err) {
    console.error(err);
    if (!interaction.replied) {
      await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
});

/* =======================
   PANEL
======================= */
async function handlePanel(interaction) {
  if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild))
    return interaction.reply({ content: 'You need Manage Server permissions.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });

  const roleOpt = interaction.options.getRole('support_role');
  const catOpt  = interaction.options.getChannel('category');
  const title   = interaction.options.getString('title') || 'Phantom Forge Support';
  const desc    = interaction.options.getString('description') || 'Click the button below to open a ticket.';

  const supportRoleId = roleOpt?.id || DEFAULT_SUPPORT_ROLE_ID;
  const categoryId    = catOpt?.id  || DEFAULT_CATEGORY_ID;

  const panel = new EmbedBuilder()
    .setColor('#8000ff')
    .setTitle(title)
    .setDescription(desc)
    .setFooter({ text: footerMetaText(supportRoleId, categoryId) });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open_ticket_btn').setLabel('🎟️ Open Ticket').setStyle(ButtonStyle.Secondary)
  );

  await interaction.channel.send({ embeds: [panel], components: [row] });
  await interaction.editReply('✅ Ticket panel posted.');
}

/* =======================
   OPEN TICKET
======================= */
const creatingFor = new Set(); // anti double-click

async function handleOpenTicket(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const guild = interaction.guild;
  if (!guild) return interaction.editReply('Server only.');

  const emb = interaction.message.embeds?.[0];
  const { supportRoleId, categoryId } = parseFooterMeta(emb);
  const userId = interaction.user.id;

  if (creatingFor.has(userId)) return interaction.editReply('Creating your ticket…');
  creatingFor.add(userId);

  try {
    const overwrites = [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel], type: OverwriteType.Role },
      { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles], type: OverwriteType.Member },
      { id: guild.members.me.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory], type: OverwriteType.Member }
    ];
    if (supportRoleId) {
      overwrites.push({
        id: supportRoleId,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
        type: OverwriteType.Role
      });
    }

    const channel = await guild.channels.create({
      name: `ticket-${interaction.user.username}`.toLowerCase().replace(/\s+/g, '-').slice(0, 90),
      type: ChannelType.GuildText,
      parent: categoryId || undefined,
      topic: makeTopic(userId, ''),
      permissionOverwrites: overwrites
    });

    const welcome = new EmbedBuilder()
      .setColor('#8000ff')
      .setTitle('🎟️ Thanks for opening a ticket!')
      .setDescription('Support will be with you shortly 💜');

    const controls = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('claim_ticket_btn').setLabel('🟣 Claim Ticket').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('close_ticket_btn').setLabel('🟪 Close Ticket').setStyle(ButtonStyle.Primary)
    );

    await channel.send({
      content: `${interaction.user}${supportRoleId ? ` <@&${supportRoleId}>` : ''}`,
      embeds: [welcome],
      components: [controls]
    });

    await interaction.editReply(`✅ Ticket created: ${channel}`);
  } catch (e) {
    console.error(e);
    await interaction.editReply('Failed creating ticket.');
  } finally {
    creatingFor.delete(userId);
  }
}

/* =======================
   CLAIM / ADD / CLOSE (+ transcript)
======================= */
async function handleClaim(interaction) {
  const ch = interaction.channel;
  if (!ch || ch.type !== ChannelType.GuildText) return interaction.reply({ content: 'Not a ticket.', ephemeral: true });
  const meta = parseTopic(ch.topic);
  if (!meta.userId) return interaction.reply({ content: 'Not a ticket.', ephemeral: true });

  await ch.setTopic(makeTopic(meta.userId, interaction.user.id)).catch(() => {});
  await interaction.reply({ content: '✅ Ticket claimed.', ephemeral: true });
  await ch.send(`Hello <@${meta.userId}>, I am ${interaction.user} from the **Phantom Forge** support team.`);
}

async function handleAdd(interaction) {
  const user = interaction.options.getUser('user', true);
  await interaction.channel.permissionOverwrites.edit(user.id, {
    ViewChannel: true, SendMessages: true, ReadMessageHistory: true
  });
  await interaction.reply({ content: `${user} added to this ticket ✅`, ephemeral: true });
}

// paginate fetch
async function fetchAllMessages(channel, maxCount) {
  const collected = [];
  let beforeId = undefined;
  while (collected.length < maxCount) {
    const batch = await channel.messages.fetch({ limit: 100, before: beforeId }).catch(() => null);
    if (!batch || batch.size === 0) break;
    const arr = [...batch.values()];
    collected.push(...arr);
    beforeId = arr[arr.length - 1].id;
    if (batch.size < 100) break;
  }
  return collected;
}

async function handleClose(interaction) {
  const channel = interaction.channel;
  const meta = parseTopic(channel.topic);
  if (!meta.userId) return interaction.reply({ content: 'Not a ticket.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });

  // 1) fetch messages (oldest -> newest)
  const fetched = await fetchAllMessages(channel, Math.max(101, MAX_TRANSCRIPT_MESSAGES));
  const sorted = fetched.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const msgs = sorted.map(m => {
    const raw = m.content ?? '';
    const content = resolveMentionsInContent(raw, m);
    return {
      authorName: m.author?.tag ?? 'Unknown',
      authorAvatar: m.author?.displayAvatarURL({ extension: 'webp', size: 128 }) ?? '',
      timestamp: formatDate(m.createdTimestamp),
      content,
      attachments: [...m.attachments.values()].map(a => ({ url: a.url, name: a.name })),
      embed: m.embeds[0]
        ? {
            title: m.embeds[0].title ?? '',
            description: m.embeds[0].description ?? '',
            footer: m.embeds[0].footer?.text ?? '',
            colorHex: toHexColor(m.embeds[0].color)
          }
        : null
    };
  });

  // 2) build HTML
  const html = buildTranscriptHTML({
    channelName: channel.name,
    closedByTag: interaction.user.tag,
    closedAt: formatDate(Date.now()),
    messages: msgs
  });

  // 3) store + link
  const filename = `${channel.name}-transcript.html`;
  const id = putTranscript(html, filename);
  const base =
    process.env.RENDER_EXTERNAL_URL ||
    process.env.KEEPALIVE_URL ||
    `http://localhost:${PORT}`;
  const downloadUrl = `${base.replace(/\/$/, '')}/t/${id}`;

  // 4) DM link to ticket opener
  const guildName = interaction.guild?.name ?? 'our server';
  const dmEmbed = new EmbedBuilder()
    .setColor('#8000ff')
    .setTitle(`Ticket Closed on ${guildName}`)
    .setDescription([
      `Your ticket on **${guildName}** has been closed.`,
      ``,
      `You can view the transcript here:`
    ].join('\n'));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Download Transcript').setURL(downloadUrl)
  );

  let dmOk = false;
  try {
    const user = await client.users.fetch(meta.userId);
    await user.send({ embeds: [dmEmbed], components: [row] });
    dmOk = true;
  } catch { dmOk = false; }

  if (dmOk) await interaction.editReply('Transcript link sent via DM ✅ Closing in 5s');
  else await interaction.editReply(`Could not DM the transcript link. Here it is instead:\n${downloadUrl}`);

  setTimeout(() => channel.delete('Ticket closed').catch(() => {}), 5000);
}

/* =======================
   TRANSCRIPT HTML (neon purple + bg + logo)
======================= */
function buildTranscriptHTML({ channelName, closedByTag, closedAt, messages }) {
  const LOGO_URL = 'https://i.postimg.cc/HkfVrFF8/Schermafbeelding-2025-10-16-170745-removebg-preview.png';
  const BG_URL   = 'https://i.postimg.cc/zvsvYJGs/Schermafbeelding-2025-10-05-022559.png';

  const head = `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1.0" />
<title>Discord Ticket Transcript - ${escapeHtml(channelName)}</title>
<style>
:root{--accent:#8000ff;--text:#e9dcff;--muted:#b7a8d9}
body{background:url('${BG_URL}') center/cover fixed;color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;margin:0;line-height:1.5}
.container{max-width:1200px;margin:0 auto;padding:20px}
.header{background:rgba(25,0,53,0.85);padding:20px;border-radius:10px 10px 0 0;box-shadow:0 0 15px rgba(128,0,255,.4);border:1px solid var(--accent);margin-bottom:20px}
.header-top{display:flex;align-items:center;gap:14px;margin-bottom:10px}
.logo{width:56px;height:56px;object-fit:contain;filter:drop-shadow(0 0 10px rgba(128,0,255,.6))}
h1{margin:0;font-size:24px;color:#fff;text-shadow:0 0 2px #fff,0 0 6px var(--accent),0 0 12px var(--accent),0 0 20px var(--accent)}
.header-info{display:flex;flex-wrap:wrap;gap:15px;font-size:14px;color:var(--muted)}
.header-info strong{color:var(--accent)}
.messages{background:rgba(20,0,40,.7);border-radius:0 0 10px 10px;padding:0 10px;box-shadow:0 0 15px rgba(128,0,255,.3);border:1px solid rgba(128,0,255,.4)}
.message{padding:15px 10px;border-top:1px solid rgba(128,0,255,.3)}
.message:first-child{border-top:none}
.header-row{display:flex;align-items:center;margin-bottom:6px}
.avatar{width:40px;height:40px;border-radius:50%;margin-right:10px;box-shadow:0 0 10px rgba(128,0,255,.5)}
.username{font-weight:600;font-size:16px;color:#fff;text-shadow:0 0 8px rgba(128,0,255,.5)}
.timestamp{color:var(--muted);font-size:12px}
.content{margin-left:50px;font-size:15px;white-space:pre-wrap}
.attachment{margin-left:50px;margin-top:8px;display:inline-block;background:rgba(40,0,80,.6);border:1px solid rgba(128,0,255,.4);border-radius:5px;padding:8px}
.attachment a{color:#cdb5ff;text-decoration:none}
.embed{margin-left:50px;margin-top:8px;padding:8px 12px;background:rgba(30,0,60,.6);border-left:4px solid var(--accent);border-radius:6px;box-shadow:0 0 10px rgba(128,0,255,.3)}
.embed-title{color:#fff;font-weight:600;margin-bottom:6px}
.embed-description{color:#e9dcff;margin-bottom:6px}
.embed-footer{color:#b7a8d9;font-size:12px;margin-top:6px}
.footer{color:#c8aaff;text-align:center;margin-top:24px;font-size:13px;text-shadow:0 0 6px rgba(128,0,255,.6)}
.footer a{color:#c8aaff;text-decoration:none;font-weight:600}
.footer a:hover{color:#fff;text-shadow:0 0 10px var(--accent)}
</style></head><body><div class="container">
  <div class="header">
    <div class="header-top">
      <img class="logo" src="${escapeHtml(LOGO_URL)}" alt="logo" onerror="this.style.display='none'">
      <h1>Ticket Transcript - ${escapeHtml(channelName)}</h1>
    </div>
    <div class="header-info">
      <div><strong>Channel:</strong> ${escapeHtml(channelName)}</div>
      <div><strong>Closed by:</strong> ${escapeHtml(closedByTag)}</div>
      <div><strong>Date:</strong> ${escapeHtml(closedAt)}</div>
    </div>
  </div>
  <div class="messages">
`;

  const body = messages.map(m => {
    const avatar = m.authorAvatar || '';
    const uname = escapeHtml(m.authorName || 'Unknown');
    const ts = escapeHtml(m.timestamp || '');
    const content = escapeHtml(m.content || '');
    const atts = (m.attachments || []).map(a =>
      `<div class="attachment"><a href="${escapeHtml(a.url)}" target="_blank">${escapeHtml(a.name || 'attachment')}</a></div>`
    ).join('\n');

    let embedHtml = '';
    if (m.embed) {
      const border = m.embed.colorHex || '#8000ff';
      const title = escapeHtml(m.embed.title || '');
      const desc  = escapeHtml(m.embed.description || '');
      const foot  = escapeHtml(m.embed.footer || '');
      embedHtml = `<div class="embed" style="border-left: 4px solid ${border}">
        ${title ? `<div class="embed-title">${title}</div>` : ''}
        ${desc ? `<div class="embed-description">${desc}</div>` : ''}
        ${foot ? `<div class="embed-footer">${foot}</div>` : ''}
      </div>`;
    }

    return `
    <div class="message">
      <div class="header-row">
        <img class="avatar" src="${escapeHtml(avatar)}" alt="${uname}">
        <div>
          <div class="username">${uname}</div>
          <div class="timestamp">${ts}</div>
        </div>
      </div>
      <div class="content">${content}</div>
      ${atts}
      ${embedHtml}
    </div>`;
  }).join('\n');

  const foot = `
  </div>
  <div class="footer">
    ──────────────────────────────<br>
    Generated by <a href="https://discord.gg/phantomforge" target="_blank">Phantom Forge Ticket Bot</a><br>
    <span style="font-size:11px;opacity:0.8;">© 2025 Phantom Forge</span>
  </div>
</div></body></html>`;

  return head + body + foot;
}

/* =======================
   STATUS (LIVE, elke seconde, 1 bericht)
======================= */
async function ensureStatusMessage() {
  if (lastStatusMessageObj && !lastStatusMessageObj.deleted) return lastStatusMessageObj;

  const ch = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) return null;

  if (lastStatusMessageId) {
    const m = await ch.messages.fetch(lastStatusMessageId).catch(() => null);
    if (m) { lastStatusMessageObj = m; return m; }
  }

  const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
  if (recent && recent.size) {
    const mine = [...recent.values()].filter(m =>
      m.author?.id === client.user.id &&
      m.embeds?.[0]?.title?.includes('Bot Status')
    );
    if (mine.length) {
      mine.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      const newest = mine[0];
      lastStatusMessageObj = newest;
      lastStatusMessageId = newest.id;
      for (const d of mine.slice(1)) d.delete().catch(() => {});
      return newest;
    }
  }

  const placeholder = new EmbedBuilder()
    .setColor('#8000ff')
    .setTitle(`🕒 ${client.user.username} Bot Status`)
    .setDescription('Starting…')
    .setFooter({ text: 'Live updated every second | Phantom Forge', iconURL: client.user.displayAvatarURL() })
    .setTimestamp();

  const newMsg = await ch.send({ embeds: [placeholder] }).catch(() => null);
  if (newMsg) { lastStatusMessageObj = newMsg; lastStatusMessageId = newMsg.id; }
  return newMsg;
}

async function postStatus() {
  if (!STATUS_CHANNEL_ID || statusEditing) return;
  statusEditing = true;
  try {
    const msg = await ensureStatusMessage();
    if (!msg) return;

    const active = client.isReady();
    const uptime = formatUptime(client.uptime);
    const ping   = Math.max(0, Math.round(client.ws.ping));
    const nowStr = new Date().toLocaleString('en-US');
    const title  = `🕒 ${client.user.username} Bot Status`;

    const embed = new EmbedBuilder()
      .setColor('#8000ff')
      .setTitle(title)
      .addFields(
        { name: 'Active:',     value: active ? '✅ Online' : '❌ Offline', inline: false },
        { name: 'Uptime',      value: `\`${uptime}\``, inline: true },
        { name: 'Ping',        value: `${ping} ms`,    inline: true },
        { name: 'Last update', value: nowStr,          inline: false },
      )
      .setFooter({ text: 'Live updated every second | Phantom Forge', iconURL: client.user.displayAvatarURL() })
      .setTimestamp(new Date());

    await msg.edit({ embeds: [embed] }).catch(async () => {
      lastStatusMessageObj = null; lastStatusMessageId = null;
      const again = await ensureStatusMessage();
      if (again) await again.edit({ embeds: [embed] }).catch(() => {});
    });
  } finally {
    statusEditing = false;
  }
}

/* =======================
   HTTP /health + transcript download
======================= */
const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url);
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  const m = /^\/t\/([a-f0-9]{24})$/i.exec(pathname || '');
  if (m) {
    const id = m[1];
    const item = transcripts.get(id);
    if (!item) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Transcript not found or expired.');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="${item.filename.replace(/"/g, '')}"`
    });
    return res.end(item.html);
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Phantom Forge bot running\n');
});
server.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

// Self-ping (combineer met GitHub Actions / UptimeRobot voor Render Free)
const BASE = process.env.RENDER_EXTERNAL_URL ? process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '') : `http://localhost:${PORT}`;
setInterval(() => { try { http.get(`${BASE}/health`).on('error', () => {}); } catch {} }, 4 * 60 * 1000);

/* =======================
   LOGIN
======================= */
client.login(TOKEN);
