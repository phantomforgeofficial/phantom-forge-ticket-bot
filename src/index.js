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

// ---------------- Helper functies ----------------
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
async function findExistingTicket(guild, userId) {
  return guild.channels.cache.find(
    ch => ch.type === ChannelType.GuildText && ch.topic && topicMetaToObj(ch.topic).user === String(userId)
  );
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

// ---------------- Slash Commands ----------------
const commands = [
  {
    name: 'pannel',
    description: 'Stuur een ticketpaneel in dit kanaal',
    options: [
      {
        name: 'support_role',
        description: 'Support-rol die tickets mag zien',
        type: 8,
        required: false
      },
      {
        name: 'category',
        description: 'Categorie voor ticketkanalen',
        type: 7,
        channel_types: [4],
        required: false
      },
      {
        name: 'title',
        description: 'Titel van het paneel',
        type: 3,
        required: false
      },
      {
        name: 'description',
        description: 'Beschrijving onder het paneel',
        type: 3,
        required: false
      }
    ]
  },
  { name: 'claim', description: 'Claim dit ticket (alleen support)' },
  {
    name: 'add',
    description: 'Voeg een gebruiker toe aan dit ticket',
    options: [
      { name: 'user', description: 'Gebruiker om toe te voegen', type: 6, required: true }
    ]
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

// ---------------- Ready Event ----------------
client.once('ready', async () => {
  console.log(`✅ Ingelogd als ${client.user.tag}`);
  await registerCommands();
});

// ---------------- Interaction Handling ----------------
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      if (commandName === 'pannel') return handlePannel(interaction);
      if (commandName === 'claim') return handleClaim(interaction);
      if (commandName === 'add') return handleAdd(interaction);
      if (commandName === 'close') return handleClose(interaction);
    } else if (interaction.isButton()) {
      if (interaction.customId === 'open_ticket_btn') return handleOpenTicket(interaction);
    }
  } catch (e) {
    console.error(e);
    const msg = { content: 'Er ging iets mis.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

// ---------------- Commands ----------------
async function handlePannel(interaction) {
  if (
    !interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild) &&
    !interaction.memberPermissions.has(PermissionsBitField.Flags.ManageChannels)
  )
    return interaction.reply({ content: 'Je hebt beheerderrechten nodig.', ephemeral: true });

  const supportRole = interaction.options.getRole('support_role');
  const category = interaction.options.getChannel('category');
  const title = interaction.options.getString('title') ?? 'Phantom Forge Support';
  const description = interaction.options.getString('description') ?? 'Klik op de knop om een privé-ticket te openen.';

  const supportRoleId = supportRole?.id ? BigInt(supportRole.id) : DEFAULT_SUPPORT_ROLE_ID;
  const categoryId = category?.id ? BigInt(category.id) : DEFAULT_CATEGORY_ID;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x5865f2)
    .setFooter({ text: panelFooterText(supportRoleId, categoryId) });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open_ticket_btn').setLabel('Open ticket 🎫').setStyle(ButtonStyle.Primary)
  );

  await interaction.channel.send({ embeds: [embed], components: [row] });
  await interaction.reply({ content: 'Ticketpaneel geplaatst ✅', ephemeral: true });
}

async function handleOpenTicket(interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ content: 'Niet in een server.', ephemeral: true });

  const existing = await findExistingTicket(guild, interaction.user.id);
  if (existing) return interaction.reply({ content: `Je hebt al een ticket: ${existing}`, ephemeral: true });

  const embed = interaction.message.embeds?.[0];
  const { supportRoleId, categoryId } = parseFooter(embed);

  const baseName = `ticket-${interaction.user.username}`.toLowerCase().replace(/\\s+/g, '-').slice(0, 90);
  const overwrites = [
    { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel], type: OverwriteType.Role },
    { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles], type: OverwriteType.Member },
    { id: guild.members.me.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles], type: OverwriteType.Member }
  ];
  if (supportRoleId) {
    overwrites.push({ id: supportRoleId.toString(), allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles], type: OverwriteType.Role });
  }

  const channel = await guild.channels.create({
    name: baseName,
    type: ChannelType.GuildText,
    parent: categoryId ? categoryId.toString() : undefined,
    topic: makeTopic(interaction.user.id, null),
    permissionOverwrites: overwrites
  });

  await interaction.reply({ content: `Ticket aangemaakt: ${channel}`, ephemeral: true });
  await channel.send(`Welkom ${interaction.user}! Gebruik /claim (staff), /add of /close.`);
}

async function handleClaim(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;
  if (!guild || channel?.type !== ChannelType.GuildText)
    return interaction.reply({ content: 'Gebruik dit in een ticketkanaal.', ephemeral: true });
  const meta = topicMetaToObj(channel.topic);
  if (!meta.user) return interaction.reply({ content: 'Geen ticket.', ephemeral: true });

  const isSupport = interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages) ||
    (DEFAULT_SUPPORT_ROLE_ID && interaction.member.roles.cache.has(DEFAULT_SUPPORT_ROLE_ID.toString()));
  if (!isSupport)
    return interaction.reply({ content: 'Alleen support kan claimen.', ephemeral: true });

  await channel.setTopic(makeTopic(meta.user, interaction.user.id));
  await interaction.reply({ content: 'Ticket geclaimd ✅', ephemeral: true });
  await channel.send(`hello <@${meta.user}> i am ${interaction.user} from the support team of **Phantom Forge**. i am happy to help u!`);
}

async function handleAdd(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;
  if (!guild || channel?.type !== ChannelType.GuildText)
    return interaction.reply({ content: 'Gebruik dit in een ticketkanaal.', ephemeral: true });
  const meta = topicMetaToObj(channel.topic);
  if (!meta.user) return interaction.reply({ content: 'Geen ticket.', ephemeral: true });

  const user = interaction.options.getUser('user', true);
  await channel.permissionOverwrites.edit(user.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true
  });
  await interaction.reply({ content: `${user} toegevoegd aan ticket ✅` });
}

async function handleClose(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;
  if (!guild || channel?.type !== ChannelType.GuildText)
    return interaction.reply({ content: 'Gebruik dit in een ticketkanaal.', ephemeral: true });
  const meta = topicMetaToObj(channel.topic);
  if (!meta.user) return interaction.reply({ content: 'Geen ticket.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  const messages = await channel.messages.fetch({ limit: 100 });
  const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  let txt = `Transcript van #${channel.name}\\nGesloten door: ${interaction.user.tag}\\n\\n`;
  for (const m of sorted) txt += `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content}\\n`;
  const buffer = Buffer.from(txt, 'utf-8');

  await channel.send({ content: 'Ticket wordt gesloten.', files: [{ attachment: buffer, name: `${channel.name}-transcript.txt` }] });
  await interaction.editReply({ content: 'Ticket gesloten ✅' });
  setTimeout(() => channel.delete().catch(() => {}), 5000);
}

client.login(TOKEN);
