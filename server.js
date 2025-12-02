const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const crypto = require('crypto');
require('dotenv').config();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";
const MONGO_URI = process.env.MONGO_URI;

// StreamElements Config (Sanitized)
let SE_JWT = process.env.STREAMELEMENTS_JWT || "";
SE_JWT = SE_JWT.replace(/^Bearer\s+/i, "").replace(/["']/g, "").trim();

let SE_CHANNEL_ID = process.env.STREAMELEMENTS_CHANNEL_ID || "";
SE_CHANNEL_ID = SE_CHANNEL_ID.replace(/["']/g, "").trim();

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || process.env.VITE_IMGBB_API_KEY;
const DEFAULT_SCHEDULE_URL = 'https://cdn.discordapp.com/attachments/1338254150479118347/1439859590152978443/3_am_17.png';

// --- APP SETUP ---
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors({ origin: '*' }));

console.log("--- URNISA BACKEND INITIALIZING ---");

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
    user: String, sourceEventId: String, nisaballs: Number, createdAt: { type: Date, default: Date.now }
});
const SpinQueue = mongoose.model('SpinQueue', SpinQueueSchema);

const SpinHistorySchema = new mongoose.Schema({
    user: String, reward: String, timestamp: { type: Date, default: Date.now }
});
const SpinHistory = mongoose.model('SpinHistory', SpinHistorySchema);

const roundOneDecimal = (num) => Math.round(num * 10) / 10;

// --- EVENT PROCESSOR ---
const processEvent = async (stats, type, user, amount, message, providerId, tier = '1000', isManual = false) => {
    let isNewEvent = true;

    // Deduplicate
    if (providerId && !isManual) {
        const existing = await NisathonEvent.findOne({ providerId });
        if (existing) isNewEvent = false;
    }

    let earnedNisaballs = 0;
    let amountDisplay = "";
    let eventType = type;

    // Rules
    if (['subscriber', 'sub', 'resub', 'subscription'].includes(type)) {
        let tVal = 0.5;
        let tLbl = "Tier 1";
        const tStr = String(tier).toLowerCase();
        if (tStr.includes('3000') || tStr === '3') { tVal = 2.0; tLbl = "Tier 3"; }
        else if (tStr.includes('2000') || tStr === '2') { tVal = 1.0; tLbl = "Tier 2"; }
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

    // Update Stats
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

    // DB Upsert
    const eventData = {
        providerId: providerId || `sim-${Date.now()}`,
        user: user || 'Anonymous',
        type: eventType,
        amountDisplay,
        message,
        nisaballAmount: earnedNisaballs,
        createdAt: isNewEvent ? new Date() : undefined
    };
    // Clean undefineds
    Object.keys(eventData).forEach(k => eventData[k] === undefined && delete eventData[k]);

    const res = await NisathonEvent.findOneAndUpdate(
        { providerId: eventData.providerId }, 
        eventData, 
        { upsert: true, new: true }
    );

    // Wheel Queue
    if (isNewEvent && earnedNisaballs >= 5) {
        const spins = Math.floor(earnedNisaballs / 5);
        console.log(`🎡 Queueing ${spins} spins for ${user}`);
        for (let i = 0; i < spins; i++) {
            await SpinQueue.create({ user: user||'Anon', sourceEventId: res._id, nisaballs: earnedNisaballs });
        }
    }
    
    return earnedNisaballs;
};

// --- STREAMELEMENTS SYNC ---
const syncStreamElements = async (stats, limit = 50) => {
    if (!SE_JWT || !SE_CHANNEL_ID) return false;

    try {
        const response = await axios.get(`https://api.streamelements.com/kappa/v2/activities/${SE_CHANNEL_ID}`, {
            headers: { 'Authorization': `Bearer ${SE_JWT}` },
            params: { limit },
            timeout: 10000
        });

        const activities = response.data;
        if (!activities || activities.length === 0) {
            console.log(`⚠️ [SE] No activities found. Check ID: ${SE_CHANNEL_ID}`);
            return false;
        }

        // Sort Oldest -> Newest
        activities.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        
        // LOG THE NEWEST ACTIVITY FOR DEBUGGING
        const newest = activities[activities.length - 1];
        console.log(`📡 [SE] Poll: ${activities.length} events. Newest: ${newest.type} by ${newest.data.username} at ${newest.createdAt}`);

        let changesMade = false;
        let newestDate = stats.lastActivityTime;

        for (const act of activities) {
            newestDate = act.createdAt;
            
            // Normalized Fields
            let amount = 0;
            let tier = '1000';
            const type = act.type;
            const user = act.data.username;

            if (['subscriber', 'sub', 'resub', 'subscription'].includes(type)) {
                amount = 1;
                tier = act.data.tier || '1000';
            } else if (type === 'gift') {
                amount = act.data.amount || 1;
            } else if (['cheer', 'tip'].includes(type)) {
                amount = act.data.amount;
            } else {
                continue;
            }

            const added = await processEvent(stats, type, user, amount, act.data.message, act._id, tier);
            if (added > 0) changesMade = true;
        }

        stats.lastActivityTime = newestDate;
        return changesMade;
    } catch (e) {
        console.error(`❌ [SE] Sync Error: ${e.response?.status || e.message}`);
        return false;
    }
};

// --- MAIN LOOP ---
const runSync = async (forceDeep = false) => {
    if (mongoose.connection.readyState !== 1) return;

    try {
        let stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) stats = await NisathonStats.create({ key: 'main', timerEndTime: new Date(Date.now() + 3*3600000) });

        if (forceDeep) console.log("🚀 Running Deep Sync...");

        const changes = await syncStreamElements(stats, forceDeep ? 100 : 25);

        if (changes || forceDeep) {
            await stats.save();
            if (changes) console.log("✅ Stats Saved.");
        }
    } catch (e) {
        console.error("Sync Loop Error:", e);
    }
};

// --- ROUTES ---
app.get('/', (req, res) => res.send('Urnisa Backend Active'));

// Debug
app.get('/api/debug/se-latest', async (req, res) => {
    if (!SE_JWT || !SE_CHANNEL_ID) return res.json({ error: "Missing Config" });
    try {
        const response = await axios.get(`https://api.streamelements.com/kappa/v2/activities/${SE_CHANNEL_ID}`, {
            headers: { Authorization: `Bearer ${SE_JWT}` },
            params: { limit: 20 }
        });
        res.json(response.data);
    } catch (e) { res.json({ error: e.message }); }
});

// Auth
const auth = (req, res, next) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    next();
};
app.post('/api/verify', (req, res) => res.json(req.body.password === ADMIN_PASSWORD ? {success:true} : {error:'Invalid'}));

// Nisathon Read
app.get('/api/nisathon/stats', async (req, res) => {
    if (mongoose.connection.readyState !== 1) return res.json({});
    let stats = await NisathonStats.findOne({ key: 'main' });
    if (!stats) stats = await NisathonStats.create({ key: 'main' });
    res.json(stats);
});
app.get('/api/nisathon/leaderboard', async (req, res) => {
    try {
        const lb = await NisathonEvent.aggregate([{ $group: { _id: "$user", total: { $sum: "$nisaballAmount" } } }, { $sort: { total: -1 } }, { $limit: 10 }]);
        res.json(lb.map((x, i) => ({ rank: i+1, user: x._id, totalNisaballs: roundOneDecimal(x.total) })));
    } catch { res.json([]); }
});
app.get('/api/nisathon/recent', async (req, res) => res.json(await NisathonEvent.find().sort({ createdAt: -1 }).limit(10)));

// Manual Event
app.post('/api/nisathon/test-event', auth, async (req, res) => {
    const stats = await NisathonStats.findOne({ key: 'main' });
    await processEvent(stats, req.body.type, req.body.user, parseFloat(req.body.amount), "Manual", null, req.body.tier, true);
    await stats.save();
    res.json({ success: true });
});

// Controls
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

// Wheel
app.get('/api/wheel/queue', async (req, res) => res.json(await SpinQueue.find().sort({ createdAt: 1 })));
app.get('/api/wheel/history', async (req, res) => res.json(await SpinHistory.find().sort({ timestamp: -1 })));
app.post('/api/wheel/spin-result', auth, async (req, res) => {
    await SpinHistory.create({ user: req.body.user, reward: req.body.reward });
    if (req.body.queueId) await SpinQueue.findByIdAndDelete(req.body.queueId);
    res.json({ success: true });
});

// Content
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
app.post('/api/stream-status', auth, async (req, res) => {
    await Setting.findOneAndUpdate({ key: 'stream_status_override' }, { value: req.body.override }, { upsert: true });
    res.json({ success: true });
});
app.get('/api/stream-status', async (req, res) => {
    const s = await Setting.findOne({ key: 'stream_status_override' });
    res.json({ override: s?.value || 'auto' });
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
    return res.status(500).send();
});

// --- BOOT ---
if (MONGO_URI) {
    mongoose.set('strictQuery', false);
    mongoose.connect(MONGO_URI)
        .then(() => {
            console.log("✅ MongoDB Ready");
            // START SERVER ONLY AFTER DB CONNECT
            app.listen(PORT, () => {
                console.log(`✅ Server on ${PORT}`);
                console.log(`ℹ️ Channel ID: ${SE_CHANNEL_ID}`);
                
                // Startup Deep Sync
                setTimeout(() => runSync(true), 5000); 
                
                // Loop
                setInterval(() => runSync(false), 30000);
                
                // Ping
                setInterval(() => { axios.get('https://urnisa-backend.onrender.com').catch(()=>{}) }, 300000);
            });
        })
        .catch(e => console.error("❌ DB Fail:", e));
} else {
    console.error("❌ MONGO_URI Missing");
}
