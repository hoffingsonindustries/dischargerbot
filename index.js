// index.js
require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CREWMAN_ROLE_ID = process.env.CREWMAN_ROLE_ID;
const DISCHARGED_ROLE_ID = process.env.DISCHARGED_ROLE_ID;

// Role required to use the discharge commands
const REQUIRED_ROLE_ID = "961288233856143421";

if (!TOKEN || !GUILD_ID || !CREWMAN_ROLE_ID || !DISCHARGED_ROLE_ID) {
  console.error(
    "Missing .env values. Required: DISCORD_TOKEN, GUILD_ID, CREWMAN_ROLE_ID, DISCHARGED_ROLE_ID"
  );
  process.exit(1);
}

// ----------------------------
// CONFIG: explicit roles to remove on discharge
// ----------------------------
const ROLES_TO_REMOVE_ON_DISCHARGE = [
  "961106083601063946",
  "961106279265353758",
  "961106416268111914",
  "961106475453915167",
  "961106538649485312",
  "961106620123852860",
  "961106774595866734",
  "961106845659975680",
  "1013077678586331206",
  "1133488610948153421",
  "961107157888151552",
  "961107256479457310",
  "961107514387226626",
  "961107580879507529",
  "961108007406686268",
  "1258049450216001596",
  "1042090286760857713",
  "1042091750493257808",
  "1331415989396439052",
  "1331412974623260743",
  "961108159496351775",
  "1331413180320321598",
  "961108098599227404",
  "1137155504595030188",
  "961107730444214364",
  "961107794994540575",
  "961107909075402773",
  "961108310042497045",
  "961108354992865302",
  "961108431320809482",
  "1309751883715448924",
  "961108497188134972",
  "1309752234665316353",
  "1229251422017556601",
  "1309752360960262244",
  "1229250240486572154",
  "1016723394890309643",
  "961110016922890312",
];

// Roles that should never be removed automatically (besides @everyone)
const KEEP_ROLE_IDS = new Set([DISCHARGED_ROLE_ID]);

// ----------------------------
// Helpers
// ----------------------------
function uniq(arr) {
  return [...new Set(arr)];
}

function extractUserIds(text) {
  if (!text) return [];
  const ids = [];

  // Mentions: <@123> or <@!123>
  const mentionRe = /<@!?(\d{15,25})>/g;
  let m;
  while ((m = mentionRe.exec(text)) !== null) ids.push(m[1]);

  // Raw IDs (15-25 digits)
  const idRe = /\b(\d{15,25})\b/g;
  while ((m = idRe.exec(text)) !== null) ids.push(m[1]);

  return uniq(ids);
}

async function dischargeMember({ guild, me, actorTag, member, reason }) {
  const removedRoleNames = [];
  const blockedRoleNames = [];
  const steps = [];

  // 1) Remove configured roles (if present)
  const removableConfigured = member.roles.cache
    .filter((r) => r.id !== guild.id) // not @everyone
    .filter((r) => ROLES_TO_REMOVE_ON_DISCHARGE.includes(r.id))
    .filter((r) => !KEEP_ROLE_IDS.has(r.id));

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
    } else {
      steps.push("Configured roles present, but none removable (hierarchy).");
    }

    if (blocked.size > 0) {
      blockedRoleNames.push(...blocked.map((r) => r.name));
      steps.push(`Blocked by hierarchy (${blocked.size})`);
    }
  } else {
    steps.push("No configured roles found to remove.");
  }

  // 2) Remove Crewman
  if (member.roles.cache.has(CREWMAN_ROLE_ID)) {
    await member.roles.remove(
      CREWMAN_ROLE_ID,
      `Discharged by ${actorTag}: ${reason}`
    );
    steps.push('Removed "SSN-780 Crewman"');
  } else {
    steps.push("Crewman role not present.");
  }

  // 3) Add Discharged
  if (!member.roles.cache.has(DISCHARGED_ROLE_ID)) {
    await member.roles.add(
      DISCHARGED_ROLE_ID,
      `Discharged by ${actorTag}: ${reason}`
    );
    steps.push('Added "Discharged"');
  } else {
    steps.push("Discharged already present.");
  }

  return {
    tag: member.user.tag,
    id: member.id,
    removedRoleNames,
    blockedRoleNames,
    steps,
  };
}

// ----------------------------
// Discord client
// ----------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const dischargeCmd = new SlashCommandBuilder()
  .setName("discharge")
  .setDescription(
    'Discharge ONE member: remove configured roles + remove "SSN-780 Crewman" + add "Discharged".'
  )
  .addUserOption((opt) =>
    opt.setName("member").setDescription("Member to discharge").setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName("reason").setDescription("Optional reason").setRequired(false)
  );

const dischargeBulkCmd = new SlashCommandBuilder()
  .setName("dischargebulk")
  .setDescription("Discharge MULTIPLE members by pasting mentions/IDs (max 25).")
  .addStringOption((opt) =>
    opt
      .setName("members")
      .setDescription("Paste @mentions and/or user IDs, separated by spaces/lines")
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName("reason").setDescription("Optional reason").setRequired(false)
  );

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
    body: [dischargeCmd.toJSON(), dischargeBulkCmd.toJSON()],
  });
  console.log("Slash commands registered.");
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Require specific role to use the bot
  if (!interaction.member?.roles?.cache?.has(REQUIRED_ROLE_ID)) {
    return interaction.reply({
      content: "❌ You do not have permission to use this command.",
      ephemeral: true,
    });
  }

  // Optional extra permission gate (keep or delete this)
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageRoles)) {
    return interaction.reply({
      content: "❌ You need **Manage Roles** to use this.",
      ephemeral: true,
    });
  }

  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({ content: "Guild not found.", ephemeral: true });
  }

  const me = await guild.members.fetchMe();

  const crewmanRole = guild.roles.cache.get(CREWMAN_ROLE_ID);
  const dischargedRole = guild.roles.cache.get(DISCHARGED_ROLE_ID);

  if (!crewmanRole || !dischargedRole) {
    return interaction.reply({
      content: "Role IDs are wrong or roles not found. Check your .env role IDs.",
      ephemeral: true,
    });
  }

  // Bot must be above the roles it will add/remove
  if (
    crewmanRole.position >= me.roles.highest.position ||
    dischargedRole.position >= me.roles.highest.position
  ) {
    return interaction.reply({
      content:
        '❌ My highest role must be **above** both "SSN-780 Crewman" and "Discharged" roles to edit them.',
      ephemeral: true,
    });
  }

  // ----------------------------
  // /discharge (single)
  // ----------------------------
  if (interaction.commandName === "discharge") {
    const user = interaction.options.getUser("member", true);
    const reason =
      interaction.options.getString("reason") ?? "No reason provided";

    let member;
    try {
      member = await guild.members.fetch(user.id);
    } catch {
      return interaction.reply({
        content: "I couldn't find that member in this server.",
        ephemeral: true,
      });
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

      const removed =
        result.removedRoleNames.length > 0
          ? `\n- Removed configured roles: ${result.removedRoleNames
              .map((n) => `**${n}**`)
              .join(", ")}`
          : "\n- No configured discharge roles removed";

      const blocked =
        result.blockedRoleNames.length > 0
          ? `\n- Could not remove (hierarchy): ${result.blockedRoleNames
              .map((n) => `**${n}**`)
              .join(", ")}`
          : "";

      return interaction.editReply(
        `done for **${result.tag}**${removed}${blocked}\n- ${result.steps.join(
          "\n- "
        )}\n**Reason:** ${reason}`
      );
    } catch (err) {
      console.error(err);
      return interaction.editReply(
        "Failed to edit roles (permissions, missing intents, or role hierarchy issue)."
      );
    }
  }

  // ----------------------------
  // /dischargebulk (bulk)
  // ----------------------------
  if (interaction.commandName === "dischargebulk") {
    const membersText = interaction.options.getString("members", true);
    const reason =
      interaction.options.getString("reason") ?? "No reason provided";

    const ids = extractUserIds(membersText);
    if (ids.length === 0) {
      return interaction.reply({
        content:
          "I couldn't find any user IDs or @mentions in that text. Paste mentions like `@User` or raw IDs.",
        ephemeral: true,
      });
    }

    // Safety limit
    const MAX = 25;
    const sliced = ids.slice(0, MAX);
    const extras = ids.length > MAX ? ids.length - MAX : 0;

    await interaction.deferReply({ ephemeral: true });

    const successes = [];
    const failures = [];

    // Small delay reduces risk of hitting role-edit rate limits
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    for (const id of sliced) {
      try {
        const member = await guild.members.fetch(id);
        const res = await dischargeMember({
          guild,
          me,
          actorTag: interaction.user.tag,
          member,
          reason,
        });

        successes.push({
          tag: res.tag,
          removed: res.removedRoleNames.length,
          blocked: res.blockedRoleNames.length,
        });
      } catch (err) {
        failures.push(id);
        console.error(`Bulk discharge failed for ${id}:`, err);
      }

      await sleep(650);
    }

    const lines = [];
    lines.push(`sweeped away the foolish rate lockers`);
    lines.push(`**Reason:** ${reason}`);
    lines.push(
      `**Processed:** ${sliced.length}${extras ? ` (ignored extra ${extras})` : ""}`
    );
    lines.push(`**Success:** ${successes.length}`);
    lines.push(`**Failed:** ${failures.length}`);

    if (successes.length > 0) {
      lines.push(`\n**Successes:**`);
      for (const s of successes.slice(0, 20)) {
        lines.push(
          `- **${s.tag}** (removed roles: ${s.removed}${
            s.blocked ? `, blocked: ${s.blocked}` : ""
          })`
        );
      }
      if (successes.length > 20) {
        lines.push(`- ...and ${successes.length - 20} more`);
      }
    }

    if (failures.length > 0) {
      lines.push(`\n**Failures (couldn't fetch or edit):**`);
      for (const f of failures.slice(0, 20)) lines.push(`- \`${f}\``);
      if (failures.length > 20) lines.push(`- ...and ${failures.length - 20} more`);
    }

    return interaction.editReply(lines.join("\n"));
  }
});

client.login(TOKEN);