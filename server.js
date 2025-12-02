const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const crypto = require('crypto');
require('dotenv').config();

// --- CONFIGURATION & SANITIZATION ---
const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin"; 
const MONGO_URI = process.env.MONGO_URI;

// Sanitize JWT: Remove 'Bearer ' prefix if present, remove quotes, trim whitespace
// This fixes the "No authorization token found" error if the env var is malformed
let SE_JWT = process.env.STREAMELEMENTS_JWT || "";
SE_JWT = SE_JWT.replace(/Bearer\s+/i, "").replace(/["']/g, "").trim();

// Sanitize Channel ID
let SE_CHANNEL_ID = process.env.STREAMELEMENTS_CHANNEL_ID || "";
SE_CHANNEL_ID = SE_CHANNEL_ID.replace(/["']/g, "").trim();

// Cloudinary
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || process.env.VITE_IMGBB_API_KEY;

const DEFAULT_SCHEDULE_URL = 'https://cdn.discordapp.com/attachments/1338254150479118347/1439859590152978443/3_am_17.png';

// --- EXPRESS SETUP ---
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors({ origin: '*' }));

// --- MONGOOSE SCHEMAS ---
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

// --- LOGIC HELPERS ---
const roundOneDecimal = (num) => Math.round(num * 10) / 10;

// --- CORE EVENT PROCESSOR ---
const processNisathonEvent = async (stats, type, user, amount, message, providerId, tier = '1000') => {
    let isNewEvent = true;

    // Idempotency Check
    if (providerId) {
        const existing = await NisathonEvent.findOne({ providerId });
        if (existing) isNewEvent = false; 
    }

    let earnedNisaballs = 0;
    let amountDisplay = "";
    let eventType = type; 

    // --- RULESET ---
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
    else if (type === 'gift') {
        earnedNisaballs = 0.5 * amount;
        amountDisplay = `${amount} Gift Subs`;
        if (isNewEvent) stats.currentSubs += amount;
    } 
    else if (['cheer', 'bits'].includes(type)) {
        earnedNisaballs = amount * 0.002;
        amountDisplay = `${amount} Bits`;
        eventType = 'bits';
        if (isNewEvent) stats.currentBits += amount;
    } 
    else if (['tip', 'donation'].includes(type)) {
        earnedNisaballs = amount * 0.2;
        amountDisplay = `$${amount.toFixed(2)}`;
        eventType = 'donation';
        if (isNewEvent) stats.currentDonations += amount;
    }

    // --- UPDATE STATS ---
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

    // --- DB UPSERT ---
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

    if (isNewEvent && earnedNisaballs >= 5) {
        const spins = Math.floor(earnedNisaballs / 5);
        console.log(`🎡 Queueing ${spins} spins for ${user}`);
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

// --- PROVIDER: STREAMELEMENTS ---
const syncStreamElements = async (stats, forceBackfill = false) => {
    if (!SE_JWT || !SE_CHANNEL_ID) {
        console.log("❌ Skipped SE Sync: Missing Config");
        return false;
    }

    try {
        const limit = forceBackfill ? 100 : 50;
        const config = {
            headers: { 'Authorization': `Bearer ${SE_JWT}` },
            params: { limit },
            timeout: 15000
        };

        if (forceBackfill) console.log(`📡 [SE] Fetching ${limit} latest events...`);
        
        const url = `https://api.streamelements.com/kappa/v2/activities/${SE_CHANNEL_ID}`;
        const { data: activities } = await axios.get(url, config);

        if (!activities || activities.length === 0) {
            if (forceBackfill) console.log(`⚠️ [SE] API returned 0 events. Check Channel ID: ${SE_CHANNEL_ID}`);
            return false;
        }

        activities.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        
        let changesMade = false;
        let newestDate = stats.lastActivityTime;

        for (const act of activities) {
            newestDate = act.createdAt;

            if (act.data.username?.toLowerCase() === 'greatrimu') {
                console.log(`👀 TARGET FOUND: ${act.type} | ${act.data.username} | Tier: ${act.data.tier}`);
            }

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
                continue;
            }

            const added = await processEvent(stats, act.type, act.data.username, amount, act.data.message, act._id, tier);
            if (added > 0) changesMade = true;
        }

        if (!forceBackfill) stats.lastActivityTime = newestDate;
        return changesMade;

    } catch (e) {
        if (e.response?.status === 401) {
            console.error("❌ [SE] 401 Unauthorized. CHECK JWT TOKEN!");
        } else {
            console.error(`❌ [SE] Error: ${e.message}`);
        }
        return false;
    }
};

// --- MAIN SYNC LOOP ---
const runSync = async (forceBackfill = false) => {
    if (mongoose.connection.readyState !== 1) return;

    try {
        let stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) stats = await NisathonStats.create({ key: 'main', timerEndTime: new Date(Date.now() + 3*3600000) });

        const seChanged = await syncStreamElements(stats, forceBackfill);
        
        if (seChanged || forceBackfill) {
            await stats.save();
            if (seChanged) console.log("✅ Stats Updated.");
        }
    } catch (e) {
        console.error("Sync Loop Error:", e);
    }
};

// --- API ROUTES ---
app.get('/', (req, res) => res.send('Backend Online'));
app.post('/api/verify', (req, res) => res.json(req.body.password === ADMIN_PASSWORD ? {success:true} : {error:'Invalid'}));

// AUTH
const auth = (req, res, next) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    next();
};

// STREAM STATUS OVERRIDE
app.get('/api/stream-status', async (req, res) => {
    try {
        const s = await Setting.findOne({ key: 'stream_status_override' });
        res.json({ override: s?.value || 'auto' });
    } catch (e) { res.json({ override: 'auto' }); }
});

app.post('/api/stream-status', auth, async (req, res) => {
    await Setting.findOneAndUpdate({ key: 'stream_status_override' }, { value: req.body.override }, { upsert: true });
    res.json({ success: true });
});

// DEBUG ROUTES
app.get('/api/debug/se-latest', async (req, res) => {
    if (!SE_JWT || !SE_CHANNEL_ID) return res.json({ error: "Config Missing" });
    try {
        const { data } = await axios.get(`https://api.streamelements.com/kappa/v2/activities/${SE_CHANNEL_ID}`, {
            headers: { Authorization: `Bearer ${SE_JWT}` },
            params: { limit: 25 }
        });
        res.json({ configId: SE_CHANNEL_ID, data: data });
    } catch (e) { res.json({ error: e.message, status: e.response?.status }); }
});

app.get('/api/debug/user/:username', async (req, res) => {
    if (!SE_JWT || !SE_CHANNEL_ID) return res.json({ error: "Config Missing" });
    try {
        const { data } = await axios.get(`https://api.streamelements.com/kappa/v2/activities/${SE_CHANNEL_ID}`, {
            headers: { Authorization: `Bearer ${SE_JWT}` },
            params: { limit: 100 }
        });
        const matches = data.filter(a => a.data.username && a.data.username.toLowerCase() === req.params.username.toLowerCase());
        res.json({ found: matches.length, matches });
    } catch (e) { res.json({ error: e.message }); }
});

// NISATHON
app.get('/api/nisathon/stats', async (req, res) => {
    if (mongoose.connection.readyState !== 1) return res.json({});
    let stats = await NisathonStats.findOne({ key: 'main' });
    if (!stats) stats = await NisathonStats.create({ key: 'main' });
    res.json(stats);
});
app.get('/api/nisathon/leaderboard', async (req, res) => {
    const lb = await NisathonEvent.aggregate([{ $group: { _id: "$user", total: { $sum: "$nisaballAmount" } } }, { $sort: { total: -1 } }, { $limit: 10 }]);
    res.json(lb.map((x, i) => ({ rank: i+1, user: x._id, totalNisaballs: roundOneDecimal(x.total) })));
});
app.get('/api/nisathon/recent', async (req, res) => res.json(await NisathonEvent.find().sort({ createdAt: -1 }).limit(10)));

// MANUAL & TEST EVENTS
app.post('/api/nisathon/test-event', auth, async (req, res) => {
    const stats = await NisathonStats.findOne({ key: 'main' });
    await processNisathonEvent(stats, req.body.type, req.body.user, parseFloat(req.body.amount), "Manual Entry", null, req.body.tier);
    await stats.save();
    res.json({ success: true });
});

// CONTROLS
app.post('/api/nisathon/timer/set', auth, async (req, res) => {
    const stats = await NisathonStats.findOne({ key: 'main' });
    const ms = (req.body.hours*3600 + req.body.minutes*60 + req.body.seconds)*1000;
    if (stats.isPaused) stats.remainingTimeMs = ms; else stats.timerEndTime = new Date(Date.now() + ms);
    await stats.save();
    res.json({ success: true });
});
app.post('/api/nisathon/timer/add', auth, async (req, res) => {
    const stats = await NisathonStats.findOne({ key: 'main' });
    const ms = req.body.minutes * 60000;
    if (stats.isPaused) stats.remainingTimeMs += ms; 
    else stats.timerEndTime = new Date(Math.max(Date.now(), new Date(stats.timerEndTime).getTime()) + ms);
    await stats.save();
    res.json({ success: true });
});
app.post('/api/nisathon/timer/pause', auth, async (req, res) => {
    const stats = await NisathonStats.findOne({ key: 'main' });
    const now = Date.now();
    if (stats.isPaused) { stats.isPaused = false; stats.timerEndTime = new Date(now + stats.remainingTimeMs); stats.remainingTimeMs = 0; }
    else { stats.isPaused = true; stats.remainingTimeMs = Math.max(0, new Date(stats.timerEndTime).getTime() - now); }
    await stats.save();
    res.json({ success: true });
});
app.post('/api/nisathon/event', auth, async (req, res) => {
    await NisathonStats.findOneAndUpdate({ key: 'main' }, { activeEvent: req.body.activeEvent });
    res.json({ success: true });
});
app.post('/api/nisathon/reset', auth, async (req, res) => {
    await NisathonEvent.deleteMany({}); await SpinQueue.deleteMany({}); await SpinHistory.deleteMany({});
    await NisathonStats.findOneAndUpdate({ key: 'main' }, { 
        currentSubs: 0, currentBits: 0, currentDonations: 0, totalNisaballs: 0, 
        remainingTimeMs: 0, isPaused: false, activeEvent: null, lastActivityTime: new Date().toISOString() 
    });
    res.json({ success: true });
});
app.post('/api/nisathon/sync', auth, async (req, res) => {
    await runSync(true);
    res.json({ success: true });
});

// WHEEL
app.get('/api/wheel/queue', async (req, res) => res.json(await SpinQueue.find().sort({ createdAt: 1 })));
app.get('/api/wheel/history', async (req, res) => res.json(await SpinHistory.find().sort({ timestamp: -1 })));
app.post('/api/wheel/spin-result', auth, async (req, res) => {
    await SpinHistory.create({ user: req.body.user, reward: req.body.reward });
    if (req.body.queueId) await SpinQueue.findByIdAndDelete(req.body.queueId);
    res.json({ success: true });
});

// CONTENT
app.get('/api/goals', async (req, res) => res.json({ goals: (await Setting.findOne({ key: 'nisathon_goals' }))?.value }));
app.post('/api/goals', auth, async (req, res) => {
    await Setting.findOneAndUpdate({ key: 'nisathon_goals' }, { value: req.body.goals }, { upsert: true });
    res.json({ success: true });
});
app.get('/api/wheel', async (req, res) => res.json({ items: (await Setting.findOne({ key: 'wheel_items' }))?.value }));
app.post('/api/wheel', auth, async (req, res) => {
    await Setting.findOneAndUpdate({ key: 'wheel_items' }, { value: req.body.items }, { upsert: true });
    res.json({ success: true });
});
app.get('/api/profile', async (req, res) => {
    const a = await Setting.findOne({ key: 'profile_about' });
    const c = await Setting.findOne({ key: 'profile_credits' });
    const w = await Setting.findOne({ key: 'profile_artworks' });
    res.json({ about: a?.value||[], credits: c?.value||[], artworks: w?.value||[] });
});
app.post('/api/profile', auth, async (req, res) => {
    await Setting.findOneAndUpdate({ key: `profile_${req.body.type}` }, { value: req.body.data }, { upsert: true });
    res.json({ success: true });
});
app.get('/api/schedule', async (req, res) => res.json({ url: (await Setting.findOne({ key: 'schedule_url' }))?.value || DEFAULT_SCHEDULE_URL }));
app.post('/api/schedule', auth, async (req, res) => {
    await Setting.findOneAndUpdate({ key: 'schedule_url' }, { value: req.body.url }, { upsert: true });
    res.json({ success: true });
});

// UPLOAD
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
    return res.status(500).send();
});

// START
if (MONGO_URI) {
    app.listen(PORT, () => {
        console.log(`✅ Server on ${PORT}`);
        setTimeout(() => runSync(true), 5000);
        setInterval(() => runSync(false), 30000);
        setInterval(() => { axios.get('https://urnisa-backend.onrender.com').catch(()=>{}) }, 300000);
    });
} else {
    console.error("❌ MONGO_URI Missing");
}
