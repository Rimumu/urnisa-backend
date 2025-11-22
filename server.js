
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

// Define Schema (must be defined before usage)
const SettingSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true }
});
const Setting = mongoose.model('Setting', SettingSchema);

if (MONGO_URI) {
    // Fix for strictQuery deprecation warning
    mongoose.set('strictQuery', false);

    // Add listeners BEFORE connecting to debug issues in Render logs
    mongoose.connection.on('connected', () => console.log("✅ MongoDB Connected successfully"));
    mongoose.connection.on('error', (err) => console.error("❌ MongoDB Runtime Error:", err));
    mongoose.connection.on('disconnected', () => console.warn("⚠️ MongoDB Disconnected"));

    // Connect with options to fail fast if IP is blocked
    mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 5000, // Fail after 5s if IP is blocked (instead of hanging)
        socketTimeoutMS: 45000,
    })
    .catch(err => console.error("❌ Initial MongoDB Connection Failed (Check Atlas Network Access 0.0.0.0/0):", err));
} else {
    console.warn("⚠️ MONGO_URI not found in environment variables. Data will not persist!");
}

// SANITIZATION: sometimes users paste "Bot <token>" into the env var.
let DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ? process.env.DISCORD_BOT_TOKEN.trim() : "";
if (DISCORD_BOT_TOKEN.startsWith("Bot ")) {
    DISCORD_BOT_TOKEN = DISCORD_BOT_TOKEN.substring(4).trim();
}

const GUILD_ID = '1336782145833668729'; 
const OWNER_ID = '433262414759198720'; 
const DEFAULT_SCHEDULE_URL = 'https://cdn.discordapp.com/attachments/1338254150479118347/1439859590152978443/3_am_17.png?ex=6921fbfd&is=6920aa7d&hm=926ad591d323ccc29cd9f7dc2e256de99d8f5dcc292aa3a883f565455844c977&';

console.log("--- SERVER STARTING ---");
if (!DISCORD_BOT_TOKEN) {
    console.error("❌ FATAL ERROR: DISCORD_BOT_TOKEN is missing in Environment Variables!");
} else {
    console.log(`✅ Discord Token loaded. Starts with: ${DISCORD_BOT_TOKEN.substring(0, 5)}...`);
}

// Root endpoint
app.get('/', (req, res) => {
    res.send('Urnisa Bot Server is Running!');
});

// --- AUTH ENDPOINT ---
app.post('/api/verify', (req, res) => {
    const { password } = req.body;
    if (password && password === ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

// --- SCHEDULE ENDPOINTS ---
app.get('/api/schedule', async (req, res) => {
    try {
        if (mongoose.connection.readyState === 1) {
            const setting = await Setting.findOne({ key: 'schedule_url' });
            if (setting && setting.value) {
                return res.json({ url: setting.value });
            }
        }
        res.json({ url: DEFAULT_SCHEDULE_URL });
    } catch (error) {
        console.error("Database Error (Get Schedule):", error);
        res.json({ url: DEFAULT_SCHEDULE_URL });
    }
});

app.post('/api/schedule', async (req, res) => {
    const authHeader = req.headers.authorization;
    const { url } = req.body;

    if (!authHeader || authHeader !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized: Incorrect Password' });
    }
    if (!url) return res.status(400).json({ error: 'Missing URL' });
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ error: 'Database not connected. Please check Render logs.' });
    }

    try {
        await Setting.findOneAndUpdate(
            { key: 'schedule_url' },
            { value: url },
            { upsert: true, new: true }
        );
        console.log(`📅 Schedule updated in DB to: ${url}`);
        res.json({ success: true, url: url });
    } catch (error) {
        console.error("Database Error (Update Schedule):", error);
        res.status(500).json({ error: 'Failed to update database: ' + error.message });
    }
});

// --- PROFILE CONTENT ENDPOINTS (About & Credits) ---

// Get all profile content
app.get('/api/profile', async (req, res) => {
    try {
        const about = await Setting.findOne({ key: 'profile_about' });
        const credits = await Setting.findOne({ key: 'profile_credits' });
        
        res.json({
            about: about ? about.value : [],
            credits: credits ? credits.value : []
        });
    } catch (error) {
        console.error("Database Error (Get Profile):", error);
        res.json({ about: [], credits: [] });
    }
});

// Update profile content (Generic for both sections)
app.post('/api/profile', async (req, res) => {
    const authHeader = req.headers.authorization;
    const { type, data } = req.body; // type: 'about' | 'credits'

    if (!authHeader || authHeader !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!type || !data) return res.status(400).json({ error: 'Missing type or data' });

    const key = type === 'about' ? 'profile_about' : 'profile_credits';

    try {
        await Setting.findOneAndUpdate(
            { key },
            { value: data },
            { upsert: true, new: true }
        );
        res.json({ success: true });
    } catch (error) {
        console.error(`Database Error (Update ${type}):`, error);
        res.status(500).json({ error: 'Failed to update database' });
    }
});

// --- DISCORD ENDPOINTS ---

app.get('/api/owner', async (req, res) => {
    if (!DISCORD_BOT_TOKEN) return res.status(500).json({ error: 'Missing Bot Token' });

    try {
        const response = await axios.get(
            `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${OWNER_ID}`,
            { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
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

        res.json({
            id: user.id,
            username: user.username,
            global_name: user.global_name,
            discriminator: user.discriminator,
            nick: member.nick,
            avatar_url: avatarUrl,
            status: 'offline'
        });

    } catch (error) {
        console.error('❌ Discord API Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch Discord data' });
    }
});

app.get('/api/messages', async (req, res) => {
    const { channelId } = req.query;
    if (!channelId) return res.status(400).json({ error: 'Missing channelId' });
    if (!DISCORD_BOT_TOKEN) return res.status(500).json({ error: 'Missing Bot Token' });

    try {
        const response = await axios.get(
            `https://discord.com/api/v10/channels/${channelId}/messages?limit=20`,
            { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
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
            member: msg.member ? { nick: msg.member.nick, avatar: msg.member.avatar } : null,
            attachments: msg.attachments || [],
            sticker_items: msg.sticker_items || [],
            mentions: msg.mentions || [],
            reactions: msg.reactions ? msg.reactions.map(r => ({ emoji: r.emoji, count: r.count, me: r.me })) : [],
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
        console.error('❌ Discord API Error (Messages):', error.message);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Bot API Server running on port ${PORT}`);
});
