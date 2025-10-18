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

// Prevent spam/duplicates
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
  { name: 'close', description: 'Close this ticket' }
];

// === REGISTER COMMANDS ===
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    const app = await client.application?.fetch();
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(app.id, GUILD_ID), { body: commands });
      console.log('✅ Synced guild commands');
    } else {
      await rest.put(Routes.applicationCommands(app.id), { body: commands });
      console.log('✅ Synced global commands');
    }
  } catch (e) {
    console.error('Command sync error:', e);
  }
}

// === READY ===
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setPresence({
    status: 'online',
    activities: [{ name: 'Phantom Forge Tickets', type: 0 }]
  });
  await registerCommands();
});

// === INTERACTION HANDLER ===
client.on('interactionCreate', async (interaction) => {
  try {
    const key = `${interaction.id}`;
    if (processingInteraction.has(key)) return;
    processingInteraction.add(key);

    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      if (commandName === 'panel') await handlePanel(interaction);
      if (commandName === 'claim') await handleClaim(interaction);
      if (commandName === 'add') await handleAdd(interaction);
      if (commandName === 'close') await handleClose(interaction);
    } else if (interaction.isButton()) {
      if (interaction.customId === 'open_ticket_btn') await handleOpenTicket(interaction);
      if (interaction.customId === 'claim_ticket_btn') await handleClaim(interaction);
      if (interaction.customId === 'close_ticket_btn') await handleClose(interaction);
    }
  } catch (e) {
    console.error(e);
    const msg = { content: 'Something went wrong.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  } finally {
    processingInteraction.delete(`${interaction.id}`);
  }
});

// === COMMAND IMPLEMENTATIONS ===
async function handlePanel(interaction) {
  if (
    !interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild) &&
    !interaction.memberPermissions.has(PermissionsBitField.Flags.ManageChannels)
  ) {
    return interaction.reply({ content: 'You need Manage Server/Channels to use this.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const supportRole = interaction.options.getRole('support_role');
  const category = interaction.options.getChannel('category');
  const title = interaction.options.getString('title') ?? 'Phantom Forge Support';
  const description = interaction.options.getString('description') ?? 'Click the button to open a private ticket.';

  const supportRoleId = supportRole?.id ? BigInt(supportRole.id) : DEFAULT_SUPPORT_ROLE_ID;
  const categoryId = category?.id ? BigInt(category.id) : DEFAULT_CATEGORY_ID;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor('#8000ff')
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

  if (creatingTicketFor.has(userId)) {
    return interaction.editReply({ content: 'Your ticket is already being created… ⏳' });
  }
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
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.AttachFiles
        ],
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
      allowedMentions: {
        parse: [],
        users: [userId],
        roles: supportRoleId ? [supportRoleId.toString()] : []
      },
      embeds: [welcomeEmbed],
      components: [ticketButtons]
    });
  } catch (err) {
    console.error('Open ticket error:', err);
    try { await interaction.editReply({ content: 'Something went wrong creating your ticket.' }); } catch {}
  } finally {
    creatingTicketFor.delete(userId);
  }
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
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true
  });

  await interaction.reply({ content: `${user} has been added to the ticket ✅`, ephemeral: true });
}

async function handleClose(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;
  if (!guild || channel?.type !== ChannelType.GuildText)
    return interaction.reply({ content: 'Use this inside a ticket channel.', ephemeral: true });

  const meta = topicMetaToObj(channel.topic);
  if (!meta.user) return interaction.reply({ content: 'This channel is not a ticket.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });

  // Transcript
  const messages = await channel.messages.fetch({ limit: 100 });
  const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  let txt = `Transcript of #${channel.name}\n\n`;
  for (const m of sorted) {
    const atts = m.attachments?.size
      ? ' ' + [...m.attachments.values()].map(a => `[attachment:${a.name}]`).join(' ')
      : '';
    txt += `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content || ''}${atts}\n`;
  }
  const buffer = Buffer.from(txt, 'utf-8');

  // DM transcript
  let dmOk = false;
  try {
    const user = await client.users.fetch(meta.user);
    await user.send({
      content: `🗂️ Here is the transcript for your ticket **#${channel.name}**.`,
      files: [{ attachment: buffer, name: `${channel.name}-transcript.txt` }]
    });
    dmOk = true;
  } catch {
    dmOk = false;
  }

  if (dmOk) await interaction.editReply({ content: 'Transcript sent via DM ✅ Closing channel…' });
  else await interaction.editReply({ content: 'Could not DM the transcript. Closing channel anyway.' });

  setTimeout(async () => {
    try { await channel.delete('Ticket closed.'); } catch {}
  }, 4000);
}

// === HTTP SERVER FOR RENDER (keeps port open) ===
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
const KEEPALIVE_URL = process.env.KEEPALIVE_URL || `http://localhost:${PORT}/health`;
setInterval(() => {
  try {
    http.get(KEEPALIVE_URL, res => {
      res.on('data', () => {});
      res.on('end', () => {});
    }).on('error', () => {});
  } catch {}
}, 4 * 60 * 1000); // every 4 min

// === LOGIN ===
client.login(TOKEN);
