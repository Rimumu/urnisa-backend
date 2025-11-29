
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
    lastActivityTime: { type: String, default: new Date().toISOString() }
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

if (SE_CHANNEL_ID) {
    console.log(`✅ StreamElements Configured. Channel ID: ${SE_CHANNEL_ID.substring(0, 5)}...`);
} else {
    console.warn("⚠️ STREAMELEMENTS_CHANNEL_ID is missing.");
}

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
const processNisathonEvent = async (stats, type, user, amount, message, providerId) => {
    // Check duplication if providerId exists
    if (providerId) {
        const exists = await NisathonEvent.findOne({ providerId });
        if (exists) return 0;
    }

    let earnedNisaballs = 0;
    let amountDisplay = "";
    let eventType = type; // normalize types

    if (type === 'subscriber' || type === 'sub') {
        earnedNisaballs = 0.5;
        amountDisplay = "Subscription";
        eventType = 'sub';
        stats.currentSubs += 1;
    } else if (type === 'gift') {
        earnedNisaballs = 0.5 * amount;
        amountDisplay = `${amount} Gift Subs`;
        stats.currentSubs += amount;
    } else if (type === 'cheer' || type === 'bits') {
        earnedNisaballs = amount * 0.002;
        amountDisplay = `${amount} Bits`;
        eventType = 'bits';
        stats.currentBits += amount;
    } else if (type === 'tip' || type === 'donation') {
        earnedNisaballs = amount * 0.2;
        amountDisplay = `$${amount.toFixed(2)}`;
        eventType = 'donation';
        stats.currentDonations += amount;
    }

    // Update Totals
    stats.totalNisaballs = roundOneDecimal(stats.totalNisaballs + earnedNisaballs);

    // Update Timer
    if (!stats.isPaused) {
        const minutesToAdd = earnedNisaballs * 10;
        const msToAdd = minutesToAdd * 60 * 1000;
        const now = new Date().getTime();
        let currentEndTime = new Date(stats.timerEndTime).getTime();
        if (currentEndTime < now) currentEndTime = now;
        stats.timerEndTime = new Date(currentEndTime + msToAdd);
    } else {
        // If paused, just add to the potential remaining buffer
        const minutesToAdd = earnedNisaballs * 10;
        stats.remainingTimeMs += (minutesToAdd * 60 * 1000);
    }

    const newEvent = await NisathonEvent.create({
        providerId: providerId || `sim-${Date.now()}-${Math.random()}`,
        user: user || 'Anonymous',
        type: eventType,
        amountDisplay,
        message,
        nisaballAmount: earnedNisaballs,
        createdAt: new Date()
    });

    // --- SPIN QUEUE LOGIC ---
    // If a single event yields >= 5 Nisaballs, add to queue
    // Note: We use Math.floor because 5 NB = 1 Spin, 10 NB = 2 Spins? 
    // Request asked for: "track the user who has donated 5 Nisaballs at once"
    if (earnedNisaballs >= 5) {
        const spinsEarned = Math.floor(earnedNisaballs / 5);
        for (let i = 0; i < spinsEarned; i++) {
            await SpinQueue.create({
                user: user || 'Anonymous',
                sourceEventId: newEvent._id,
                nisaballs: earnedNisaballs
            });
        }
        console.log(`🎡 Added ${spinsEarned} spins to queue for ${user}`);
    }

    return earnedNisaballs;
};

// --- NISATHON SYNC LOGIC ---
const updateNisathonStats = async () => {
    if (!SE_CHANNEL_ID || !SE_JWT || mongoose.connection.readyState !== 1) return;

    try {
        let stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) {
            stats = await NisathonStats.create({ key: 'main', timerEndTime: new Date(Date.now() + 3 * 60 * 60 * 1000) });
        }

        const lastCheck = stats.lastActivityTime;
        
        // CORRECTED ENDPOINT: /activities/{channelId}
        const response = await axios.get(`https://api.streamelements.com/kappa/v2/activities/${SE_CHANNEL_ID}`, {
            headers: { Authorization: `Bearer ${SE_JWT}` },
            params: { after: lastCheck, limit: 20 }
        });

        const activities = response.data;
        if (activities.length === 0) return; 

        // Sort by date ascending (oldest first) so we process in order
        const sortedActivities = activities.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        let newestDate = lastCheck;
        let changesMade = false;

        for (const act of sortedActivities) {
            newestDate = act.createdAt;
            
            // Map SE types to our types
            let type = act.type;
            let amount = 0;
            const user = act.data.username;
            const message = act.data.message || "";
            const providerId = act._id;

            if (type === 'subscriber') {
                amount = 1;
                // Handle gifts if distinguishable, SE usually sends separate events per sub
            } else if (type === 'cheer') {
                amount = act.data.amount;
            } else if (type === 'tip') {
                amount = act.data.amount;
            } else {
                continue; // Skip followers, hosts, etc.
            }

            const nbAdded = await processNisathonEvent(stats, type, user, amount, message, providerId);
            if (nbAdded > 0 || type === 'subscriber') changesMade = true;
        }

        if (changesMade) {
            stats.lastActivityTime = newestDate;
            await stats.save();
            console.log(`🔄 Synced SE Data.`);
        }

    } catch (error) {
        if (error.response && error.response.status === 404) {
            console.error(`❌ StreamElements 404 Error. Check if Channel ID '${SE_CHANNEL_ID}' is correct (Must be Account ID, not Username)`);
        } else {
            console.error("StreamElements Sync Error:", error.message);
        }
    }
};

setInterval(updateNisathonStats, 60000);

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
        // Save history
        await SpinHistory.create({ user, reward });
        
        // Remove from queue if valid queueId provided
        if (queueId) {
            await SpinQueue.findByIdAndDelete(queueId);
        }
        
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- NISATHON API ---

app.get('/api/nisathon/stats', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.json({ 
                currentSubs: 0, currentBits: 0, currentDonations: 0, 
                totalNisaballs: 0, timerEndTime: new Date().toISOString(),
                isPaused: false
            });
        }
        let stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) {
            stats = await NisathonStats.create({ key: 'main', timerEndTime: new Date(Date.now() + 3 * 60 * 60 * 1000) });
        }
        res.json({
            currentSubs: stats.currentSubs,
            currentBits: stats.currentBits,
            currentDonations: stats.currentDonations,
            totalNisaballs: stats.totalNisaballs,
            timerEndTime: stats.timerEndTime,
            isPaused: stats.isPaused,
            remainingTimeMs: stats.remainingTimeMs
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
        // Add rank
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
        if (stats) {
            const ms = (hours * 3600 + minutes * 60 + seconds) * 1000;
            const now = Date.now();
            
            if (stats.isPaused) {
                stats.remainingTimeMs = ms;
            } else {
                stats.timerEndTime = new Date(now + ms);
            }
            await stats.save();
            res.json({ success: true });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nisathon/timer/add', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    const { minutes } = req.body;
    try {
        const stats = await NisathonStats.findOne({ key: 'main' });
        if (stats) {
            const msToAdd = minutes * 60 * 1000;
            if (stats.isPaused) {
                stats.remainingTimeMs += msToAdd;
            } else {
                const currentEnd = new Date(stats.timerEndTime).getTime();
                const now = Date.now();
                const base = currentEnd > now ? currentEnd : now;
                stats.timerEndTime = new Date(base + msToAdd);
            }
            await stats.save();
            res.json({ success: true });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nisathon/timer/pause', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const stats = await NisathonStats.findOne({ key: 'main' });
        if (stats) {
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
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// TEST EVENT INJECTION
app.post('/api/nisathon/test-event', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    const { type, user, amount } = req.body;
    try {
        const stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) return res.status(404).json({ error: "Stats not init" });

        await processNisathonEvent(stats, type, user, parseFloat(amount), "Test Event", null);
        await stats.save();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// --- CONTENT API (Schedule, Profile, etc.) ---
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
    const { url } = req.body;
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    await Setting.findOneAndUpdate({ key: 'schedule_url' }, { value: url }, { upsert: true });
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
    const { type, data } = req.body;
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    const key = type === 'about' ? 'profile_about' : type === 'credits' ? 'profile_credits' : 'profile_artworks';
    await Setting.findOneAndUpdate({ key }, { value: data }, { upsert: true });
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

// Start Server
const server = app.listen(PORT, () => {
    console.log(`✅ General Backend running on ${PORT}`);
    startKeepAlive();
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
