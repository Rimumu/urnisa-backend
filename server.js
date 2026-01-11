
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
    isEnded: { type: Boolean, default: false }, // New field to track if Nisathon is ended
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

// NEW: Bingo Card Schema
const BingoCard = mongoose.model('BingoCard', new mongoose.Schema({
    discordId: { type: String, required: true },
    name: { type: String, required: true }, // User given name
    cardId: { type: String, required: true }, // The seed ID
    gridData: { type: Array, required: true }, // Snapshot of cells to ensure consistency
    marked: { type: [Boolean], required: true }, // Array of booleans
    updatedAt: { type: Date, default: Date.now }
}));

// NEW: Bingo Card DEFINITION Schema (Ensures ID -> Same Grid Always)
const BingoDefinition = mongoose.model('BingoDefinition', new mongoose.Schema({
    cardId: { type: String, required: true, unique: true },
    gridData: { type: Array, required: true }, // The definitive layout
    difficulty: String,
    createdAt: { type: Date, default: Date.now }
}));

// NEW: Bingo Winner Schema for Leaderboard
const BingoWinner = mongoose.model('BingoWinner', new mongoose.Schema({
    discordId: { type: String, required: true },
    minecraftUsername: { type: String, required: true },
    discordAvatar: { type: String }, // Optional cached avatar
    cardId: { type: String, required: true },
    linesCompleted: { type: Number, required: true },
    completedAt: { type: Date, default: Date.now }
}));

// NEW: Tournament Entry Schema
const TournamentEntry = mongoose.model('TournamentEntry', new mongoose.Schema({
    discordId: { type: String, required: true, unique: true },
    minecraftUsername: { type: String, required: true },
    team: [{
        id: Number,
        name: String
    }],
    isLocked: { type: Boolean, default: false },
    isDev: { type: Boolean, default: false }, // Flag for dummy players
    updatedAt: { type: Date, default: Date.now }
}));

// NEW: Tournament Bracket Schema
const TournamentMatchSchema = new mongoose.Schema({
    id: String,
    bracketGroup: { type: String, default: 'winners' }, // 'winners', 'losers', 'finals'
    round: Number, // 1 = First Round, etc.
    matchIndex: Number, // Position in round (0 = top, 1 = next down)
    player1: { type: String, default: null }, // Minecraft Username
    player2: { type: String, default: null }, // Minecraft Username
    winner: { type: String, default: null }, // Minecraft Username
    score: { type: String, default: "" },
    nextMatchId: String, // ID of the match the winner advances to
    loserNextMatchId: { type: String, default: null }, // ID where the loser goes (Double Elim)
    status: { type: String, default: "PENDING" } // PENDING, READY, COMPLETED
});

const TournamentBracket = mongoose.model('TournamentBracket', new mongoose.Schema({
    key: { type: String, default: 'main', unique: true }, // 'production' or 'dev'
    type: { type: String, default: 'SINGLE_ELIMINATION' },
    matches: [TournamentMatchSchema],
    updatedAt: { type: Date, default: Date.now }
}));

// ==========================================
// SNAKES AND LADDERS SCHEMAS
// ==========================================
const SnakesQueue = mongoose.model('SnakesQueue', new mongoose.Schema({
    user: { type: String, required: true },
    avatarUrl: String,
    amount: { type: Number, default: 1 }, // How many rolls this entry represents
    type: { type: String, default: 'sub' }, // 'sub' or 'gift'
    sourceEventId: String,
    createdAt: { type: Date, default: Date.now }
}));

const SnakesPlayer = mongoose.model('SnakesPlayer', new mongoose.Schema({
    user: { type: String, required: true, unique: true },
    avatarUrl: String,
    position: { type: Number, default: 0 }, // 0 = not on board, 1-100 = tile
    lastMovedAt: { type: Date, default: Date.now }
}));

const SnakesHistory = mongoose.model('SnakesHistory', new mongoose.Schema({
    user: { type: String, required: true },
    roll: { type: Number, required: true },
    fromPosition: { type: Number, required: true },
    toPosition: { type: Number, required: true },
    specialMove: String, // 'ladder', 'snake', or null
    timestamp: { type: Date, default: Date.now }
}));

const SnakesWinner = mongoose.model('SnakesWinner', new mongoose.Schema({
    user: { type: String, required: true, unique: true },
    avatarUrl: String,
    winCount: { type: Number, default: 1 },
    lastWinAt: { type: Date, default: Date.now }
}));

const SnakesSettings = mongoose.model('SnakesSettings', new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    isActive: { type: Boolean, default: false }, // Whether to process incoming events
    lastProcessedEventId: String
}));

// Snakes and Ladders board configuration (standard layout)
const SNAKES_AND_LADDERS = {
    // Ladders: start -> end (go UP)
    ladders: { 2: 38, 7: 14, 8: 31, 15: 26, 21: 42, 28: 84, 36: 44, 51: 67, 71: 91, 78: 98, 87: 94 },
    // Snakes: start -> end (go DOWN)
    snakes: { 16: 6, 46: 25, 49: 11, 62: 19, 64: 60, 74: 53, 89: 68, 92: 88, 95: 75, 99: 80 }
};

const roundOneDecimal = (num) => Math.round(num * 10) / 10;

// ==========================================
// GIFT BATCHING BUFFER
// ==========================================
// Stores pending gift events: { "SenderName": { count: 5, tier: '1000', timer: Timeout } }
const giftBuffer = {};

const processBufferedGift = async (sender, data) => {
    console.log(`🎁 Processing Bulk Gift: ${sender} gifted ${data.count} subs!`);

    try {
        const stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) return;

        // If ended, do not process
        if (stats.isEnded) {
            console.log("🛑 Nisathon Ended - Skipping Gift Buffer");
            return;
        }

        // Generate a unique ID for this bulk event
        const providerId = `bulk-gift-${Date.now()}-${sender}`;

        // Process as a single 'gift' event with amount = count
        await processEvent(
            stats,
            'gift',
            sender,
            data.count,
            `Gifted ${data.count} subs`,
            providerId,
            data.tier
        );

        await stats.save();
    } catch (e) {
        console.error("Gift Buffer Error:", e);
    }

    // Cleanup
    delete giftBuffer[sender];
};

// ==========================================
// CORE LOGIC
// ==========================================

const processEvent = async (stats, type, user, amount, message, providerId, tier = '1000', isManual = false) => {
    // If Nisathon is ended, ignore incoming auto events
    if (stats.isEnded && !isManual) {
        return 0;
    }

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
        // Skip Recipient Events (trust bulk 'gift' event logic) unless manual
        if (!isManual && (message.includes('gift') || amount === 0)) {
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
    else if (type === 'gift') {
        earnedNisaballs = 0.5 * amount; // 0.5 NB per gift sub
        amountDisplay = `${amount} Gift Sub${amount > 1 ? 's' : ''}`;
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

    // Wheel Logic (Single Transaction >= 5 NB)
    if (isNewEvent && earnedNisaballs >= 5) {
        const spins = Math.floor(earnedNisaballs / 5);
        console.log(`🎡 Queueing ${spins} spins for ${user}`);
        for (let i = 0; i < spins; i++) {
            await SpinQueue.create({ user: user || 'Anon', sourceEventId: res._id, nisaballs: earnedNisaballs });
        }
    }

    if (isNewEvent) console.log(`✅ [${isManual ? 'MANUAL' : 'AUTO'}] ${user} | (${eventType}) | +${earnedNisaballs}NB`);
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

            // --- STOP IF ENDED ---
            if (stats.isEnded) {
                console.log("🛑 Nisathon Ended - Ignoring Event");
                return;
            }

            const info = data.data;
            let amount = 1;
            let tier = '1000';
            let type = data.type;
            let username = info.username;

            // GIFT BUFFERING LOGIC
            if (type === 'subscriber' && info.gifted) {
                const sender = info.sender;
                // If we have a pending buffer for this sender, clear its timeout
                if (giftBuffer[sender]) {
                    clearTimeout(giftBuffer[sender].timer);
                    giftBuffer[sender].count += 1;
                } else {
                    // Start new buffer
                    giftBuffer[sender] = { count: 1, tier: info.tier || '1000', timer: null };
                }

                // Set/Reset timeout to process the batch after 2 seconds of silence
                giftBuffer[sender].timer = setTimeout(() => {
                    processBufferedGift(sender, giftBuffer[sender]);
                }, 2000);

                return; // Stop processing this individual event
            }

            // Normal Processing
            if (type === 'subscriber') {
                tier = info.tier || '1000';
                amount = info.amount || 1;
            } else if (type === 'tip' || type === 'cheer') {
                amount = info.amount;
            } else if (type === 'follow') {
                type = 'follower';
                amount = 0;
            }

            const providerId = data._id || `sock-${Date.now()}-${Math.random()}`;
            await processEvent(stats, type, username, amount, info.message || "", providerId, tier);
            await stats.save();
        } catch (e) { console.error("Socket Error:", e); }
    });
};

// ==========================================
// 2. REST POLLING & RESOLVER
// ==========================================
const resolveChannelId = async () => {
    if (!SE_JWT) return null;
    try {
        const res = await axios.get(`https://api.streamelements.com/kappa/v2/channels/${TARGET_USERNAME}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (res.data && res.data._id) {
            return res.data._id;
        }
    } catch (e) { }
    try {
        const me = await axios.get('https://api.streamelements.com/kappa/v2/channels/me', {
            headers: { 'Authorization': `Bearer ${SE_JWT}` }
        });
        return me.data._id;
    } catch (e) { return null; }
};

const fetchAndProcess = async (channelId, label, stats, limit = 25, offset = 0) => {
    if (!channelId) return [];

    // Check if ended (extra safety for poll loop)
    if (stats && stats.isEnded) return [];

    try {
        const url = `https://api.streamelements.com/kappa/v2/activities/${channelId}`;
        const { data: activities } = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${SE_JWT}`,
                'Accept': 'application/json',
                'User-Agent': 'UrnisaBot/1.0'
            },
            params: { limit, offset, types: 'subscriber,tip,cheer,follow' },
            timeout: 10000
        });

        if (!activities || activities.length === 0) return [];

        if (offset === 0) {
            activities.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
            let changes = false;
            for (const act of activities) {
                let amt = 0;
                let tier = '1000';
                let type = act.type;
                let username = act.data.username;

                // Handle Gifts in REST
                if (['subscriber', 'sub', 'resub'].includes(act.type)) {
                    amt = 1;
                    tier = act.data.tier || '1000';
                    if (act.data.gifted) {
                        username = act.data.sender;
                        type = 'gift';
                    }
                }
                else if (act.type === 'gift') {
                    amt = act.data.amount || 1;
                }
                else if (['cheer', 'tip'].includes(act.type)) {
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
        }
        return activities;
    } catch (e) { return []; }
};

const syncSessionFallback = async (channelId, stats) => {
    // Check if ended
    if (stats.isEnded) return;

    try {
        const { data: session } = await axios.get(`https://api.streamelements.com/kappa/v2/sessions/${channelId}`, {
            headers: { 'Authorization': `Bearer ${SE_JWT}` }
        });

        if (!session || !session.data) return;

        let changes = false;
        const lastSub = session.data['latest-subscriber'];
        if (lastSub) {
            let username = lastSub.name;
            let type = 'subscriber';
            if (lastSub.gifted) {
                username = lastSub.sender;
                type = 'gift';
            }
            await processEvent(stats, type, username, 1, "", `session-sub-${username}`, lastSub.tier);
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
    } catch (e) { }
};

const runSync = async (forceDeep = false) => {
    if (mongoose.connection.readyState !== 1) return;
    if (!SE_JWT) return;

    try {
        let stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) stats = await NisathonStats.create({ key: 'main', timerEndTime: new Date(Date.now() + 3 * 3600000) });

        // If Nisathon is ended, stop fetching activity
        if (stats.isEnded && !forceDeep) return;

        let resolvedId = await resolveChannelId();
        if (!resolvedId) resolvedId = ENV_CHANNEL_ID;

        if (resolvedId) {
            const limit = forceDeep ? 100 : 25;
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
    stats.remainingTimeMs = 0; stats.isPaused = false; stats.isEnded = false;
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

    console.log(`   -> Processing ${allActivities.length} historical events...`);
    allActivities.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    for (const act of allActivities) {
        let amt = 0, tier = '1000', type = act.type, user = act.data.username;

        if (['subscriber', 'sub', 'resub'].includes(act.type)) {
            amt = 1;
            tier = act.data.tier || '1000';
            if (act.data.gifted) {
                user = act.data.sender;
                type = 'gift';
            }
        }
        else if (act.type === 'gift') amt = act.data.amount || 1;
        else if (['cheer', 'tip'].includes(act.type)) amt = act.data.amount;
        else if (act.type === 'follow') { type = 'follower'; amt = 0; }
        else continue;

        await processEvent(stats, type, user, amt, act.data.message, act._id, tier);
    }
    stats.lastActivityTime = new Date().toISOString();
    await stats.save();
    console.log("✅ REBUILD COMPLETE.");
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
    } catch (e) { }

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
app.post('/api/verify', (req, res) => res.json(req.body.password === ADMIN_PASSWORD ? { success: true } : { error: 'Invalid' }));

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
        res.json(lb.map((x, i) => ({ rank: i + 1, user: x._id, totalNisaballs: roundOneDecimal(x.total) })));
    } catch { res.json([]); }
});

app.get('/api/nisathon/recent', async (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json(await NisathonEvent.find().sort({ createdAt: -1 }).limit(limit));
});

app.post('/api/nisathon/test-event', auth, async (req, res) => {
    const stats = await NisathonStats.findOne({ key: 'main' });
    await processEvent(stats, req.body.type, req.body.user, parseFloat(req.body.amount), "Manual", null, req.body.tier, true);
    await stats.save();
    res.json({ success: true });
});

app.post('/api/nisathon/timer/set', auth, async (req, res) => {
    const stats = await NisathonStats.findOne({ key: 'main' });
    const ms = (req.body.hours * 3600 + req.body.minutes * 60 + req.body.seconds) * 1000;
    if (stats.isPaused) stats.remainingTimeMs = ms; else stats.timerEndTime = new Date(Date.now() + ms);
    await stats.save();
    res.json({ success: true });
});
app.post('/api/nisathon/timer/add', auth, async (req, res) => {
    const stats = await NisathonStats.findOne({ key: 'main' });
    const ms = req.body.minutes * 60000;
    if (stats.isPaused) {
        stats.remainingTimeMs += ms;
        // Clamp to 0 if we removed too much time while paused
        if (stats.remainingTimeMs < 0) stats.remainingTimeMs = 0;
    }
    else {
        // Unpaused: modify end time. 
        // If adding: extend from max(now, endtime). 
        // If removing: subtract from current endtime.
        stats.timerEndTime = new Date(Math.max(Date.now(), new Date(stats.timerEndTime).getTime()) + ms);
    }
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
        remainingTimeMs: 0, isPaused: false, isEnded: false, activeEvent: null, lastActivityTime: new Date().toISOString()
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

// NEW: END NISATHON ENDPOINT
app.post('/api/nisathon/end', auth, async (req, res) => {
    try {
        await NisathonStats.findOneAndUpdate({ key: 'main' }, { isEnded: true, isPaused: true });
        res.json({ success: true, message: "Nisathon Ended" });
    } catch (e) {
        res.status(500).json({ error: "Failed to end Nisathon" });
    }
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

app.post('/api/nisathon/merge-users', auth, async (req, res) => {
    const { sourceUser, targetUser } = req.body;
    if (!sourceUser || !targetUser) return res.status(400).json({ error: "Invalid parameters" });

    // Sanitize
    const cleanSource = sourceUser.trim();
    const cleanTarget = targetUser.trim();

    try {
        // Use loose regex for finding ALL variations of the SOURCE name (including those with spaces)
        // Escaping input to be safe for regex
        const escapedSource = cleanSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // This matches: "name", " name", "name ", " name " etc. case-insensitive
        const sourceRegex = new RegExp(`^\\s*${escapedSource}\\s*$`, 'i');

        // Note: We intentionally do NOT check if source === target string.
        // This allows admins to enter "takoz212" -> "takoz212" to clean up "takoz212 " and "Takoz212" into one clean entry.

        const events = await NisathonEvent.updateMany({ user: sourceRegex }, { user: cleanTarget });
        const spinsQ = await SpinQueue.updateMany({ user: sourceRegex }, { user: cleanTarget });
        const spinsH = await SpinHistory.updateMany({ user: sourceRegex }, { user: cleanTarget });

        res.json({
            success: true,
            message: `Merged/Normalized ${events.modifiedCount} events, ${spinsQ.modifiedCount} queued spins, ${spinsH.modifiedCount} history entries into "${cleanTarget}".`
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Wheel
app.get('/api/wheel/queue', async (req, res) => res.json(await SpinQueue.find().sort({ createdAt: 1 })));
app.get('/api/wheel/history', async (req, res) => res.json(await SpinHistory.find().sort({ timestamp: -1 })));
app.post('/api/wheel/spin-result', auth, async (req, res) => {
    await SpinHistory.create({ user: req.body.user, reward: req.body.reward });
    if (req.body.queueId) await SpinQueue.findByIdAndDelete(req.body.queueId);
    res.json({ success: true });
});

// ==========================================
// SNAKES AND LADDERS API
// ==========================================

// Get full game state (players, queue, settings)
app.get('/api/snakes/state', async (req, res) => {
    try {
        const [queue, players, history, winners, settings] = await Promise.all([
            SnakesQueue.find().sort({ createdAt: 1 }),
            SnakesPlayer.find().sort({ lastMovedAt: -1 }),
            SnakesHistory.find().sort({ timestamp: -1 }).limit(50),
            SnakesWinner.find().sort({ winCount: -1 }).limit(10),
            SnakesSettings.findOne({ key: 'main' })
        ]);
        res.json({
            queue,
            players,
            history,
            winners,
            isActive: settings?.isActive || false,
            board: SNAKES_AND_LADDERS
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Toggle game active state
app.post('/api/snakes/toggle', auth, async (req, res) => {
    try {
        let settings = await SnakesSettings.findOne({ key: 'main' });
        if (!settings) settings = await SnakesSettings.create({ key: 'main' });
        settings.isActive = !settings.isActive;
        await settings.save();
        console.log(`🐍 Snakes Game ${settings.isActive ? 'ACTIVATED' : 'DEACTIVATED'}`);
        res.json({ success: true, isActive: settings.isActive });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Process a move (admin triggers this when ready)
app.post('/api/snakes/move', auth, async (req, res) => {
    try {
        // Get first item in queue
        const queueItem = await SnakesQueue.findOne().sort({ createdAt: 1 });
        if (!queueItem) {
            return res.status(400).json({ error: 'Queue is empty' });
        }

        // Roll dice (1-6)
        const roll = Math.floor(Math.random() * 6) + 1;

        // Get or create player
        let player = await SnakesPlayer.findOne({ user: queueItem.user });
        if (!player) {
            player = await SnakesPlayer.create({
                user: queueItem.user,
                avatarUrl: queueItem.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(queueItem.user)}&background=random`,
                position: 0
            });
        }

        const fromPosition = player.position;
        let newPosition = fromPosition + roll;
        let specialMove = null;

        // Can't go beyond 100 - Bounce back
        if (newPosition > 100) {
            const diff = newPosition - 100;
            newPosition = 100 - diff;
        }

        // Check for ladder
        if (SNAKES_AND_LADDERS.ladders[newPosition]) {
            specialMove = 'ladder';
            newPosition = SNAKES_AND_LADDERS.ladders[newPosition];
        }
        // Check for snake
        else if (SNAKES_AND_LADDERS.snakes[newPosition]) {
            specialMove = 'snake';
            newPosition = SNAKES_AND_LADDERS.snakes[newPosition];
        }

        // Update player position
        player.position = newPosition;
        player.lastMovedAt = new Date();
        await player.save();

        // Log history
        await SnakesHistory.create({
            user: queueItem.user,
            roll,
            fromPosition,
            toPosition: newPosition,
            specialMove
        });

        // Remove from queue
        await SnakesQueue.findByIdAndDelete(queueItem._id);

        const isWinner = newPosition === 100;

        if (isWinner) {
            const winner = await SnakesWinner.findOneAndUpdate(
                { user: queueItem.user },
                {
                    $inc: { winCount: 1 },
                    $set: {
                        lastWinAt: new Date(),
                        avatarUrl: queueItem.avatarUrl || player.avatarUrl
                    }
                },
                { upsert: true, new: true }
            );
            console.log(`🏆 ${queueItem.user} recorded as winner! Total wins: ${winner.winCount}`);
        }

        console.log(`🎲 ${queueItem.user} rolled ${roll}: ${fromPosition} -> ${newPosition}${specialMove ? ` (${specialMove}!)` : ''}${isWinner ? ' 🏆 WINNER!' : ''}`);

        res.json({
            success: true,
            user: queueItem.user,
            roll,
            fromPosition,
            toPosition: newPosition,
            specialMove,
            isWinner
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Admin: Move player manually
app.post('/api/snakes/admin/move', auth, async (req, res) => {
    try {
        const { user, spaces } = req.body;
        if (!user || spaces === undefined) return res.status(400).json({ error: 'User and spaces required' });

        // Case-insensitive search
        let player = await SnakesPlayer.findOne({ user: new RegExp(`^${user}$`, 'i') });
        if (!player) return res.status(404).json({ error: 'Player not found' });

        let newPosition = player.position + parseInt(spaces);

        // Clamp to valid board range 0-100
        if (newPosition < 0) newPosition = 0;
        if (newPosition > 100) newPosition = 100;

        let specialMove = null;

        // Check for ladder
        if (SNAKES_AND_LADDERS.ladders[newPosition]) {
            specialMove = 'ladder';
            newPosition = SNAKES_AND_LADDERS.ladders[newPosition];
        }
        // Check for snake
        else if (SNAKES_AND_LADDERS.snakes[newPosition]) {
            specialMove = 'snake';
            newPosition = SNAKES_AND_LADDERS.snakes[newPosition];
        }

        player.position = newPosition;
        player.lastMovedAt = new Date();
        await player.save();

        const isWinner = newPosition === 100;

        if (isWinner) {
            const winner = await SnakesWinner.findOneAndUpdate(
                { user: player.user },
                {
                    $inc: { winCount: 1 },
                    $set: {
                        lastWinAt: new Date(),
                        avatarUrl: player.avatarUrl
                    }
                },
                { upsert: true, new: true }
            );
            console.log(`🏆 Admin move triggered win for ${player.user}! Total wins: ${winner.winCount}`);
        }

        console.log(`🔧 Admin moved ${player.user} by ${spaces} to ${newPosition}${specialMove ? ` (${specialMove}!)` : ''}`);
        res.json({ success: true, newPosition, specialMove });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Add test event to queue (for testing without real subs)
app.post('/api/snakes/test-event', auth, async (req, res) => {
    try {
        const { user, amount = 1 } = req.body;
        if (!user) return res.status(400).json({ error: 'User required' });

        for (let i = 0; i < amount; i++) {
            await SnakesQueue.create({
                user,
                avatarUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(user)}&background=random`,
                amount: 1,
                type: 'test'
            });
        }

        console.log(`🧪 Added ${amount} test roll(s) for ${user}`);
        res.json({ success: true, added: amount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Reset game (clear all data)
app.post('/api/snakes/reset', auth, async (req, res) => {
    try {
        await Promise.all([
            SnakesQueue.deleteMany({}),
            SnakesPlayer.deleteMany({}),
            SnakesHistory.deleteMany({}),
            SnakesWinner.deleteMany({}) // Clear Hall of Fame
        ]);
        console.log('🐍 Snakes game RESET (including winners)');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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
    const ms = (req.body.hours * 3600 + req.body.minutes * 60 + req.body.seconds) * 1000;
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
app.get('/api/profile', async (req, res) => { const a = await Setting.findOne({ key: 'profile_about' }); const c = await Setting.findOne({ key: 'profile_credits' }); const w = await Setting.findOne({ key: 'profile_artworks' }); res.json({ about: a?.value || [], credits: c?.value || [], artworks: w?.value || [] }); });
app.post('/api/profile', auth, async (req, res) => { await Setting.findOneAndUpdate({ key: `profile_${req.body.type}` }, { value: req.body.data }, { upsert: true }); res.json({ success: true }); });
app.get('/api/schedule', async (req, res) => res.json({ url: (await Setting.findOne({ key: 'schedule_url' }))?.value || DEFAULT_SCHEDULE_URL }));
app.post('/api/schedule', auth, async (req, res) => { await Setting.findOneAndUpdate({ key: 'schedule_url' }, { value: req.body.url }, { upsert: true }); res.json({ success: true }); });
app.post('/api/stream-status', auth, async (req, res) => { await Setting.findOneAndUpdate({ key: 'stream_status_override' }, { value: req.body.override }, { upsert: true }); res.json({ success: true }); });
app.get('/api/stream-status', async (req, res) => { const s = await Setting.findOne({ key: 'stream_status_override' }); res.json({ override: s?.value || 'auto' }); });
app.post('/api/upload', async (req, res) => { const { image } = req.body; if (!image) return res.status(400).send(); if (CLOUDINARY_CLOUD_NAME) { try { const ts = Math.round(new Date().getTime() / 1000); const sig = crypto.createHash('sha1').update(`timestamp=${ts}${CLOUDINARY_API_SECRET}`).digest('hex'); const f = new FormData(); f.append('file', `data:image/jpeg;base64,${image}`); f.append('api_key', CLOUDINARY_API_KEY); f.append('timestamp', ts); f.append('signature', sig); const r = await axios.post(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, f); return res.json({ success: true, data: { url: r.data.secure_url } }); } catch (e) { return res.status(500).send(); } } return res.status(500).send(); });
const imageValidationCache = new Map();
app.get('/api/utils/check-image', async (req, res) => { const { url } = req.query; if (!url) return res.json({ valid: false }); if (imageValidationCache.has(url)) { return res.json({ valid: imageValidationCache.get(url) }); } try { const response = await axios.head(url, { timeout: 5000 }); const length = parseInt(response.headers['content-length'] || '0'); const isValid = length > 2048; imageValidationCache.set(url, isValid); res.json({ valid: isValid }); } catch (e) { imageValidationCache.set(url, false); res.json({ valid: false }); } });

// ==========================================
// NEW BINGO API
// ==========================================

// Save or Update a Bingo Card
app.post('/api/bingo/save', async (req, res) => {
    const { discordId, name, cardId, gridData, marked } = req.body;

    if (!discordId || !name || !cardId || !gridData) {
        return res.status(400).json({ error: "Missing required data" });
    }

    try {
        // Check if updating existing by name for this user, or create new
        const result = await BingoCard.findOneAndUpdate(
            { discordId, name },
            {
                cardId,
                gridData,
                marked,
                updatedAt: new Date()
            },
            { upsert: true, new: true }
        );
        res.json({ success: true, message: "Card saved successfully!" });
    } catch (e) {
        console.error("Bingo Save Error:", e);
        res.status(500).json({ error: "Failed to save card" });
    }
});

// List User's Saved Cards
app.get('/api/bingo/list', async (req, res) => {
    const { discordId } = req.query;
    if (!discordId) return res.status(400).json({ error: "Missing Discord ID" });

    try {
        const cards = await BingoCard.find({ discordId }).sort({ updatedAt: -1 });
        res.json(cards);
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch cards" });
    }
});

// Delete a Saved Card
app.post('/api/bingo/delete', async (req, res) => {
    const { discordId, name } = req.body;
    if (!discordId || !name) return res.status(400).json({ error: "Missing data" });

    try {
        await BingoCard.findOneAndDelete({ discordId, name });
        res.json({ success: true, message: "Card deleted" });
    } catch (e) {
        res.status(500).json({ error: "Failed to delete card" });
    }
});

// Get Bingo Configuration (Card ID, Win Condition)
app.get('/api/bingo/config', async (req, res) => {
    try {
        const config = await Setting.findOne({ key: 'bingo_config' });
        // Default fallbacks if not set
        res.json(config ? config.value : { cardId: 'WEEK1', winCondition: '1 Line' });
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch bingo config" });
    }
});

// Set Bingo Configuration (Admin)
app.post('/api/bingo/config', auth, async (req, res) => {
    const { cardId, winCondition } = req.body;
    try {
        await Setting.findOneAndUpdate(
            { key: 'bingo_config' },
            { value: { cardId, winCondition } },
            { upsert: true }
        );
        res.json({ success: true, message: "Bingo config updated" });
    } catch (e) {
        res.status(500).json({ error: "Failed to update bingo config" });
    }
});

// --- BINGO DEFINITIONS (PERSISTENT CARDS) ---

// Get Bingo Definition (The locked layout for a given ID)
app.get('/api/bingo/definition', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing ID" });
    try {
        const def = await BingoDefinition.findOne({ cardId: id });
        if (def) return res.json(def);
        return res.status(404).json({ error: "Not found" });
    } catch (e) {
        return res.status(500).json({ error: "Error" });
    }
});

// Save Bingo Definition (Locking a generated layout)
app.post('/api/bingo/definition', async (req, res) => {
    const { cardId, gridData, difficulty } = req.body;
    if (!cardId || !gridData) return res.status(400).json({ error: "Missing data" });

    try {
        // Try to create, if exists, return existing (first write wins strategy for consistency)
        const existing = await BingoDefinition.findOne({ cardId });
        if (existing) {
            return res.json({ success: true, data: existing, message: "Definition already exists" });
        }

        const newDef = await BingoDefinition.create({ cardId, gridData, difficulty });
        res.json({ success: true, data: newDef });
    } catch (e) {
        // Handle race condition unique constraint error
        if (e.code === 11000) {
            const existing = await BingoDefinition.findOne({ cardId });
            return res.json({ success: true, data: existing });
        }
        res.status(500).json({ error: "Error saving definition" });
    }
});

// --- BINGO LEADERBOARD API (NEW) ---

// Get Bingo Winners
app.get('/api/bingo/winners', async (req, res) => {
    try {
        const winners = await BingoWinner.find().sort({ linesCompleted: -1, completedAt: 1 }); // Most lines first, then earliest completion
        res.json(winners);
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch winners" });
    }
});

// Add Bingo Winner (Admin)
app.post('/api/admin/bingo/winner', auth, async (req, res) => {
    const { discordId, minecraftUsername, cardId, linesCompleted, completedAt } = req.body;

    if (!discordId || !minecraftUsername || !cardId || linesCompleted === undefined) {
        return res.status(400).json({ error: "Missing fields" });
    }

    try {
        // Create new winner record
        const winner = await BingoWinner.create({
            discordId,
            minecraftUsername,
            cardId,
            linesCompleted,
            completedAt: completedAt ? new Date(completedAt) : new Date()
        });
        res.json({ success: true, data: winner });
    } catch (e) {
        console.error("Add Winner Error:", e);
        res.status(500).json({ error: "Failed to add winner" });
    }
});

// Delete Bingo Winner (Admin)
app.post('/api/admin/bingo/winner/delete', auth, async (req, res) => {
    const { id } = req.body;
    try {
        await BingoWinner.findByIdAndDelete(id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to delete" });
    }
});

// ==========================================
// TOURNAMENT API ROUTES
// ==========================================

// Get Tournament Config
app.get('/api/tournament/config', async (req, res) => {
    try {
        const config = await Setting.findOne({ key: 'tournament_config' });
        // Default to DRAFTING if not present
        const val = config ? config.value : {};
        // Use status if present, otherwise infer from legacy lockEnabled
        const status = val.status || (val.lockEnabled ? 'LOCK_IN' : 'DRAFTING');

        res.json({
            status,
            lockEnabled: status === 'LOCK_IN' // Maintain backward compat
        });
    } catch (e) {
        res.status(500).json({ error: "Fetch failed" });
    }
});

// Admin: Set Tournament Config
app.post('/api/admin/tournament/config', auth, async (req, res) => {
    // Expect status string: 'DRAFTING', 'LOCK_IN', 'ONGOING'
    const { status, lockEnabled } = req.body;

    try {
        // Determine status from legacy input if new status input missing
        const newStatus = status || (lockEnabled ? 'LOCK_IN' : 'DRAFTING');

        await Setting.findOneAndUpdate(
            { key: 'tournament_config' },
            { value: { status: newStatus, lockEnabled: newStatus === 'LOCK_IN' } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Update failed" });
    }
});

// Get My Team
app.get('/api/tournament/my-team', async (req, res) => {
    const { discordId } = req.query;
    if (!discordId) return res.status(400).json({ error: "Missing Discord ID" });

    try {
        const entry = await TournamentEntry.findOne({ discordId });
        if (!entry) {
            // Not registered
            return res.json({ registered: false, team: new Array(6).fill(null), isLocked: false });
        }
        // Registered
        res.json({ ...entry.toObject(), registered: true });
    } catch (e) {
        res.status(500).json({ error: "Fetch failed" });
    }
});

// Register/Save Team
app.post('/api/tournament/register', async (req, res) => {
    const { discordId, minecraftUsername, team } = req.body;
    if (!discordId || !minecraftUsername || !team) return res.status(400).json({ error: "Missing Data" });

    try {
        // Check config for ONGOING status
        const config = await Setting.findOne({ key: 'tournament_config' });
        if (config && config.value && config.value.status === 'ONGOING') {
            return res.status(403).json({ error: "Tournament is ongoing. Registration closed." });
        }

        // Check if locked
        const existing = await TournamentEntry.findOne({ discordId });
        if (existing && existing.isLocked) {
            return res.status(403).json({ error: "Team is locked and cannot be edited." });
        }

        await TournamentEntry.findOneAndUpdate(
            { discordId },
            {
                minecraftUsername,
                team,
                updatedAt: new Date()
            },
            { upsert: true, new: true }
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Save failed" });
    }
});

// Lock Team
app.post('/api/tournament/lock', async (req, res) => {
    const { discordId } = req.body;
    if (!discordId) return res.status(400).json({ error: "Missing ID" });

    // Check if locking is enabled (Status MUST be LOCK_IN)
    const config = await Setting.findOne({ key: 'tournament_config' });
    const currentStatus = config?.value?.status || (config?.value?.lockEnabled ? 'LOCK_IN' : 'DRAFTING');

    if (currentStatus !== 'LOCK_IN') {
        return res.status(403).json({ error: "Lock-ins are currently unavailable." });
    }

    try {
        const entry = await TournamentEntry.findOne({ discordId });
        if (!entry) return res.status(404).json({ error: "No team found to lock." });

        // Basic Validation: Ensure team is somewhat valid (not completely empty)
        const validPokemon = entry.team.filter(p => p !== null).length;
        if (validPokemon === 0) return res.status(400).json({ error: "Cannot lock an empty team." });

        entry.isLocked = true;
        await entry.save();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Lock failed" });
    }
});

// Get All Players (Public - Masked Drafts)
// Updated to filter out Dev players by default unless specified
app.get('/api/tournament/players', async (req, res) => {
    const { dev } = req.query;
    // If ?dev=true is NOT present, we filter out isDev: true players
    const filter = dev === 'true' ? {} : { isDev: { $ne: true } };

    try {
        const players = await TournamentEntry.find(filter).sort({ updatedAt: -1 });
        // Sanitize: If not locked, hide team
        const sanitized = players.map(p => {
            if (p.isLocked) return p;
            return {
                _id: p._id,
                discordId: p.discordId,
                minecraftUsername: p.minecraftUsername,
                team: new Array(6).fill(null), // Mask team
                isLocked: false,
                isDev: p.isDev, // Include for dev tools if needed
                updatedAt: p.updatedAt
            };
        });
        res.json(sanitized);
    } catch (e) {
        res.status(500).json({ error: "Fetch failed" });
    }
});

// Admin: Get All Players (Locked and Unlocked)
app.get('/api/admin/tournament/all-players', auth, async (req, res) => {
    try {
        const players = await TournamentEntry.find().sort({ updatedAt: -1 });
        res.json(players);
    } catch (e) {
        res.status(500).json({ error: "Fetch failed" });
    }
});

// Admin: Unlock and Reset Team
app.post('/api/admin/tournament/unlock-team', auth, async (req, res) => {
    const { discordId } = req.body;
    if (!discordId) return res.status(400).json({ error: "Missing Discord ID" });

    try {
        const result = await TournamentEntry.findOneAndUpdate(
            { discordId },
            {
                isLocked: false,
                team: new Array(6).fill(null),
                updatedAt: new Date()
            },
            { new: true }
        );
        if (!result) return res.status(404).json({ error: "Player not found." });
        res.json({ success: true, message: "Team unlocked and reset successfully!" });
    } catch (e) {
        res.status(500).json({ error: "Action failed." });
    }
});

// Admin: Revoke Registration
app.post('/api/admin/tournament/revoke-registration', auth, async (req, res) => {
    const { discordId } = req.body;
    if (!discordId) return res.status(400).json({ error: "Missing Discord ID" });

    try {
        const result = await TournamentEntry.findOneAndDelete({ discordId });
        if (!result) return res.status(404).json({ error: "Player not found." });
        res.json({ success: true, message: "Registration revoked successfully!" });
    } catch (e) {
        res.status(500).json({ error: "Action failed." });
    }
});

// ==========================================
// TOURNAMENT GENERATOR HELPERS
// ==========================================

const generateMatches = async (key, type, participants) => {
    // Clear existing
    await TournamentBracket.deleteMany({ key });

    const totalPlayers = participants.length;
    let size = 2;
    while (size < totalPlayers) size *= 2;

    // Create Bracket Structure
    const matches = [];

    // --- SINGLE ELIMINATION GENERATION ---
    if (type === 'SINGLE_ELIMINATION') {
        const numRounds = Math.log2(size);
        let roundMatches = [];

        // R1 (Leaf Nodes)
        for (let i = 0; i < size / 2; i++) {
            const p1 = participants[i * 2] || null;
            const p2 = participants[i * 2 + 1] || null;

            let winner = null;
            let status = 'PENDING';
            if (p1 && !p2) { winner = p1; status = 'COMPLETED'; }
            else if (!p1 && !p2) { status = 'COMPLETED'; } // Bye vs Bye
            else if (p1 && p2) { status = 'READY'; }

            roundMatches.push({
                id: `R1-M${i + 1}`,
                bracketGroup: 'winners',
                round: 1,
                matchIndex: i,
                player1: p1,
                player2: p2,
                winner: winner,
                status: status,
                score: "",
                nextMatchId: null
            });
        }
        matches.push(...roundMatches);

        let prevRoundMatches = roundMatches;

        // Subsequent Rounds
        for (let r = 2; r <= numRounds; r++) {
            let currentRoundMatches = [];
            const numMatchesInRound = size / Math.pow(2, r);

            for (let i = 0; i < numMatchesInRound; i++) {
                const matchId = `R${r}-M${i + 1}`;
                const prev1 = prevRoundMatches[i * 2];
                const prev2 = prevRoundMatches[i * 2 + 1];

                prev1.nextMatchId = matchId;
                prev2.nextMatchId = matchId;

                let p1 = prev1.winner;
                let p2 = prev2.winner;
                let status = 'PENDING';

                if (p1 && p2) status = 'READY';

                currentRoundMatches.push({
                    id: matchId,
                    bracketGroup: 'winners',
                    round: r,
                    matchIndex: i,
                    player1: p1,
                    player2: p2,
                    winner: null,
                    status: status,
                    score: "",
                    nextMatchId: null
                });
            }
            matches.push(...currentRoundMatches);
            prevRoundMatches = currentRoundMatches;
        }
    }
    // --- DOUBLE ELIMINATION GENERATION ---
    else if (type === 'DOUBLE_ELIMINATION') {
        // Limitation: Supports up to 16 players for logic simplicity in this implementation
        // For larger brackets, a more generic algorithm is needed.
        if (size > 16) throw new Error("Double Elimination currently supports max 16 players.");

        // 1. Generate Winners Bracket (Same as Single Elim basically)
        const wbMatches = [];
        const numWbRounds = Math.log2(size);
        let prevWbRound = [];

        // WB Round 1
        for (let i = 0; i < size / 2; i++) {
            const p1 = participants[i * 2] || null;
            const p2 = participants[i * 2 + 1] || null;

            let winner = null;
            let status = 'PENDING';
            if (p1 && !p2) { winner = p1; status = 'COMPLETED'; }
            else if (!p1 && !p2) { status = 'COMPLETED'; }
            else if (p1 && p2) { status = 'READY'; }

            const m = {
                id: `WB-R1-M${i + 1}`,
                bracketGroup: 'winners',
                round: 1,
                matchIndex: i,
                player1: p1,
                player2: p2,
                winner: winner,
                status: status,
                score: "",
                nextMatchId: null,
                loserNextMatchId: null // To be filled
            };
            wbMatches.push(m);
            prevWbRound.push(m);
        }
        matches.push(...prevWbRound);

        // WB Rounds 2+
        for (let r = 2; r <= numWbRounds; r++) {
            let currentWbRound = [];
            const count = size / Math.pow(2, r);
            for (let i = 0; i < count; i++) {
                const matchId = `WB-R${r}-M${i + 1}`;
                const prev1 = prevWbRound[i * 2];
                const prev2 = prevWbRound[i * 2 + 1];

                prev1.nextMatchId = matchId;
                prev2.nextMatchId = matchId;

                let p1 = prev1.winner;
                let p2 = prev2.winner;
                let status = 'PENDING';
                if (p1 && p2) status = 'READY';

                const m = {
                    id: matchId,
                    bracketGroup: 'winners',
                    round: r,
                    matchIndex: i,
                    player1: p1,
                    player2: p2,
                    winner: null,
                    status: status,
                    score: "",
                    nextMatchId: null,
                    loserNextMatchId: null
                };
                currentWbRound.push(m);
            }
            matches.push(...currentWbRound);
            prevWbRound = currentWbRound;
        }

        // 2. Generate Losers Bracket Logic (Mapped manually for 4, 8, 16 sizes for stability)
        const lbMatches = [];

        // Helper to find match by ID
        const findMatch = (id) => matches.find(m => m.id === id);

        // --- 4 Players ---
        if (size === 4) {
            // LB R1 (1 match) - Takes losers from WB R1
            const lbR1M1 = { id: `LB-R1-M1`, bracketGroup: 'losers', round: 1, matchIndex: 0, player1: null, player2: null, nextMatchId: 'LB-R2-M1' };
            findMatch('WB-R1-M1').loserNextMatchId = 'LB-R1-M1'; // WB R1 M1 Loser -> LB R1 M1 P1
            findMatch('WB-R1-M2').loserNextMatchId = 'LB-R1-M1'; // WB R1 M2 Loser -> LB R1 M1 P2

            // LB R2 (Loser Finals) - Winner of LB R1 vs Loser of WB R2
            const lbR2M1 = { id: `LB-R2-M1`, bracketGroup: 'losers', round: 2, matchIndex: 0, player1: null, player2: null, nextMatchId: 'GF-M1' };
            findMatch('WB-R2-M1').loserNextMatchId = 'LB-R2-M1'; // WB Finals Loser -> LB Finals P2

            lbMatches.push(lbR1M1, lbR2M1);
        }
        // --- 8 Players ---
        else if (size === 8) {
            // LB R1 (2 matches) - Takes losers from WB R1
            const lbR1 = [
                { id: 'LB-R1-M1', bracketGroup: 'losers', round: 1, matchIndex: 0, nextMatchId: 'LB-R2-M1' },
                { id: 'LB-R1-M2', bracketGroup: 'losers', round: 1, matchIndex: 1, nextMatchId: 'LB-R2-M1' }
            ];
            findMatch('WB-R1-M1').loserNextMatchId = 'LB-R1-M1';
            findMatch('WB-R1-M2').loserNextMatchId = 'LB-R1-M1';
            findMatch('WB-R1-M3').loserNextMatchId = 'LB-R1-M2';
            findMatch('WB-R1-M4').loserNextMatchId = 'LB-R1-M2';

            // LB R2 (1 match) - Winners of LB R1 fight
            const lbR2 = [
                { id: 'LB-R2-M1', bracketGroup: 'losers', round: 2, matchIndex: 0, nextMatchId: 'LB-R3-M1' }
            ];

            // LB R3 (1 match) - Winner of LB R2 vs Loser of WB R2 (Semis)
            // Note: Standard double elim usually has more matches. Simplified here: 
            // WB R2 has 2 matches. Losers drop to LB R2 (or R3).
            // Let's use standard:
            // LB R1 (2 matches, 4 players): WB R1 Losers.
            // LB R2 (2 matches, 4 players): LB R1 Winners vs WB R2 Losers.
            // LB R3 (1 match, 2 players): LB R2 Winners.
            // LB R4 (1 match, 2 players): LB R3 Winner vs WB R3 Loser (WB Finals loser).

            // Redoing LB structure for 8 players standard:
            lbMatches.length = 0; // Clear

            // Round 1 (WB R1 Losers)
            lbMatches.push({ id: 'LB-R1-M1', bracketGroup: 'losers', round: 1, matchIndex: 0, nextMatchId: 'LB-R2-M1', player1: null, player2: null });
            lbMatches.push({ id: 'LB-R1-M2', bracketGroup: 'losers', round: 1, matchIndex: 1, nextMatchId: 'LB-R2-M2', player1: null, player2: null });

            findMatch('WB-R1-M1').loserNextMatchId = 'LB-R1-M1';
            findMatch('WB-R1-M2').loserNextMatchId = 'LB-R1-M1';
            findMatch('WB-R1-M3').loserNextMatchId = 'LB-R1-M2';
            findMatch('WB-R1-M4').loserNextMatchId = 'LB-R1-M2';

            // Round 2 (LB R1 Winners vs WB R2 Losers)
            lbMatches.push({ id: 'LB-R2-M1', bracketGroup: 'losers', round: 2, matchIndex: 0, nextMatchId: 'LB-R3-M1', player1: null, player2: null });
            lbMatches.push({ id: 'LB-R2-M2', bracketGroup: 'losers', round: 2, matchIndex: 1, nextMatchId: 'LB-R3-M1', player1: null, player2: null });

            findMatch('WB-R2-M1').loserNextMatchId = 'LB-R2-M2'; // Cross seeding or direct
            findMatch('WB-R2-M2').loserNextMatchId = 'LB-R2-M1';

            // Round 3 (LB R2 Winners fight)
            lbMatches.push({ id: 'LB-R3-M1', bracketGroup: 'losers', round: 3, matchIndex: 0, nextMatchId: 'LB-R4-M1', player1: null, player2: null });

            // Round 4 (LB R3 Winner vs WB Finals Loser)
            lbMatches.push({ id: 'LB-R4-M1', bracketGroup: 'losers', round: 4, matchIndex: 0, nextMatchId: 'GF-M1', player1: null, player2: null });
            findMatch('WB-R3-M1').loserNextMatchId = 'LB-R4-M1';
        }
        // --- 16 Players ---
        else if (size === 16) {
            // LB R1 (4 matches) - WB R1 Losers
            for (let i = 0; i < 4; i++) {
                lbMatches.push({ id: `LB-R1-M${i + 1}`, bracketGroup: 'losers', round: 1, matchIndex: i, nextMatchId: `LB-R2-M${Math.ceil((i + 1) / 2)}` });
                // Link WB R1 matches (0,1 -> 0 | 2,3 -> 1...)
                findMatch(`WB-R1-M${i * 2 + 1}`).loserNextMatchId = `LB-R1-M${i + 1}`;
                findMatch(`WB-R1-M${i * 2 + 2}`).loserNextMatchId = `LB-R1-M${i + 1}`;
            }

            // LB R2 (4 matches) - LB R1 Winners vs WB R2 Losers
            for (let i = 0; i < 4; i++) {
                lbMatches.push({ id: `LB-R2-M${i + 1}`, bracketGroup: 'losers', round: 2, matchIndex: i, nextMatchId: `LB-R3-M${Math.ceil((i + 1) / 2)}` });
                // Link WB R2 Losers (inverse order usually for seeding, doing direct for simplicity)
                findMatch(`WB-R2-M${4 - i}`).loserNextMatchId = `LB-R2-M${i + 1}`;
            }

            // LB R3 (2 matches) - LB R2 Winners
            for (let i = 0; i < 2; i++) {
                lbMatches.push({ id: `LB-R3-M${i + 1}`, bracketGroup: 'losers', round: 3, matchIndex: i, nextMatchId: `LB-R4-M${i + 1}` }); // Direct mapping to R4
            }

            // LB R4 (2 matches) - LB R3 Winners vs WB R3 Losers (Semis Losers)
            for (let i = 0; i < 2; i++) {
                lbMatches.push({ id: `LB-R4-M${i + 1}`, bracketGroup: 'losers', round: 4, matchIndex: i, nextMatchId: `LB-R5-M1` });
                findMatch(`WB-R3-M${2 - i}`).loserNextMatchId = `LB-R4-M${i + 1}`;
            }

            // LB R5 (1 match) - LB R4 Winners
            lbMatches.push({ id: 'LB-R5-M1', bracketGroup: 'losers', round: 5, matchIndex: 0, nextMatchId: 'LB-R6-M1' });

            // LB R6 (1 match) - LB R5 Winner vs WB Finals Loser
            lbMatches.push({ id: 'LB-R6-M1', bracketGroup: 'losers', round: 6, matchIndex: 0, nextMatchId: 'GF-M1' });
            findMatch('WB-R4-M1').loserNextMatchId = 'LB-R6-M1';
        }

        matches.push(...lbMatches);

        // 3. Grand Finals
        // WB Winner vs LB Winner
        const gfMatch = {
            id: 'GF-M1',
            bracketGroup: 'finals',
            round: 1,
            matchIndex: 0,
            player1: null, // From WB Finals Winner
            player2: null, // From LB Finals Winner
            nextMatchId: null
        };
        findMatch(`WB-R${numWbRounds}-M1`).nextMatchId = 'GF-M1';
        // LB connection is handled in LB logic above (last LB match nextMatchId = GF-M1)

        matches.push(gfMatch);
    }

    await TournamentBracket.create({
        key: key,
        type: type,
        matches: matches
    });
};

// ==========================================
// TOURNAMENT BRACKET DEV ENDPOINTS (KEY='main')
// ==========================================

// Get Current Bracket
app.get('/api/dev/tournament/bracket', async (req, res) => {
    try {
        let bracket = await TournamentBracket.findOne({ key: 'main' });
        if (!bracket) {
            // Return empty structure if not found
            return res.json({ type: 'SINGLE_ELIMINATION', matches: [] });
        }
        res.json(bracket);
    } catch (e) {
        res.status(500).json({ error: "Fetch failed" });
    }
});

// Generate Bracket from Locked Players
app.post('/api/dev/tournament/generate', auth, async (req, res) => {
    const { type, participants: manualParticipants } = req.body;

    try {
        let participants = [];
        if (manualParticipants && Array.isArray(manualParticipants)) {
            participants = manualParticipants;
        } else {
            let players = await TournamentEntry.find({ isLocked: true });
            players = players.sort(() => Math.random() - 0.5);
            participants = players.map(p => p.minecraftUsername);
        }

        await generateMatches('main', type || 'SINGLE_ELIMINATION', participants);
        res.json({ success: true, message: `Bracket generated with ${participants.length} players.` });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Generation failed" });
    }
});

// Update Match Result
app.post('/api/dev/tournament/match/update', auth, async (req, res) => {
    const { matchId, winner, score, player1, player2 } = req.body;

    try {
        const bracket = await TournamentBracket.findOne({ key: 'main' });
        if (!bracket) return res.status(404).json({ error: "No bracket found" });

        const matchIndex = bracket.matches.findIndex(m => m.id === matchId);
        if (matchIndex === -1) return res.status(404).json({ error: "Match not found" });

        const match = bracket.matches[matchIndex];

        // Update fields if provided
        if (player1 !== undefined) match.player1 = player1;
        if (player2 !== undefined) match.player2 = player2;
        if (winner !== undefined) match.winner = winner;
        if (score !== undefined) match.score = score;

        // Auto status update if players set
        if (match.player1 && match.player2 && match.status === 'PENDING') {
            match.status = 'READY';
        }

        // If winner set, mark completed
        if (match.winner) match.status = 'COMPLETED';

        // Propagate to next matches

        // 1. Winner Progression
        if (match.nextMatchId) {
            const nextMatch = bracket.matches.find(m => m.id === match.nextMatchId);
            if (nextMatch) {
                // If special handling needed for Grand Finals where p1 comes from WB and p2 from LB
                if (nextMatch.bracketGroup === 'finals') {
                    if (match.bracketGroup === 'winners') nextMatch.player1 = match.winner;
                    else nextMatch.player2 = match.winner;
                } else {
                    // Standard tree progression
                    const isPlayerOneSlot = (match.matchIndex % 2) === 0;
                    if (match.winner) {
                        if (isPlayerOneSlot) nextMatch.player1 = match.winner;
                        else nextMatch.player2 = match.winner;
                    }
                }
                if (nextMatch.player1 && nextMatch.player2) nextMatch.status = 'READY';
            }
        }

        // 2. Loser Progression (Double Elimination)
        if (match.loserNextMatchId && match.player1 && match.player2 && match.winner) {
            const loser = match.winner === match.player1 ? match.player2 : match.player1;
            const loserMatch = bracket.matches.find(m => m.id === match.loserNextMatchId);

            if (loserMatch) {
                // Logic to place loser into empty slot. 
                // Simple logic: fill p1 if empty, else p2.
                // NOTE: In strict brackets, the slot is deterministic. 
                // For simplicity here, we fill the first available slot.
                if (!loserMatch.player1) loserMatch.player1 = loser;
                else if (!loserMatch.player2) loserMatch.player2 = loser;

                if (loserMatch.player1 && loserMatch.player2) loserMatch.status = 'READY';
            }
        }

        // Save the *parent* document, not the subdocument directly
        bracket.markModified('matches');
        await bracket.save();

        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Update failed" });
    }
});

// Clear Bracket
app.post('/api/dev/tournament/clear', auth, async (req, res) => {
    try {
        await TournamentBracket.deleteMany({ key: 'main' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed" });
    }
});

// Inject Fake Player
app.post('/api/dev/tournament/inject-players', auth, async (req, res) => {
    const { count } = req.body;
    try {
        const dummies = [];
        for (let i = 0; i < count; i++) {
            const id = `dummy-${Date.now()}-${i}`;
            dummies.push({
                discordId: id,
                minecraftUsername: `Player_${Math.floor(Math.random() * 1000)}`,
                team: new Array(6).fill(null), // Empty team is fine for bracket testing logic
                isLocked: true, // Auto-lock to be eligible
                isDev: true, // Marked as Dev Player
                updatedAt: new Date()
            });
        }
        await TournamentEntry.insertMany(dummies);
        res.json({ success: true, count: dummies.length });
    } catch (e) {
        res.status(500).json({ error: "Failed" });
    }
});

// ==========================================
// TOURNAMENT BRACKET PRODUCTION ENDPOINTS (KEY='production')
// ==========================================

// Get Current Bracket (Production)
app.get('/api/tournament/bracket', async (req, res) => {
    try {
        let bracket = await TournamentBracket.findOne({ key: 'production' });
        if (!bracket) {
            return res.json({ type: 'SINGLE_ELIMINATION', matches: [] });
        }
        res.json(bracket);
    } catch (e) {
        res.status(500).json({ error: "Fetch failed" });
    }
});

// Generate Bracket (Production)
app.post('/api/admin/tournament/generate', auth, async (req, res) => {
    const { type, participants: manualParticipants } = req.body;

    try {
        let participants = [];
        if (manualParticipants && Array.isArray(manualParticipants)) {
            participants = manualParticipants;
        } else {
            let players = await TournamentEntry.find({ isLocked: true });
            players = players.sort(() => Math.random() - 0.5);
            participants = players.map(p => p.minecraftUsername);
        }

        await generateMatches('production', type || 'SINGLE_ELIMINATION', participants);
        res.json({ success: true, message: `Production bracket generated with ${participants.length} players.` });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Generation failed" });
    }
});

// Update Match Result (Production)
app.post('/api/admin/tournament/match/update', auth, async (req, res) => {
    const { matchId, winner, score, player1, player2 } = req.body;

    try {
        const bracket = await TournamentBracket.findOne({ key: 'production' });
        if (!bracket) return res.status(404).json({ error: "No bracket found" });

        const matchIndex = bracket.matches.findIndex(m => m.id === matchId);
        if (matchIndex === -1) return res.status(404).json({ error: "Match not found" });

        const match = bracket.matches[matchIndex];

        if (player1 !== undefined) match.player1 = player1;
        if (player2 !== undefined) match.player2 = player2;
        if (winner !== undefined) match.winner = winner;
        if (score !== undefined) match.score = score;

        if (match.player1 && match.player2 && match.status === 'PENDING') {
            match.status = 'READY';
        }
        if (match.winner) match.status = 'COMPLETED';

        // Progression Logic
        if (match.nextMatchId) {
            const nextMatch = bracket.matches.find(m => m.id === match.nextMatchId);
            if (nextMatch) {
                if (nextMatch.bracketGroup === 'finals') {
                    if (match.bracketGroup === 'winners') nextMatch.player1 = match.winner;
                    else nextMatch.player2 = match.winner;
                } else {
                    const isPlayerOneSlot = (match.matchIndex % 2) === 0;
                    if (match.winner) {
                        if (isPlayerOneSlot) nextMatch.player1 = match.winner;
                        else nextMatch.player2 = match.winner;
                    }
                }
                if (nextMatch.player1 && nextMatch.player2) nextMatch.status = 'READY';
            }
        }

        if (match.loserNextMatchId && match.player1 && match.player2 && match.winner) {
            const loser = match.winner === match.player1 ? match.player2 : match.player1;
            const loserMatch = bracket.matches.find(m => m.id === match.loserNextMatchId);
            if (loserMatch) {
                if (!loserMatch.player1) loserMatch.player1 = loser;
                else if (!loserMatch.player2) loserMatch.player2 = loser;
                if (loserMatch.player1 && loserMatch.player2) loserMatch.status = 'READY';
            }
        }

        bracket.markModified('matches');
        await bracket.save();

        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Update failed" });
    }
});

// Clear Bracket (Production)
app.post('/api/admin/tournament/clear', auth, async (req, res) => {
    try {
        await TournamentBracket.deleteMany({ key: 'production' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed" });
    }
});

// ==========================================
// COBBLEMON RANKED SYSTEM
// ==========================================

// Ranked Player Schema
const RankedPlayer = mongoose.model('RankedPlayer', new mongoose.Schema({
    uuid: { type: String, required: true, unique: true },
    minecraftName: { type: String, required: true },

    // === COMBINED STATS (ACTIVE - used for current leaderboard) ===
    elo: { type: Number, default: 1000 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    tier: { type: String, default: 'UNRANKED' },
    totalKOs: { type: Number, default: 0 },
    totalDeaths: { type: Number, default: 0 },
    winStreak: { type: Number, default: 0 },
    bestWinStreak: { type: Number, default: 0 },

    // === 1v1 STATS (INACTIVE - for future separate leaderboard) ===
    elo1v1: { type: Number, default: 1000 },
    wins1v1: { type: Number, default: 0 },
    losses1v1: { type: Number, default: 0 },
    tier1v1: { type: String, default: 'UNRANKED' },
    winStreak1v1: { type: Number, default: 0 },
    bestWinStreak1v1: { type: Number, default: 0 },

    // === 2v2 STATS (INACTIVE - for future separate leaderboard) ===
    elo2v2: { type: Number, default: 1000 },
    wins2v2: { type: Number, default: 0 },
    losses2v2: { type: Number, default: 0 },
    tier2v2: { type: String, default: 'UNRANKED' },
    winStreak2v2: { type: Number, default: 0 },
    bestWinStreak2v2: { type: Number, default: 0 },

    lastMatchAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}));


// Ranked Match Schema
const RankedMatch = mongoose.model('RankedMatch', new mongoose.Schema({
    winnerUuid: { type: String, required: true },
    winnerName: { type: String, required: true },
    loserUuid: { type: String, required: true },
    loserName: { type: String, required: true },
    winnerAlivePokemon: { type: Number, default: 0 },
    winnerTotalPokemon: { type: Number, default: 0 },
    loserAlivePokemon: { type: Number, default: 0 },
    loserTotalPokemon: { type: Number, default: 0 },
    winnerKOs: { type: Number, default: 0 },
    loserKOs: { type: Number, default: 0 },
    battleType: { type: String, default: '1v1' }, // '1v1' or '2v2'
    endReason: { type: String, default: 'normal' }, // 'normal', 'forfeit', 'disconnect'
    winnerEloChange: { type: Number, default: 0 },
    loserEloChange: { type: Number, default: 0 },
    winnerEloBefore: { type: Number, default: 0 },
    loserEloBefore: { type: Number, default: 0 },
    // Anti-abuse tracking
    diminishingMultiplier: { type: Number, default: 1.0 },
    uniqueOpponentBonus: { type: Boolean, default: false },
    eloRangeReduced: { type: Boolean, default: false },
    // Pokemon details for match history
    winnerPokemon: [{
        species: { type: String },
        nickname: { type: String },
        level: { type: Number, default: 50 },
        fainted: { type: Boolean, default: false }
    }],
    loserPokemon: [{
        species: { type: String },
        nickname: { type: String },
        level: { type: Number, default: 50 },
        fainted: { type: Boolean, default: false }
    }],
    createdAt: { type: Date, default: Date.now }
}));


// Opponent History Schema - tracks matches between specific player pairs
const OpponentHistory = mongoose.model('OpponentHistory', new mongoose.Schema({
    playerUuid: { type: String, required: true },
    opponentUuid: { type: String, required: true },
    matchCount: { type: Number, default: 0 },
    lastMatchAt: { type: Date, default: null },
    firstMatchAt: { type: Date, default: null }, // Tracks when first match started for 12hr reset
    cooldownUntil: { type: Date, default: null } // When null, no cooldown active
}));

// Create compound index for efficient lookups
OpponentHistory.collection.createIndex({ playerUuid: 1, opponentUuid: 1 }, { unique: true });

// Daily Stats Schema - tracks unique opponents per day
const DailyStats = mongoose.model('DailyStats', new mongoose.Schema({
    playerUuid: { type: String, required: true },
    date: { type: String, required: true }, // YYYY-MM-DD format
    uniqueOpponents: [{ type: String }], // Array of opponent UUIDs
    matchesPlayed: { type: Number, default: 0 },
    bonusEarned: { type: Boolean, default: false }
}));

DailyStats.collection.createIndex({ playerUuid: 1, date: 1 }, { unique: true });

// Ranked Ban Schema - persistent bans
const RankedBan = mongoose.model('RankedBan', new mongoose.Schema({
    playerUuid: { type: String, required: true, unique: true },
    playerName: { type: String },
    reason: { type: String, default: 'Manual ban' },
    bannedBy: { type: String }, // UUID or 'SYSTEM' for auto-bans
    bannedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null }, // null = permanent
    isPermanent: { type: Boolean, default: false }
}));

// Forfeit History Schema - tracks recent forfeits for abuse detection
const ForfeitHistory = mongoose.model('ForfeitHistory', new mongoose.Schema({
    playerUuid: { type: String, required: true },
    matchId: { type: String },
    opponent: { type: String },
    forfeitedAt: { type: Date, default: Date.now }
}));

ForfeitHistory.collection.createIndex({ playerUuid: 1, forfeitedAt: -1 });

// Helper function to check if player is banned
const isPlayerBanned = async (playerUuid) => {
    const ban = await RankedBan.findOne({ playerUuid });
    if (!ban) return { banned: false };

    // Check if ban has expired
    if (ban.expiresAt && new Date() > ban.expiresAt) {
        await RankedBan.deleteOne({ playerUuid });
        return { banned: false };
    }

    return {
        banned: true,
        reason: ban.reason,
        expiresAt: ban.expiresAt,
        isPermanent: ban.isPermanent
    };
};

// Helper function to check and apply forfeit abuse ban
const checkForfeitAbuse = async (playerUuid, playerName) => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    // Get recent forfeits (last hour)
    const recentForfeits = await ForfeitHistory.find({
        playerUuid,
        forfeitedAt: { $gte: oneHourAgo }
    }).sort({ forfeitedAt: -1 });

    // If 3 or more forfeits in last hour, auto-ban for 24 hours
    if (recentForfeits.length >= 3) {
        const existingBan = await RankedBan.findOne({ playerUuid });
        if (!existingBan) {
            await RankedBan.create({
                playerUuid,
                playerName,
                reason: 'Auto-ban: 3 forfeits within 1 hour',
                bannedBy: 'SYSTEM',
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
                isPermanent: false
            });
            console.log(`🚫 Auto-banned ${playerName} for 24h (forfeit abuse)`);
            return { banned: true, duration: '24 hours' };
        }
    }

    return { banned: false };
};


// Anti-Abuse Helper Functions

/**
 * Get diminishing returns multiplier for same-opponent matches
 * 
 * Logic:
 * - Matches 1-3: Full ELO (100%)
 * - After 3rd match: 30-minute cooldown starts
 * - During cooldown: Cannot queue (handled by mod/frontend), but if bypassed,
 *   match proceeds with diminishing returns (50% -> 25%)
 * - After cooldown: Match allowed with diminishing returns, then new cooldown
 * - After 12 hours since FIRST match with this opponent: Full reset
 */
const getDiminishingMultiplier = async (playerUuid, opponentUuid) => {
    const now = new Date();
    const twelveHoursMs = 12 * 60 * 60 * 1000;
    const thirtyMinutesMs = 30 * 60 * 1000;

    let history = await OpponentHistory.findOne({ playerUuid, opponentUuid });

    if (!history) {
        // First match with this opponent
        return { multiplier: 1.0, matchCount: 0, onCooldown: false, cooldownRemaining: 0 };
    }

    // Check if 12-hour reset has passed
    // Use firstMatchAt if available, otherwise fall back to lastMatchAt for legacy data
    const referenceTime = history.firstMatchAt || history.lastMatchAt;

    if (referenceTime && (now.getTime() - new Date(referenceTime).getTime() >= twelveHoursMs)) {
        // Full reset - back to 3 free matches
        history.matchCount = 0;
        history.firstMatchAt = null;
        history.cooldownUntil = null;
        await history.save();
        console.log(`🔄 Opponent history reset for ${playerUuid} vs ${opponentUuid} (12h passed)`);
        return { multiplier: 1.0, matchCount: 0, onCooldown: false, cooldownRemaining: 0 };
    }

    // ADDITIONAL FIX: If no reference time exists but matchCount is high, reset it (corrupted data)
    if (!referenceTime && history.matchCount >= 3) {
        console.log(`⚠️ Corrupted opponent history detected for ${playerUuid} vs ${opponentUuid}, resetting`);
        history.matchCount = 0;
        history.firstMatchAt = null;
        history.cooldownUntil = null;
        await history.save();
        return { multiplier: 1.0, matchCount: 0, onCooldown: false, cooldownRemaining: 0 };
    }

    const count = history.matchCount;

    // Check if currently on cooldown
    if (history.cooldownUntil && now < new Date(history.cooldownUntil)) {
        const cooldownRemaining = Math.ceil((new Date(history.cooldownUntil).getTime() - now.getTime()) / 60000);
        // On cooldown - return info but still allow with heavy penalty if they somehow bypass
        return {
            multiplier: 0.25,
            matchCount: count,
            onCooldown: true,
            cooldownRemaining
        };
    }

    // First 3 matches: Full ELO
    if (count < 3) {
        return { multiplier: 1.0, matchCount: count, onCooldown: false, cooldownRemaining: 0 };
    }

    // Beyond 3 matches (after cooldown expired): Diminishing returns
    // Match 4-5: 50%, Match 6+: 25%
    let multiplier = 1.0;
    if (count <= 4) {
        multiplier = 0.50;
    } else {
        multiplier = 0.25;
    }

    return { multiplier, matchCount: count, onCooldown: false, cooldownRemaining: 0 };
};

/**
 * Update opponent history after a match
 * Handles cooldown setting and firstMatchAt tracking
 */
const updateOpponentHistory = async (playerUuid, opponentUuid) => {
    const now = new Date();
    const thirtyMinutesMs = 30 * 60 * 1000;

    let history = await OpponentHistory.findOne({ playerUuid, opponentUuid });

    if (!history) {
        // Create new record - this is the first match
        await OpponentHistory.create({
            playerUuid,
            opponentUuid,
            matchCount: 1,
            lastMatchAt: now,
            firstMatchAt: now,
            cooldownUntil: null
        });
        return;
    }

    // Increment match count
    history.matchCount += 1;
    history.lastMatchAt = now;

    // If this was the first match of a new cycle, set firstMatchAt
    if (!history.firstMatchAt) {
        history.firstMatchAt = now;
    }

    // If we just hit 3 matches or beyond, start/extend cooldown
    if (history.matchCount >= 3) {
        history.cooldownUntil = new Date(now.getTime() + thirtyMinutesMs);
    }

    await history.save();
};


/**
 * Check daily unique opponents and return bonus multiplier
 * Returns bonus of 1.15 (15% extra) if player has fought 3+ unique opponents today
 */
const getUniqueOpponentBonus = async (playerUuid, opponentUuid) => {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    let stats = await DailyStats.findOne({ playerUuid, date: today });

    if (!stats) {
        stats = await DailyStats.create({
            playerUuid,
            date: today,
            uniqueOpponents: [],
            matchesPlayed: 0,
            bonusEarned: false
        });
    }

    // Check if this opponent is new for today
    const isNewOpponent = !stats.uniqueOpponents.includes(opponentUuid);

    // Add opponent to list if new
    if (isNewOpponent) {
        stats.uniqueOpponents.push(opponentUuid);
    }
    stats.matchesPlayed += 1;

    // Check if bonus threshold reached (3 unique opponents)
    const uniqueCount = stats.uniqueOpponents.length;
    let bonusMultiplier = 1.0;
    let bonusApplied = false;

    if (uniqueCount >= 3 && !stats.bonusEarned) {
        bonusMultiplier = 1.15; // 15% bonus
        bonusApplied = true;
        stats.bonusEarned = true;
    } else if (uniqueCount >= 3 && stats.bonusEarned) {
        // Already earned bonus today, still get small bonus for variety
        bonusMultiplier = 1.05; // 5% ongoing bonus for variety
    }

    await stats.save();

    return {
        bonusMultiplier,
        bonusApplied,
        uniqueCount,
        isNewOpponent
    };
};

/**
 * Get ELO range penalty - reduces gains if ELO difference > 200 (2 ranks)
 * Updated for small server where ranks are ~100 ELO apart
 */
const getEloRangePenalty = (winnerElo, loserElo) => {
    const eloDiff = Math.abs(winnerElo - loserElo);

    // No penalty for matches within 200 ELO (~2 ranks)
    if (eloDiff <= 200) {
        return { multiplier: 1.0, reduced: false };
    }

    // Graduated reduction for farming lower/higher ranked players
    // 200-400 diff (~3-4 ranks): 75%
    if (eloDiff <= 400) {
        return { multiplier: 0.75, reduced: true };
    }

    // 400-600 diff (~5-6 ranks): 50%
    if (eloDiff <= 600) {
        return { multiplier: 0.50, reduced: true };
    }

    // 600+ diff: 25%
    return { multiplier: 0.25, reduced: true };
};

// Tier definitions - Fast Track for Small Server
// Tier definitions - Adjusted for specific progression timeline
const TIERS = {
    UNRANKED: { name: 'Unranked', minElo: 0, minWins: 0, color: '#666666' },
    DIRT: { name: 'Dirt', minElo: 0, minWins: 1, color: '#D2691E' },
    CASUAL: { name: 'Casual', minElo: 0, minWins: 2, color: '#808080' },
    OMEGA: { name: 'Omega', minElo: 1100, color: '#55FF55' },      // Raised start to 1100
    BETA: { name: 'Beta', minElo: 1200, color: '#5555FF' },
    ALPHA: { name: 'Alpha', minElo: 1275, color: '#AA00AA' },      // Bridge tier
    LEGENDARY: { name: 'Legend', minElo: 1425, color: '#FFFF55' }, // Target: 5 Days
    MYTHIC: { name: 'Mythic', minElo: 1625, color: '#FF55FF' },     // Target: 10 Days
    ETERNAL: { name: 'Eternal', minElo: 1900, color: '#FF5555' }    // Target: 14 Days
};

// Calculate tier from ELO and wins
const calculateTier = (elo, wins) => {
    if (wins === 0) return 'UNRANKED';

    // Demotion Rule: If ELO drops below 1000, you are DIRT (even with 2+ wins)
    // To reach/return to Casual, you must be >= 1000.
    if (elo < 1000) return 'DIRT';

    if (wins === 1) return 'DIRT'; // Gatekeeper for new players staying >1000

    if (elo >= 1900) return 'ETERNAL';
    if (elo >= 1625) return 'MYTHIC';
    if (elo >= 1425) return 'LEGENDARY';
    if (elo >= 1275) return 'ALPHA';
    if (elo >= 1200) return 'BETA';
    if (elo >= 1100) return 'OMEGA';

    // If Wins >= 2 AND ELO >= 1000
    return 'CASUAL';
};

// Custom ELO calculation with bonuses
// OPTIMIZED for 8-player server progression (Legendary ~5d, Mythic ~10d, Eternal ~14d)
const calculateEloChange = (winnerElo, loserElo, result) => {
    const K = 100; // High K for small server fast progression
    const LOSER_ELO_RATIO = 0.5; // Asymmetric: loser loses 50% of winner gains (inflation)

    // Expected score for winner
    const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
    const expectedLoser = 1 - expectedWinner;

    // Base ELO change
    let baseWinnerChange = K * (1 - expectedWinner);
    let baseLoserChange = K * (0 - expectedLoser);

    // Alive Pokemon bonus for winner (0-10.0 points) - HIGH BONUS for speed
    let aliveBonus = 0;
    if (result.winnerTotalPokemon > 0) {
        aliveBonus = (result.winnerAlivePokemon / result.winnerTotalPokemon) * 10.0;
    }

    // KO bonus for winner (0-10.0 points)
    let koBonus = 0;
    if (result.loserTotalPokemon > 0) {
        koBonus = (result.winnerKOs / result.loserTotalPokemon) * 10.0;
    }

    // Format multiplier (2v2 battles slightly higher stakes)
    const formatMultiplier = result.battleType === '2v2' ? 1.1 : 1.0;

    // End reason modifiers
    let winnerMultiplier = 1.0;
    let loserMultiplier = 1.0;

    if (result.endReason === 'forfeit') {
        winnerMultiplier = 0.5; // Winner gets half ELO
        loserMultiplier = 1.5; // Loser loses 1.5x
    } else if (result.endReason === 'disconnect') {
        winnerMultiplier = 0; // No ELO for winner
        loserMultiplier = 1.0; // Normal loss for disconnector
    }

    // Calculate final changes
    const winnerChange = Math.round((baseWinnerChange * formatMultiplier + aliveBonus + koBonus) * winnerMultiplier);
    const loserChange = Math.round(baseLoserChange * formatMultiplier * loserMultiplier * LOSER_ELO_RATIO);

    return { winnerChange, loserChange };
};

// Submit Match Result (from Mod)
app.post('/api/ranked/match', async (req, res) => {
    // API Authentication
    const apiKey = req.headers['x-api-key'];
    const validKey = process.env.RANKED_API_KEY || 'urnisa-ranked-api-key-2024';

    if (apiKey !== validKey) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }

    try {
        const {
            winnerUuid, winnerName, loserUuid, loserName,
            winnerAlivePokemon, winnerTotalPokemon,
            loserAlivePokemon, loserTotalPokemon,
            winnerKOs, loserKOs, battleType, endReason,
            winnerPokemon, loserPokemon
        } = req.body;

        if (!winnerUuid || !loserUuid) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Get or create players
        let winner = await RankedPlayer.findOne({ uuid: winnerUuid });
        let loser = await RankedPlayer.findOne({ uuid: loserUuid });

        if (!winner) {
            winner = await RankedPlayer.create({ uuid: winnerUuid, minecraftName: winnerName });
        }
        if (!loser) {
            loser = await RankedPlayer.create({ uuid: loserUuid, minecraftName: loserName });
        }

        // Update names in case they changed
        if (winnerName) winner.minecraftName = winnerName;
        if (loserName) loser.minecraftName = loserName;

        // === TIMEOUT DRAW HANDLING ===
        // If battle timed out, record as draw with 0 ELO changes
        if (endReason === 'timeout') {
            const match = await RankedMatch.create({
                winnerUuid: winnerUuid,
                winnerName: winnerName,
                loserUuid: loserUuid,
                loserName: loserName,
                winnerEloChange: 0,
                loserEloChange: 0,
                winnerEloBefore: winner.elo,
                loserEloBefore: loser.elo,
                winnerEloAfter: winner.elo,
                loserEloAfter: loser.elo,
                winnerAlivePokemon: 0,
                winnerTotalPokemon: winnerTotalPokemon || 0,
                loserAlivePokemon: 0,
                loserTotalPokemon: loserTotalPokemon || 0,
                battleType: battleType || '1v1',
                endReason: 'timeout'
            });

            console.log(`⏱️ Timeout draw recorded: ${winnerName} vs ${loserName}`);

            return res.status(200).json({
                success: true,
                matchId: match._id,
                draw: true,
                reason: 'timeout',
                message: 'Battle timed out - no ELO changes'
            });
        }

        // === ANTI-ABUSE CHECKS ===

        // 1. Diminishing returns for same opponent (resets after 12 hours)
        const winnerDiminishing = await getDiminishingMultiplier(winnerUuid, loserUuid);
        const loserDiminishing = await getDiminishingMultiplier(loserUuid, winnerUuid);

        // 2. ELO range penalty (>500 difference = reduced gains)
        const eloRangePenalty = getEloRangePenalty(winner.elo, loser.elo);

        // 3. Unique opponent bonus (3+ unique per day)
        const winnerUniqueBonus = await getUniqueOpponentBonus(winnerUuid, loserUuid);
        const loserUniqueBonus = await getUniqueOpponentBonus(loserUuid, winnerUuid);

        // Calculate base ELO changes
        const baseEloChanges = calculateEloChange(winner.elo, loser.elo, {
            winnerAlivePokemon: winnerAlivePokemon || 0,
            winnerTotalPokemon: winnerTotalPokemon || 1,
            loserTotalPokemon: loserTotalPokemon || 1,
            winnerKOs: winnerKOs || 0,
            battleType: battleType || '1v1',
            endReason: endReason || 'normal'
        });

        // Apply anti-abuse modifiers to winner's gains
        let finalWinnerChange = baseEloChanges.winnerChange;
        finalWinnerChange *= winnerDiminishing.multiplier;  // Diminishing returns
        finalWinnerChange *= eloRangePenalty.multiplier;    // ELO range penalty
        finalWinnerChange *= winnerUniqueBonus.bonusMultiplier; // Unique opponent bonus
        finalWinnerChange = Math.round(finalWinnerChange);

        // Loser's loss is not affected by winner's modifiers (but can be by their own)
        let finalLoserChange = baseEloChanges.loserChange;
        finalLoserChange = Math.round(finalLoserChange);

        // Store ELO before changes
        const winnerEloBefore = winner.elo;
        const loserEloBefore = loser.elo;

        const format = (battleType || '1v1').toLowerCase().replace('v', 'v');
        const is1v1 = format === '1v1';

        // Update winner - COMBINED stats (active)
        winner.elo = Math.max(0, winner.elo + finalWinnerChange);
        winner.wins += 1;
        winner.winStreak += 1;
        winner.bestWinStreak = Math.max(winner.bestWinStreak, winner.winStreak);
        winner.totalKOs += (winnerKOs || 0);
        winner.totalDeaths += (winnerTotalPokemon - winnerAlivePokemon) || 0;
        winner.tier = calculateTier(winner.elo, winner.wins);
        winner.lastMatchAt = new Date();
        winner.updatedAt = new Date();

        // Update winner - FORMAT-SPECIFIC stats (inactive, for future use)
        if (is1v1) {
            winner.elo1v1 = Math.max(0, (winner.elo1v1 || 0) + finalWinnerChange);
            winner.wins1v1 = (winner.wins1v1 || 0) + 1;
            winner.winStreak1v1 = (winner.winStreak1v1 || 0) + 1;
            winner.bestWinStreak1v1 = Math.max(winner.bestWinStreak1v1 || 0, winner.winStreak1v1);
            winner.tier1v1 = calculateTier(winner.elo1v1, winner.wins1v1);
        } else {
            winner.elo2v2 = Math.max(0, (winner.elo2v2 || 0) + finalWinnerChange);
            winner.wins2v2 = (winner.wins2v2 || 0) + 1;
            winner.winStreak2v2 = (winner.winStreak2v2 || 0) + 1;
            winner.bestWinStreak2v2 = Math.max(winner.bestWinStreak2v2 || 0, winner.winStreak2v2);
            winner.tier2v2 = calculateTier(winner.elo2v2, winner.wins2v2);
        }

        // Update loser - COMBINED stats (active)
        loser.elo = Math.max(0, loser.elo + finalLoserChange);
        loser.losses += 1;
        loser.winStreak = 0;
        loser.totalKOs += (loserKOs || 0);
        loser.totalDeaths += (loserTotalPokemon - loserAlivePokemon) || 0;
        loser.tier = calculateTier(loser.elo, loser.wins);
        loser.lastMatchAt = new Date();
        loser.updatedAt = new Date();

        // Update loser - FORMAT-SPECIFIC stats (inactive, for future use)
        if (is1v1) {
            loser.elo1v1 = Math.max(0, (loser.elo1v1 || 0) + finalLoserChange);
            loser.losses1v1 = (loser.losses1v1 || 0) + 1;
            loser.winStreak1v1 = 0;
            loser.tier1v1 = calculateTier(loser.elo1v1, loser.wins1v1 || 0);
        } else {
            loser.elo2v2 = Math.max(0, (loser.elo2v2 || 0) + finalLoserChange);
            loser.losses2v2 = (loser.losses2v2 || 0) + 1;
            loser.winStreak2v2 = 0;
            loser.tier2v2 = calculateTier(loser.elo2v2, loser.wins2v2 || 0);
        }

        await winner.save();
        await loser.save();

        // Update opponent history for both players
        await updateOpponentHistory(winnerUuid, loserUuid);
        await updateOpponentHistory(loserUuid, winnerUuid);

        // Record match with anti-abuse info and Pokemon data
        const match = await RankedMatch.create({
            winnerUuid, winnerName, loserUuid, loserName,
            winnerAlivePokemon, winnerTotalPokemon,
            loserAlivePokemon, loserTotalPokemon,
            winnerKOs, loserKOs, battleType, endReason,
            winnerEloChange: finalWinnerChange,
            loserEloChange: finalLoserChange,
            winnerEloBefore, loserEloBefore,
            diminishingMultiplier: winnerDiminishing.multiplier,
            uniqueOpponentBonus: winnerUniqueBonus.bonusApplied,
            eloRangeReduced: eloRangePenalty.reduced,
            winnerPokemon: winnerPokemon || [],
            loserPokemon: loserPokemon || []
        });

        // Log with anti-abuse info
        let logMsg = `🏆 Ranked Match: ${winnerName} (+${finalWinnerChange}) defeated ${loserName} (${finalLoserChange})`;
        if (winnerDiminishing.multiplier < 1) logMsg += ` [Diminishing: ${Math.round(winnerDiminishing.multiplier * 100)}%]`;
        if (eloRangePenalty.reduced) logMsg += ` [ELO Range Penalty]`;
        if (winnerUniqueBonus.bonusApplied) logMsg += ` [Unique Opponent Bonus!]`;
        console.log(logMsg);

        // Track forfeits for abuse detection
        let forfeitBan = null;
        if (endReason === 'forfeit') {
            // Record this forfeit
            await ForfeitHistory.create({
                playerUuid: loserUuid,
                matchId: match._id.toString(),
                opponent: winnerUuid
            });

            // Check if this triggers an auto-ban
            forfeitBan = await checkForfeitAbuse(loserUuid, loserName);

            // Clean up old forfeit records (older than 12 hours)
            const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
            await ForfeitHistory.deleteMany({ forfeitedAt: { $lt: twelveHoursAgo } });
        }

        // Fire-and-forget call to Discord Bot to sync ranks immediately
        // On Render, we must use the remote URL provided in env, else fallback to localhost
        const botUrl = process.env.BOT_API_URL || `http://localhost:${process.env.BOT_PORT || 3002}`;
        axios.post(`${botUrl}/api/internal/sync-ranks`)
            .catch(err => console.error("⚠️ Failed to trigger Bot Rank Sync:", err.message));

        res.json({
            success: true,
            winnerElo: winner.elo,
            loserElo: loser.elo,
            winnerWins: winner.wins,
            loserLosses: loser.losses,
            winnerEloChange: finalWinnerChange,
            loserEloChange: finalLoserChange,
            winnerTier: winner.tier,
            loserTier: loser.tier,
            matchId: match._id,
            // Anti-abuse info for client display
            antiAbuse: {
                diminishingMultiplier: winnerDiminishing.multiplier,
                sameOpponentCount: winnerDiminishing.matchCount + 1,
                eloRangeReduced: eloRangePenalty.reduced,
                uniqueOpponentBonus: winnerUniqueBonus.bonusApplied,
                uniqueOpponentsToday: winnerUniqueBonus.uniqueCount,
                forfeitBan: forfeitBan
            }
        });
    } catch (e) {
        console.error('Ranked match error:', e);
        res.status(500).json({ error: e.message });
    }
});

// === BAN MANAGEMENT ENDPOINTS ===

// Check if player is banned (for mod to call)
app.get('/api/ranked/ban/:uuid', async (req, res) => {
    try {
        const { uuid } = req.params;
        const banStatus = await isPlayerBanned(uuid);
        res.json(banStatus);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Ban a player (requires API key)
app.post('/api/ranked/ban', async (req, res) => {
    try {
        const { apiKey, playerUuid, playerName, reason, duration, bannedBy, isPermanent } = req.body;

        const configApiKey = process.env.RANKED_API_KEY || 'your-api-key-here';
        if (apiKey !== configApiKey) {
            return res.status(403).json({ error: 'Invalid API key' });
        }

        // Check if already banned
        const existing = await RankedBan.findOne({ playerUuid });
        if (existing) {
            return res.json({ success: false, message: 'Player is already banned' });
        }

        // Calculate expiry
        let expiresAt = null;
        if (!isPermanent && duration) {
            expiresAt = new Date(Date.now() + duration * 60 * 60 * 1000); // duration in hours
        }

        await RankedBan.create({
            playerUuid,
            playerName: playerName || 'Unknown',
            reason: reason || 'Manual ban',
            bannedBy: bannedBy || 'OP',
            expiresAt,
            isPermanent: isPermanent || false
        });

        console.log(`🚫 ${playerName} banned from ranked by ${bannedBy} - Reason: ${reason}`);

        res.json({
            success: true,
            expiresAt,
            isPermanent: isPermanent || false
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Unban a player (requires API key)
app.delete('/api/ranked/ban/:uuid', async (req, res) => {
    try {
        const { uuid } = req.params;
        const { apiKey, unbannedBy } = req.body;

        const configApiKey = process.env.RANKED_API_KEY || 'your-api-key-here';
        if (apiKey !== configApiKey) {
            return res.status(403).json({ error: 'Invalid API key' });
        }

        const ban = await RankedBan.findOneAndDelete({ playerUuid: uuid });

        if (!ban) {
            return res.json({ success: false, message: 'Player is not banned' });
        }

        console.log(`✅ ${ban.playerName} unbanned from ranked by ${unbannedBy || 'OP'}`);

        res.json({
            success: true,
            playerName: ban.playerName
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// List all active bans (requires API key)
app.get('/api/ranked/bans', async (req, res) => {
    try {
        const { apiKey } = req.query;

        const configApiKey = process.env.RANKED_API_KEY || 'your-api-key-here';
        if (apiKey !== configApiKey) {
            return res.status(403).json({ error: 'Invalid API key' });
        }

        // Clean up expired bans first
        await RankedBan.deleteMany({
            expiresAt: { $ne: null, $lt: new Date() }
        });

        const bans = await RankedBan.find({}).sort({ bannedAt: -1 });

        res.json({
            count: bans.length,
            bans: bans.map(b => ({
                uuid: b.playerUuid,
                name: b.playerName,
                reason: b.reason,
                bannedBy: b.bannedBy,
                bannedAt: b.bannedAt,
                expiresAt: b.expiresAt,
                isPermanent: b.isPermanent
            }))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get Leaderboard
app.get('/api/ranked/leaderboard', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 1000);
        const offset = parseInt(req.query.offset) || 0;

        const players = await RankedPlayer.find({})
            .sort({ elo: -1, wins: -1 })
            .skip(offset)
            .limit(limit)
            .select('uuid minecraftName elo wins losses tier winStreak bestWinStreak');

        const total = await RankedPlayer.countDocuments({});

        const leaderboard = players.map((p, i) => ({
            rank: offset + i + 1,
            uuid: p.uuid,
            minecraftName: p.minecraftName,
            elo: p.elo,
            wins: p.wins,
            losses: p.losses,
            tier: p.tier,
            tierInfo: TIERS[p.tier] || TIERS.DIRT,
            winRate: p.wins + p.losses > 0 ? Math.round((p.wins / (p.wins + p.losses)) * 100) : 0,
            winStreak: p.winStreak,
            bestWinStreak: p.bestWinStreak
        }));

        res.json({ players: leaderboard, total, tiers: TIERS });
    } catch (e) {
        console.error('Leaderboard error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Get Player Profile
app.get('/api/ranked/player/:uuid', async (req, res) => {
    try {
        const player = await RankedPlayer.findOne({ uuid: req.params.uuid });
        if (!player) {
            return res.json({
                uuid: req.params.uuid,
                elo: 0, wins: 0, losses: 0, tier: 'DIRT',
                tierInfo: TIERS.DIRT
            });
        }

        // Get rank position
        const rank = await RankedPlayer.countDocuments({
            $or: [
                { elo: { $gt: player.elo } },
                { elo: player.elo, wins: { $gt: player.wins } }
            ],
            wins: { $gt: 0 }
        }) + 1;

        res.json({
            uuid: player.uuid,
            minecraftName: player.minecraftName,
            elo: player.elo,
            wins: player.wins,
            losses: player.losses,
            tier: player.tier,
            tierInfo: TIERS[player.tier] || TIERS.DIRT,
            rank: player.wins > 0 ? rank : null,
            winRate: player.wins + player.losses > 0 ?
                Math.round((player.wins / (player.wins + player.losses)) * 100) : 0,
            winStreak: player.winStreak,
            bestWinStreak: player.bestWinStreak,
            totalKOs: player.totalKOs,
            totalDeaths: player.totalDeaths,
            lastMatchAt: player.lastMatchAt
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get Player Match History
app.get('/api/ranked/player/:uuid/history', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const page = parseInt(req.query.page) || 1;
        const skip = (page - 1) * limit;

        const matches = await RankedMatch.find({
            $or: [
                { winnerUuid: req.params.uuid },
                { loserUuid: req.params.uuid }
            ]
        }).sort({ createdAt: -1 }).skip(skip).limit(limit);

        const total = await RankedMatch.countDocuments({
            $or: [
                { winnerUuid: req.params.uuid },
                { loserUuid: req.params.uuid }
            ]
        });

        const history = matches.map(m => {
            const isWin = m.winnerUuid === req.params.uuid;
            return {
                id: m._id,
                isWin,
                opponent: isWin ? m.loserName : m.winnerName,
                opponentUuid: isWin ? m.loserUuid : m.winnerUuid,
                eloChange: isWin ? m.winnerEloChange : m.loserEloChange,
                eloBefore: isWin ? m.winnerEloBefore : m.loserEloBefore,
                eloAfter: isWin ? (m.winnerEloBefore + m.winnerEloChange) : (m.loserEloBefore + m.loserEloChange),
                battleType: m.battleType,
                endReason: m.endReason,
                pokemonAlive: isWin ? m.winnerAlivePokemon : m.loserAlivePokemon,
                pokemonTotal: isWin ? m.winnerTotalPokemon : m.loserTotalPokemon,
                date: m.createdAt
            };
        });

        res.json({
            matches: history,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get Single Match Details
app.get('/api/ranked/match/:id', async (req, res) => {
    try {
        const match = await RankedMatch.findById(req.params.id);
        if (!match) {
            return res.status(404).json({ error: 'Match not found' });
        }

        res.json({
            id: match._id,
            winner: {
                uuid: match.winnerUuid,
                name: match.winnerName,
                eloChange: match.winnerEloChange,
                eloBefore: match.winnerEloBefore,
                eloAfter: match.winnerEloBefore + match.winnerEloChange,
                pokemonAlive: match.winnerAlivePokemon,
                pokemonTotal: match.winnerTotalPokemon,
                kos: match.winnerKOs,
                pokemon: match.winnerPokemon || []
            },
            loser: {
                uuid: match.loserUuid,
                name: match.loserName,
                eloChange: match.loserEloChange,
                eloBefore: match.loserEloBefore,
                eloAfter: match.loserEloBefore + match.loserEloChange,
                pokemonAlive: match.loserAlivePokemon,
                pokemonTotal: match.loserTotalPokemon,
                kos: match.loserKOs,
                pokemon: match.loserPokemon || []
            },
            battleType: match.battleType,
            endReason: match.endReason,
            date: match.createdAt
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// Get Player Rank (for in-game display)
app.get('/api/ranked/player/:uuid/rank', async (req, res) => {
    try {
        const player = await RankedPlayer.findOne({ uuid: req.params.uuid });
        if (!player) {
            return res.json({ tier: 'DIRT', tierInfo: TIERS.DIRT, elo: 0 });
        }
        res.json({
            tier: player.tier,
            tierInfo: TIERS[player.tier] || TIERS.DIRT,
            elo: player.elo
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Admin: Reset Ranked Data
app.post('/api/ranked/reset', auth, async (req, res) => {
    try {
        await RankedPlayer.deleteMany({});
        await RankedMatch.deleteMany({});
        res.json({ success: true, message: 'All ranked data cleared' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// === ADMIN COMMAND ENDPOINTS ===

// Modify ELO (add or remove)
app.post('/api/ranked/admin/modify-elo', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const validKey = process.env.RANKED_API_KEY || 'urnisa-ranked-api-key-2024';
    if (apiKey !== validKey) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const { playerUuid, playerName, eloChange, modifiedBy } = req.body;

        let player = await RankedPlayer.findOne({ uuid: playerUuid });
        if (!player) {
            player = await RankedPlayer.create({ uuid: playerUuid, minecraftName: playerName });
        }

        const oldElo = player.elo;
        player.elo = Math.max(0, player.elo + eloChange);
        player.tier = calculateTier(player.elo, player.wins);
        player.updatedAt = new Date();
        await player.save();

        console.log(`⚙️ Admin ELO Modify: ${playerName} ${eloChange >= 0 ? '+' : ''}${eloChange} (${oldElo} → ${player.elo}) by ${modifiedBy}`);

        res.json({
            success: true,
            oldElo,
            newElo: player.elo,
            tier: player.tier
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Set ELO to specific value
app.post('/api/ranked/admin/set-elo', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const validKey = process.env.RANKED_API_KEY || 'urnisa-ranked-api-key-2024';
    if (apiKey !== validKey) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const { playerUuid, playerName, newElo, modifiedBy } = req.body;

        let player = await RankedPlayer.findOne({ uuid: playerUuid });
        if (!player) {
            player = await RankedPlayer.create({ uuid: playerUuid, minecraftName: playerName });
        }

        const oldElo = player.elo;
        player.elo = Math.max(0, newElo);
        player.tier = calculateTier(player.elo, player.wins);
        player.updatedAt = new Date();
        await player.save();

        console.log(`⚙️ Admin ELO Set: ${playerName} ${oldElo} → ${player.elo} by ${modifiedBy}`);

        res.json({
            success: true,
            oldElo,
            newElo: player.elo,
            tier: player.tier
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Reset Player Stats
app.post('/api/ranked/admin/reset-player', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const validKey = process.env.RANKED_API_KEY || 'urnisa-ranked-api-key-2024';
    if (apiKey !== validKey) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const { playerUuid, playerName, resetBy } = req.body;

        const player = await RankedPlayer.findOne({ uuid: playerUuid });
        if (!player) {
            return res.json({ success: false, message: 'Player not found' });
        }

        const oldStats = { elo: player.elo, wins: player.wins, losses: player.losses };

        // Reset all stats
        player.elo = 1000;
        player.wins = 0;
        player.losses = 0;
        player.tier = 'UNRANKED';
        player.totalKOs = 0;
        player.totalDeaths = 0;
        player.winStreak = 0;
        player.bestWinStreak = 0;
        player.updatedAt = new Date();
        await player.save();

        // Also clear opponent history for this player
        await OpponentHistory.deleteMany({
            $or: [{ playerUuid }, { opponentUuid: playerUuid }]
        });

        console.log(`⚙️ Admin Reset: ${playerName} stats reset by ${resetBy} (was: ELO ${oldStats.elo}, W${oldStats.wins}/L${oldStats.losses})`);

        res.json({
            success: true,
            oldStats,
            message: `${playerName}'s stats have been reset`
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get Player Info (Admin Detail)
app.get('/api/ranked/admin/player-info/:uuid', async (req, res) => {
    try {
        const { uuid } = req.params;

        const player = await RankedPlayer.findOne({ uuid });
        if (!player) {
            return res.json({ found: false });
        }

        // Get ban status
        const banStatus = await isPlayerBanned(uuid);

        // Get opponent history count
        const opponentHistoryCount = await OpponentHistory.countDocuments({
            $or: [{ playerUuid: uuid }, { opponentUuid: uuid }]
        });

        // Get recent forfeits
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const recentForfeits = await ForfeitHistory.countDocuments({
            playerUuid: uuid,
            forfeitedAt: { $gte: oneHourAgo }
        });

        res.json({
            found: true,
            uuid: player.uuid,
            name: player.minecraftName,
            elo: player.elo,
            tier: player.tier,
            wins: player.wins,
            losses: player.losses,
            winRate: player.wins + player.losses > 0
                ? Math.round((player.wins / (player.wins + player.losses)) * 100)
                : 0,
            winStreak: player.winStreak,
            bestWinStreak: player.bestWinStreak,
            totalKOs: player.totalKOs,
            totalDeaths: player.totalDeaths,
            lastMatchAt: player.lastMatchAt,
            createdAt: player.createdAt,
            banStatus,
            opponentHistoryCount,
            recentForfeits
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Clear Opponent History Between Two Players
app.post('/api/ranked/admin/clear-history', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const validKey = process.env.RANKED_API_KEY || 'urnisa-ranked-api-key-2024';
    if (apiKey !== validKey) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const { player1Uuid, player2Uuid, clearedBy } = req.body;

        // Delete both directions
        const result = await OpponentHistory.deleteMany({
            $or: [
                { playerUuid: player1Uuid, opponentUuid: player2Uuid },
                { playerUuid: player2Uuid, opponentUuid: player1Uuid }
            ]
        });

        console.log(`⚙️ Admin Clear History: ${player1Uuid} <-> ${player2Uuid} by ${clearedBy} (${result.deletedCount} records)`);

        res.json({
            success: true,
            deletedCount: result.deletedCount,
            message: `Cleared ${result.deletedCount} opponent history records`
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ADMIN: Clear ALL Opponent History (resets everyone's diminishing returns)
app.post('/api/ranked/admin/clear-all-opponent-history', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const validKey = process.env.RANKED_API_KEY || 'urnisa-ranked-api-key-2024';

    if (apiKey !== validKey) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }

    try {
        const { clearedBy } = req.body;

        const result = await OpponentHistory.deleteMany({});

        console.log(`🗑️ ADMIN: ALL opponent history cleared by ${clearedBy || 'Unknown'} (${result.deletedCount} records)`);

        res.json({
            success: true,
            deletedCount: result.deletedCount,
            message: `Cleared ALL ${result.deletedCount} opponent history records. All diminishing returns reset.`
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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
                setInterval(() => { axios.get('https://urnisa-backend-21ls.onrender.com').catch(() => { }) }, 300000);
            });
        })
        .catch(e => console.error("❌ DB Fail:", e));
} else {
    console.error("❌ MONGO_URI Missing");
}
