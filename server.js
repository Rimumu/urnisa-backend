const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const crypto = require('crypto');
const io = require('socket.io-client');
require('dotenv').config();

// ==========================================
// CONFIGURATION & SETUP
// ==========================================
const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";
const MONGO_URI = process.env.MONGO_URI;

// StreamElements Config
let SE_JWT = process.env.STREAMELEMENTS_JWT || "";
SE_JWT = SE_JWT.replace(/^Bearer\s+/i, "").replace(/["']/g, "").trim();

let ENV_CHANNEL_ID = process.env.STREAMELEMENTS_CHANNEL_ID || "";
ENV_CHANNEL_ID = ENV_CHANNEL_ID.replace(/["']/g, "").trim();

const TARGET_USERNAME = 'urnisa_';
// Dynamic ID
let ACTIVE_CHANNEL_ID = ENV_CHANNEL_ID; 

// Image Hosting
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || process.env.VITE_IMGBB_API_KEY;

const DEFAULT_SCHEDULE_URL = 'https://cdn.discordapp.com/attachments/1338254150479118347/1439859590152978443/3_am_17.png';

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors({ origin: '*' }));

console.log("--- URNISA HYBRID BACKEND STARTING ---");

// ==========================================
// DATABASE SCHEMAS
// ==========================================
if (MONGO_URI) {
    mongoose.set('strictQuery', false);
    mongoose.connect(MONGO_URI)
        .then(() => console.log("✅ MongoDB Connected"))
        .catch(e => console.error("❌ MongoDB Error:", e));
}

const Setting = mongoose.model('Setting', new mongoose.Schema({ key: { type: String, unique: true }, value: mongoose.Schema.Types.Mixed }));

const NisathonStats = mongoose.model('NisathonStats', new mongoose.Schema({
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
}));

const CountdownStats = mongoose.model('CountdownStats', new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    timerEndTime: { type: Date, default: Date.now },
    remainingTimeMs: { type: Number, default: 0 },
    isPaused: { type: Boolean, default: true }
}));

const NisathonEvent = mongoose.model('NisathonEvent', new mongoose.Schema({
    providerId: { type: String, unique: true },
    user: { type: String, required: true },
    type: { type: String, required: true },
    amountDisplay: { type: String, required: true },
    message: String,
    nisaballAmount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
}));

const SpinQueue = mongoose.model('SpinQueue', new mongoose.Schema({
    user: String, sourceEventId: String, nisaballs: Number, createdAt: { type: Date, default: Date.now }
}));

const SpinHistory = mongoose.model('SpinHistory', new mongoose.Schema({
    user: String, reward: String, timestamp: { type: Date, default: Date.now }
}));

const roundOneDecimal = (num) => Math.round(num * 10) / 10;

// ==========================================
// CORE LOGIC
// ==========================================

const processEvent = async (stats, type, user, amount, message, providerId, tier = '1000', isManual = false) => {
    let isNewEvent = true;

    // Check duplicates
    if (providerId && !isManual) {
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
        if (tStr.includes('3000') || tStr === '3') { tVal = 2.0; tLbl = "Tier 3"; }
        else if (tStr.includes('2000') || tStr === '2') { tVal = 1.0; tLbl = "Tier 2"; }
        else if (tStr.includes('prime')) { tVal = 0.5; tLbl = "Prime"; }
        
        earnedNisaballs = tVal;
        amountDisplay = `${tLbl} Sub`;
        eventType = 'sub';
        
        if (isNewEvent) stats.currentSubs += 1;
    } 
    // NOTE: 'gift' type events from SE are often just the bulk message, handled below.
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
    // FOLLOWER LOGIC
    else if (['follower', 'follow'].includes(type)) {
        earnedNisaballs = 0;
        amountDisplay = "New Follower";
        eventType = 'follower';
    }

    // Update Stats & Timer
    if (isNewEvent) {
        stats.totalNisaballs = roundOneDecimal(stats.totalNisaballs + earnedNisaballs);
        const mult = stats.activeEvent === 'DOUBLE_TIMER' ? 2 : 1;
        const msAdd = earnedNisaballs * 10 * mult * 60000;
        
        if (earnedNisaballs > 0) {
            if (!stats.isPaused) {
                const now = Date.now();
                const curEnd = new Date(stats.timerEndTime).getTime();
                // If timer expired, start from now
                const baseTime = curEnd < now ? now : curEnd;
                stats.timerEndTime = new Date(baseTime + msAdd);
            } else {
                stats.remainingTimeMs += msAdd;
            }
        }
    }

    // Save Event
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

    // Wheel Logic
    if (isNewEvent && earnedNisaballs >= 5) {
        const spins = Math.floor(earnedNisaballs / 5);
        console.log(`🎡 Queueing ${spins} spins for ${user}`);
        for (let i = 0; i < spins; i++) {
            await SpinQueue.create({ user: user||'Anon', sourceEventId: res._id, nisaballs: earnedNisaballs });
        }
    }
    
    if (isNewEvent) console.log(`✅ [${isManual?'MANUAL':'AUTO'}] ${user} | (${eventType}) | +${earnedNisaballs}NB`);
    return earnedNisaballs;
};

// ==========================================
// 1. SOCKET (REAL-TIME)
// ==========================================
let socket = null;

const connectSocket = () => {
    if (!SE_JWT) { console.log("❌ [Socket] No JWT"); return; }
    
    console.log("🔌 [Socket] Connecting...");
    socket = io('https://realtime.streamelements.com', { 
        transports: ['websocket'],
        forceNew: true,
        autoConnect: true,
        reconnection: true
    });

    socket.on('connect', () => {
        console.log('🔌 [Socket] Connected. Authenticating...');
        socket.emit('authenticate', { method: 'jwt', token: SE_JWT });
    });

    socket.on('authenticated', (data) => {
        console.log(`✅ [Socket] Authenticated! (Channel: ${data.channelId})`);
    });

    socket.on('event', async (data) => {
        if (!data || !data.type) return;
        if (!['subscriber', 'tip', 'cheer', 'follower', 'follow'].includes(data.type)) return;

        try {
            const stats = await NisathonStats.findOne({ key: 'main' });
            if (!stats) return;

            const info = data.data;
            let amount = 1;
            let tier = '1000';
            let type = data.type;
            let username = info.username;

            if (type === 'subscriber') {
                tier = info.tier || '1000';
                amount = info.amount || 1; 
                // GIFT LOGIC FOR SOCKET
                if (info.gifted) {
                    username = info.sender; // Attribute to Sender
                    // Don't skip, process as 'sub' but for sender.
                    // NOTE: Socket sends individual gift events. We process them as +0.5 for sender.
                }
            } else if (type === 'tip' || type === 'cheer') {
                amount = info.amount;
            } else if (type === 'follow') {
                type = 'follower'; 
                amount = 0;
            }

            const providerId = data._id || `sock-${Date.now()}-${Math.random()}`;
            await processEvent(stats, type, username, amount, info.message||"", providerId, tier);
            await stats.save();
        } catch (e) { console.error("Socket Error:", e); }
    });
};

// ==========================================
// 2. REST POLLING & SYNC
// ==========================================
const fetchAndProcess = async (channelId, label, stats, limit = 50, offset = 0) => {
    if (!channelId) return false;
    
    try {
        const url = `https://api.streamelements.com/kappa/v2/activities/${channelId}`;
        
        const { data: activities } = await axios.get(url, {
            headers: { 
                'Authorization': `Bearer ${SE_JWT}`,
                'Accept': 'application/json',
                'User-Agent': 'UrnisaBot/1.0' 
            },
            params: { limit, offset },
            timeout: 10000
        });

        if (!activities || activities.length === 0) {
            return false;
        }

        // Process Oldest to Newest if getting latest page, but if paging back, order matters differently.
        // Standard sync: Oldest -> Newest.
        activities.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        
        let changes = false;
        for (const act of activities) {
            let amt = 0;
            let tier = '1000';
            let type = act.type;
            let username = act.data.username;
            
            if (['subscriber','sub','resub'].includes(act.type)) { 
                amt = 1; 
                tier = act.data.tier || '1000';
                
                // GIFT LOGIC:
                // If gifted, we attribute it to the SENDER.
                // This handles "bulk gifts" by processing each individual gift sub for the sender.
                if (act.data.gifted) {
                    username = act.data.sender;
                    // display text update? handled in processEvent by checking type
                }
            }
            else if (act.type === 'gift') {
                // Some SE integrations send a summary "gift" event.
                // To avoid double counting with individual sub-gifts, we MIGHT skip this if we trust the individuals.
                // But often SE *only* sends individuals in activity feed.
                // If we see a type='gift', it's usually distinct.
                amt = act.data.amount || 1; 
            }
            else if (['cheer','tip'].includes(act.type)) {
                amt = act.data.amount; 
            }
            else if (act.type === 'follow') { 
                type = 'follower'; 
                amt = 0; 
            }
            else continue;

            const added = await processEvent(stats, type, username, amt, act.data.message, act._id, tier);
            if (added > 0 || type === 'follower') changes = true;
        }
        return changes;

    } catch (e) {
        if (e.response?.status === 401) console.error(`❌ [${label}] 401 Unauthorized.`);
        else console.error(`❌ [${label}] Error: ${e.message}`);
        return false;
    }
};

// Resolve correct ID for 'urnisa_'
const resolveChannelId = async () => {
    if (!SE_JWT) return null;
    try {
        const res = await axios.get(`https://api.streamelements.com/kappa/v2/channels/${TARGET_USERNAME}`, {
             headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (res.data && res.data._id) {
            ACTIVE_CHANNEL_ID = res.data._id;
            console.log(`✅ RESOLVED ID: ${ACTIVE_CHANNEL_ID}`);
            return ACTIVE_CHANNEL_ID;
        }
    } catch (e) { 
        console.log("⚠️ Could not resolve alias. Using Configured/Token ID."); 
    }
    // Fallback to token owner
    try {
        const me = await axios.get('https://api.streamelements.com/kappa/v2/channels/me', {
            headers: { 'Authorization': `Bearer ${SE_JWT}` }
        });
        return me.data._id;
    } catch (e) { return null; }
};

// Full Rebuild Logic (The "Recount" Feature)
const rebuildEverything = async () => {
    if (!ACTIVE_CHANNEL_ID) return;
    console.log("🔥 STARTING FULL REBUILD & RECOUNT...");

    // 1. Reset DB
    await NisathonEvent.deleteMany({});
    await SpinQueue.deleteMany({});
    await SpinHistory.deleteMany({});
    
    // Reset Stats to initial state (3 hours default)
    let stats = await NisathonStats.findOne({ key: 'main' });
    stats.currentSubs = 0;
    stats.currentBits = 0;
    stats.currentDonations = 0;
    stats.totalNisaballs = 0;
    stats.remainingTimeMs = 0;
    stats.isPaused = false;
    stats.timerEndTime = new Date(Date.now() + 3 * 60 * 60 * 1000);
    stats.lastActivityTime = new Date(0).toISOString(); // Reset cursor
    await stats.save();

    // 2. Fetch Deep History (1000 items / 10 pages)
    // We fetch pages in reverse (oldest pages first would be ideal, but API is Limit/Offset from Newest)
    // So we fetch all pages, combine them, then sort by date ascending.
    let allActivities = [];
    const limit = 100; // Max per page
    const pagesToFetch = 10; // 1000 items total

    for (let i = 0; i < pagesToFetch; i++) {
        const offset = i * limit;
        console.log(`   -> Fetching Page ${i+1} (Offset ${offset})...`);
        try {
            const { data: acts } = await axios.get(`https://api.streamelements.com/kappa/v2/activities/${ACTIVE_CHANNEL_ID}`, {
                headers: { 'Authorization': `Bearer ${SE_JWT}` },
                params: { limit, offset }
            });
            if (acts && acts.length > 0) {
                allActivities = allActivities.concat(acts);
            } else {
                break; // End of history
            }
        } catch (e) {
            console.error("Rebuild Fetch Error:", e.message);
            break;
        }
    }

    console.log(`   -> Processing ${allActivities.length} historical events...`);

    // 3. Process Chronologically
    allActivities.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    for (const act of allActivities) {
        let amt = 0;
        let tier = '1000';
        let type = act.type;
        let username = act.data.username;
        
        if (['subscriber','sub','resub'].includes(act.type)) { 
            amt = 1; 
            tier = act.data.tier || '1000';
            if (act.data.gifted) {
                username = act.data.sender; // Fix attribution
            }
        }
        else if (act.type === 'gift') amt = act.data.amount || 1;
        else if (['cheer','tip'].includes(act.type)) amt = act.data.amount;
        else if (act.type === 'follow') { type = 'follower'; amt = 0; }
        else continue;

        await processEvent(stats, type, username, amt, act.data.message, act._id, tier);
    }

    // Update cursor to now
    stats.lastActivityTime = new Date().toISOString();
    await stats.save();
    console.log("✅ REBUILD COMPLETE.");
};

const runSync = async () => {
    if (mongoose.connection.readyState !== 1 || !SE_JWT) return;
    try {
        let stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) stats = await NisathonStats.create({ key: 'main', timerEndTime: new Date(Date.now() + 3*3600000) });

        let resolvedId = ACTIVE_CHANNEL_ID || await resolveChannelId();
        if (resolvedId) {
            await fetchAndProcess(resolvedId, "AUTO-ID", stats);
            await stats.save();
        }
    } catch (e) { console.error("Loop Error:", e); }
};

// ==========================================
// API ROUTES
// ==========================================
app.get('/', (req, res) => res.send('Backend OK'));

app.get('/api/debug/se-latest', async (req, res) => {
    if (!SE_JWT || !ACTIVE_CHANNEL_ID) return res.json({ error: "Config Missing" });
    try {
        const response = await axios.get(`https://api.streamelements.com/kappa/v2/activities/${ACTIVE_CHANNEL_ID}`, {
            headers: { Authorization: `Bearer ${SE_JWT}` },
            params: { limit: 25 }
        });
        res.json({ configId: ACTIVE_CHANNEL_ID, data: response.data });
    } catch (e) { res.json({ error: e.message }); }
});

const auth = (req, res, next) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    next();
};
app.post('/api/verify', (req, res) => res.json(req.body.password === ADMIN_PASSWORD ? {success:true} : {error:'Invalid'}));

// NISATHON
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

app.post('/api/nisathon/test-event', auth, async (req, res) => {
    const stats = await NisathonStats.findOne({ key: 'main' });
    await processEvent(stats, req.body.type, req.body.user, parseFloat(req.body.amount), "Manual", null, req.body.tier, true);
    await stats.save();
    res.json({ success: true });
});

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

// NEW: REBUILD ENDPOINT
app.post('/api/nisathon/rebuild', auth, async (req, res) => {
    rebuildEverything(); // Async, don't wait
    res.json({ success: true, message: "Rebuild started" });
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

// NEW: COUNTDOWN API (STANDALONE)
app.get('/api/countdown/stats', async (req, res) => {
    if (mongoose.connection.readyState !== 1) return res.json({});
    let stats = await mongoose.model('CountdownStats').findOne({ key: 'main' });
    if (!stats) stats = await mongoose.model('CountdownStats').create({ key: 'main' });
    res.json(stats);
});

app.post('/api/countdown/set', auth, async (req, res) => {
    const stats = await mongoose.model('CountdownStats').findOne({ key: 'main' });
    const ms = (req.body.hours*3600 + req.body.minutes*60 + req.body.seconds)*1000;
    if (stats.isPaused) stats.remainingTimeMs = ms; else stats.timerEndTime = new Date(Date.now() + ms);
    await stats.save();
    res.json({ success: true });
});

app.post('/api/countdown/add', auth, async (req, res) => {
    const stats = await mongoose.model('CountdownStats').findOne({ key: 'main' });
    const ms = req.body.minutes * 60000;
    if (stats.isPaused) stats.remainingTimeMs += ms;
    else stats.timerEndTime = new Date(Math.max(Date.now(), new Date(stats.timerEndTime).getTime()) + ms);
    await stats.save();
    res.json({ success: true });
});

app.post('/api/countdown/pause', auth, async (req, res) => {
    const stats = await mongoose.model('CountdownStats').findOne({ key: 'main' });
    const now = Date.now();
    if (stats.isPaused) {
        stats.isPaused = false; stats.timerEndTime = new Date(now + stats.remainingTimeMs); stats.remainingTimeMs = 0;
    } else {
        stats.isPaused = true; stats.remainingTimeMs = Math.max(0, new Date(stats.timerEndTime).getTime() - now);
    }
    await stats.save();
    res.json({ success: true, isPaused: stats.isPaused });
});

app.post('/api/countdown/reset', auth, async (req, res) => {
    await mongoose.model('CountdownStats').findOneAndUpdate({ key: 'main' }, { remainingTimeMs: 0, isPaused: true, timerEndTime: new Date() });
    res.json({ success: true });
});


// Content
app.get('/api/goals', async (req, res) => res.json({ goals: (await Setting.findOne({ key: 'nisathon_goals' }))?.value }));
app.post('/api/goals', auth, async (req, res) => { await Setting.findOneAndUpdate({ key: 'nisathon_goals' }, { value: req.body.goals }, { upsert: true }); res.json({ success: true }); });
app.get('/api/wheel', async (req, res) => res.json({ items: (await Setting.findOne({ key: 'wheel_items' }))?.value }));
app.post('/api/wheel', auth, async (req, res) => { await Setting.findOneAndUpdate({ key: 'wheel_items' }, { value: req.body.items }, { upsert: true }); res.json({ success: true }); });
app.get('/api/profile', async (req, res) => { const a = await Setting.findOne({ key: 'profile_about' }); const c = await Setting.findOne({ key: 'profile_credits' }); const w = await Setting.findOne({ key: 'profile_artworks' }); res.json({ about: a?.value||[], credits: c?.value||[], artworks: w?.value||[] }); });
app.post('/api/profile', auth, async (req, res) => { await Setting.findOneAndUpdate({ key: `profile_${req.body.type}` }, { value: req.body.data }, { upsert: true }); res.json({ success: true }); });
app.get('/api/schedule', async (req, res) => res.json({ url: (await Setting.findOne({ key: 'schedule_url' }))?.value || DEFAULT_SCHEDULE_URL }));
app.post('/api/schedule', auth, async (req, res) => { await Setting.findOneAndUpdate({ key: 'schedule_url' }, { value: req.body.url }, { upsert: true }); res.json({ success: true }); });
app.post('/api/stream-status', auth, async (req, res) => { await Setting.findOneAndUpdate({ key: 'stream_status_override' }, { value: req.body.override }, { upsert: true }); res.json({ success: true }); });
app.get('/api/stream-status', async (req, res) => { const s = await Setting.findOne({ key: 'stream_status_override' }); res.json({ override: s?.value || 'auto' }); });

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
    mongoose.set('strictQuery', false);
    mongoose.connect(MONGO_URI)
        .then(() => {
            console.log("✅ MongoDB Ready");
            app.listen(PORT, async () => {
                console.log(`✅ Server on ${PORT}`);
                
                await resolveChannelId();
                connectSocket();
                
                console.log("🚀 Startup Sync...");
                await runSync();
                setInterval(() => runSync(), 30000);
                
                setInterval(() => { axios.get('https://urnisa-backend.onrender.com').catch(()=>{}) }, 300000);
            });
        })
        .catch(e => console.error("❌ DB Fail:", e));
} else {
    console.error("❌ MONGO_URI Missing");
}
