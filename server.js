const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
// Render will provide a PORT environment variable.
const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin"; 

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// --- MONGODB CONNECTION ---
const MONGO_URI = process.env.MONGO_URI;

// Schemas
const SettingSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true }
});
const Setting = mongoose.model('Setting', SettingSchema);

const NisathonStatsSchema = new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    currentSubs: { type: Number, default: 0 },
    currentBits: { type: Number, default: 0 },
    currentDonations: { type: Number, default: 0 },
    totalNisaballs: { type: Number, default: 0 }, 
    timerEndTime: { type: Date, default: Date.now },
    remainingTimeMs: { type: Number, default: 0 }, // Used when paused
    isPaused: { type: Boolean, default: false },
    activeEvent: { type: String, default: null }, // e.g., 'DOUBLE_TIMER'
    lastActivityTime: { type: String, default: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString() } 
});
const NisathonStats = mongoose.model('NisathonStats', NisathonStatsSchema);

// New Schema for individual events (History & Leaderboard)
const NisathonEventSchema = new mongoose.Schema({
    providerId: { type: String, unique: true }, // StreamElements ID to prevent dupes
    user: { type: String, required: true },
    type: { type: String, required: true }, // 'sub', 'gift', 'bits', 'donation'
    amountDisplay: { type: String, required: true }, // "5 Subs", "$50", "100 Bits"
    message: String,
    nisaballAmount: { type: Number, default: 0 }, // How much NB this event added
    createdAt: { type: Date, default: Date.now }
});
const NisathonEvent = mongoose.model('NisathonEvent', NisathonEventSchema);

// --- WHEEL SCHEMAS ---
const SpinQueueSchema = new mongoose.Schema({
    user: { type: String, required: true },
    sourceEventId: { type: String }, // Link to the donation event
    nisaballs: Number, // How much they donated to earn this
    createdAt: { type: Date, default: Date.now }
});
const SpinQueue = mongoose.model('SpinQueue', SpinQueueSchema);

const SpinHistorySchema = new mongoose.Schema({
    user: { type: String, required: true },
    reward: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
});
const SpinHistory = mongoose.model('SpinHistory', SpinHistorySchema);


if (MONGO_URI) {
    mongoose.set('strictQuery', false);
    mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 5000, 
        socketTimeoutMS: 45000,
    })
    .then(() => console.log("✅ MongoDB Connected successfully"))
    .catch(err => console.error("❌ MongoDB Connection Failed:", err));
} else {
    console.warn("⚠️ MONGO_URI not found. Data will not persist!");
}

// Env Vars for Uploads
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || process.env.VITE_IMGBB_API_KEY;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

// StreamElements Config
const SE_CHANNEL_ID = process.env.STREAMELEMENTS_CHANNEL_ID;
const SE_JWT = process.env.STREAMELEMENTS_JWT;

const DEFAULT_SCHEDULE_URL = 'https://cdn.discordapp.com/attachments/1338254150479118347/1439859590152978443/3_am_17.png?ex=6921fbfd&is=6920aa7d&hm=926ad591d323ccc29cd9f7dc2e256de99d8f5dcc292aa3a883f565455844c977&';

console.log("--- GENERAL BACKEND STARTING ---");

const roundOneDecimal = (num) => Math.round(num * 10) / 10;

app.get('/', (req, res) => res.send('Urnisa General Backend is Running!'));

// --- AUTH ---
app.post('/api/verify', (req, res) => {
    const { password } = req.body;
    res.json(password === ADMIN_PASSWORD ? { success: true } : { error: 'Invalid password' });
});

// --- HELPER: Process Event ---
const processNisathonEvent = async (stats, type, user, amount, message, providerId, tier = '1000') => {
    let isNewEvent = true;

    // Check duplication if providerId exists
    if (providerId) {
        const existingEvent = await NisathonEvent.findOne({ providerId });
        if (existingEvent) {
            isNewEvent = false;
        }
    }

    let earnedNisaballs = 0;
    let amountDisplay = "";
    let eventType = type; 

    // Normalize Sub Types
    if (['subscriber', 'sub', 'resub', 'subscription'].includes(type)) {
        let tierLabel = "Tier 1";
        let tierVal = 0.5;
        const tierStr = String(tier || '1000').toLowerCase();

        if (tierStr.includes('3000') || tierStr.includes('tier 3')) {
            tierVal = 2.0;
            tierLabel = "Tier 3";
        } else if (tierStr.includes('2000') || tierStr.includes('tier 2')) {
            tierVal = 1.0;
            tierLabel = "Tier 2";
        } else if (tierStr.includes('prime')) {
            tierVal = 0.5;
            tierLabel = "Prime";
        }

        earnedNisaballs = tierVal;
        amountDisplay = `${tierLabel} Sub`;
        eventType = 'sub';
        
        if (isNewEvent) stats.currentSubs += 1;
    } else if (type === 'gift') {
        earnedNisaballs = 0.5 * amount;
        amountDisplay = `${amount} Gift Subs`;
        if (isNewEvent) stats.currentSubs += amount;
    } else if (['cheer', 'bits'].includes(type)) {
        earnedNisaballs = amount * 0.002; // 500 bits = 1 NB
        amountDisplay = `${amount} Bits`;
        eventType = 'bits';
        if (isNewEvent) stats.currentBits += amount;
    } else if (['tip', 'donation'].includes(type)) {
        earnedNisaballs = amount * 0.2;
        amountDisplay = `$${amount.toFixed(2)}`;
        eventType = 'donation';
        if (isNewEvent) stats.currentDonations += amount;
    }

    if (isNewEvent) {
        stats.totalNisaballs = roundOneDecimal(stats.totalNisaballs + earnedNisaballs);
        const timeMultiplier = stats.activeEvent === 'DOUBLE_TIMER' ? 2 : 1;
        
        if (!stats.isPaused) {
            const minutesToAdd = earnedNisaballs * 10 * timeMultiplier;
            const msToAdd = minutesToAdd * 60 * 1000;
            const now = new Date().getTime();
            let currentEndTime = new Date(stats.timerEndTime).getTime();
            if (currentEndTime < now) currentEndTime = now;
            stats.timerEndTime = new Date(currentEndTime + msToAdd);
        } else {
            const minutesToAdd = earnedNisaballs * 10 * timeMultiplier;
            stats.remainingTimeMs += (minutesToAdd * 60 * 1000);
        }
    }

    const eventData = {
        providerId: providerId || `sim-${Date.now()}-${Math.random()}`,
        user: user || 'Anonymous',
        type: eventType,
        amountDisplay,
        message,
        nisaballAmount: earnedNisaballs,
        createdAt: isNewEvent ? new Date() : undefined
    };

    Object.keys(eventData).forEach(key => eventData[key] === undefined && delete eventData[key]);

    const resultEvent = await NisathonEvent.findOneAndUpdate(
        { providerId: eventData.providerId },
        eventData,
        { upsert: true, new: true }
    );

    if (isNewEvent) {
        console.log(`✅ Event Processed: +${earnedNisaballs} NB (x${stats.activeEvent === 'DOUBLE_TIMER' ? 2 : 1}) for ${user}`);
        
        if (earnedNisaballs >= 5) {
            const spinsEarned = Math.floor(earnedNisaballs / 5);
            for (let i = 0; i < spinsEarned; i++) {
                await SpinQueue.create({
                    user: user || 'Anonymous',
                    sourceEventId: resultEvent._id,
                    nisaballs: earnedNisaballs
                });
            }
            console.log(`🎡 Added ${spinsEarned} spins to queue for ${user}`);
        }
    }

    return earnedNisaballs;
};

// --- STREAMELEMENTS DIAGNOSTIC ---
const diagnoseStreamElements = async () => {
    if (!SE_JWT || !SE_CHANNEL_ID) {
        console.error("❌ ERROR: Missing Config. Check SE_JWT and STREAMELEMENTS_CHANNEL_ID");
        return;
    }
    
    try {
        console.log("🔍 DIAGNOSING CONFIGURATION...");
        
        // 1. Who owns the token?
        const meRes = await axios.get('https://api.streamelements.com/kappa/v2/channels/me', {
            headers: { Authorization: `Bearer ${SE_JWT}` }
        });
        console.log(`   - Token Owner: ${meRes.data.username} (ID: ${meRes.data._id})`);

        // 2. Who does the Channel ID belong to?
        // If this 404s, the ID is invalid.
        try {
            const chanRes = await axios.get(`https://api.streamelements.com/kappa/v2/channels/${SE_CHANNEL_ID}`, {
                headers: { Authorization: `Bearer ${SE_JWT}` }
            });
            console.log(`   - Configured ID (${SE_CHANNEL_ID}) belongs to: ${chanRes.data.username}`);
            
            if (chanRes.data._id !== SE_CHANNEL_ID) {
                 console.log(`   ⚠️ WARNING: ID mismatch? API returned ${chanRes.data._id}`);
            }
            
        } catch (e) {
            console.error(`   ❌ ERROR: Configured Channel ID (${SE_CHANNEL_ID}) NOT FOUND or Invalid!`);
            console.error(`      Ensure you are using the Account ID (24 chars), not the Twitch ID.`);
        }

    } catch (error) {
        console.error("❌ SE Auth Failed:", error.message);
    }
};

// --- NISATHON SYNC LOGIC ---
const updateNisathonStats = async (forceBackfill = false) => {
    if (!SE_CHANNEL_ID || !SE_JWT || mongoose.connection.readyState !== 1) return;

    try {
        let stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) {
            stats = await NisathonStats.create({ key: 'main', timerEndTime: new Date(Date.now() + 3 * 60 * 60 * 1000) });
        }

        let limit = forceBackfill ? 500 : 100;
        const url = `https://api.streamelements.com/kappa/v2/activities/${SE_CHANNEL_ID}`;
        
        // Explicitly Log URL on Startup
        if (forceBackfill) console.log(`📡 Fetching Activities from: ${url}`);

        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${SE_JWT}` },
            params: { limit: limit },
            timeout: 15000
        });

        const activities = response.data;
        
        if (!activities || activities.length === 0) {
            console.log(`❌ API returned 0 activities. Check if channel has history.`);
            return; 
        }

        if (forceBackfill) console.log(`📥 Downloaded ${activities.length} activities.`);

        const sortedActivities = activities.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        let newestDate = stats.lastActivityTime;
        let changesMade = false;

        for (const act of sortedActivities) {
            newestDate = act.createdAt;
            
            // DEBUG TARGET
            if (act.data.username && act.data.username.toLowerCase() === 'greatrimu') {
                console.log(`👀 FOUND TARGET: ${act.type} | ID: ${act._id} | Tier: ${act.data.tier}`);
            }

            let type = act.type;
            let amount = 0;
            let tier = '1000';
            
            const user = act.data.username;
            const message = act.data.message || "";
            const providerId = act._id;

            if (['subscriber', 'sub', 'resub', 'subscription'].includes(type)) {
                amount = 1;
                if (act.data.tier) tier = act.data.tier;
            } 
            else if (type === 'gift') {
                amount = act.data.amount || 1;
            }
            else if (['cheer', 'bits'].includes(type)) {
                amount = act.data.amount;
            } 
            else if (['tip', 'donation'].includes(type)) {
                amount = act.data.amount;
            } 
            else {
                continue; 
            }

            const nbAdded = await processNisathonEvent(stats, type, user, amount, message, providerId, tier);
            if (nbAdded > 0) changesMade = true;
        }

        if (changesMade || forceBackfill) {
            stats.lastActivityTime = newestDate;
            await stats.save();
            if (changesMade) console.log(`✅ Database Updated.`);
        }

    } catch (error) {
        console.error("❌ Sync Error:", error.message);
        if (error.response) console.error("   Details:", JSON.stringify(error.response.data));
    }
};

// Start Server
const server = app.listen(PORT, async () => {
    console.log(`✅ General Backend running on ${PORT}`);
    
    // 1. Diagnose ID
    await diagnoseStreamElements();
    
    // 2. Backfill
    console.log("🚀 Running Startup Backfill...");
    await updateNisathonStats(true);
    
    // 3. Loop
    setInterval(() => updateNisathonStats(false), 30000);
    
    startKeepAlive();
});

// --- WHEEL API ---
app.get('/api/wheel/queue', async (req, res) => {
    try {
        const queue = await SpinQueue.find().sort({ createdAt: 1 });
        res.json(queue);
    } catch (e) { res.json([]); }
});

app.get('/api/wheel/history', async (req, res) => {
    try {
        const history = await SpinHistory.find().sort({ timestamp: -1 });
        res.json(history);
    } catch (e) { res.json([]); }
});

app.post('/api/wheel/spin-result', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    const { user, reward, queueId } = req.body;
    try {
        await SpinHistory.create({ user, reward });
        if (queueId) await SpinQueue.findByIdAndDelete(queueId);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- NISATHON API ---
app.get('/api/nisathon/stats', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) return res.json({ currentSubs: 0, currentBits: 0, currentDonations: 0, totalNisaballs: 0, timerEndTime: new Date().toISOString(), isPaused: false, activeEvent: null });
        let stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) stats = await NisathonStats.create({ key: 'main', timerEndTime: new Date(Date.now() + 3 * 60 * 60 * 1000) });
        res.json({
            currentSubs: stats.currentSubs,
            currentBits: stats.currentBits,
            currentDonations: stats.currentDonations,
            totalNisaballs: stats.totalNisaballs,
            timerEndTime: stats.timerEndTime,
            isPaused: stats.isPaused,
            remainingTimeMs: stats.remainingTimeMs,
            activeEvent: stats.activeEvent
        });
    } catch (error) { res.status(500).json({ error: 'Failed to fetch stats' }); }
});

app.get('/api/nisathon/leaderboard', async (req, res) => {
    try {
        const leaderboard = await NisathonEvent.aggregate([
            { $group: { _id: "$user", totalNisaballs: { $sum: "$nisaballAmount" } } },
            { $sort: { totalNisaballs: -1 } },
            { $limit: 10 },
            { $project: { user: "$_id", totalNisaballs: { $round: ["$totalNisaballs", 1] }, _id: 0 } }
        ]);
        const ranked = leaderboard.map((item, index) => ({ rank: index + 1, ...item }));
        res.json(ranked);
    } catch (e) { res.json([]); }
});

app.get('/api/nisathon/recent', async (req, res) => {
    try {
        const recent = await NisathonEvent.find().sort({ createdAt: -1 }).limit(10);
        res.json(recent);
    } catch (e) { res.json([]); }
});

// TIMER CONTROLS
app.post('/api/nisathon/timer/set', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    const { hours, minutes, seconds } = req.body;
    try {
        const stats = await NisathonStats.findOne({ key: 'main' });
        const ms = (hours * 3600 + minutes * 60 + seconds) * 1000;
        const now = Date.now();
        if (stats.isPaused) stats.remainingTimeMs = ms;
        else stats.timerEndTime = new Date(now + ms);
        await stats.save();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nisathon/timer/add', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    const { minutes } = req.body;
    try {
        const stats = await NisathonStats.findOne({ key: 'main' });
        const msToAdd = minutes * 60 * 1000;
        if (stats.isPaused) stats.remainingTimeMs += msToAdd;
        else {
            const currentEnd = new Date(stats.timerEndTime).getTime();
            const now = Date.now();
            const base = currentEnd > now ? currentEnd : now;
            stats.timerEndTime = new Date(base + msToAdd);
        }
        await stats.save();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nisathon/timer/pause', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const stats = await NisathonStats.findOne({ key: 'main' });
        const now = Date.now();
        if (stats.isPaused) {
            // RESUME
            stats.isPaused = false;
            stats.timerEndTime = new Date(now + stats.remainingTimeMs);
            stats.remainingTimeMs = 0;
        } else {
            // PAUSE
            const currentEnd = new Date(stats.timerEndTime).getTime();
            stats.remainingTimeMs = Math.max(0, currentEnd - now);
            stats.isPaused = true;
        }
        await stats.save();
        res.json({ success: true, isPaused: stats.isPaused });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nisathon/event', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const stats = await NisathonStats.findOne({ key: 'main' });
        stats.activeEvent = req.body.activeEvent;
        await stats.save();
        res.json({ success: true, activeEvent: stats.activeEvent });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nisathon/test-event', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    const { type, user, amount, tier } = req.body; 
    try {
        const stats = await NisathonStats.findOne({ key: 'main' });
        await processNisathonEvent(stats, type, user, parseFloat(amount), "Test Event", null, tier);
        await stats.save();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// RESET ALL DATA
app.post('/api/nisathon/reset', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    try {
        await NisathonEvent.deleteMany({});
        await SpinQueue.deleteMany({});
        await SpinHistory.deleteMany({});
        
        await NisathonStats.findOneAndUpdate({ key: 'main' }, {
            currentSubs: 0, currentBits: 0, currentDonations: 0, totalNisaballs: 0,
            timerEndTime: new Date(Date.now() + 3 * 60 * 60 * 1000), // Default 3 hours
            remainingTimeMs: 0,
            isPaused: false, activeEvent: null,
            // Reset Last Checked time to 24h ago so next sync pulls recent history
            lastActivityTime: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString()
        });

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// FORCE SYNC (LAST 24 HOURS)
app.post('/api/nisathon/sync', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const stats = await NisathonStats.findOne({ key: 'main' });
        if (stats) {
            // Trigger manual sync looking back 24 hours
            await updateNisathonStats(true);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: "Stats not found" });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- CONTENT API ---
app.get('/api/schedule', async (req, res) => {
    try {
        if (mongoose.connection.readyState === 1) {
            const setting = await Setting.findOne({ key: 'schedule_url' });
            if (setting && setting.value) return res.json({ url: setting.value });
        }
        res.json({ url: DEFAULT_SCHEDULE_URL });
    } catch (e) { res.json({ url: DEFAULT_SCHEDULE_URL }); }
});

app.post('/api/schedule', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    await Setting.findOneAndUpdate({ key: 'schedule_url' }, { value: req.body.url }, { upsert: true });
    res.json({ success: true });
});

app.get('/api/profile', async (req, res) => {
    try {
        const about = await Setting.findOne({ key: 'profile_about' });
        const credits = await Setting.findOne({ key: 'profile_credits' });
        const artworks = await Setting.findOne({ key: 'profile_artworks' });
        res.json({ about: about?.value || [], credits: credits?.value || [], artworks: artworks?.value || [] });
    } catch (e) { res.json({ about: [], credits: [], artworks: [] }); }
});

app.post('/api/profile', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    const key = `profile_${req.body.type}`;
    await Setting.findOneAndUpdate({ key }, { value: req.body.data }, { upsert: true });
    res.json({ success: true });
});

app.get('/api/goals', async (req, res) => {
    try {
        const goals = await Setting.findOne({ key: 'nisathon_goals' });
        res.json({ goals: goals?.value || null });
    } catch (e) { res.json({ goals: null }); }
});

app.post('/api/goals', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    await Setting.findOneAndUpdate({ key: 'nisathon_goals' }, { value: req.body.goals }, { upsert: true });
    res.json({ success: true });
});

app.get('/api/wheel', async (req, res) => {
    try {
        const wheel = await Setting.findOne({ key: 'wheel_items' });
        res.json({ items: wheel?.value || null });
    } catch (e) { res.json({ items: null }); }
});

app.post('/api/wheel', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    await Setting.findOneAndUpdate({ key: 'wheel_items' }, { value: req.body.items }, { upsert: true });
    res.json({ success: true });
});

app.post('/api/upload', async (req, res) => {
    const { image } = req.body;
    if (!image) return res.status(400).json({ success: false });

    if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
        try {
            const timestamp = Math.round((new Date()).getTime() / 1000);
            const signature = crypto.createHash('sha1').update(`timestamp=${timestamp}${CLOUDINARY_API_SECRET}`).digest('hex');
            const formData = new FormData();
            formData.append('file', `data:image/jpeg;base64,${image}`);
            formData.append('api_key', CLOUDINARY_API_KEY);
            formData.append('timestamp', timestamp);
            formData.append('signature', signature);
            const r = await axios.post(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
            return res.json({ success: true, data: { url: r.data.secure_url } });
        } catch (e) { return res.status(500).json({ success: false }); }
    }
    if (IMGBB_API_KEY) {
        try {
            const formData = new FormData();
            formData.append('image', image);
            const r = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
            return res.json(r.data);
        } catch (e) { return res.status(500).json({ success: false }); }
    }
    return res.status(500).json({ success: false });
});

// --- CROSS-PING KEEP ALIVE ---
const SELF_URL = 'https://urnisa-backend.onrender.com';
const BOT_URL = 'https://urnisa-bot.onrender.com';

function startKeepAlive() {
    setInterval(() => {
        axios.get(SELF_URL).catch(() => {});
        axios.get(BOT_URL).catch(() => {});
        console.log("⏰ Keep-Alive Ping sent to Backend & Bot");
    }, 5 * 60 * 1000);
}
