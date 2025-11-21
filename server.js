
const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
// Render will provide a PORT environment variable. Use it, or fallback to 3001 for local dev.
const PORT = process.env.PORT || 3001;

// Enable CORS so your frontend (localhost:5173 or production) can reach this server
app.use(cors());

// SANITIZATION: Sometimes users paste "Bot <token>" into the env var. 
// We strip the "Bot " prefix and whitespace to ensure it's just the raw token.
let DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ? process.env.DISCORD_BOT_TOKEN.trim() : "";
if (DISCORD_BOT_TOKEN.startsWith("Bot ")) {
    DISCORD_BOT_TOKEN = DISCORD_BOT_TOKEN.substring(4).trim();
}

// Hardcoded IDs from your constants.ts
const GUILD_ID = '1336782145833668729'; 
const OWNER_ID = '433262414759198720'; 

// LOGGING: Print startup info to help debug on Render
console.log("--- SERVER STARTING ---");
if (!DISCORD_BOT_TOKEN) {
    console.error("❌ FATAL ERROR: DISCORD_BOT_TOKEN is missing in Environment Variables!");
} else {
    // Log the first 5 chars to verify the correct token is loaded without revealing the whole secret
    console.log(`✅ Token loaded. Starts with: ${DISCORD_BOT_TOKEN.substring(0, 5)}...`);
}

// Root endpoint to check if server is running
app.get('/', (req, res) => {
    res.send('Urnisa Bot Server is Running!');
});

app.get('/api/owner', async (req, res) => {
    if (!DISCORD_BOT_TOKEN) {
        console.error("Attempted to fetch owner data, but no token is configured.");
        return res.status(500).json({ error: 'Server configuration error: Missing Bot Token' });
    }

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
            console.error('❌ Discord API Error:', error.response.status, error.response.data);
            if (error.response.status === 401) {
                 console.error("⚠️ ACTION REQUIRED: Your DISCORD_BOT_TOKEN is invalid. Please update it in Render Environment Variables.");
            }
        } else {
            console.error('❌ Server Error:', error.message);
        }
        res.status(500).json({ error: 'Failed to fetch Discord data' });
    }
});

// Endpoint to fetch channel messages
app.get('/api/messages', async (req, res) => {
    const { channelId } = req.query;

    if (!channelId) {
        return res.status(400).json({ error: 'Missing channelId parameter' });
    }

    if (!DISCORD_BOT_TOKEN) {
        console.error("Attempted to fetch messages, but no token is configured.");
        return res.status(500).json({ error: 'Server configuration error: Missing Bot Token' });
    }

    try {
        // Fetch latest 20 messages from the channel
        const response = await axios.get(
            `https://discord.com/api/v10/channels/${channelId}/messages?limit=20`,
            {
                headers: {
                    Authorization: `Bot ${DISCORD_BOT_TOKEN}`
                }
            }
        );

        // Map data to a simple format for frontend
        const messages = response.data.map(msg => ({
            id: msg.id,
            content: msg.content,
            timestamp: msg.timestamp,
            author: {
                id: msg.author.id,
                username: msg.author.username,
                global_name: msg.author.global_name, // Actual display name
                avatar: msg.author.avatar,
                discriminator: msg.author.discriminator
            },
            member: msg.member ? {
                nick: msg.member.nick, // Server nickname
                avatar: msg.member.avatar // Server specific avatar
            } : null,
            attachments: msg.attachments || [],
            sticker_items: msg.sticker_items || [], // Fetch stickers
            mentions: msg.mentions || [], // Fetch mentions to resolve names
            reactions: msg.reactions ? msg.reactions.map(r => ({
                emoji: r.emoji,
                count: r.count,
                me: r.me
            })) : [],
            // Handle replies
            referenced_message: msg.referenced_message ? {
                id: msg.referenced_message.id,
                author: {
                    id: msg.referenced_message.author.id,
                    username: msg.referenced_message.author.username,
                    global_name: msg.referenced_message.author.global_name,
                    avatar: msg.referenced_message.author.avatar,
                    discriminator: msg.referenced_message.author.discriminator
                },
                content: msg.referenced_message.content,
                mentions: msg.referenced_message.mentions || []
            } : null
        }));

        // Return messages reversed so they appear chronologically (oldest to newest) 
        // if scrolling down, but Discord returns newest first.
        // Typically chat widgets show newest at bottom.
        res.json(messages.reverse());

    } catch (error) {
        if (error.response) {
            console.error('❌ Discord API Error (Messages):', error.response.status, error.response.data);
             if (error.response.status === 403) {
                 console.error("⚠️ PERMISSION ERROR: The bot cannot view this channel. Please ensure the bot is added to the channel and has 'View Channel' and 'Read Message History' permissions.");
            }
        } else {
            console.error('❌ Server Error (Messages):', error.message);
        }
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Bot API Server running on port ${PORT}`);
});
