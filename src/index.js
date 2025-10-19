import 'dotenv/config';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import url from 'node:url';
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

// === ENVIRONMENT VARS ===
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID ? BigInt(process.env.SUPPORT_ROLE_ID) : null;
const CATEGORY_ID = process.env.TICKETS_CATEGORY_ID ? BigInt(process.env.TICKETS_CATEGORY_ID) : null;
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID;
const PORT = process.env.PORT || 3000;

if (!TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

// === SETUP CLIENT ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const creatingTicket = new Set();
const transcripts = new Map();

// === STATUS CACHE ===
let lastStatusMessageId = null;
let lastStatusMessageObj = null;
let statusEditing = false;

// === HELPERS ===
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
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

function makeId() {
  return randomBytes(10).toString('hex');
}

// === SLASH COMMANDS ===
const commands = [
  { name: 'panel', description: 'Send a ticket panel' },
  { name: 'claim', description: 'Claim this ticket' },
  { name: 'add', description: 'Add user to ticket', options: [{ name: 'user', description: 'User', type: 6, required: true }] },
  { name: 'close', description: 'Close ticket' },
  { name: 'uptime', description: 'Show bot uptime' }
];

// === REGISTER COMMANDS ===
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const app = await client.application.fetch();
  await rest.put(Routes.applicationCommands(app.id), { body: commands });
  console.log('✅ Commands registered');
}

// === BOT READY ===
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: client.guilds.cache.first()?.name || 'the server', type: ActivityType.Watching }],
    status: 'online'
  });
  await registerCommands();
  postStatus().catch(() => {});
  setInterval(() => postStatus().catch(() => {}), 1000);
});

// === HANDLE INTERACTIONS ===
client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand()) {
      if (i.commandName === 'uptime') return uptimeCommand(i);
      if (i.commandName === 'panel') return createPanel(i);
    }
  } catch (err) {
    console.error(err);
  }
});

// === UPTIME COMMAND ===
async function uptimeCommand(i) {
  const embed = new EmbedBuilder()
    .setColor('#8000ff')
    .setTitle('Phantom Forge Ticket Bot')
    .setDescription(`**Active:** ✅ true\n**Uptime:** \`${formatUptime(client.uptime)}\`\n**Ping:** \`${client.ws.ping} ms\``);
  await i.reply({ embeds: [embed], ephemeral: true });
}

// === CREATE PANEL ===
async function createPanel(i) {
  await i.deferReply({ ephemeral: true });
  const embed = new EmbedBuilder()
    .setColor('#8000ff')
    .setTitle('Phantom Forge Support')
    .setDescription('Click below to open a ticket.')
    .setFooter({ text: 'Phantom Forge Tickets' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open_ticket').setLabel('🎟️ Open Ticket').setStyle(ButtonStyle.Secondary)
  );
  await i.channel.send({ embeds: [embed], components: [row] });
  await i.editReply('✅ Ticket panel created.');
}

// === STATUS HANDLING ===
async function ensureStatusMessage() {
  // gebruik cache als geldig
  if (lastStatusMessageObj && !lastStatusMessageObj.deleted) return lastStatusMessageObj;

  const ch = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) return null;

  // fetch via ID
  if (lastStatusMessageId) {
    const msg = await ch.messages.fetch(lastStatusMessageId).catch(() => null);
    if (msg) { lastStatusMessageObj = msg; return msg; }
  }

  // zoek bestaande van bot
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

      // verwijder duplicaten
      const dups = mine.slice(1);
      for (const d of dups) d.delete().catch(() => {});
      return newest;
    }
  }

  // niks gevonden, maak nieuw
  const placeholder = new EmbedBuilder()
    .setColor('#8000ff')
    .setTitle(`🕒 ${client.user.username} Bot Status`)
    .setDescription('Starting…')
    .setFooter({ text: 'Live updated every second | Phantom Forge', iconURL: client.user.displayAvatarURL() })
    .setTimestamp();

  const newMsg = await ch.send({ embeds: [placeholder] }).catch(() => null);
  if (newMsg) {
    lastStatusMessageObj = newMsg;
    lastStatusMessageId = newMsg.id;
    return newMsg;
  }
  return null;
}

// === POST STATUS (Live embed) ===
async function postStatus() {
  if (!STATUS_CHANNEL_ID || statusEditing) return;
  statusEditing = true;

  try {
    const msg = await ensureStatusMessage();
    if (!msg) return;

    const active = client.isReady();
    const uptime = formatUptime(client.uptime ?? 0);
    const ping = Math.max(0, Math.round(client.ws.ping));
    const now = new Date().toLocaleString('en-US');
    const title = `🕒 ${client.user.username} Bot Status`;

    const embed = new EmbedBuilder()
      .setColor('#8000ff')
      .setTitle(title)
      .addFields(
        { name: 'Active:', value: active ? '✅ Online' : '❌ Offline', inline: false },
        { name: 'Uptime', value: `\`${uptime}\``, inline: true },
        { name: 'Ping', value: `${ping} ms`, inline: true },
        { name: 'Last update', value: now, inline: false },
      )
      .setFooter({ text: 'Live updated every second | Phantom Forge', iconURL: client.user.displayAvatarURL() })
      .setTimestamp();

    await msg.edit({ embeds: [embed] }).catch(async () => {
      lastStatusMessageObj = null;
      lastStatusMessageId = null;
      const again = await ensureStatusMessage();
      if (again) await again.edit({ embeds: [embed] }).catch(() => {});
    });
  } finally {
    statusEditing = false;
  }
}

// === SIMPLE HTTP KEEPALIVE ===
const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url);
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot running.');
  }
});
server.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

// === KEEPALIVE PING ===
const PING_URL = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}/health`
  : `http://localhost:${PORT}/health`;
setInterval(() => {
  try { http.get(PING_URL).on('error', () => {}); } catch {}
}, 4 * 60 * 1000);

// === LOGIN ===
client.login(TOKEN);
