import 'dotenv/config';
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

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const DEFAULT_SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID ? BigInt(process.env.SUPPORT_ROLE_ID) : null;
const DEFAULT_CATEGORY_ID = process.env.TICKETS_CATEGORY_ID ? BigInt(process.env.TICKETS_CATEGORY_ID) : null;

if (!TOKEN) {
  console.error('❌ Zet DISCORD_TOKEN in je .env!');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// ====== Anti-duplicate locks ======
const creatingTicketFor = new Set();
const processingInteraction = new Set();

// ---------------- Helpers ----------------
function topicMetaToObj(topic) {
  const meta = { user: null, claimed_by: null };
  if (!topic) return meta;
  try {
    for (const kv of topic.split(';')) {
      const [k, v] = kv.split(':');
      if (k === 'ticket_user') meta.user = v && v !== 'None' ? v : null;
      if (k === 'claimed_by') meta.claimed_by = v && v !== 'None' ? v : null;
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

// ---------------- Slash Commands ----------------
const commands = [
  {
    name: 'panel',
    description: 'Stuur een ticketpaneel in dit kanaal',
    options: [
      { name: 'support_role', description: 'Support-rol die tickets mag zien', type: 8, required: false },
      { name: 'category', description: 'Categorie voor ticketkanalen', type: 7, channel_types: [4], required: false },
      { name: 'title', description: 'Titel van het paneel', type: 3, required: false },
      { name: 'description', description: 'Beschrijving onder het paneel', type: 3, required: false }
    ]
  },
  { name: 'claim', description: 'Claim dit ticket (alleen support)' },
  {
    name: 'add',
    description: 'Voeg een gebruiker toe aan dit ticket',
    options: [{ name: 'user', description: 'Gebruiker om toe te voegen', type: 6, required: true }]
  },
  { name: 'close', description: 'Sluit dit ticket' }
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    const app = await client.application?.fetch();
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(app.id, GUILD_ID), { body: commands });
      console.log('✅ Guild commands gesynchroniseerd');
    } else {
      await rest.put(Routes.applicationCommands(app.id), { body: commands });
      console.log('✅ Globale commands gesynchroniseerd');
    }
  } catch (e) {
    console.error('Fout bij command sync:', e);
  }
}

// ---------------- Ready ----------------
client.once('ready', async () => {
  console.log(`✅ Ingelogd als ${client.user.tag}`);
  await registerCommands();
});

// ---------------- Interaction Handling ----------------
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
    const msg = { content: 'Er ging iets mis.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  } finally {
    processingInteraction.delete(`${interaction.id}`);
  }
});

// ---------------- Commands ----------------
async function handlePanel(interaction) {
  if (
    !interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild) &&
    !interaction.memberPermissions.has(PermissionsBitField.Flags.ManageChannels)
  ) {
    return interaction.reply({ content: 'Je hebt beheerderrechten nodig.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const supportRole = interaction.options.getRole('support_role');
  const category = interaction.options.getChannel('category');
  const title = interaction.options.getString('title') ?? 'Phantom Forge Support';
  const description = interaction.options.getString('description') ?? 'Klik op de knop om een privé-ticket te openen.';

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
    await interaction.editReply('Bestaand ticketpaneel geüpdatet ✅');
  } else {
    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.editReply('Ticketpaneel geplaatst ✅');
  }
}

async function handleOpenTicket(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ content: 'Niet in een server.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  const userId = interaction.user.id;

  if (creatingTicketFor.has(userId)) {
    return interaction.editReply({ content: 'Je ticket is al in aanmaak… ⏳' });
  }
  creatingTicketFor.add(userId);

  try {
    const allChannels = await guild.channels.fetch();
    const existing = allChannels.find(
      ch => ch?.type === ChannelType.GuildText && ch.topic && topicMetaToObj(ch.topic).user === String(userId)
    );
    if (existing) return interaction.editReply({ content: `Je hebt al een open ticket: ${existing}` });

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

    await interaction.editReply({ content: `✅ Ticket aangemaakt: ${channel}` });

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
    console.error('Fout bij open ticket:', err);
    try { await interaction.editReply({ content: 'Er ging iets mis bij het aanmaken van je ticket.' }); } catch {}
  } finally {
    creatingTicketFor.delete(userId);
  }
}

async function handleClaim(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;
  if (!guild || channel?.type !== ChannelType.GuildText)
    return interaction.reply({ content: 'Gebruik dit in een ticketkanaal.', ephemeral: true });

  const meta = topicMetaToObj(channel.topic);
  if (!meta.user) return interaction.reply({ content: 'Dit kanaal is geen ticket.', ephemeral: true });

  await channel.setTopic(makeTopic(meta.user, interaction.user.id));
  await interaction.reply({ content: 'Ticket geclaimd ✅', ephemeral: true });

  await channel.send(
    `hello <@${meta.user}> i am ${interaction.user} from the support team of **Phantom Forge**. i am happy to help u!`
  );
}

async function handleClose(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;
  if (!guild || channel?.type !== ChannelType.GuildText)
    return interaction.reply({ content: 'Gebruik dit in een ticketkanaal.', ephemeral: true });

  const meta = topicMetaToObj(channel.topic);
  if (!meta.user) return interaction.reply({ content: 'Geen ticket.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });

  // Transcript (zoals eerst — gewoon bestand posten)
  const messages = await channel.messages.fetch({ limit: 100 });
  const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  let txt = '';
  for (const m of sorted) {
    const atts = m.attachments?.size
      ? ' ' + [...m.attachments.values()].map(a => `[attachment:${a.name}]`).join(' ')
      : '';
    txt += `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content || ''}${atts}\n`;
  }
  const buffer = Buffer.from(txt, 'utf-8');

  await channel.send({ files: [{ attachment: buffer, name: `${channel.name}-transcript.txt` }] });
  await interaction.editReply({ content: 'Transcript verzonden ✅ Kanaal wordt gesloten...' });

  setTimeout(async () => {
    try { await channel.delete('Ticket gesloten.'); } catch {}
  }, 5000);
}

client.login(TOKEN);
