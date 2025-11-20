
const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
// Render will provide a PORT environment variable. Use it, or fallback to 3001 for local dev.
const PORT = process.env.PORT || 3001;

// Enable CORS so your frontend (localhost:5173 or production) can reach this server
app.use(cors());

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
// Hardcoded IDs from your constants.ts
const GUILD_ID = '1336782145833668729'; 
const OWNER_ID = '433262414759198720'; 

if (!DISCORD_BOT_TOKEN) {
    console.error("❌ ERROR: Missing DISCORD_BOT_TOKEN in .env file");
    // We don't exit process here on render to avoid crash loops, but logs will show error
}

// Root endpoint to check if server is running
app.get('/', (req, res) => {
    res.send('Urnisa Bot Server is Running!');
});

app.get('/api/owner', async (req, res) => {
    try {
        // Fetch the member from the guild to get server-specific data (Nickname, Server Avatar)
        // This requires the bot to be in the server and have the SERVER MEMBERS intent enabled in Dev Portal.
        const response = await axios.get(
            `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${OWNER_ID}`,
            {
                headers: {
                    Authorization: `Bot ${DISCORD_BOT_TOKEN}`
                }
            }
        );

        const member = response.data;
        const user = member.user;

        // Construct the correct avatar URL (Server avatar > User avatar > Default)
        let avatarUrl = null;
        if (member.avatar) {
             // Server specific avatar
            avatarUrl = `https://cdn.discordapp.com/guilds/${GUILD_ID}/users/${user.id}/avatars/${member.avatar}.png?size=256`;
        } else if (user.avatar) {
             // Global avatar
            avatarUrl = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=256`;
        } else {
            // Default avatar
            const index = (user.discriminator === '0' ? (BigInt(user.id) >> 22n) % 6n : parseInt(user.discriminator) % 5);
            avatarUrl = `https://cdn.discordapp.com/embed/avatars/${index}.png`;
        }

        // Return a structure that matches our frontend expectations
        const ownerData = {
            id: user.id,
            username: user.username,
            global_name: user.global_name,
            discriminator: user.discriminator,
            nick: member.nick, // The server nickname!
            avatar_url: avatarUrl,
            status: 'offline' // Bot API doesn't give presence easily, assuming offline if not in widget
        };

        res.json(ownerData);

    } catch (error) {
        // Log detailed error for debugging on server logs
        if (error.response) {
            console.error('Discord API Error:', error.response.status, error.response.data);
        } else {
            console.error('Server Error:', error.message);
        }
        res.status(500).json({ error: 'Failed to fetch Discord data' });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Bot API Server running on port ${PORT}`);
});
