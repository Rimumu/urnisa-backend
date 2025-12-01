const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin"; 

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(cors({ origin: '*' }));

// --- MONGODB CONNECTION ---
const MONGO_URI = process.env.MONGO_URI;

// --- CONFIG ---
const SE_JWT = process.env.STREAMELEMENTS_JWT;
// We start with Env Var, but might auto-correct it later
let ACTIVE_CHANNEL_ID = process.env.STREAMELEMENTS_CHANNEL_ID;

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || process.env.VITE_IMGBB_API_KEY;
const DEFAULT_SCHEDULE_URL = 'https://cdn.discordapp.com/attachments/1338254150479118347/1439859590152978443/3_am_17.png';

// --- SCHEMAS ---
const SettingSchema = new mongoose.Schema({ key: { type: String, unique: true }, value: mongoose.Schema.Types.Mixed });
const Setting = mongoose.model('Setting', SettingSchema);

const NisathonStatsSchema = new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    currentSubs: { type: Number, default: 0 },
    currentBits: { type: Number, default: 0 },
    currentDonations: { type: Number, default: 0 },
    totalNisaballs: { type: Number, default: 0 }, 
    timerEndTime: { type: Date, default: Date.now },
    remainingTimeMs: { type: Number, default: 0 },
    isPaused: { type: Boolean, default: false },
    activeEvent: { type: String, default: null },
    lastActivityTime: { type: String, default: new Date().toISOString() } 
});
const NisathonStats = mongoose.model('NisathonStats', NisathonStatsSchema);

const NisathonEventSchema = new mongoose.Schema({
    providerId: { type: String, unique: true },
    user: { type: String, required: true },
    type: { type: String, required: true },
    amountDisplay: { type: String, required: true },
    message: String,
    nisaballAmount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});
const NisathonEvent = mongoose.model('NisathonEvent', NisathonEventSchema);

const SpinQueueSchema = new mongoose.Schema({
    user: { type: String, required: true },
    sourceEventId: { type: String },
    nisaballs: Number,
    createdAt: { type: Date, default: Date.now }
});
const SpinQueue = mongoose.model('SpinQueue', SpinQueueSchema);

const SpinHistorySchema = new mongoose.Schema({
    user: { type: String, required: true },
    reward: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
});
const SpinHistory = mongoose.model('SpinHistory', SpinHistorySchema);

const roundOneDecimal = (num) => Math.round(num * 10) / 10;

// --- HELPER: Process Event (Upsert) ---
const processNisathonEvent = async (stats, type, user, amount, message, providerId, tier = '1000') => {
    let isNewEvent = true;

    // Check if event already processed
    if (providerId) {
        const existing = await NisathonEvent.findOne({ providerId });
        if (existing) isNewEvent = false; 
    }

    let earnedNisaballs = 0;
    let amountDisplay = "";
    let eventType = type; 

    // Logic for Subs
    if (['subscriber', 'sub', 'resub', 'subscription'].includes(type)) {
        let tVal = 0.5;
        let tLbl = "Tier 1";
        const tStr = String(tier).toLowerCase();
        if (tStr.includes('3000') || tStr.includes('tier 3')) { tVal = 2.0; tLbl = "Tier 3"; }
        else if (tStr.includes('2000') || tStr.includes('tier 2')) { tVal = 1.0; tLbl = "Tier 2"; }
        else if (tStr.includes('prime')) { tVal = 0.5; tLbl = "Prime"; }
        
        earnedNisaballs = tVal;
        amountDisplay = `${tLbl} Sub`;
        eventType = 'sub';
        if (isNewEvent) stats.currentSubs += 1;
    } 
    // Logic for Gifts
    else if (type === 'gift') {
        earnedNisaballs = 0.5 * amount;
        amountDisplay = `${amount} Gift Subs`;
        if (isNewEvent) stats.currentSubs += amount;
    } 
    // Logic for Bits
    else if (['cheer', 'bits'].includes(type)) {
        earnedNisaballs = amount * 0.002;
        amountDisplay = `${amount} Bits`;
        eventType = 'bits';
        if (isNewEvent) stats.currentBits += amount;
    } 
    // Logic for Tips
    else if (['tip', 'donation'].includes(type)) {
        earnedNisaballs = amount * 0.2;
        amountDisplay = `$${amount.toFixed(2)}`;
        eventType = 'donation';
        if (isNewEvent) stats.currentDonations += amount;
    }

    // Add to Stats (Only if new)
    if (isNewEvent) {
        stats.totalNisaballs = roundOneDecimal(stats.totalNisaballs + earnedNisaballs);
        const mult = stats.activeEvent === 'DOUBLE_TIMER' ? 2 : 1;
        const msAdd = earnedNisaballs * 10 * mult * 60000;
        
        if (!stats.isPaused) {
            const now = Date.now();
            const curEnd = new Date(stats.timerEndTime).getTime();
            stats.timerEndTime = new Date(Math.max(now, curEnd) + msAdd);
        } else {
            stats.remainingTimeMs += msAdd;
        }
    }

    // Save/Update Event
    const eventData = {
        providerId: providerId || `sim-${Date.now()}`,
        user: user || 'Anonymous',
        type: eventType,
        amountDisplay,
        message,
        nisaballAmount: earnedNisaballs,
        createdAt: isNewEvent ? new Date() : undefined
    };
    Object.keys(eventData).forEach(k => eventData[k] === undefined && delete eventData[k]);

    const res = await NisathonEvent.findOneAndUpdate(
        { providerId: eventData.providerId }, 
        eventData, 
        { upsert: true, new: true }
    );

    // Add to Wheel Queue
    if (isNewEvent && earnedNisaballs >= 5) {
        const spins = Math.floor(earnedNisaballs / 5);
        console.log(`🎡 Adding ${spins} spins for ${user}`);
        for (let i = 0; i < spins; i++) {
            await SpinQueue.create({ 
                user: user||'Anon', 
                sourceEventId: res._id, 
                nisaballs: earnedNisaballs 
            });
        }
    }
    return earnedNisaballs;
};

// --- SE AUTH CHECK ---
const verifyStreamElements = async () => {
    if (!SE_JWT) { console.error("❌ ERROR: No SE_JWT Configured"); return; }
    try {
        console.log("🔍 Verifying StreamElements...");
        const { data } = await axios.get('https://api.streamelements.com/kappa/v2/channels/me', {
            headers: { Authorization: `Bearer ${SE_JWT}` }
        });
        console.log(`✅ Token Owner: ${data.username} (${data._id})`);
        
        if (ACTIVE_CHANNEL_ID) {
            console.log(`ℹ️ Using Configured Channel ID: ${ACTIVE_CHANNEL_ID}`);
            if (ACTIVE_CHANNEL_ID !== data._id) console.log("   (Tracking a different channel than token owner. OK for Bots.)");
        } else {
            ACTIVE_CHANNEL_ID = data._id;
            console.log(`⚠️ No ID Configured. Defaulting to Token ID: ${ACTIVE_CHANNEL_ID}`);
        }
    } catch (e) {
        console.error("❌ SE Auth Failed:", e.message);
    }
};

// --- SYNC LOGIC ---
const updateNisathonStats = async (forceBackfill = false) => {
    // Guard Clauses with Logging
    if (!ACTIVE_CHANNEL_ID) { console.log("❌ Sync Aborted: No Channel ID"); return; }
    if (!SE_JWT) { console.log("❌ Sync Aborted: No JWT"); return; }
    if (mongoose.connection.readyState !== 1) return;

    try {
        let stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) stats = await NisathonStats.create({ key: 'main', timerEndTime: new Date(Date.now() + 3*3600000) });

        const limit = forceBackfill ? 100 : 50; // 100 on startup, 50 on poll
        const url = `https://api.streamelements.com/kappa/v2/activities/${ACTIVE_CHANNEL_ID}`;
        
        if (forceBackfill) console.log(`📡 Backfilling 100 events from: ${url}`);

        // Fetch from SE
        const { data: activities } = await axios.get(url, {
            headers: { Authorization: `Bearer ${SE_JWT}` },
            params: { limit }, 
            timeout: 15000
        });

        if (!activities || activities.length === 0) {
            if (forceBackfill) console.log(`❌ API returned 0 activities for ID ${ACTIVE_CHANNEL_ID}`);
            return;
        }

        if (forceBackfill) console.log(`📥 Received ${activities.length} items.`);
        
        // Sort Oldest to Newest
        activities.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        
        let newestDate = stats.lastActivityTime;
        let changesMade = false;

        for (const act of activities) {
            newestDate = act.createdAt;
            
            // --- DEBUG: Check for User ---
            if (act.data.username?.toLowerCase() === 'greatrimu') {
                console.log(`👀 TARGET FOUND: ${act.type} | ${act.data.username} | Tier: ${act.data.tier}`);
            }

            // Map Fields
            let amount = 0;
            let tier = '1000';
            
            if (['subscriber', 'sub', 'resub', 'subscription'].includes(act.type)) {
                amount = 1;
                tier = act.data.tier || '1000';
            } else if (act.type === 'gift') {
                amount = act.data.amount || 1;
            } else if (['cheer', 'tip'].includes(act.type)) {
                amount = act.data.amount;
            } else {
                continue; // Skip non-monetary events
            }

            // Process
            await processNisathonEvent(stats, act.type, act.data.username, amount, act.data.message, act._id, tier);
            changesMade = true;
        }

        if (changesMade) {
            if (!forceBackfill) stats.lastActivityTime = newestDate;
            await stats.save();
            if (forceBackfill) console.log("✅ Backfill Complete.");
        }

    } catch (e) {
        console.error("Sync Error:", e.message);
        if (e.response) console.error("   Details:", e.response.data);
    }
};

// --- ROUTES ---

app.get('/', (req, res) => res.send('Backend Online'));

// ** NEW DEBUG ROUTES **
app.get('/api/debug/se-latest', async (req, res) => {
    if (!ACTIVE_CHANNEL_ID || !SE_JWT) return res.json({ error: "Config Missing" });
    try {
        const { data } = await axios.get(`https://api.streamelements.com/kappa/v2/activities/${ACTIVE_CHANNEL_ID}`, {
            headers: { Authorization: `Bearer ${SE_JWT}` },
            params: { limit: 20 }
        });
        res.json({ configId: ACTIVE_CHANNEL_ID, count: data.length, data });
    } catch (e) { res.json({ error: e.message, details: e.response?.data }); }
});

app.get('/api/debug/user/:username', async (req, res) => {
    if (!ACTIVE_CHANNEL_ID || !SE_JWT) return res.json({ error: "Config Missing" });
    try {
        const { data } = await axios.get(`https://api.streamelements.com/kappa/v2/activities/${ACTIVE_CHANNEL_ID}`, {
            headers: { Authorization: `Bearer ${SE_JWT}` },
            params: { limit: 100 }
        });
        const matches = data.filter(a => a.data.username?.toLowerCase() === req.params.username.toLowerCase());
        res.json({ found: matches.length, matches });
    } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/verify', (req, res) => res.json(req.body.password === ADMIN_PASSWORD ? {success:true} : {error:'Invalid'}));

// ** NISATHON ROUTES **
app.get('/api/nisathon/stats', async (req, res) => {
    if (mongoose.connection.readyState !== 1) return res.json({});
    let stats = await NisathonStats.findOne({ key: 'main' });
    if (!stats) stats = await NisathonStats.create({ key: 'main' });
    res.json(stats);
});

app.get('/api/nisathon/leaderboard', async (req, res) => {
    const lb = await NisathonEvent.aggregate([
        { $group: { _id: "$user", total: { $sum: "$nisaballAmount" } } },
        { $sort: { total: -1 } }, { $limit: 10 }
    ]);
    res.json(lb.map((x, i) => ({ rank: i+1, user: x._id, totalNisaballs: roundOneDecimal(x.total) })));
});

app.get('/api/nisathon/recent', async (req, res) => {
    res.json(await NisathonEvent.find().sort({ createdAt: -1 }).limit(10));
});

app.post('/api/nisathon/test-event', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).send();
    const stats = await NisathonStats.findOne({ key: 'main' });
    await processNisathonEvent(stats, req.body.type, req.body.user, parseFloat(req.body.amount), "Test", null, req.body.tier);
    await stats.save();
    res.json({ success: true });
});

// ** TIMER CONTROLS **
app.post('/api/nisathon/timer/set', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).send();
    const stats = await NisathonStats.findOne({ key: 'main' });
    const ms = (req.body.hours*3600 + req.body.minutes*60 + req.body.seconds)*1000;
    if (stats.isPaused) stats.remainingTimeMs = ms; else stats.timerEndTime = new Date(Date.now() + ms);
    await stats.save();
    res.json({ success: true });
});
app.post('/api/nisathon/timer/add', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).send();
    const stats = await NisathonStats.findOne({ key: 'main' });
    const ms = req.body.minutes * 60000;
    if (stats.isPaused) stats.remainingTimeMs += ms; 
    else stats.timerEndTime = new Date(Math.max(Date.now(), new Date(stats.timerEndTime).getTime()) + ms);
    await stats.save();
    res.json({ success: true });
});
app.post('/api/nisathon/timer/pause', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).send();
    const stats = await NisathonStats.findOne({ key: 'main' });
    const now = Date.now();
    if (stats.isPaused) { stats.isPaused = false; stats.timerEndTime = new Date(now + stats.remainingTimeMs); stats.remainingTimeMs = 0; }
    else { stats.isPaused = true; stats.remainingTimeMs = Math.max(0, new Date(stats.timerEndTime).getTime() - now); }
    await stats.save();
    res.json({ success: true, isPaused: stats.isPaused });
});
app.post('/api/nisathon/event', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).send();
    await NisathonStats.findOneAndUpdate({ key: 'main' }, { activeEvent: req.body.activeEvent });
    res.json({ success: true });
});

app.post('/api/nisathon/reset', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).send();
    await NisathonEvent.deleteMany({}); await SpinQueue.deleteMany({}); await SpinHistory.deleteMany({});
    await NisathonStats.findOneAndUpdate({ key: 'main' }, { currentSubs: 0, currentBits: 0, currentDonations: 0, totalNisaballs: 0, remainingTimeMs: 0, isPaused: false, activeEvent: null, lastActivityTime: new Date().toISOString() });
    res.json({ success: true });
});

app.post('/api/nisathon/sync', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).send();
    await updateNisathonStats(true);
    res.json({ success: true });
});

// ** CONTENT API **
app.get('/api/schedule', async (req, res) => res.json({ url: (await Setting.findOne({ key: 'schedule_url' }))?.value || DEFAULT_SCHEDULE_URL }));
app.post('/api/schedule', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).send();
    await Setting.findOneAndUpdate({ key: 'schedule_url' }, { value: req.body.url }, { upsert: true });
    res.json({ success: true });
});
app.get('/api/profile', async (req, res) => {
    const a = await Setting.findOne({ key: 'profile_about' });
    const c = await Setting.findOne({ key: 'profile_credits' });
    const w = await Setting.findOne({ key: 'profile_artworks' });
    res.json({ about: a?.value||[], credits: c?.value||[], artworks: w?.value||[] });
});
app.post('/api/profile', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).send();
    await Setting.findOneAndUpdate({ key: `profile_${req.body.type}` }, { value: req.body.data }, { upsert: true });
    res.json({ success: true });
});
app.get('/api/goals', async (req, res) => res.json({ goals: (await Setting.findOne({ key: 'nisathon_goals' }))?.value }));
app.post('/api/goals', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).send();
    await Setting.findOneAndUpdate({ key: 'nisathon_goals' }, { value: req.body.goals }, { upsert: true });
    res.json({ success: true });
});
app.get('/api/wheel', async (req, res) => res.json({ items: (await Setting.findOne({ key: 'wheel_items' }))?.value }));
app.post('/api/wheel', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).send();
    await Setting.findOneAndUpdate({ key: 'wheel_items' }, { value: req.body.items }, { upsert: true });
    res.json({ success: true });
});
app.get('/api/wheel/queue', async (req, res) => res.json(await SpinQueue.find().sort({ createdAt: 1 })));
app.get('/api/wheel/history', async (req, res) => res.json(await SpinHistory.find().sort({ timestamp: -1 })));
app.post('/api/wheel/spin-result', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).send();
    await SpinHistory.create({ user: req.body.user, reward: req.body.reward });
    if (req.body.queueId) await SpinQueue.findByIdAndDelete(req.body.queueId);
    res.json({ success: true });
});

app.post('/api/upload', async (req, res) => {
    const { image } = req.body;
    if (!image) return res.status(400).send();
    if (CLOUDINARY_CLOUD_NAME) {
        try {
            const ts = Math.round(new Date().getTime()/1000);
            const sig = crypto.createHash('sha1').update(`timestamp=${ts}${CLOUDINARY_API_SECRET}`).digest('hex');
            const f = new FormData(); f.append('file', `data:image/jpeg;base64,${image}`); f.append('api_key', CLOUDINARY_API_KEY); f.append('timestamp', ts); f.append('signature', sig);
            const r = await axios.post(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, f);
            return res.json({ success: true, data: { url: r.data.secure_url } });
        } catch (e) { return res.status(500).send(); }
    }
    if (IMGBB_API_KEY) {
        try {
            const f = new FormData(); f.append('image', image);
            const r = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, f);
            return res.json(r.data);
        } catch (e) { return res.status(500).send(); }
    }
    res.status(500).send();
});

// --- CROSS-PING ---
function startKeepAlive() {
    setInterval(() => {
        axios.get('https://urnisa-backend.onrender.com').catch(()=>{});
        axios.get('https://urnisa-bot.onrender.com').catch(()=>{});
        console.log("⏰ Ping");
    }, 300000);
}

// --- BOOT SEQUENCE ---
if (MONGO_URI) {
    mongoose.set('strictQuery', false);
    mongoose.connect(MONGO_URI)
        .then(async () => {
            console.log("✅ MongoDB Connected");
            app.listen(PORT, async () => {
                console.log(`✅ Server on ${PORT}`);
                await verifyStreamElements();
                console.log("🚀 Startup Backfill...");
                await updateNisathonStats(true);
                setInterval(() => updateNisathonStats(false), 30000);
                startKeepAlive();
            });
        })
        .catch(err => console.error("❌ DB Fail:", err));
} else { console.error("❌ MONGO_URI Missing"); }
