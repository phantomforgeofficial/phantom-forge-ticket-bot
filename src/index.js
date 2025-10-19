import 'dotenv/config';
import http from 'node:http';
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

// ====== ENV ======
const TOKEN = process.env.DISCORD_TOKEN;
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID || '';
const DEFAULT_SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID || '';     // optional
const DEFAULT_CATEGORY_ID     = process.env.TICKETS_CATEGORY_ID || ''; // optional
const PORT = process.env.PORT || 3000;

if (!TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

// ====== CLIENT ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel],
});

// ====== HELPERS ======
function formatUptime(ms) {
  const s = Math.floor((ms ?? 0) / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
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

// ====== STATUS CACHING ======
let lastStatusMessageId = null;
let lastStatusMessageObj = null;
let statusEditing = false;

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
      // verwijder duplicaten
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

// ====== COMMANDS ======
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
  { name: 'close', description: 'Close this ticket' },
  { name: 'uptime', description: 'Show bot uptime and status' }
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const app = await client.application.fetch();
  await rest.put(Routes.applicationCommands(app.id), { body: commands });
  console.log('✅ Slash commands registered');
}

// ====== READY ======
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

// ====== INTERACTIONS ======
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

// ====== PANEL ======
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

// ====== OPEN TICKET ======
const creatingFor = new Set(); // anti double-click
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

// ====== CLAIM ======
async function handleClaim(interaction) {
  const ch = interaction.channel;
  if (!ch || ch.type !== ChannelType.GuildText) return interaction.reply({ content: 'Not a ticket.', ephemeral: true });
  const meta = parseTopic(ch.topic);
  if (!meta.userId) return interaction.reply({ content: 'Not a ticket.', ephemeral: true });

  await ch.setTopic(makeTopic(meta.userId, interaction.user.id)).catch(() => {});
  await interaction.reply({ content: '✅ Ticket claimed.', ephemeral: true });
  await ch.send(`Hello <@${meta.userId}>, I am ${interaction.user} from the **Phantom Forge** support team.`);
}

// ====== ADD ======
async function handleAdd(interaction) {
  const user = interaction.options.getUser('user', true);
  await interaction.channel.permissionOverwrites.edit(user.id, {
    ViewChannel: true, SendMessages: true, ReadMessageHistory: true
  });
  await interaction.reply({ content: `${user} added to this ticket ✅`, ephemeral: true });
}

// ====== CLOSE ======
async function handleClose(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const ch = interaction.channel;
  const meta = parseTopic(ch.topic);
  if (!meta.userId) return interaction.editReply('Not a ticket.');
  await interaction.editReply('Closing ticket in 5 seconds…');
  setTimeout(() => ch.delete('Ticket closed').catch(() => {}), 5000);
}

// ====== HTTP SERVER (/health) ======
const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url);
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Phantom Forge bot running\n');
  }
});
server.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

// ====== KEEP-ALIVE (Render) ======
const BASE = process.env.RENDER_EXTERNAL_URL ? process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '') : `http://localhost:${PORT}`;
setInterval(() => { try { http.get(`${BASE}/health`).on('error', () => {}); } catch {} }, 4 * 60 * 1000);

// ====== LOGIN ======
client.login(TOKEN);
