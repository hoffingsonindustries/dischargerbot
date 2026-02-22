// index.js
require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CREWMAN_ROLE_ID = process.env.CREWMAN_ROLE_ID;
const DISCHARGED_ROLE_ID = process.env.DISCHARGED_ROLE_ID;
const CIV_ROLE_ID = process.env.CIV_ROLE_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

if (!TOKEN || !CREWMAN_ROLE_ID || !DISCHARGED_ROLE_ID || !CIV_ROLE_ID || !LOG_CHANNEL_ID) {
  console.error(
    "Missing env values. Required: DISCORD_TOKEN, CREWMAN_ROLE_ID, DISCHARGED_ROLE_ID, CIV_ROLE_ID, LOG_CHANNEL_ID"
  );
  process.exit(1);
}

const ROLES_TO_REMOVE_ON_DISCHARGE = [
  /* ... your full list ... */
];

function uniq(arr) {
  return [...new Set(arr)];
}

function extractUserIds(text) {
  if (!text) return [];
  const ids = [];
  const mentionRe = /<@!?(\d{15,25})>/g;
  let m;
  while ((m = mentionRe.exec(text)) !== null) ids.push(m[1]);
  const idRe = /\b(\d{15,25})\b/g;
  while ((m = idRe.exec(text)) !== null) ids.push(m[1]);
  return uniq(ids);
}

async function dischargeMember({ guild, me, actorTag, member, reason }) {
  const removedRoleNames = [];
  const blockedRoleNames = [];
  const steps = [];

  const removableConfigured = member.roles.cache
    .filter((r) => r.id !== guild.id)
    .filter((r) => ROLES_TO_REMOVE_ON_DISCHARGE.includes(r.id));

  if (removableConfigured.size > 0) {
    const allowed = removableConfigured.filter(
      (r) => r.position < me.roles.highest.position
    );
    const blocked = removableConfigured.filter(
      (r) => r.position >= me.roles.highest.position
    );

    if (allowed.size > 0) {
      await member.roles.remove(
        allowed.map((r) => r.id),
        `Discharged cleanup by ${actorTag}: ${reason}`
      );
      removedRoleNames.push(...allowed.map((r) => r.name));
      steps.push(`Removed configured roles (${allowed.size})`);
    }
    if (blocked.size > 0) {
      blockedRoleNames.push(...blocked.map((r) => r.name));
      steps.push(`Blocked hierarchy (${blocked.size})`);
    }
  } else {
    steps.push("No configured roles to remove.");
  }

  if (member.roles.cache.has(CREWMAN_ROLE_ID)) {
    await member.roles.remove(
      CREWMAN_ROLE_ID,
      `Discharged by ${actorTag}: ${reason}`
    );
    steps.push('Removed "SSN-780 Crewman"');
  }

  if (!member.roles.cache.has(DISCHARGED_ROLE_ID)) {
    await member.roles.add(
      DISCHARGED_ROLE_ID,
      `Discharged by ${actorTag}: ${reason}`
    );
    steps.push('Added "Discharged"');
  }

  if (!member.roles.cache.has(CIV_ROLE_ID)) {
    await member.roles.add(
      CIV_ROLE_ID,
      `Discharged by ${actorTag}: ${reason}`
    );
    steps.push('Added "Civilian"');
  }

  return { tag: member.user.tag, removedRoleNames, blockedRoleNames, steps };
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// Build slash commands
const dischargeCmd = new SlashCommandBuilder()
  .setName("discharge")
  .setDescription("Discharge a member")
  .addUserOption((opt) =>
    opt.setName("member").setDescription("Member to discharge").setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName("reason").setDescription("Reason").setRequired(false)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles);

const massDischargeCmd = new SlashCommandBuilder()
  .setName("massdischarge")
  .setDescription("Discharge multiple members")
  .addStringOption((opt) =>
    opt
      .setName("members")
      .setDescription("Paste mentions or IDs separated by space or newline")
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName("reason").setDescription("Reason").setRequired(false)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles);

// Register commands for all guilds
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    const body = [dischargeCmd.toJSON(), massDischargeCmd.toJSON()];
    const guilds = await client.guilds.fetch();
    for (const [guildId] of guilds) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body });
    }
    console.log("Registered slash commands.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guild = interaction.guild;
  const me = await guild.members.fetchMe();

  // fetch logging channel
  const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID);

  // /discharge
  if (interaction.commandName === "discharge") {
    const user = interaction.options.getUser("member", true);
    const reason = interaction.options.getString("reason") ?? "No reason provided";

    let member;
    try {
      member = await guild.members.fetch(user.id);
    } catch {
      return interaction.reply({ content: "Member not found.", ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await dischargeMember({
        guild,
        me,
        actorTag: interaction.user.tag,
        member,
        reason,
      });

      // send log embed
      if (logChannel) {
        const embed = new EmbedBuilder()
          .setTitle("Member Discharged")
          .setColor("Red")
          .addFields(
            { name: "User", value: `${result.tag}` },
            { name: "By", value: `${interaction.user.tag}` },
            { name: "Reason", value: reason },
            { name: "Steps", value: result.steps.join("\n") }
          )
          .setTimestamp();
        logChannel.send({ embeds: [embed] });
      }

      return interaction.editReply(`✅ ${result.tag} has been discharged.`);
    } catch (err) {
      console.error(err);
      return interaction.editReply("Failed to discharge.");
    }
  }

  // /massdischarge
  if (interaction.commandName === "massdischarge") {
    const membersText = interaction.options.getString("members", true);
    const reason = interaction.options.getString("reason") ?? "No reason provided";
    const ids = extractUserIds(membersText);

    if (ids.length === 0) {
      return interaction.reply({
        content: "No valid IDs or mentions found.",
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    const successes = [];
    const failures = [];

    for (const id of ids.slice(0, 25)) {
      try {
        const member = await guild.members.fetch(id);
        await dischargeMember({
          guild,
          me,
          actorTag: interaction.user.tag,
          member,
          reason,
        });
        successes.push(id);
      } catch {
        failures.push(id);
      }
    }

    const summary = `Processed: ${successes.length}, Failed: ${failures.length}`;
    if (logChannel) logChannel.send(`Mass discharge by ${interaction.user.tag}: ${summary}`);

    return interaction.editReply(summary);
  }
});

client.login(TOKEN);
