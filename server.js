
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
    lastActivityTime: { type: String, default: new Date().toISOString() },
    isPaused: { type: Boolean, default: false }
});
const NisathonStats = mongoose.model('NisathonStats', NisathonStatsSchema);

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

// --- NISATHON SYNC LOGIC ---
const updateNisathonStats = async () => {
    if (!SE_CHANNEL_ID || !SE_JWT || mongoose.connection.readyState !== 1) return;

    try {
        let stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) {
            stats = await NisathonStats.create({ key: 'main', timerEndTime: new Date(Date.now() + 3 * 60 * 60 * 1000) });
        }

        const lastCheck = stats.lastActivityTime;
        const response = await axios.get(`https://api.streamelements.com/kappa/v2/sessions/${SE_CHANNEL_ID}/activities`, {
            headers: { Authorization: `Bearer ${SE_JWT}` },
            params: { after: lastCheck, limit: 20 }
        });

        const activities = response.data;
        if (activities.length === 0) return; 

        let newSubs = 0;
        let newBits = 0;
        let newDonationAmount = 0;
        let earnedNisaballs = 0;

        const sortedActivities = activities.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        let newestDate = lastCheck;

        for (const act of sortedActivities) {
            newestDate = act.createdAt;
            if (act.type === 'subscriber') {
                newSubs += 1;
                earnedNisaballs += 0.5;
            }
            if (act.type === 'cheer') {
                const bits = act.data.amount;
                newBits += bits;
                earnedNisaballs += (bits * 0.002);
            }
            if (act.type === 'tip') {
                const tip = act.data.amount;
                newDonationAmount += tip;
                earnedNisaballs += (tip * 0.2);
            }
        }

        const minutesToAdd = earnedNisaballs * 10;
        const msToAdd = minutesToAdd * 60 * 1000;
        const now = new Date().getTime();
        let currentEndTime = new Date(stats.timerEndTime).getTime();

        if (currentEndTime < now) {
            currentEndTime = now;
        }
        
        const newEndTime = new Date(currentEndTime + msToAdd);

        stats.currentSubs += newSubs;
        stats.currentBits += newBits;
        stats.currentDonations += newDonationAmount;
        stats.totalNisaballs = roundOneDecimal(stats.totalNisaballs + earnedNisaballs);
        stats.timerEndTime = newEndTime;
        stats.lastActivityTime = newestDate;
        
        await stats.save();
        console.log(`🔄 Synced SE Data: +${earnedNisaballs.toFixed(1)} NB. Timer extended by ${minutesToAdd.toFixed(1)}m`);

    } catch (error) {
        console.error("StreamElements Sync Error:", error.message);
    }
};

setInterval(updateNisathonStats, 60000);

// --- NISATHON API ---
app.get('/api/nisathon/stats', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.json({ 
                currentSubs: 0, currentBits: 0, currentDonations: 0, 
                totalNisaballs: 0, timerEndTime: new Date().toISOString() 
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
            isPaused: stats.isPaused
        });
    } catch (error) { res.status(500).json({ error: 'Failed to fetch stats' }); }
});

app.post('/api/nisathon/timer', async (req, res) => {
    const authHeader = req.headers.authorization;
    const { minutes } = req.body;
    if (!authHeader || authHeader !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const stats = await NisathonStats.findOne({ key: 'main' });
        if (stats) {
            const currentEnd = new Date(stats.timerEndTime).getTime();
            const now = Date.now();
            const baseTime = currentEnd > now ? currentEnd : now;
            stats.timerEndTime = new Date(baseTime + (minutes * 60 * 1000));
            await stats.save();
            res.json({ success: true, newEndTime: stats.timerEndTime });
        } else { res.status(404).json({ error: 'Stats not found' }); }
    } catch (error) { res.status(500).json({ error: error.message }); }
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

const SELF_URL = 'https://urnisa-backend.onrender.com';
function startKeepAlive() {
    setInterval(() => { axios.get(SELF_URL).catch(() => {}); }, 5 * 60 * 1000);
}
