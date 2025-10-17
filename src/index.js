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

// ========== ENV ==========
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const DEFAULT_SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID ? BigInt(process.env.SUPPORT_ROLE_ID) : null;
const DEFAULT_CATEGORY_ID = process.env.TICKETS_CATEGORY_ID ? BigInt(process.env.TICKETS_CATEGORY_ID) : null;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // voor transcript (gist scope)

if (!TOKEN) {
  console.error('❌ Zet DISCORD_TOKEN in je .env!');
  process.exit(1);
}

// ========== CLIENT ==========
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// ========== LOCKS ==========
const creatingTicketFor = new Set();     // per user
const processingInteraction = new Set(); // per interaction

// ========== HELPERS ==========
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

// Zoek of er al een paneel in dit kanaal staat met dezelfde config (footer)
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

// Upload transcript als HTML naar GitHub Gist en retourneer de URL
async function uploadTranscriptToGist(filename, html, isPublic = false) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN ontbreekt (met gist scope)');
  const body = {
    description: `Phantom Forge Ticket Transcript - ${filename}`,
    public: isPublic,
    files: { [filename]: { content: html } }
  };
  const res = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gist upload failed: ${res.status} ${txt}`);
  }
  const data = await res.json();
  return data.html_url;
}

// ========== SLASH COMMANDS ==========
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

// ========== READY ==========
client.once('ready', async () => {
  console.log(`✅ Ingelogd als ${client.user.tag}`);
  await registerCommands();
});

// ========== INTERACTIONS ==========
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

// ========== HANDLERS ==========
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

    // anti-spam
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(() => {});
    await channel.permissionOverwrites.edit(userId, { SendMessages: true }).catch(() => {});
    if (supportRoleId) {
      await channel.permissionOverwrites.edit(supportRoleId.toString(), { SendMessages: true }).catch(() => {});
    }
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

  const isSupport =
    interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages) ||
    (DEFAULT_SUPPORT_ROLE_ID && interaction.member.roles.cache.has(DEFAULT_SUPPORT_ROLE_ID.toString())) ||
    interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
    interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);

  if (!isSupport) return interaction.reply({ content: 'Alleen support kan claimen.', ephemeral: true });

  await channel.setTopic(makeTopic(meta.user, interaction.user.id));
  await interaction.reply({ content: 'Ticket geclaimd ✅', ephemeral: true });

  await channel.send(
    `hello <@${meta.user}> i am ${interaction.user} from the support team of **Phantom Forge**. i am happy to help u!`
  );
}

async function handleAdd(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;
  if (!guild || channel?.type !== ChannelType.GuildText)
    return interaction.reply({ content: 'Gebruik dit in een ticketkanaal.', ephemeral: true });

  const meta = topicMetaToObj(channel.topic);
  if (!meta.user) return interaction.reply({ content: 'Geen ticket.', ephemeral: true });

  const user = interaction.options.getUser('user', true);

  const isOwner = String(interaction.user.id) === meta.user;
  const isSupport =
    interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages) ||
    (DEFAULT_SUPPORT_ROLE_ID && interaction.member.roles.cache.has(DEFAULT_SUPPORT_ROLE_ID.toString()));
  const isAdmin =
    interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
    interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);

  if (!(isOwner || isSupport || isAdmin))
    return interaction.reply({ content: 'Je mag geen personen toevoegen aan dit ticket.', ephemeral: true });

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

  const isOwner = String(interaction.user.id) === meta.user;
  const isSupport =
    interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages) ||
    (DEFAULT_SUPPORT_ROLE_ID && interaction.member.roles.cache.has(DEFAULT_SUPPORT_ROLE_ID.toString()));
  const isAdmin =
    interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
    interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);

  if (!(isOwner || isSupport || isAdmin))
    return interaction.reply({ content: 'Je mag dit ticket niet sluiten.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });

  // Berichten ophalen
  const messages = await channel.messages.fetch({ limit: 100 });
  const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  // HTML transcript
  const rows = sorted.map(m => {
    const time = new Date(m.createdTimestamp).toLocaleString();
    const name = m.author?.tag ?? m.author?.id ?? 'Unknown';
    const content = (m.content || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\n/g,'<br>');
    const atts = m.attachments?.size
      ? [...m.attachments.values()].map(a => `<a href="${a.url}" target="_blank" rel="noopener">📎 ${a.name}</a>`).join(' ')
      : '';
    return `<div class="msg"><div class="meta">[${time}] <b>${name}</b></div><div class="text">${content} ${atts}</div></div>`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>Transcript #${channel.name}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{background:#0f0f14;color:#eaeaf0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial,sans-serif;margin:0;padding:24px;}
  .wrap{max-width:900px;margin:0 auto;}
  h1{margin:0 0 6px;font-size:22px}
  .sub{opacity:.8;margin:0 0 18px;font-size:13px}
  .msg{background:#181826;border:1px solid #2a2a40;border-radius:12px;padding:12px 14px;margin:10px 0}
  .meta{color:#9aa0a6;font-size:12px;margin-bottom:6px}
  .text{font-size:14px;line-height:1.4;word-break:break-word}
  a{color:#8a5fff}
</style></head>
<body><div class="wrap">
  <h1>Transcript #${channel.name}</h1>
  <div class="sub">Closed by: ${interaction.user.tag} (${interaction.user.id}) · Guild: ${guild.name}</div>
  ${rows || '<i>No content</i>'}
</div></body></html>`;

  // Upload naar Gist (secret)
  const filename = `${channel.name}-${Date.now()}.html`;
  let url;
  try {
    url = await uploadTranscriptToGist(filename, html, false);
  } catch (e) {
    console.error(e);
    return interaction.editReply({ content: '❌ Upload naar website (Gist) mislukte.' });
  }

  // DM embed + knop (geen link in het ticket)
  const user = await client.users.fetch(meta.user).catch(() => null);
  const transcriptEmbed = new EmbedBuilder()
    .setColor('#8000ff')
    .setTitle(`🎫 Ticket Closed on ${guild.name}`)
    .setDescription(`Your ticket on the server **${guild.name}** has been closed.\nYou can view the transcript here:`)
    .setFooter({ text: 'Phantom Forge Support' });

  const button = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('📜 View Transcript').setStyle(ButtonStyle.Link).setURL(url)
  );

  let dmOk = false;
  if (user) {
    dmOk = await user.send({ embeds: [transcriptEmbed], components: [button] })
      .then(() => true)
      .catch(() => false);
  }

  if (dmOk) {
    await channel.send({ content: '✅ Ticket wordt gesloten. Transcript is per DM naar de opener gestuurd.' }).catch(() => {});
  } else {
    await channel.send({ content: 'ℹ️ Ticket wordt gesloten. Kon geen DM sturen naar de opener (DMs uit?).' }).catch(() => {});
  }

  await interaction.editReply({ content: '✅ Afgerond. Kanaal wordt verwijderd…' });

  setTimeout(async () => {
    try { await channel.delete('Ticket gesloten en transcript via DM verstuurd.'); } catch {}
  }, 5000);
}

// ========== LOGIN ==========
client.login(TOKEN);
