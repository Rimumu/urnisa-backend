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

// We will try this ID, and also auto-resolve 'urnisa_'
let ENV_CHANNEL_ID = process.env.STREAMELEMENTS_CHANNEL_ID || "";
ENV_CHANNEL_ID = ENV_CHANNEL_ID.replace(/["']/g, "").trim();

const TARGET_USERNAME = 'urnisa_';

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
                stats.timerEndTime = new Date(Math.max(now, curEnd) + msAdd);
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

    // Wheel Logic (Followers don't get spins)
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
// 1. REAL-TIME SOCKET (METHOD 1)
// ==========================================
let socket = null;

const connectSocket = () => {
    if (!SE_JWT) { console.log("❌ [Socket] No JWT"); return; }
    
    console.log("🔌 [Socket] Connecting...");
    
    // StreamElements uses Socket.IO v2. 
    // We MUST use 'transports: [websocket]' to avoid polling issues.
    socket = io('https://realtime.streamelements.com', { 
        transports: ['websocket'],
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

    socket.on('unauthorized', (data) => {
        console.error('❌ [Socket] Auth Failed:', data);
    });

    socket.on('event', async (data) => {
        // LOG RAW DATA FOR DEBUGGING
        // console.log('🔥 [Socket] RAW:', JSON.stringify(data));

        if (!data || !data.type) return;
        
        // Allow 'follow' event type
        if (!['subscriber', 'tip', 'cheer', 'follower', 'follow'].includes(data.type)) return;

        console.log(`⚡ [Socket] New Event: ${data.type}`);
        try {
            const stats = await NisathonStats.findOne({ key: 'main' });
            if (!stats) return;

            const info = data.data;
            let amount = 1;
            let tier = '1000';
            let type = data.type; 

            if (type === 'subscriber') {
                tier = info.tier || '1000';
                amount = info.amount || 1; 
                if (info.gifted) type = 'gift'; 
            } else if (type === 'tip' || type === 'cheer') {
                amount = info.amount;
            } else if (type === 'follow') {
                type = 'follower'; 
                amount = 0;
            }

            const providerId = data._id || `sock-${Date.now()}-${Math.random()}`;
            await processEvent(stats, type, info.username, amount, info.message||"", providerId, tier);
            await stats.save();
        } catch (e) { console.error("Socket Error:", e); }
    });
    
    socket.on('disconnect', () => {
        console.log('⚠️ [Socket] Disconnected');
    });
};

// ==========================================
// 2. REST POLLING (METHOD 2)
// ==========================================
const fetchAndProcess = async (channelId, label, stats) => {
    if (!channelId) return false;
    
    try {
        const url = `https://api.streamelements.com/kappa/v2/activities/${channelId}`;
        
        const { data: activities } = await axios.get(url, {
            headers: { 
                'Authorization': `Bearer ${SE_JWT}`,
                'Accept': 'application/json',
                'User-Agent': 'UrnisaBot/1.0' 
            },
            params: { limit: 25 },
            timeout: 10000
        });

        if (!activities || activities.length === 0) {
            return false;
        }

        activities.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        
        let changes = false;
        for (const act of activities) {
            let amt = 0;
            let tier = '1000';
            let type = act.type;
            
            if (['subscriber','sub','resub'].includes(act.type)) { amt = 1; tier = act.data.tier || '1000'; }
            else if (act.type === 'gift') amt = act.data.amount || 1;
            else if (['cheer','tip'].includes(act.type)) amt = act.data.amount;
            // Explicitly allow followers in REST sync now
            else if (act.type === 'follow') { type = 'follower'; amt = 0; }
            else continue;

            const added = await processEvent(stats, type, act.data.username, amt, act.data.message, act._id, tier);
            if (added > 0 || type === 'follower') changes = true; // Mark change even if 0 NB for followers
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
            console.log(`🔍 Resolved '${TARGET_USERNAME}' to ID: ${res.data._id}`);
            return res.data._id;
        }
    } catch (e) { 
        console.log("⚠️ Could not resolve alias. Using Token Owner."); 
    }
    // Fallback to token owner
    try {
        const me = await axios.get('https://api.streamelements.com/kappa/v2/channels/me', {
            headers: { 'Authorization': `Bearer ${SE_JWT}` }
        });
        return me.data._id;
    } catch (e) { return null; }
};

const syncSessionFallback = async (channelId, stats) => {
    try {
        const { data: session } = await axios.get(`https://api.streamelements.com/kappa/v2/sessions/${channelId}`, {
             headers: { 'Authorization': `Bearer ${SE_JWT}` }
        });
        
        if (!session || !session.data) return;
        
        let changes = false;
        const lastSub = session.data['latest-subscriber'];
        if (lastSub) {
            await processEvent(stats, 'subscriber', lastSub.name, 1, "", `session-sub-${lastSub.name}`, lastSub.tier);
            changes = true;
        }
        
        const lastTip = session.data['latest-tip'];
        if (lastTip) {
             await processEvent(stats, 'tip', lastTip.name, lastTip.amount, lastTip.message, `session-tip-${lastTip.name}-${lastTip.amount}`);
             changes = true;
        }

        const lastCheer = session.data['latest-cheer'];
        if (lastCheer) {
             await processEvent(stats, 'cheer', lastCheer.name, lastCheer.amount, lastCheer.message, `session-cheer-${lastCheer.name}-${lastCheer.amount}`);
             changes = true;
        }
        if (changes) console.log("✅ Session Sync Processed");
    } catch (e) {
        // Silent fail is ok for fallback
    }
};

const runSync = async () => {
    if (mongoose.connection.readyState !== 1) return;
    if (!SE_JWT) return;

    try {
        let stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) stats = await NisathonStats.create({ key: 'main', timerEndTime: new Date(Date.now() + 3*3600000) });

        let resolvedId = null;
        try {
            const r = await axios.get(`https://api.streamelements.com/kappa/v2/channels/${TARGET_USERNAME}`, { headers: { 'Authorization': `Bearer ${SE_JWT}` } });
            resolvedId = r.data._id;
        } catch (e) {}

        let c1 = false, c2 = false;
        if (resolvedId) {
            c1 = await fetchAndProcess(resolvedId, "AUTO-ID", stats);
            if (!c1) await syncSessionFallback(resolvedId, stats);
        }
        if (ENV_CHANNEL_ID && ENV_CHANNEL_ID !== resolvedId) {
            c2 = await fetchAndProcess(ENV_CHANNEL_ID, "ENV-ID", stats);
        }

        if (c1 || c2) await stats.save();

    } catch (e) { console.error("Loop Error:", e); }
};

// ==========================================
// API ROUTES
// ==========================================
app.get('/', (req, res) => res.send('Backend OK'));

app.get('/api/debug/se-latest', async (req, res) => {
    if (!SE_JWT || !ENV_CHANNEL_ID) return res.json({ error: "Missing Config" });
    let targetId = ENV_CHANNEL_ID;
    try {
        const r = await axios.get(`https://api.streamelements.com/kappa/v2/channels/${TARGET_USERNAME}`, { headers: { 'Authorization': `Bearer ${SE_JWT}` } });
        targetId = r.data._id;
    } catch(e){}

    try {
        const response = await axios.get(`https://api.streamelements.com/kappa/v2/activities/${targetId}`, {
            headers: { Authorization: `Bearer ${SE_JWT}` },
            params: { limit: 25 }
        });
        res.json({ configId: targetId, data: response.data });
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
                
                console.log("🚀 Startup Deep Sync...");
                await runSync(true);
                setInterval(() => runSync(false), 30000);
                setInterval(() => { axios.get('https://urnisa-backend.onrender.com').catch(()=>{}) }, 300000);
            });
        })
        .catch(e => console.error("❌ DB Fail:", e));
} else {
    console.error("❌ MONGO_URI Missing");
}
