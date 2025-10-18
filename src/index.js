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
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID || '';

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
function makeTopic(userId, claimedBy) {
  return `ticket_user:${userId};claimed_by:${claimedBy ?? ''}`;
}
function panelFooterText(supportRoleId, categoryId) {
  return `support_role:${supportRoleId || ''};category:${categoryId || ''}`;
}
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
  { name: 'uptime', description: 'Show bot uptime and status' } // 🟣 NEW
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    const app = await client.application?.fetch();
    if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(app.id, GUILD_ID), { body: commands });
    else await rest.put(Routes.applicationCommands(app.id), { body: commands });
    console.log('✅ Slash commands synced');
  } catch (e) {
    console.error('Command sync error:', e);
  }
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
  const content = ['Phantom Forge Ticket Bot', `active: ${active ? 'true' : 'false'}`, `uptime: ${uptimeStr}`].join('\n');
  await ch.send({ content }).catch(() => {});
}

// === INTERACTIONS ===
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    if (commandName === 'panel') await handlePanel(interaction);
    if (commandName === 'claim') await handleClaim(interaction);
    if (commandName === 'add') await handleAdd(interaction);
    if (commandName === 'close') await handleClose(interaction);
    if (commandName === 'uptime') await handleUptime(interaction);
  } catch (e) {
    console.error(e);
    if (!interaction.replied)
      await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
  }
});

// === /uptime command ===
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

// === HANDLE OPEN/CLOSE/CLAIM/ADD (same as before) ===
// ... [keep your previous handleOpenTicket, handleClaim, handleAdd, handleClose functions unchanged]

// === HTTP SERVER (Render keepalive) ===
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
  console.log(`🌐 HTTP server listening on port ${PORT}`);
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

client.login(TOKEN);
