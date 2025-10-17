// =========================
// Phantom Forge Ticket Bot
// =========================

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ChannelType,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");
const { Octokit } = require("@octokit/rest");
const dotenv = require("dotenv");
dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID;
const CATEGORY_ID = process.env.CATEGORY_ID;
const GITHUB_USER = process.env.GITHUB_USER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// =========================
//  Slash Command Setup
// =========================

const commands = [
  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Verzend het ticketpanel in dit kanaal."),
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log("🔮 Registreren van slash commands...");
    await rest.put(Routes.applicationGuildCommands(client.user?.id || process.env.CLIENT_ID, GUILD_ID), {
      body: commands.map((cmd) => cmd.toJSON()),
    });
    console.log("✅ Slash commands succesvol geregistreerd.");
  } catch (err) {
    console.error("❌ Fout bij het registreren van commands:", err);
  }
})();

// =========================
//  Transcript functie
// =========================

async function uploadTranscript({ guild, channel, user, messages }) {
  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  const html = `
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${channel.name} — Ticket Transcript</title>
<style>
body {
  background: #08000f url('https://i.postimg.cc/zvsvYJGs/Schermafbeelding-2025-10-05-022559.png') center/cover fixed;
  color: white;
  font-family: 'Inter', sans-serif;
  padding: 20px;
}
.wrap {
  background: rgba(0,0,0,0.7);
  border-radius: 16px;
  padding: 20px 28px;
  box-shadow: 0 0 30px rgba(128,0,255,0.4);
  max-width: 900px;
  margin: 40px auto;
}
.msg {
  background: rgba(19,0,37,0.8);
  border: 1px solid #8000ff55;
  border-radius: 10px;
  margin: 10px 0;
  padding: 8px 12px;
}
.author { color: #a877ff; font-weight: bold; }
.time { color: #aaa; font-size: 13px; margin-left: 6px; }
.content { margin-top: 5px; white-space: pre-wrap; }
h1 { color: #a877ff; text-align: center; text-shadow: 0 0 8px #8000ff; }
footer { opacity: .6; text-align: center; margin-top: 30px; }
</style>
</head>
<body>
<div class="wrap">
<h1>Phantom Forge Ticket Transcript</h1>
<p>Server: ${guild.name}<br>
Kanaal: ${channel.name}<br>
Gesloten: ${new Date().toLocaleString()}<br>
Gebruiker: ${user.tag}</p>
<hr>
${messages
  .map(
    (m) => `
<div class="msg">
  <div><span class="author">${m.author?.tag || "Onbekend"}</span>
  <span class="time">${new Date(m.createdTimestamp).toLocaleString()}</span></div>
  <div class="content">${m.content
    ? m.content.replace(/</g, "&lt;").replace(/>/g, "&gt;")
    : "<i>Geen tekst</i>"}</div>
</div>`
  )
  .join("\n")}
<hr>
<footer>💜 Gemaakt door Phantom Forge</footer>
</div>
</body>
</html>`;

  const fileName = `transcripts/ticket-${Date.now()}.html`;

  await octokit.repos.createOrUpdateFileContents({
    owner: GITHUB_USER,
    repo: GITHUB_REPO,
    path: fileName,
    message: `Add transcript ${channel.name}`,
    content: Buffer.from(html).toString("base64"),
    branch: "gh-pages",
  });

  return `https://${GITHUB_USER}.github.io/${GITHUB_REPO}/${fileName}`;
}

// =========================
//  Ready event
// =========================
client.once("ready", () => {
  console.log(`✅ Ingelogd als ${client.user.tag}`);
});

// =========================
//  Command handler
// =========================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "panel") {
    const embed = new EmbedBuilder()
      .setTitle("🎟️ Open een Ticket")
      .setDescription("Klik hieronder om een ticket te openen.\nOnze support helpt je zo snel mogelijk 💜")
      .setColor("#8000FF");

    const button = new ButtonBuilder()
      .setCustomId("open_ticket")
      .setLabel("🎫 Open Ticket")
      .setStyle(ButtonStyle.Primary);

    await interaction.reply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(button)],
    });
  }
});

// =========================
//  Ticket logica
// =========================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  // =========== Open Ticket ===========
  if (interaction.customId === "open_ticket") {
    const existing = interaction.guild.channels.cache.find(
      (ch) => ch.name === `ticket-${interaction.user.id}`
    );
    if (existing)
      return interaction.reply({
        content: "❌ Je hebt al een open ticket!",
        ephemeral: true,
      });

    const channel = await interaction.guild.channels.create({
      name: `ticket-${interaction.user.username}`,
      type: ChannelType.GuildText,
      parent: CATEGORY_ID,
      permissionOverwrites: [
        {
          id: interaction.guild.roles.everyone.id,
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: interaction.user.id,
          allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
        },
        {
          id: SUPPORT_ROLE_ID,
          allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
        },
      ],
    });

    const openEmbed = new EmbedBuilder()
      .setTitle("🎟️ Ticket geopend")
      .setDescription(
        `Bedankt voor het openen van een ticket, <@${interaction.user.id}>.\nSupport <@&${SUPPORT_ROLE_ID}> zal je zo snel mogelijk helpen 💜`
      )
      .setColor("#8000FF");

    const claimBtn = new ButtonBuilder()
      .setCustomId("claim_ticket")
      .setLabel("Claim Ticket")
      .setStyle(ButtonStyle.Secondary);

    const closeBtn = new ButtonBuilder()
      .setCustomId("close_ticket")
      .setLabel("Close Ticket")
      .setStyle(ButtonStyle.Danger);

    await channel.send({
      content: `<@${interaction.user.id}> <@&${SUPPORT_ROLE_ID}>`,
      embeds: [openEmbed],
      components: [new ActionRowBuilder().addComponents(claimBtn, closeBtn)],
    });

    await interaction.reply({
      content: `✅ Ticket geopend: ${channel}`,
      ephemeral: true,
    });
  }

  // =========== Claim Ticket ===========
  if (interaction.customId === "claim_ticket") {
    await interaction.reply({
      content: `💜 Hello <@${interaction.channel.topic || interaction.user.id}>, ik ben <@${interaction.user.id}> van het support team van Phantom Forge. Ik help je graag verder!`,
    });
  }

  // =========== Close Ticket ===========
  if (interaction.customId === "close_ticket") {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.channel;

    const messages = await channel.messages.fetch({ limit: 100 });
    const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const link = await uploadTranscript({
      guild: interaction.guild,
      channel,
      user: interaction.user,
      messages: sorted,
    });

    await interaction.followUp({
      content: `✅ Ticket gesloten. Bekijk het transcript hier:\n${link}`,
      ephemeral: true,
    });

    setTimeout(() => channel.delete().catch(() => {}), 5000);
  }
});

// =========================
//  Login
// =========================
client.login(TOKEN);
