const fs = require("fs/promises");
const path = require("path");

// ========================================================
// CONFIGURATION
// ========================================================

const GROUP_ID = "971966282";
const MINIMUM_RANK = 6;

const API_KEY = process.env.ROBLOX_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const CHECK_INTERVAL =
    Number(process.env.CHECK_INTERVAL || 60000);

// Railway persistent volume will be /data.
// Locally, it falls back to the current folder.
const DATA_DIRECTORY =
    process.env.RAILWAY_VOLUME_MOUNT_PATH || ".";

const STATE_FILE =
    path.join(DATA_DIRECTORY, "state.json");


// ========================================================
// CHECK CONFIG
// ========================================================

if (!API_KEY) {
    console.error("ERROR: ROBLOX_API_KEY is missing.");
    process.exit(1);
}

if (!DISCORD_WEBHOOK_URL) {
    console.error("ERROR: DISCORD_WEBHOOK_URL is missing.");
    process.exit(1);
}


// ========================================================
// ROBLOX OPEN CLOUD
// ========================================================

async function robloxRequest(url) {

    const response = await fetch(url, {
        headers: {
            "x-api-key": API_KEY,
            "Accept": "application/json"
        }
    });

    if (!response.ok) {

        const body = await response.text();

        throw new Error(
            `Roblox API returned ${response.status}: ${body}`
        );
    }

    return response.json();
}


// ========================================================
// GET ALL GROUP ROLES
// ========================================================

async function getRoles() {

    const roles = [];

    let pageToken = "";

    do {

        const url = new URL(
            `https://apis.roblox.com/cloud/v2/groups/${GROUP_ID}/roles`
        );

        url.searchParams.set("maxPageSize", "100");

        if (pageToken) {
            url.searchParams.set(
                "pageToken",
                pageToken
            );
        }

        const data = await robloxRequest(url);

        const returnedRoles =
            data.groupRoles ||
            data.roles ||
            [];

        roles.push(...returnedRoles);

        pageToken =
            data.nextPageToken || "";

    } while (pageToken);

    return roles;
}


// ========================================================
// NORMALISE ROLE INFORMATION
// ========================================================

function parseRole(role) {

    const resourceName =
        role.path ||
        role.name ||
        "";

    const roleId =
        String(
            role.id ||
            role.roleId ||
            resourceName.split("/").pop()
        );

    const displayName =
        role.displayName ||
        role.display_name ||
        role.name ||
        `Role ${roleId}`;

    const rank =
        Number(
            role.rank ??
            role.rankNumber ??
            role.rank_number ??
            0
        );

    return {
        id: roleId,
        name: displayName,
        rank
    };
}


// ========================================================
// GET ALL MEMBERSHIPS
// ========================================================

async function getMemberships() {

    const memberships = [];

    let pageToken = "";

    do {

        const url = new URL(
            `https://apis.roblox.com/cloud/v2/groups/${GROUP_ID}/memberships`
        );

        url.searchParams.set(
            "maxPageSize",
            "100"
        );

        if (pageToken) {
            url.searchParams.set(
                "pageToken",
                pageToken
            );
        }

        const data = await robloxRequest(url);

        const returnedMemberships =
            data.groupMemberships ||
            data.memberships ||
            [];

        memberships.push(
            ...returnedMemberships
        );

        pageToken =
            data.nextPageToken || "";

    } while (pageToken);

    return memberships;
}


// ========================================================
// EXTRACT USER ID
// ========================================================

function getUserId(membership) {

    if (membership.userId) {
        return String(membership.userId);
    }

    if (membership.user?.id) {
        return String(membership.user.id);
    }

    if (typeof membership.user === "string") {
        return membership.user
            .split("/")
            .pop();
    }

    if (membership.user) {

        const resource =
            membership.user.name ||
            membership.user.path;

        if (resource) {
            return resource
                .split("/")
                .pop();
        }
    }

    return null;
}


// ========================================================
// EXTRACT ROLE ID
// ========================================================

function getRoleId(membership) {

    const role =
        membership.role ||
        membership.roles?.[0];

    if (!role) {
        return null;
    }

    if (typeof role === "string") {
        return role
            .split("/")
            .pop();
    }

    if (role.id) {
        return String(role.id);
    }

    if (role.roleId) {
        return String(role.roleId);
    }

    const resource =
        role.name ||
        role.path;

    if (resource) {
        return resource
            .split("/")
            .pop();
    }

    return null;
}


// ========================================================
// GET ROBLOX USERNAME
// ========================================================

async function getUsername(userId) {

    try {

        const response = await fetch(
            `https://users.roblox.com/v1/users/${userId}`
        );

        if (!response.ok) {
            return `User ${userId}`;
        }

        const data = await response.json();

        return data.name ||
            `User ${userId}`;

    } catch {

        return `User ${userId}`;
    }
}


// ========================================================
// LOAD SAVED STATE
// ========================================================

async function loadState() {

    try {

        const contents =
            await fs.readFile(
                STATE_FILE,
                "utf8"
            );

        return JSON.parse(contents);

    } catch {

        return null;
    }
}


// ========================================================
// SAVE STATE
// ========================================================

async function saveState(state) {

    await fs.mkdir(
        DATA_DIRECTORY,
        { recursive: true }
    );

    await fs.writeFile(
        STATE_FILE,
        JSON.stringify(
            state,
            null,
            2
        )
    );
}


// ========================================================
// DISCORD WEBHOOK
// ========================================================

async function sendDiscordWebhook(embed) {

    const response = await fetch(
        DISCORD_WEBHOOK_URL,
        {
            method: "POST",

            headers: {
                "Content-Type":
                    "application/json"
            },

            body: JSON.stringify({
                username:
                    "Roblox Staff Monitor",

                embeds: [embed]
            })
        }
    );

    if (!response.ok) {

        const body =
            await response.text();

        throw new Error(
            `Discord returned ${response.status}: ${body}`
        );
    }
}


// ========================================================
// DEPARTURE NOTIFICATION
// ========================================================

async function sendDeparture(user) {

    const unixTime =
        Math.floor(Date.now() / 1000);

    const embed = {

        title: "🚨 Staff Departure",

        description:
            `**${user.username}** is no longer rank ${MINIMUM_RANK}+.`,

        fields: [

            {
                name: "Username",
                value:
                    `[${user.username}](https://www.roblox.com/users/${user.userId}/profile)`,
                inline: true
            },

            {
                name: "User ID",
                value: user.userId,
                inline: true
            },

            {
                name: "Previous Role",
                value:
                    `${user.roleName} (Rank ${user.rank})`,
                inline: false
            },

            {
                name: "Detected",
                value:
                    `<t:${unixTime}:F>\n<t:${unixTime}:R>`,
                inline: false
            }

        ],

        timestamp:
            new Date().toISOString(),

        footer: {
            text:
                `Group ${GROUP_ID} • Rank ${MINIMUM_RANK}+ Monitor`
        }
    };

    await sendDiscordWebhook(embed);
}


// ========================================================
// NEW STAFF NOTIFICATION
// ========================================================

async function sendJoined(user) {

    const unixTime =
        Math.floor(Date.now() / 1000);

    const embed = {

        title: "⬆️ Staff Added",

        description:
            `**${user.username}** is now rank ${MINIMUM_RANK}+.`,

        fields: [

            {
                name: "Username",
                value:
                    `[${user.username}](https://www.roblox.com/users/${user.userId}/profile)`,
                inline: true
            },

            {
                name: "Role",
                value:
                    `${user.roleName} (Rank ${user.rank})`,
                inline: true
            },

            {
                name: "Detected",
                value:
                    `<t:${unixTime}:F>\n<t:${unixTime}:R>`,
                inline: false
            }

        ],

        timestamp:
            new Date().toISOString()
    };

    await sendDiscordWebhook(embed);
}


// ========================================================
// ROLE CHANGE
// ========================================================

async function sendRoleChange(oldUser, newUser) {

    const unixTime =
        Math.floor(Date.now() / 1000);

    const embed = {

        title: "🔄 Staff Role Changed",

        description:
            `**${newUser.username}** changed roles.`,

        fields: [

            {
                name: "Username",
                value:
                    `[${newUser.username}](https://www.roblox.com/users/${newUser.userId}/profile)`,
                inline: false
            },

            {
                name: "Previous",
                value:
                    `${oldUser.roleName} (Rank ${oldUser.rank})`,
                inline: true
            },

            {
                name: "New",
                value:
                    `${newUser.roleName} (Rank ${newUser.rank})`,
                inline: true
            },

            {
                name: "Detected",
                value:
                    `<t:${unixTime}:F>\n<t:${unixTime}:R>`,
                inline: false
            }

        ],

        timestamp:
            new Date().toISOString()
    };

    await sendDiscordWebhook(embed);
}


// ========================================================
// CREATE STAFF SNAPSHOT
// ========================================================

async function createSnapshot() {

    console.log("Getting group roles...");

    const rawRoles =
        await getRoles();

    const roles = {};

    for (const rawRole of rawRoles) {

        const role =
            parseRole(rawRole);

        roles[role.id] = role;
    }

    const monitoredRoles =
        Object.values(roles)
            .filter(
                role =>
                    role.rank >= MINIMUM_RANK
            );

    console.log(
        `Found ${monitoredRoles.length} monitored roles.`
    );

    for (const role of monitoredRoles) {

        console.log(
            `  Rank ${role.rank}: ${role.name}`
        );
    }

    console.log(
        "Getting group memberships..."
    );

    const memberships =
        await getMemberships();

    const snapshot = {};

    for (const membership of memberships) {

        const userId =
            getUserId(membership);

        const roleId =
            getRoleId(membership);

        if (!userId || !roleId) {
            continue;
        }

        const role =
            roles[roleId];

        if (!role) {
            continue;
        }

        if (role.rank < MINIMUM_RANK) {
            continue;
        }

        const username =
            await getUsername(userId);

        snapshot[userId] = {

            userId,
            username,

            roleId:
                role.id,

            roleName:
                role.name,

            rank:
                role.rank
        };
    }

    return snapshot;
}


// ========================================================
// CHECK FOR CHANGES
// ========================================================

async function checkGroup() {

    console.log("");
    console.log(
        `[${new Date().toISOString()}] Checking group...`
    );

    // IMPORTANT:
    // If Roblox throws an error here,
    // nothing below runs and our previous state
    // is preserved.

    const current =
        await createSnapshot();

    const previous =
        await loadState();

    console.log(
        `Currently monitoring ${
            Object.keys(current).length
        } staff members.`
    );


    // ====================================================
    // FIRST RUN
    // ====================================================

    if (!previous) {

        console.log(
            "First run. Saving initial staff list."
        );

        await saveState(current);

        console.log(
            "Initial snapshot saved."
        );

        return;
    }


    // ====================================================
    // PEOPLE WHO DISAPPEARED FROM RANK 6+
    // ====================================================

    for (
        const [userId, oldUser]
        of Object.entries(previous)
    ) {

        if (!current[userId]) {

            console.log(
                `DEPARTURE: ${oldUser.username}`
            );

            try {

                await sendDeparture(
                    oldUser
                );

            } catch (error) {

                console.error(
                    "Discord departure notification failed:",
                    error
                );
            }
        }
    }


    // ====================================================
    // NEW RANK 6+ MEMBERS
    // ====================================================

    for (
        const [userId, newUser]
        of Object.entries(current)
    ) {

        if (!previous[userId]) {

            console.log(
                `NEW STAFF: ${newUser.username}`
            );

            try {

                await sendJoined(
                    newUser
                );

            } catch (error) {

                console.error(
                    "Discord new staff notification failed:",
                    error
                );
            }

            continue;
        }


        // ================================================
        // ROLE CHANGE WHILE STILL 6+
        // ================================================

        const oldUser =
            previous[userId];

        if (
            oldUser.roleId !==
            newUser.roleId
        ) {

            console.log(
                `ROLE CHANGE: ${newUser.username}`
            );

            try {

                await sendRoleChange(
                    oldUser,
                    newUser
                );

            } catch (error) {

                console.error(
                    "Discord role notification failed:",
                    error
                );
            }
        }
    }


    // Only save after successful Roblox retrieval.

    await saveState(current);

    console.log(
        "Check complete."
    );
}


// ========================================================
// PREVENT OVERLAPPING CHECKS
// ========================================================

let checking = false;

async function safeCheck() {

    if (checking) {
        console.log(
            "Previous check still running. Skipping."
        );

        return;
    }

    checking = true;

    try {

        await checkGroup();

    } catch (error) {

        console.error(
            "CHECK FAILED:",
            error
        );

        console.error(
            "Previous state has NOT been overwritten."
        );

    } finally {

        checking = false;
    }
}


// ========================================================
// START
// ========================================================

async function start() {

    console.log(
        "======================================"
    );

    console.log(
        " Roblox 24/7 Staff Monitor"
    );

    console.log(
        "======================================"
    );

    console.log(
        `Group: ${GROUP_ID}`
    );

    console.log(
        `Minimum Rank: ${MINIMUM_RANK}`
    );

    console.log(
        `Check every: ${
            CHECK_INTERVAL / 1000
        } seconds`
    );

    console.log(
        `State file: ${STATE_FILE}`
    );

    console.log(
        "======================================"
    );

    // Check immediately.

    await safeCheck();

    // Then continuously check.

    setInterval(
        safeCheck,
        CHECK_INTERVAL
    );
}

start();
