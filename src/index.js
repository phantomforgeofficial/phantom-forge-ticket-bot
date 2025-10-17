// =========================
// Phantom Forge Ticket Bot (CommonJS)
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

// ---- ENV
const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID;
const CATEGORY_ID = process.env.CATEGORY_ID?.trim() || ""; // mag leeg
const GITHUB_USER = process.env.GITHUB_USER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// =========================
// Helpers
// =========================

// Haal categorie op en valideer type
async function resolveCategory(guild) {
  if (!CATEGORY_ID) return { category: null, reason: "Geen CATEGORY_ID gezet." };
  try {
    // Probeer uit cache
    let cat = guild.channels.cache.get(CATEGORY_ID);
    if (!cat) {
      // fetch uit API
      cat = await guild.channels.fetch(CATEGORY_ID).catch(() => null);
    }
    if (!cat) {
      return { category: null, reason: `Categorie met ID ${CATEGORY_ID} niet gevonden.` };
    }
    if (cat.type !== ChannelType.GuildCategory) {
      return { category: null, reason: `Kanaal ${CATEGORY_ID} is geen categorie (type=${cat.type}).` };
    }
    return { category: cat, reason: "OK" };
  } catch (e) {
    return { category: null, reason: `Fout bij ophalen categorie: ${e.message}` };
  }
}

// Upload transcript naar GitHub Pages (branch gh-pages)
async function uploadTranscript({ guild, channel, openerUser, closerUser, messages }) {
  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  const rows = messages.map(m => {
    const name = m.author?.tag || m.author?.id || "Onbekend";
    const time = new Date(m.createdTimestamp).toLocaleString();
    const text = (m.content || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const atts = m.attachments?.size
      ? [...m.attachments.values()].map(a => `<a href="${a.url}" target="_blank" rel="noopener">📎 ${a.name}</a>`).join(" ")
      : "";
    return `<div class="msg"><div class="h"><b class="author">${name}</b><span class="time">${time}</span></div><div class="content">${text} ${atts}</div></div>`;
  }).join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${channel.name} — Ticket Transcript</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  body{margin:0;min-height:100vh;color:#fff;font:15px/1.5 Inter,system-ui,sans-serif;
    background:url('https://i.postimg.cc/zvsvYJGs/Schermafbeelding-2025-10-05-022559.png') center/cover no-repeat fixed}
  .wrap{max-width:900px;margin:40px auto;background:rgba(0,0,0,.65);border-radius:16px;padding:20px 28px;
    box-shadow:0 0 40px rgba(128,0,255,.25)}
  h1{margin:0 0 6px;font-size:26px;color:#a877ff;text-shadow:0 0 10px rgba(128,0,255,.5)}
  .meta{color:#a77fff;font-size:14px;margin-bottom:12px}
  .msg{background:rgba(19,0,37,.85);border:1px solid #2a0b4d;border-radius:12px;padding:10px 14px;margin:8px 0}
  .msg:hover{border-color:#8000ff;box-shadow:0 0 10px rgba(128,0,255,.25)}
  .h{display:flex;gap:8px;align-items:baseline}
  .author{color:#a877ff}
  .time{color:#aaa;font-size:12px}
  .content{margin-top:4px;white-space:pre-wrap;line-height:1.5}
  footer{text-align:center;margin-top:24px;opacity:.75;color:#a77fff}
  a{color:#a877ff}
</style></head>
<body><div class="wrap">
  <h1>Ticket Transcript</h1>
  <div class="meta">
    Server: <b>${guild.name}</b> • Channel: <b>#${channel.name}</b><br/>
    Opened by: ${openerUser?.tag || openerUser?.id} • Closed by: ${closerUser?.tag || closerUser?.id}<br/>
    Closed at: ${new Date().toLocaleString()}
  </div>
  ${rows || "<i>No content</i>"}
  <footer>Made with 💜 by Phantom Forge</footer>
</div></body></html>`;

  const filename = `transcripts/${channel.name}-${Date.now()}.html`;

  // Upload HTML
  await octokit.repos.createOrUpdateFileContents({
    owner: GITHUB_USER,
    repo: GITHUB_REPO,
    path: filename,
    message: `Add transcript ${channel.name}`,
    content: Buffer.from(html, "utf-8").toString("base64"),
    branch: "gh-pages",
  });

  // Update index.json (lijst op de site)
  const indexPath = "data/index.json";
  // Eerst proberen bestaande index op te halen
  let sha = null;
  let list = [];
  try {
    const existing = await octokit.repos.getContent({
      owner: GITHUB_USER, repo: GITHUB_REPO, path: indexPath, ref: "gh-pages",
    });
    if (existing && "content" in existing.data) {
      const buf = Buffer.from(existing.data.content, "base64").toString("utf-8");
      sha = existing.data.sha;
      list = JSON.parse(buf);
      if (!Array.isArray(list)) list = [];
    }
  } catch { /* geen index nog */ }

  list.push({
    file: filename.split("/").pop(),
    url: filename,
    channel: `#${channel.name}`,
    guild: guild.name,
    userId: openerUser?.id,
    userTag: openerUser?.tag || openerUser?.id,
    closedBy: closerUser?.tag || closerUser?.id,
    closedAt: Date.now(),
  });

  await octokit.repos.createOrUpdateFileContents({
    owner: GITHUB_USER,
    repo: GITHUB_REPO,
    path: indexPath,
    message: `Update index with ${filename}`,
    content: Buffer.from(JSON.stringify(list, null, 2), "utf-8").toString("base64"),
    branch: "gh-pages",
    sha: sha || undefined,
  });

  return `https://${GITHUB_USER}.github.io/${GITHUB_REPO}/${filename}`;
}

// =========================
// Slash command: /panel
// =========================
const commands = [
  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Verzend het ticket panel in dit kanaal."),
];

// Registreer commands NA login (zodat client.user.id bestaat)
client.once("ready", async () => {
  console.log(`✅ Ingelogd als ${client.user.tag}`);
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, GUILD_ID),
      { body: commands.map(c => c.toJSON()) }
    );
    console.log("🎯 Slash commands geregistreerd.");
  } catch (e) {
    console.error("❌ Commands registreren faalde:", e);
  }
});

// =========================
// Interactions
// =========================
client.on("interactionCreate", async (interaction) => {
  try {
    // /panel
    if (interaction.isChatInputCommand() && interaction.commandName === "panel") {
      const embed = new EmbedBuilder()
        .setColor("#8000FF")
        .setTitle("🎟️ Open een Ticket")
        .setDescription("Klik hieronder om een ticket te openen. Ons supportteam helpt je zo snel mogelijk 💜");

      // LET OP: paars/blurple = Primary (Discord beperkt kleuren van knoppen)
      const openBtn = new ButtonBuilder()
        .setCustomId("open_ticket")
        .setLabel("💜 Open Ticket")
        .setStyle(ButtonStyle.Primary);

      await interaction.reply({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(openBtn)],
      });
      return;
    }

    // Buttons
    if (!interaction.isButton()) return;

    // Open ticket
    if (interaction.customId === "open_ticket") {
      // Uniek kanaal per gebruiker
      const already = interaction.guild.channels.cache.find(
        ch => ch.type === ChannelType.GuildText && ch.name === `ticket-${interaction.user.id}`
      );
      if (already) {
        return interaction.reply({ content: `❌ Je hebt al een ticket: ${already}`, ephemeral: true });
      }

      // Categorie ophalen/valideren
      const { category, reason } = await resolveCategory(interaction.guild);
      if (!category) {
        console.warn(`ℹ️ Ticket wordt zonder categorie gemaakt: ${reason}`);
      }

      const perms = [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
      ];
      if (SUPPORT_ROLE_ID) {
        perms.push({ id: SUPPORT_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] });
      }

      const ch = await interaction.guild.channels.create({
        name: `ticket-${interaction.user.id}`,
        type: ChannelType.GuildText,
        parent: category?.id || undefined, // alleen zetten als geldig
        permissionOverwrites: perms,
      });

      // Paarse look embeds + knoppen
      const info = new EmbedBuilder()
        .setColor("#8000FF")
        .setTitle("🎟️ Ticket geopend")
        .setDescription(`Bedankt voor het openen van een ticket, <@${interaction.user.id}>.\nSupport <@&${SUPPORT_ROLE_ID}> helpt je zo 💜`);

      const claimBtn = new ButtonBuilder()
        .setCustomId("claim_ticket")
        .setLabel("💜 Claim")
        .setStyle(ButtonStyle.Primary); // paars/blurple

      const closeBtn = new ButtonBuilder()
        .setCustomId("close_ticket")
        .setLabel("Close")
        .setStyle(ButtonStyle.Danger);

      await ch.send({
        content: `<@${interaction.user.id}> ${SUPPORT_ROLE_ID ? `<@&${SUPPORT_ROLE_ID}>` : ""}`,
        embeds: [info],
        components: [new ActionRowBuilder().addComponents(claimBtn, closeBtn)],
      });

      await interaction.reply({ content: `✅ Ticket geopend: ${ch}`, ephemeral: true });
      return;
    }

    // Claim
    if (interaction.customId === "claim_ticket") {
      await interaction.reply({
        content: `💜 Hello <@${interaction.message.mentions?.users?.first()?.id || ""}> ik ben <@${interaction.user.id}> van het support team van Phantom Forge. Ik help je graag!`,
      });
      return;
    }

    // Close -> transcript upload
    if (interaction.customId === "close_ticket") {
      await interaction.deferReply({ ephemeral: true });
      const channel = interaction.channel;
      if (channel.type !== ChannelType.GuildText) {
        return interaction.editReply({ content: "Dit werkt alleen in een ticketkanaal." });
      }

      // Berichten ophalen (laatste 100)
      const msgs = await channel.messages.fetch({ limit: 100 });
      const sorted = [...msgs.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      // opener is de eerste @mention in het eerste ticketbericht (of probeer uit kanaalnaam)
      let openerId = sorted[0]?.mentions?.users?.first()?.id || channel.name.split("ticket-")[1] || null;
      const openerUser = openerId ? await client.users.fetch(openerId).catch(() => null) : null;

      let url;
      try {
        url = await uploadTranscript({
          guild: interaction.guild,
          channel,
          openerUser,
          closerUser: interaction.user,
          messages: sorted,
        });
      } catch (e) {
        console.error("Transcript upload faalde:", e);
        return interaction.editReply({ content: "❌ Upload naar website mislukte. Check je GITHUB_* env en repo/branch." });
      }

      // DM naar opener + meld in kanaal
      if (openerUser) {
        const dmEmbed = new EmbedBuilder()
          .setColor("#8000FF")
          .setTitle(`🎫 Ticket Closed on ${interaction.guild.name}`)
          .setDescription(`Your ticket on **${interaction.guild.name}** has been closed.\nYou can view the transcript here:`);

        const linkRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("📜 View Transcript").setURL(url)
        );
        await openerUser.send({ embeds: [dmEmbed], components: [linkRow] }).catch(() => {});
      }

      await interaction.editReply({ content: "✅ Transcript geüpload en verzonden. Kanaal sluit in 5s..." });
      setTimeout(() => channel.delete("Ticket gesloten"), 5000);
      return;
    }
  } catch (err) {
    console.error("Fout in interaction handler:", err);
    if (interaction.isRepliable()) {
      interaction.reply({ content: "Er is iets misgegaan.", ephemeral: true }).catch(() => {});
    }
  }
});

// =========================
// Start
// =========================
client.login(TOKEN);
