
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
// Render will provide a PORT environment variable. Use it, or fallback to 3001 for local dev.
const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin"; // Default fallback, please change in env

// Middleware to parse JSON bodies
app.use(express.json());

// Enable CORS for all origins to ensure the frontend can always connect
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// --- MONGODB CONNECTION ---
const MONGO_URI = process.env.MONGO_URI;

if (MONGO_URI) {
    mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));
} else {
    console.warn("⚠️ MONGO_URI not found in environment variables. Data will not persist!");
}

// Define a simple schema for storing app settings (Key-Value pair)
const SettingSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true }
});

const Setting = mongoose.model('Setting', SettingSchema);

// SANITIZATION: Sometimes users paste "Bot <token>" into the env var. 
// We strip the "Bot " prefix and whitespace to ensure it's just the raw token.
let DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ? process.env.DISCORD_BOT_TOKEN.trim() : "";
if (DISCORD_BOT_TOKEN.startsWith("Bot ")) {
    DISCORD_BOT_TOKEN = DISCORD_BOT_TOKEN.substring(4).trim();
}

// Hardcoded IDs
const GUILD_ID = '1336782145833668729'; 
const OWNER_ID = '433262414759198720'; 
// Default fallback URL if DB is empty or fails
const DEFAULT_SCHEDULE_URL = 'https://cdn.discordapp.com/attachments/1338254150479118347/1439859590152978443/3_am_17.png?ex=6921fbfd&is=6920aa7d&hm=926ad591d323ccc29cd9f7dc2e256de99d8f5dcc292aa3a883f565455844c977&';

// LOGGING: Print startup info to help debug on Render
console.log("--- SERVER STARTING ---");
if (!DISCORD_BOT_TOKEN) {
    console.error("❌ FATAL ERROR: DISCORD_BOT_TOKEN is missing in Environment Variables!");
} else {
    console.log(`✅ Discord Token loaded. Starts with: ${DISCORD_BOT_TOKEN.substring(0, 5)}...`);
}

// Root endpoint to check if server is running
app.get('/', (req, res) => {
    res.send('Urnisa Bot Server is Running!');
});

// --- SCHEDULE ENDPOINTS (DB BACKED) ---

// Get current schedule URL
app.get('/api/schedule', async (req, res) => {
    try {
        // Try to find the setting in the DB
        const setting = await Setting.findOne({ key: 'schedule_url' });
        
        if (setting && setting.value) {
            res.json({ url: setting.value });
        } else {
            // If not in DB, return default
            res.json({ url: DEFAULT_SCHEDULE_URL });
        }
    } catch (error) {
        console.error("Database Error (Get Schedule):", error);
        // Fallback to default on error so the site doesn't break
        res.json({ url: DEFAULT_SCHEDULE_URL });
    }
});

// Update schedule URL (Protected)
app.post('/api/schedule', async (req, res) => {
    const authHeader = req.headers.authorization;
    const { url } = req.body;

    if (!authHeader || authHeader !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized: Incorrect Password' });
    }

    if (!url) {
        return res.status(400).json({ error: 'Missing URL' });
    }

    try {
        // Upsert: Update if exists, Insert if it doesn't
        await Setting.findOneAndUpdate(
            { key: 'schedule_url' },
            { value: url },
            { upsert: true, new: true }
        );
        
        console.log(`📅 Schedule updated in DB to: ${url}`);
        res.json({ success: true, url: url });
    } catch (error) {
        console.error("Database Error (Update Schedule):", error);
        res.status(500).json({ error: 'Failed to update database.' });
    }
});

// --- DISCORD ENDPOINTS ---

app.get('/api/owner', async (req, res) => {
    if (!DISCORD_BOT_TOKEN) {
        console.error("Attempted to fetch owner data, but no token is configured.");
        return res.status(500).json({ error: 'Server configuration error: Missing Bot Token' });
    }

    try {
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

        let avatarUrl = null;
        if (member.avatar) {
            avatarUrl = `https://cdn.discordapp.com/guilds/${GUILD_ID}/users/${user.id}/avatars/${member.avatar}.png?size=256`;
        } else if (user.avatar) {
            avatarUrl = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=256`;
        } else {
            const index = (user.discriminator === '0' ? (BigInt(user.id) >> 22n) % 6n : parseInt(user.discriminator) % 5);
            avatarUrl = `https://cdn.discordapp.com/embed/avatars/${index}.png`;
        }

        const ownerData = {
            id: user.id,
            username: user.username,
            global_name: user.global_name,
            discriminator: user.discriminator,
            nick: member.nick,
            avatar_url: avatarUrl,
            status: 'offline'
        };

        res.json(ownerData);

    } catch (error) {
        if (error.response) {
            console.error('❌ Discord API Error:', error.response.status, error.response.data);
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
        return res.status(500).json({ error: 'Server configuration error: Missing Bot Token' });
    }

    try {
        const response = await axios.get(
            `https://discord.com/api/v10/channels/${channelId}/messages?limit=20`,
            {
                headers: {
                    Authorization: `Bot ${DISCORD_BOT_TOKEN}`
                }
            }
        );

        const messages = response.data.map(msg => ({
            id: msg.id,
            content: msg.content,
            timestamp: msg.timestamp,
            author: {
                id: msg.author.id,
                username: msg.author.username,
                global_name: msg.author.global_name,
                avatar: msg.author.avatar,
                discriminator: msg.author.discriminator
            },
            member: msg.member ? {
                nick: msg.member.nick,
                avatar: msg.member.avatar
            } : null,
            attachments: msg.attachments || [],
            sticker_items: msg.sticker_items || [],
            mentions: msg.mentions || [],
            reactions: msg.reactions ? msg.reactions.map(r => ({
                emoji: r.emoji,
                count: r.count,
                me: r.me
            })) : [],
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

        res.json(messages.reverse());

    } catch (error) {
        if (error.response) {
            console.error('❌ Discord API Error (Messages):', error.response.status);
        } else {
            console.error('❌ Server Error (Messages):', error.message);
        }
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Bot API Server running on port ${PORT}`);
});
