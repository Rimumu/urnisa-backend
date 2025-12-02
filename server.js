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
    
    // SUBSCRIPTIONS
    if (['subscriber', 'sub', 'resub', 'subscription'].includes(type)) {
        // CRITICAL FIX: Ignore "received gift" events IF we are not in manual mode.
        // This prevents double counting because the 'gift' bulk event handles the credit.
        // StreamElements sends individual 'subscriber' events for gift recipients. We want to skip those.
        if (!isManual && (message.includes('gift') || amount === 0)) {
             // console.log(`⏩ Skipping recipient event for ${user}`);
             return 0; 
        }

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
    // GIFT SUBS (The Gifter)
    else if (type === 'gift') {
        // amount here is number of gifts (e.g. 5, 10)
        earnedNisaballs = 0.5 * amount; 
        amountDisplay = `${amount} Gift Subs`;
        if (isNewEvent) stats.currentSubs += amount;
    } 
    // BITS
    else if (['cheer', 'bits'].includes(type)) {
        earnedNisaballs = amount * 0.002;
        amountDisplay = `${amount} Bits`;
        eventType = 'bits';
        if (isNewEvent) stats.currentBits += amount;
    } 
    // TIPS
    else if (['tip', 'donation'].includes(type)) {
        earnedNisaballs = amount * 0.2;
        amountDisplay = `$${amount.toFixed(2)}`;
        eventType = 'donation';
        if (isNewEvent) stats.currentDonations += amount;
    }
    // FOLLOWERS
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

    socket.on('unauthorized', (data) => {
        console.error('❌ [Socket] Auth Failed:', data);
    });

    socket.on('event', async (data) => {
        if (!data || !data.type) return;
        
        // Filter relevant events
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
                
                // GIFT LOGIC:
                // If 'gifted' is true in socket data, it means this is a recipient event.
                // We want to SKIP this to avoid double counting, assuming a BULK GIFT event fires separately.
                // OR if SE doesn't fire bulk events via socket, we might need to process these but attribute to sender.
                // SAFEST: For now, skip socket recipients. rely on REST to catch bulk gifts correctly.
                if (info.gifted) {
                    // console.log("⏩ Skipping socket event (Gift Recipient)");
                    return; 
                }
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
};

// ==========================================
// 2. REST POLLING (METHOD 2)
// ==========================================
const fetchAndProcess = async (channelId, label, stats, limit = 25, offset = 0) => {
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

        activities.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        
        let changes = false;
        for (const act of activities) {
            let amt = 0;
            let tier = '1000';
            let type = act.type;
            
            if (['subscriber','sub','resub'].includes(act.type)) { 
                amt = 1; 
                tier = act.data.tier || '1000';
                
                // GIFT LOGIC:
                // If act.data.gifted is true, this is a recipient event.
                // However, SE REST API often *doesn't* show a separate "bulk gift" event.
                // It shows 10 separate "subscriber" events with gifted=true.
                // TO FIX THIS: We must attribute these to the SENDER.
                // And ensure we process them as +0.5 each.
                if (act.data.gifted) {
                    // Override user to be the sender
                    // This effectively turns "UserB received gift" into "UserA gifted 1 sub"
                    const sender = act.data.sender;
                    if (sender) {
                        // We change the type to 'gift' for our system so it processes as +0.5
                        type = 'gift'; 
                        amt = 1; // 1 gift
                        // We need to use a unique ID for this 'gift instance' so we don't dedupe it against other gifts in the same batch
                        // Luckily, each recipient event has a unique ID.
                        // So we process this as: "Sender gifted 1 sub (ID: xyz)"
                        // This results in 10 separate "Gift" events for the sender in the DB.
                        // While verbose in the list, the MATH is correct (10 * 0.5 = 5).
                        // And the wheel queue will get 10 entries of 0.5 (total 5).
                        // We pass the sender as the user.
                        await processEvent(stats, type, sender, amt, `Gift for ${act.data.username}`, act._id, tier);
                        changes = true;
                        continue; // Skip the default call at bottom
                    }
                }
            }
            else if (act.type === 'gift') {
                // If SE *does* send a bulk event, we process it.
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

            const added = await processEvent(stats, type, act.data.username, amt, act.data.message, act._id, tier);
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
            // Session data is tricky for gifts. Safest to treat as regular sub if we can't distinguish.
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

const runSync = async (forceDeep = false) => {
    if (mongoose.connection.readyState !== 1) return;
    if (!SE_JWT) return;

    try {
        let stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) stats = await NisathonStats.create({ key: 'main', timerEndTime: new Date(Date.now() + 3*3600000) });

        let resolvedId = await resolveChannelId();
        if (!resolvedId) resolvedId = ENV_CHANNEL_ID;

        if (resolvedId) {
            const limit = forceDeep ? 100 : 25;
            if (forceDeep) console.log(`🚀 Deep Syncing 100 items from ${resolvedId}...`);
            
            const c1 = await fetchAndProcess(resolvedId, "AUTO-ID", stats, limit);
            if (!c1 && forceDeep) await syncSessionFallback(resolvedId, stats);
            
            if (c1 || forceDeep) await stats.save();
        }
    } catch (e) { console.error("Loop Error:", e); }
};

// ==========================================
// REBUILD LOGIC
// ==========================================
const rebuildEverything = async () => {
    const resolvedId = await resolveChannelId() || ENV_CHANNEL_ID;
    if (!resolvedId) return;
    console.log(`🔥 STARTING REBUILD for ${resolvedId}...`);

    await NisathonEvent.deleteMany({});
    await SpinQueue.deleteMany({});
    await SpinHistory.deleteMany({});
    
    let stats = await NisathonStats.findOne({ key: 'main' });
    if (!stats) stats = await NisathonStats.create({ key: 'main' });
    stats.currentSubs = 0; stats.currentBits = 0; stats.currentDonations = 0; stats.totalNisaballs = 0;
    stats.remainingTimeMs = 0; stats.isPaused = false;
    stats.timerEndTime = new Date(Date.now() + 3 * 60 * 60 * 1000);
    stats.lastActivityTime = new Date(0).toISOString(); 
    await stats.save();

    let allActivities = [];
    const limit = 100; 
    const pagesToFetch = 10; 

    for (let i = 0; i < pagesToFetch; i++) {
        const acts = await fetchAndProcess(resolvedId, "REBUILD", null, limit, i * limit);
        if (Array.isArray(acts) && acts.length > 0) allActivities = allActivities.concat(acts);
        else break;
    }
    
    // Logic inside fetchAndProcess (above) already handles the attribution.
    // But fetchAndProcess in "rebuild mode" (returning array) isn't fully implemented in the helper.
    // The helper updates the DB directly.
    // So for Rebuild, we actually just want to call fetchAndProcess in a loop? 
    // No, fetchAndProcess updates stats live. That works for us.
    // BUT we need to make sure we process them in order.
    // Since fetchAndProcess does sort, we are good, BUT we need to do it page by page in reverse?
    // Actually, simpler strategy: fetch ALL raw data first, then process.
    
    // Redo Rebuild Fetch properly:
    try {
        let rawActs = [];
        for(let i=0; i<10; i++) {
            const { data } = await axios.get(`https://api.streamelements.com/kappa/v2/activities/${resolvedId}`, {
                headers: { 'Authorization': `Bearer ${SE_JWT}` },
                params: { limit: 100, offset: i*100 }
            });
            if(data && data.length > 0) rawActs = rawActs.concat(data);
            else break;
        }
        
        console.log(`   -> Processing ${rawActs.length} historical events...`);
        rawActs.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        for (const act of rawActs) {
            let amt = 0;
            let tier = '1000';
            let type = act.type;
            let username = act.data.username;
            
            if (['subscriber','sub','resub'].includes(act.type)) { 
                amt = 1; 
                tier = act.data.tier || '1000';
                if (act.data.gifted) {
                    username = act.data.sender; 
                    type = 'gift'; // Force gift type for calc
                }
            }
            else if (act.type === 'gift') amt = act.data.amount || 1;
            else if (['cheer','tip'].includes(act.type)) amt = act.data.amount;
            else if (act.type === 'follow') { type = 'follower'; amt = 0; }
            else continue;

            await processEvent(stats, type, username, amt, act.data.message, act._id, tier);
        }
        await stats.save();
        console.log("✅ REBUILD COMPLETE.");
    } catch(e) { console.error("Rebuild Error", e); }
};


// ==========================================
// API ROUTES
// ==========================================
app.get('/', (req, res) => res.send('Backend OK'));

// DEBUG
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

// AUTH
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

app.get('/api/nisathon/recent', async (req, res) => res.json(await NisathonEvent.find().sort({ createdAt: -1 }).limit(50)));

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
app.post('/api/nisathon/rebuild', auth, async (req, res) => {
    rebuildEverything();
    res.json({ success: true, message: "Rebuild Started" });
});

app.post('/api/nisathon/delete-event', auth, async (req, res) => {
    const { id, revert } = req.body;
    try {
        const event = await NisathonEvent.findById(id);
        if (!event) return res.status(404).json({ error: "Not Found" });

        if (revert) {
            const stats = await NisathonStats.findOne({ key: 'main' });
            if (stats) {
                // Approximate Revert
                if (event.type === 'sub') stats.currentSubs -= 1;
                else if (event.type === 'gift') stats.currentSubs -= (event.nisaballAmount * 2); 
                else if (event.type === 'bits') stats.currentBits -= (event.nisaballAmount * 500);
                else if (event.type === 'donation') stats.currentDonations -= (event.nisaballAmount * 5);

                stats.totalNisaballs = Math.max(0, roundOneDecimal(stats.totalNisaballs - event.nisaballAmount));
                
                const msToRemove = event.nisaballAmount * 10 * 60 * 1000;
                if (stats.isPaused) stats.remainingTimeMs = Math.max(0, stats.remainingTimeMs - msToRemove);
                else stats.timerEndTime = new Date(new Date(stats.timerEndTime).getTime() - msToRemove);
                await stats.save();
            }
        }
        await SpinQueue.deleteMany({ sourceEventId: id });
        await NisathonEvent.findByIdAndDelete(id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
