
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const crypto = require('crypto');
const io = require('socket.io-client');
let Rcon;
try {
    Rcon = require('rcon-client').Rcon;
} catch (e) {
    console.warn("⚠️ 'rcon-client' not installed. RCON commands will be simulated in logs.");
}
require('dotenv').config();

// ==========================================
// CONFIGURATION & SETUP
// ==========================================
const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";
const MONGO_URI = process.env.MONGO_URI;

// RCON Config
const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = parseInt(process.env.RCON_PORT || '25575');
const RCON_PASSWORD = process.env.RCON_PASSWORD;

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

// --- INVENTORY & MC SCHEMAS ---
const InventoryItemSchema = new mongoose.Schema({
    discordId: { type: String, required: true },
    cardId: Number,
    name: String,
    rarity: String,
    image: String,
    type: String, // 'Pokemon' or 'Item'
    subType: String,
    claimed: { type: Boolean, default: false },
    claimedAt: Date,
    createdAt: { type: Date, default: Date.now }
});
const InventoryItem = mongoose.model('InventoryItem', InventoryItemSchema);

const MinecraftLinkSchema = new mongoose.Schema({
    discordId: { type: String, required: true, unique: true },
    discordUsername: String,
    discordAvatar: String,
    minecraftUsername: { type: String, required: true, unique: true },
    linkedAt: { type: Date, default: Date.now }
});
const MinecraftLink = mongoose.models.MinecraftLink || mongoose.model('MinecraftLink', MinecraftLinkSchema);

const roundOneDecimal = (num) => Math.round(num * 10) / 10;

// ==========================================
// RCON HELPER
// ==========================================
const sendRconCommand = async (command) => {
    if (!Rcon || !RCON_HOST || !RCON_PASSWORD) {
        console.log(`🔔 [RCON SIMULATION] ${command}`);
        return true; // Simulate success
    }

    const rcon = new Rcon({
        host: RCON_HOST,
        port: RCON_PORT,
        password: RCON_PASSWORD,
        timeout: 5000
    });

    try {
        await rcon.connect();
        const response = await rcon.send(command);
        console.log(`✅ [RCON] ${command} => ${response}`);
        await rcon.end();
        return true;
    } catch (error) {
        console.error(`❌ [RCON ERROR] ${command}: ${error.message}`);
        return false;
    }
};

const getRconCommand = (username, item) => {
    // Sanitize
    const safeUser = username.replace(/[^a-zA-Z0-9_]/g, '');
    
    if (item.type === 'Pokemon') {
        // Example: pokesgive <player> <pokemon> [args]
        const pokeName = item.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        let args = "";
        if (item.rarity === 'Legendary' || item.rarity === 'Mythical') {
            args = "lvl=50"; 
        } else {
            args = "lvl=15";
        }
        return `pokesgive ${safeUser} ${pokeName} ${args}`;
    } 
    else if (item.type === 'Item') {
        let count = 1;
        let cleanName = item.name.toLowerCase();
        
        // Extract count if present (e.g. "5x ")
        const countMatch = cleanName.match(/^(\d+)x\s/);
        if (countMatch) {
            count = parseInt(countMatch[1]);
            cleanName = cleanName.replace(/^\d+x\s/, '');
        }

        // Map names to IDs
        let itemId = "minecraft:stone"; // Fallback
        
        if (cleanName.includes("coin")) itemId = "cobblemon:relic_coin";
        if (cleanName.includes("bronze coin")) itemId = "cobblemon:copper_nugget"; 
        if (cleanName.includes("silver coin")) itemId = "cobblemon:iron_nugget"; 
        if (cleanName.includes("gold coin")) itemId = "cobblemon:gold_nugget"; 
        
        if (cleanName.includes("exp. candy")) {
            if (cleanName.includes("xs")) itemId = "cobblemon:exp_candy_xs";
            else if (cleanName.includes("s")) itemId = "cobblemon:exp_candy_s";
            else if (cleanName.includes("m")) itemId = "cobblemon:exp_candy_m";
            else if (cleanName.includes("l")) itemId = "cobblemon:exp_candy_l";
            else if (cleanName.includes("xl")) itemId = "cobblemon:exp_candy_xl";
        }
        
        if (cleanName.includes("potion")) itemId = "cobblemon:potion";
        if (cleanName.includes("super potion")) itemId = "cobblemon:super_potion";
        if (cleanName.includes("hyper potion")) itemId = "cobblemon:hyper_potion";
        if (cleanName.includes("max potion")) itemId = "cobblemon:max_potion";
        if (cleanName.includes("full restore")) itemId = "cobblemon:full_restore";
        if (cleanName.includes("full heal")) itemId = "cobblemon:full_heal";
        if (cleanName.includes("max ether")) itemId = "cobblemon:max_ether";
        if (cleanName.includes("max elixir")) itemId = "cobblemon:max_elixir";
        if (cleanName.includes("ether")) itemId = "cobblemon:ether";
        if (cleanName.includes("elixir")) itemId = "cobblemon:elixir";
        if (cleanName.includes("antidote")) itemId = "cobblemon:antidote";
        if (cleanName.includes("awakening")) itemId = "cobblemon:awakening";
        
        if (cleanName.includes("ball")) {
            itemId = "cobblemon:" + cleanName.replace(/\s/g, '_');
        }
        
        if (cleanName.includes("rare candy")) itemId = "cobblemon:rare_candy";
        if (cleanName.includes("shiny upgrade")) itemId = "cobblemon:shiny_charm"; 
        if (cleanName.includes("tm choice")) itemId = "cobblemon:tm_normal"; 
        
        // IV Caps logic (using vitamins as proxies as defined in Gacha.tsx)
        if (cleanName.includes("hp iv cap")) itemId = "cobblemon:hp_up";
        if (cleanName.includes("atk iv cap")) itemId = "cobblemon:protein";
        if (cleanName.includes("def iv cap")) itemId = "cobblemon:iron";
        if (cleanName.includes("sp. atk iv cap")) itemId = "cobblemon:calcium";
        if (cleanName.includes("sp. def iv cap")) itemId = "cobblemon:zinc";
        if (cleanName.includes("speed iv cap")) itemId = "cobblemon:carbos";

        return `give ${safeUser} ${itemId} ${count}`;
    }
    
    return `say User ${safeUser} claimed ${item.name} but command failed logic.`;
};

// ==========================================
// GIFT BATCHING BUFFER
// ==========================================
const giftBuffer = {};

const processBufferedGift = async (sender, data) => {
    console.log(`🎁 Processing Bulk Gift: ${sender} gifted ${data.count} subs!`);
    try {
        const stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) return;
        const providerId = `bulk-gift-${Date.now()}-${sender}`;
        await processEvent(stats, 'gift', sender, data.count, `Gifted ${data.count} subs`, providerId, data.tier);
        await stats.save();
    } catch (e) { console.error("Gift Buffer Error:", e); }
    delete giftBuffer[sender];
};

const processEvent = async (stats, type, user, amount, message, providerId, tier = '1000', isManual = false) => {
    let isNewEvent = true;
    if (providerId && !isManual) {
        const existing = await NisathonEvent.findOne({ providerId });
        if (existing) isNewEvent = false;
    }

    let earnedNisaballs = 0;
    let amountDisplay = "";
    let eventType = type;

    if (['subscriber', 'sub', 'resub', 'subscription'].includes(type)) {
        if (!isManual && (message.includes('gift') || amount === 0)) return 0; 
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
            await SpinQueue.create({ user: user||'Anon', sourceEventId: res._id, nisaballs: earnedNisaballs });
        }
    }
    
    if (isNewEvent) console.log(`✅ [${isManual?'MANUAL':'AUTO'}] ${user} | (${eventType}) | +${earnedNisaballs}NB`);
    return earnedNisaballs;
};

// ==========================================
// 1. REAL-TIME SOCKET
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

            if (type === 'subscriber' && info.gifted) {
                const sender = info.sender;
                if (giftBuffer[sender]) {
                    clearTimeout(giftBuffer[sender].timer);
                    giftBuffer[sender].count += 1;
                } else {
                    giftBuffer[sender] = { count: 1, tier: info.tier || '1000', timer: null };
                }
                giftBuffer[sender].timer = setTimeout(() => {
                    processBufferedGift(sender, giftBuffer[sender]);
                }, 2000);
                return;
            }
            
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
            await processEvent(stats, type, username, amount, info.message||"", providerId, tier);
            await stats.save();
        } catch (e) { console.error("Socket Error:", e); }
    });
};

// ==========================================
// 2. REST POLLING
// ==========================================
const resolveChannelId = async () => {
    if (!SE_JWT) return null;
    try {
        const res = await axios.get(`https://api.streamelements.com/kappa/v2/channels/${TARGET_USERNAME}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (res.data && res.data._id) return res.data._id;
    } catch (e) { }
    try {
        const me = await axios.get('https://api.streamelements.com/kappa/v2/channels/me', { headers: { 'Authorization': `Bearer ${SE_JWT}` } });
        return me.data._id;
    } catch (e) { return null; }
};

const fetchAndProcess = async (channelId, label, stats, limit = 25, offset = 0) => {
    if (!channelId) return [];
    try {
        const url = `https://api.streamelements.com/kappa/v2/activities/${channelId}`;
        const { data: activities } = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${SE_JWT}`, 'Accept': 'application/json', 'User-Agent': 'UrnisaBot/1.0' },
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
                
                if (['subscriber','sub','resub'].includes(act.type)) { 
                    amt = 1; 
                    tier = act.data.tier || '1000';
                    if (act.data.gifted) { username = act.data.sender; type = 'gift'; }
                }
                else if (act.type === 'gift') amt = act.data.amount || 1; 
                else if (['cheer','tip'].includes(act.type)) amt = act.data.amount; 
                else if (act.type === 'follow') { type = 'follower'; amt = 0; }
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
            if (lastSub.gifted) { username = lastSub.sender; type = 'gift'; }
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
        if (!stats) stats = await NisathonStats.create({ key: 'main', timerEndTime: new Date(Date.now() + 3*3600000) });
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
    console.log(`   -> Processing ${allActivities.length} historical events...`);
    allActivities.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    for (const act of allActivities) {
        let amt = 0, tier = '1000', type = act.type, user = act.data.username;
        if (['subscriber','sub','resub'].includes(act.type)) { 
            amt = 1; tier = act.data.tier || '1000';
            if (act.data.gifted) { user = act.data.sender; type = 'gift'; }
        }
        else if (act.type === 'gift') amt = act.data.amount || 1;
        else if (['cheer','tip'].includes(act.type)) amt = act.data.amount;
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

app.get('/api/wheel/queue', async (req, res) => res.json(await SpinQueue.find().sort({ createdAt: 1 })));
app.get('/api/wheel/history', async (req, res) => res.json(await SpinHistory.find().sort({ timestamp: -1 })));
app.post('/api/wheel/spin-result', auth, async (req, res) => {
    await SpinHistory.create({ user: req.body.user, reward: req.body.reward });
    if (req.body.queueId) await SpinQueue.findByIdAndDelete(req.body.queueId);
    res.json({ success: true });
});

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

// --- INVENTORY API ---

// Save Gacha Pulls
app.post('/api/gacha/save', async (req, res) => {
    const { discordId, cards } = req.body;
    if (!discordId || !cards || !Array.isArray(cards)) return res.status(400).json({ error: "Invalid data" });

    try {
        const items = cards.map(card => ({
            discordId,
            cardId: card.id,
            name: card.name,
            rarity: card.rarity,
            image: card.image,
            type: card.type,
            subType: card.subType,
            claimed: false
        }));
        await InventoryItem.insertMany(items);
        res.json({ success: true, count: items.length });
    } catch (e) {
        console.error("Gacha Save Error:", e);
        res.status(500).json({ error: "Failed to save inventory" });
    }
});

// Get Inventory
app.get('/api/inventory/:discordId', async (req, res) => {
    try {
        const items = await InventoryItem.find({ discordId: req.params.discordId }).sort({ claimed: 1, createdAt: -1 });
        res.json(items);
    } catch (e) {
        res.status(500).json({ error: "Fetch failed" });
    }
});

// Claim Item
app.post('/api/inventory/claim', async (req, res) => {
    const { discordId, itemId } = req.body;
    try {
        const item = await InventoryItem.findOne({ _id: itemId, discordId });
        if (!item) return res.status(404).json({ error: "Item not found" });
        if (item.claimed) return res.status(400).json({ error: "Already claimed" });

        const link = await MinecraftLink.findOne({ discordId });
        if (!link || !link.minecraftUsername) return res.status(400).json({ error: "No Minecraft account linked!" });

        const command = getRconCommand(link.minecraftUsername, item);
        const success = await sendRconCommand(command);

        if (success) {
            item.claimed = true;
            item.claimedAt = new Date();
            await item.save();
            res.json({ success: true, message: `Sent ${item.name} to ${link.minecraftUsername}` });
        } else {
            res.status(500).json({ error: "RCON Failed. Server offline?" });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const imageValidationCache = new Map();
app.get('/api/utils/check-image', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.json({ valid: false });
    if (imageValidationCache.has(url)) return res.json({ valid: imageValidationCache.get(url) });
    try {
        const response = await axios.head(url, { timeout: 5000 });
        const length = parseInt(response.headers['content-length'] || '0');
        const isValid = length > 2048;
        imageValidationCache.set(url, isValid);
        res.json({ valid: isValid });
    } catch (e) {
        imageValidationCache.set(url, false);
        res.json({ valid: false });
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
                setInterval(() => { axios.get('https://urnisa-backend.onrender.com').catch(()=>{}) }, 300000);
            });
        })
        .catch(e => console.error("❌ DB Fail:", e));
} else {
    console.error("❌ MONGO_URI Missing");
}
