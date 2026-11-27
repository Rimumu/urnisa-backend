'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Bypass Node 21+ native WebSocket (undici) bug with socket.io-client v2
delete global.WebSocket;
if (typeof globalThis !== 'undefined') {
    delete globalThis.WebSocket;
}
try {
    const ws = require('ws');
    global.WebSocket = ws;
    globalThis.WebSocket = ws;
} catch (e) {
    // Fall back to engine.io-client's internal node transport if ws is unavailable
}

const io = require('socket.io-client');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
require('dotenv').config();

// ==========================================
// 1. CONFIGURATION & MIDDLEWARE
// ==========================================
const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const RANKED_API_KEY = process.env.RANKED_API_KEY || 'urnisa-ranked-api-key-2024';
const ADMIN_OVERRIDE_TOKEN = process.env.ADMIN_OVERRIDE_TOKEN || 'GreatRimu_Override_True';
const MONGO_URI = process.env.MONGO_URI;

// Cross-service Keep-Alive Config
const DBOT_URL = (process.env.DBOT_URL || 'https://urnisa-dbot.onrender.com').replace(/\/+$/, '');
const KEEP_ALIVE_INTERVAL_MS = 8 * 60 * 1000; // 8 minutes (under Render's 15-minute idle threshold)

// Supabase Storage Setup
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'urnisa-media';

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
    try {
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
        console.log('🔌 Supabase Client Initialized for Storage:', SUPABASE_URL);
    } catch (e) {
        console.error('❌ Failed to initialize Supabase client:', e.message);
    }
}

// Multer Memory Storage Configuration (max 50MB)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }
});

// StreamElements Config
let SE_JWT = process.env.STREAMELEMENTS_JWT || '';
SE_JWT = SE_JWT.replace(/^Bearer\s+/i, '').replace(/["']/g, '').trim();

let ENV_CHANNEL_ID = process.env.STREAMELEMENTS_CHANNEL_ID || '';
ENV_CHANNEL_ID = ENV_CHANNEL_ID.replace(/["']/g, '').trim();

const TARGET_USERNAME = 'urnisa_';

// Cloudinary Fallback Config
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

const DEFAULT_SCHEDULE_URL = 'https://cdn.discordapp.com/attachments/1338254150479118347/1439859590152978443/3_am_17.png';

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors({ origin: '*' }));

const CARDS_DIR = path.join(__dirname, 'public', 'cards');
if (!fs.existsSync(CARDS_DIR)) {
    fs.mkdirSync(CARDS_DIR, { recursive: true });
}
app.use('/cards', express.static(CARDS_DIR));

console.log('--- URNISA HYBRID BACKEND STARTING ---');

// ==========================================
// 2. SHARED HELPERS & AUTH MIDDLEWARE
// ==========================================
const roundOneDecimal = (num) => Math.round(num * 10) / 10;

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isSafeHttpUrl = (rawUrl) => {
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        const host = parsed.hostname.toLowerCase();
        if (
            host === 'localhost' ||
            host === '::1' ||
            host === '[::1]' ||
            host.endsWith('.local') ||
            host.endsWith('.internal') ||
            host.startsWith('127.') ||
            host.startsWith('10.') ||
            host.startsWith('0.') ||
            host.startsWith('169.254.') ||
            host.startsWith('192.168.') ||
            host.startsWith('fe80:') ||
            host.startsWith('fc') ||
            host.startsWith('fd')
        ) {
            return false;
        }
        const octets = host.split('.');
        if (octets.length === 4 && octets[0] === '172') {
            const second = parseInt(octets[1], 10);
            if (second >= 16 && second <= 31) return false;
        }
        return true;
    } catch {
        return false;
    }
};

const auth = (req, res, next) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

const rankedAuth = (req, res, next) => {
    const provided = req.headers['x-api-key'] || req.body?.apiKey || req.query?.apiKey;
    if (provided !== RANKED_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }
    next();
};

// ==========================================
// 3. DATABASE SCHEMAS & MODELS
// ==========================================
const Setting = mongoose.model('Setting', new mongoose.Schema({
    key: { type: String, unique: true },
    value: mongoose.Schema.Types.Mixed
}));

const NisathonStats = mongoose.model('NisathonStats', new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    currentSubs: { type: Number, default: 0 },
    currentBits: { type: Number, default: 0 },
    currentDonations: { type: Number, default: 0 },
    totalNisaballs: { type: Number, default: 0 },
    nbFromSubs: { type: Number, default: 0 },
    nbFromBits: { type: Number, default: 0 },
    nbFromDonations: { type: Number, default: 0 },
    timerEndTime: { type: Date, default: Date.now },
    remainingTimeMs: { type: Number, default: 0 },
    isPaused: { type: Boolean, default: false },
    isEnded: { type: Boolean, default: false },
    eventListenerActive: { type: Boolean, default: true },
    subsRate: { type: Number, default: 2 },
    bitsRate: { type: Number, default: 500 },
    donationRate: { type: Number, default: 5 },
    timePerNb: { type: Number, default: 10 },
    activeEvent: { type: String, default: null },
    lastActivityTime: { type: String, default: () => new Date().toISOString() }
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
    createdAt: { type: Date, default: Date.now },
    hidden: { type: Boolean, default: false },
    isNisathon: { type: Boolean, default: true },
    adminNote: { type: String, default: '' }
}));

const SpinQueue = mongoose.model('SpinQueue', new mongoose.Schema({
    user: String,
    sourceEventId: String,
    nisaballs: Number,
    createdAt: { type: Date, default: Date.now }
}));

const SpinHistory = mongoose.model('SpinHistory', new mongoose.Schema({
    user: String,
    reward: String,
    timestamp: { type: Date, default: Date.now }
}));

// Bingo Schemas
const BingoCard = mongoose.model('BingoCard', new mongoose.Schema({
    discordId: { type: String, required: true },
    name: { type: String, required: true },
    cardId: { type: String, required: true },
    gridData: { type: Array, required: true },
    marked: { type: [Boolean], required: true },
    updatedAt: { type: Date, default: Date.now },
    syncCode: { type: String, unique: true, sparse: true }
}));

const BingoDefinition = mongoose.model('BingoDefinition', new mongoose.Schema({
    cardId: { type: String, required: true, unique: true },
    gridData: { type: Array, required: true },
    difficulty: String,
    createdAt: { type: Date, default: Date.now }
}));

const BingoWinner = mongoose.model('BingoWinner', new mongoose.Schema({
    discordId: { type: String, required: true },
    minecraftUsername: { type: String, required: true },
    discordAvatar: { type: String },
    cardId: { type: String, required: true },
    linesCompleted: { type: Number, required: true },
    completedAt: { type: Date, default: Date.now }
}));

// Drinking Stream Event Schemas (Completely Isolated from Nisathon & Snakes)
const DEFAULT_DRINK_WHEEL_ITEMS = [
    { label: 'Take an Extra Shot', weight: 15 },
    { label: 'No-Hands Shot', weight: 15 },
    { label: 'Truth or Shot', weight: 20 },
    { label: 'Sour Candy Chaser', weight: 15 },
    { label: 'Chat Picks 5-Min Dare', weight: 15 },
    { label: 'Double Pour Next Tip', weight: 10 },
    { label: 'Free Pass (Lucky!)', weight: 10 }
];

const DrinkSettings = mongoose.model('DrinkSettings', new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    eventTitle: { type: String, default: 'Shots with Urnisa' },
    eventSubtitle: { type: String, default: 'Every donation auto-converts to GBP (£), rounds down to whole shots, and unlocks a live Wheel Spin every 5 shots.' },
    donationsActive: { type: Boolean, default: false },
    gbpPerShot: { type: Number, default: 3 },
    shotLabel: { type: String, default: 'Shot' },
    shotsPerSpin: { type: Number, default: 5 },
    wheelItems: {
        type: [{ label: String, weight: Number }],
        default: DEFAULT_DRINK_WHEEL_ITEMS
    }
}));

const DrinkQueueItem = mongoose.model('DrinkQueueItem', new mongoose.Schema({
    user: { type: String, required: true },
    drinkType: { type: String, enum: ['shot'], default: 'shot' },
    drinkLabel: { type: String, required: true },
    triggerType: { type: String, default: 'manual' },
    amountDisplay: { type: String, default: '' },
    message: { type: String, default: '' },
    totalShots: { type: Number, default: 1 },
    servedShots: { type: Number, default: 0 },
    skippedShots: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'completed', 'skipped'], default: 'pending' },
    isTest: { type: Boolean, default: false },
    sourceEventId: { type: String, index: true },
    completedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
}));

const DrinkSpinHistory = mongoose.model('DrinkSpinHistory', new mongoose.Schema({
    spinId: { type: String, required: true, unique: true },
    winningIndex: { type: Number, required: true },
    reward: { type: String, required: true },
    isFreeSpin: { type: Boolean, default: false },
    shotCountAtSpin: { type: Number, default: 0 },
    spunBy: { type: String, default: 'Admin' },
    startedAt: { type: Date, default: Date.now },
    revealAt: { type: Date, required: true }
}));

const DrinkDebugLog = mongoose.model('DrinkDebugLog', new mongoose.Schema({
    source: { type: String, default: 'live' },
    triggerType: { type: String, default: '' },
    user: { type: String, default: '' },
    amountDisplay: { type: String, default: '' },
    outcome: { type: String, enum: ['queued', 'skipped', 'dry_run', 'error'], default: 'queued' },
    reason: { type: String, default: '' },
    queuedSummary: { type: String, default: '' },
    isTest: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
}));

// Tournament Schemas
const tournamentEntrySchema = new mongoose.Schema({
    discordId: { type: String, required: true },
    minecraftUsername: { type: String, required: true },
    seasonId: { type: Number, default: 1 },
    team: [{ id: Number, name: String }],
    isLocked: { type: Boolean, default: false },
    isDev: { type: Boolean, default: false },
    gimmickType: { type: String, default: null },
    gimmickPokemonId: { type: Number, default: null },
    updatedAt: { type: Date, default: Date.now },
    syncCode: { type: String, unique: true, sparse: true }
});
tournamentEntrySchema.index({ discordId: 1, seasonId: 1 }, { unique: true });
const TournamentEntry = mongoose.model('TournamentEntry', tournamentEntrySchema);

const TournamentMatchSchema = new mongoose.Schema({
    id: String,
    bracketGroup: { type: String, default: 'winners' },
    round: Number,
    matchIndex: Number,
    player1: { type: String, default: null },
    player2: { type: String, default: null },
    winner: { type: String, default: null },
    score: { type: String, default: '' },
    nextMatchId: String,
    loserNextMatchId: { type: String, default: null },
    status: { type: String, default: 'PENDING' }
});

const TournamentBracket = mongoose.model('TournamentBracket', new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    seasonId: { type: Number, default: 1 },
    type: { type: String, default: 'SINGLE_ELIMINATION' },
    matches: [TournamentMatchSchema],
    updatedAt: { type: Date, default: Date.now },
    syncCode: { type: String, unique: true, sparse: true }
}));

const TournamentSeason = mongoose.model('TournamentSeason', new mongoose.Schema({
    seasonId: { type: Number, unique: true, required: true },
    name: { type: String, default: 'Season 1' },
    format: { type: String, default: 'Singles 4v4' },
    status: { type: String, default: 'DRAFTING' },
    winners: [{
        rank: Number,
        username: String,
        teamName: String,
        player1: String,
        player2: String,
        score: String
    }],
    description: { type: String, default: '' },
    bannedPokemonIds: { type: [Number], default: [] },
    isHidden: { type: Boolean, default: false },
    rules: [{
        title: { type: String, required: true },
        icon: { type: String, default: '⚖️' },
        color: { type: String, default: 'border-white/10' },
        content: { type: String, default: '' }
    }],
    isArchived: { type: Boolean, default: false },
    challongeUrl: { type: String, default: '' },
    archivedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
}));

const TournamentDuo = mongoose.model('TournamentDuo', new mongoose.Schema({
    duoId: { type: String, required: true, unique: true },
    seasonId: { type: Number, required: true },
    player1DiscordId: { type: String, required: true },
    player1Username: { type: String, required: true },
    player2DiscordId: { type: String, required: true },
    player2Username: { type: String, required: true },
    captainDiscordId: { type: String, required: true },
    teamName: { type: String, default: '' },
    team: [{ id: Number, name: String }],
    isLocked: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
}));

const DuoPartyData = mongoose.model('DuoPartyData', new mongoose.Schema({
    duoId: { type: String, required: true, unique: true },
    player1Username: { type: String },
    player2Username: { type: String },
    player1Picks: [{ name: String, level: Number }],
    player2Picks: [{ name: String, level: Number }],
    rawLogData: { type: String },
    lastUpdated: { type: Date, default: Date.now }
}));

// Snakes & Ladders Schemas
const SnakesQueue = mongoose.model('SnakesQueue', new mongoose.Schema({
    user: { type: String, required: true },
    avatarUrl: String,
    amount: { type: Number, default: 1 },
    type: { type: String, default: 'sub' },
    sourceEventId: String,
    createdAt: { type: Date, default: Date.now }
}));

const SnakesPlayer = mongoose.model('SnakesPlayer', new mongoose.Schema({
    user: { type: String, required: true, unique: true },
    avatarUrl: String,
    position: { type: Number, default: 0 },
    lastMovedAt: { type: Date, default: Date.now }
}));

const SnakesHistory = mongoose.model('SnakesHistory', new mongoose.Schema({
    user: { type: String, required: true },
    roll: { type: Number, required: true },
    fromPosition: { type: Number, required: true },
    toPosition: { type: Number, required: true },
    specialMove: String,
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
    isActive: { type: Boolean, default: false },
    subsActive: { type: Boolean, default: false },
    donationsActive: { type: Boolean, default: false },
    lastProcessedEventId: String
}));

const SnakesSpecialTile = mongoose.model('SnakesSpecialTile', new mongoose.Schema({
    tile: { type: Number, required: true, unique: true, min: 1, max: 100 },
    text: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
}));

// Archive Schemas
const ArchiveSnapshot = mongoose.model('ArchiveSnapshot', new mongoose.Schema({
    archiveId: { type: String, required: true, unique: true },
    eventName: { type: String, default: 'Birthday Nisathon' },
    archivedAt: { type: Date, default: Date.now },
    finalStats: {
        currentSubs: { type: Number, default: 0 },
        currentBits: { type: Number, default: 0 },
        currentDonations: { type: Number, default: 0 },
        totalNisaballs: { type: Number, default: 0 }
    },
    topContributors: [{ rank: Number, user: String, totalNisaballs: Number }],
    events: [{
        _id: String,
        user: String,
        type: String,
        amountDisplay: String,
        message: String,
        createdAt: Date,
        nisaballAmount: Number,
        adminNote: String
    }],
    goalsAchieved: [{ count: Number, reward: String, status: String }]
}));

const ArchiveRankedPlayer = mongoose.model('ArchiveRankedPlayer', new mongoose.Schema({
    archiveId: { type: String, required: true },
    seasonName: { type: String, default: 'Season 1' },
    archivedAt: { type: Date, default: Date.now },
    uuid: { type: String, required: true },
    minecraftName: { type: String, required: true },
    elo: { type: Number, default: 1000 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    tier: { type: String, default: 'UNRANKED' },
    winRate: { type: Number, default: 0 },
    winStreak: { type: Number, default: 0 },
    bestWinStreak: { type: Number, default: 0 }
}));

// Cobblemon Ranked Schemas
const RankedPlayer = mongoose.model('RankedPlayer', new mongoose.Schema({
    uuid: { type: String, required: true, unique: true },
    minecraftName: { type: String, required: true },
    elo: { type: Number, default: 1000 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    tier: { type: String, default: 'UNRANKED' },
    totalKOs: { type: Number, default: 0 },
    totalDeaths: { type: Number, default: 0 },
    winStreak: { type: Number, default: 0 },
    bestWinStreak: { type: Number, default: 0 },
    elo1v1: { type: Number, default: 1000 },
    wins1v1: { type: Number, default: 0 },
    losses1v1: { type: Number, default: 0 },
    tier1v1: { type: String, default: 'UNRANKED' },
    winStreak1v1: { type: Number, default: 0 },
    bestWinStreak1v1: { type: Number, default: 0 },
    elo2v2: { type: Number, default: 1000 },
    wins2v2: { type: Number, default: 0 },
    losses2v2: { type: Number, default: 0 },
    tier2v2: { type: String, default: 'UNRANKED' },
    winStreak2v2: { type: Number, default: 0 },
    bestWinStreak2v2: { type: Number, default: 0 },
    lastMatchAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    syncCode: { type: String, unique: true, sparse: true }
}));

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
    battleType: { type: String, default: '1v1' },
    endReason: { type: String, default: 'normal' },
    winnerEloChange: { type: Number, default: 0 },
    loserEloChange: { type: Number, default: 0 },
    winnerEloBefore: { type: Number, default: 0 },
    loserEloBefore: { type: Number, default: 0 },
    diminishingMultiplier: { type: Number, default: 1.0 },
    uniqueOpponentBonus: { type: Boolean, default: false },
    eloRangeReduced: { type: Boolean, default: false },
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

const opponentHistorySchema = new mongoose.Schema({
    playerUuid: { type: String, required: true },
    opponentUuid: { type: String, required: true },
    matchCount: { type: Number, default: 0 },
    lastMatchAt: { type: Date, default: null },
    firstMatchAt: { type: Date, default: null },
    cooldownUntil: { type: Date, default: null }
});
opponentHistorySchema.index({ playerUuid: 1, opponentUuid: 1 }, { unique: true });
const OpponentHistory = mongoose.model('OpponentHistory', opponentHistorySchema);

const dailyStatsSchema = new mongoose.Schema({
    playerUuid: { type: String, required: true },
    date: { type: String, required: true },
    uniqueOpponents: [{ type: String }],
    matchesPlayed: { type: Number, default: 0 },
    bonusEarned: { type: Boolean, default: false }
});
dailyStatsSchema.index({ playerUuid: 1, date: 1 }, { unique: true });
const DailyStats = mongoose.model('DailyStats', dailyStatsSchema);

const RankedBan = mongoose.model('RankedBan', new mongoose.Schema({
    playerUuid: { type: String, required: true, unique: true },
    playerName: { type: String },
    reason: { type: String, default: 'Manual ban' },
    bannedBy: { type: String },
    bannedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },
    isPermanent: { type: Boolean, default: false }
}));

const forfeitHistorySchema = new mongoose.Schema({
    playerUuid: { type: String, required: true },
    matchId: { type: String },
    opponent: { type: String },
    forfeitedAt: { type: Date, default: Date.now }
});
forfeitHistorySchema.index({ playerUuid: 1, forfeitedAt: -1 });
const ForfeitHistory = mongoose.model('ForfeitHistory', forfeitHistorySchema);

// ==========================================
// 4. CORE ENGINES
// ==========================================

// --- Snakes & Ladders Board & Engine ---
const SNAKES_AND_LADDERS = {
    ladders: { 2: 38, 7: 14, 8: 31, 15: 26, 21: 42, 28: 84, 36: 44, 51: 67, 71: 91, 78: 98, 87: 94 },
    snakes: { 16: 6, 46: 25, 62: 19, 64: 60, 74: 53, 92: 88, 99: 80 }
};

const snakesProcessedCache = new Set();
const SNAKES_CACHE_EXPIRY_MS = 60000;

const processSnakesEvent = async (type, user, amount, providerId, tier = '1000', isManual = false, avatarUrl = '') => {
    try {
        if (providerId && !isManual) {
            if (snakesProcessedCache.has(providerId)) return;
            snakesProcessedCache.add(providerId);
            setTimeout(() => snakesProcessedCache.delete(providerId), SNAKES_CACHE_EXPIRY_MS);
        }

        const settings = await SnakesSettings.findOne({ key: 'main' });
        let shouldProcess = false;

        if (['subscriber', 'sub', 'resub', 'subscription', 'gift'].includes(type)) {
            if (settings && settings.subsActive) shouldProcess = true;
        } else if (['tip', 'donation'].includes(type)) {
            if (settings && settings.donationsActive) shouldProcess = true;
        }

        if (!shouldProcess) {
            if (isManual) console.log(`⚠️ Blocked ${type} simulation: Listener is OFF.`);
            return;
        }

        if (!avatarUrl && user) {
            try {
                const avRes = await axios.get(`https://decapi.me/twitch/avatar/${encodeURIComponent(user)}`, { timeout: 4000 });
                if (avRes.data && typeof avRes.data === 'string' && avRes.data.startsWith('http')) {
                    avatarUrl = avRes.data.trim();
                }
            } catch {
                // Fallback handled on frontend
            }
        }

        if (providerId && !isManual) {
            const existing = await SnakesQueue.findOne({ sourceEventId: providerId });
            if (existing) return;
        }

        let rolls = 0;
        if (['subscriber', 'sub', 'resub', 'subscription'].includes(type)) {
            if (!isManual && amount === 0) return;
            let multiplier = 1;
            const tStr = String(tier).toLowerCase();
            if (tStr.includes('3000') || tStr === '3') multiplier = 3;
            else if (tStr.includes('2000') || tStr === '2') multiplier = 2;
            rolls = 1 * multiplier;
        } else if (type === 'gift') {
            rolls = amount;
        } else if (type === 'tip' || type === 'donation') {
            rolls = Math.floor(amount / 3);
        }

        if (rolls > 0) {
            console.log(`🐍 Queueing ${rolls} rolls for ${user} (Source: ${type})`);
            const finalSourceId = providerId || `snakes-${Date.now()}-${Math.random()}`;
            for (let i = 0; i < rolls; i++) {
                await SnakesQueue.create({
                    user: user || 'Anonymous',
                    avatarUrl: avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(user || 'A')}&background=random`,
                    amount: 1,
                    type,
                    sourceEventId: finalSourceId
                });
            }
        }
    } catch (e) {
        console.error('Snakes Event Error:', e);
    }
};

// --- Drinking Stream Event Engine (Donations-Only GBP, Shots-Only, Wheel Spins, Isolated from Nisathon & Snakes) ---
const drinkProcessedCache = new Set();
const DRINK_CACHE_EXPIRY_MS = 60000;

const CURRENCY_FALLBACK_USD_RATES = {
    USD: 1,
    GBP: 0.79,
    EUR: 0.92,
    MYR: 4.70,
    IDR: 15500,
    SGD: 1.34,
    AUD: 1.52,
    CAD: 1.36,
    PHP: 56.0,
    THB: 35.0,
    JPY: 155.0,
    KRW: 1350.0
};

const normalizeDrinkCurrency = (rawCurrency) => {
    const cur = String(rawCurrency || 'USD').trim().toUpperCase();
    if (cur === 'RM') return 'MYR';
    if (cur === '£') return 'GBP';
    if (cur === '$') return 'USD';
    if (cur === '€') return 'EUR';
    return cur || 'USD';
};

const convertAmountToGBP = async (rawAmount, rawCurrency = 'USD') => {
    const amount = Math.max(0, Number(rawAmount) || 0);
    const currency = normalizeDrinkCurrency(rawCurrency);
    if (amount <= 0) {
        return { gbpAmount: 0, originalAmount: 0, originalCurrency: currency, gbpRate: 1 };
    }
    if (currency === 'GBP') {
        return { gbpAmount: amount, originalAmount: amount, originalCurrency: 'GBP', gbpRate: 1 };
    }

    let rateFromUSD = currency === 'USD' ? 1 : await getUSDRate(currency);
    if (!rateFromUSD || rateFromUSD <= 0) {
        rateFromUSD = CURRENCY_FALLBACK_USD_RATES[currency] || 1;
    }

    let gbpPerUSD = await getUSDRate('GBP');
    if (!gbpPerUSD || gbpPerUSD <= 0) {
        gbpPerUSD = CURRENCY_FALLBACK_USD_RATES.GBP;
    }

    const usdAmount = currency === 'USD' ? amount : (amount / rateFromUSD);
    const gbpAmount = usdAmount * gbpPerUSD;
    return {
        gbpAmount,
        originalAmount: amount,
        originalCurrency: currency,
        gbpRate: gbpPerUSD / rateFromUSD
    };
};

const formatDrinkOriginalAmount = (amount, currency) => {
    const cur = normalizeDrinkCurrency(currency);
    if (cur === 'GBP') return `£${amount.toFixed(2)}`;
    if (cur === 'USD') return `$${amount.toFixed(2)} USD`;
    if (cur === 'MYR') return `RM${amount.toFixed(2)} MYR`;
    if (cur === 'EUR') return `€${amount.toFixed(2)} EUR`;
    if (cur === 'IDR') return `Rp${Math.round(amount).toLocaleString()} IDR`;
    return `${amount.toFixed(2)} ${cur}`;
};

const getDrinkRemainingShots = (item) => {
    if (!item) return 0;
    const total = Math.max(1, Number(item.totalShots) || 1);
    const resolved = (Number(item.servedShots) || 0) + (Number(item.skippedShots) || 0);
    if (item.status !== 'pending' && resolved === 0) return 0;
    return Math.max(0, total - resolved);
};

const getDrinkServedShots = (item) => {
    if (!item) return 0;
    const explicit = Number(item.servedShots) || 0;
    if (explicit > 0) return explicit;
    if (item.status === 'completed' && !(Number(item.skippedShots) || 0)) {
        return Math.max(1, Number(item.totalShots) || 1);
    }
    return 0;
};

const serializeDrinkQueueItem = (doc) => {
    const obj = doc.toObject ? doc.toObject() : { ...doc };
    const totalShots = Math.max(1, Number(obj.totalShots) || 1);
    const servedShots = getDrinkServedShots(obj);
    const skippedShots = Number(obj.skippedShots) || (obj.status === 'skipped' && servedShots === 0 ? totalShots : 0);
    const remainingShots = obj.status === 'pending' ? Math.max(0, totalShots - servedShots - skippedShots) : 0;
    return {
        ...obj,
        drinkType: 'shot',
        totalShots,
        servedShots,
        skippedShots,
        remainingShots
    };
};

const getOrCreateDrinkSettings = async () => {
    let settings = await DrinkSettings.findOne({ key: 'main' });
    if (!settings) {
        settings = await DrinkSettings.create({ key: 'main', wheelItems: DEFAULT_DRINK_WHEEL_ITEMS });
    } else if (!Array.isArray(settings.wheelItems) || settings.wheelItems.length === 0) {
        settings.wheelItems = DEFAULT_DRINK_WHEEL_ITEMS;
        await settings.save();
    }
    return settings;
};

const evaluateDrinkTrigger = async (settings, payload) => {
    const rawType = String(payload.type || '').toLowerCase();
    const rawAmount = Number(payload.amount) || 0;
    const rawCurrency = normalizeDrinkCurrency(payload.currency || 'USD');
    const isTest = Boolean(payload.isTest);
    const ignoreToggles = Boolean(payload.ignoreToggles);

    let normalizedType = rawType;
    if (['tip', 'donation', 'tip-myr', 'donation_myr', 'donation_gbp'].includes(rawType)) {
        normalizedType = 'donation';
    } else {
        return {
            shouldQueue: false,
            normalizedType,
            amountDisplay: '',
            gbpAmount: 0,
            originalAmount: rawAmount,
            originalCurrency: rawCurrency,
            shotCount: 0,
            items: [],
            reason: `Donations only — ignored "${rawType}"`
        };
    }

    const converted = await convertAmountToGBP(rawAmount, rawCurrency);
    const gbpAmount = converted.gbpAmount;
    const amountDisplay = converted.originalCurrency === 'GBP'
        ? `£${gbpAmount.toFixed(2)} GBP`
        : `£${gbpAmount.toFixed(2)} GBP (${formatDrinkOriginalAmount(converted.originalAmount, converted.originalCurrency)})`;

    if (!ignoreToggles && !settings.donationsActive) {
        return {
            shouldQueue: false,
            normalizedType,
            amountDisplay,
            gbpAmount,
            originalAmount: converted.originalAmount,
            originalCurrency: converted.originalCurrency,
            shotCount: 0,
            items: [],
            reason: 'Donations shot listener is OFF'
        };
    }

    const gbpPerShot = Math.max(0.5, Number(settings.gbpPerShot) || 3);
    const shotCount = Math.floor((gbpAmount + 1e-6) / gbpPerShot);
    const mathDetail = `floor(£${gbpAmount.toFixed(2)} / £${gbpPerShot}) = ${shotCount}`;

    if (shotCount <= 0) {
        return {
            shouldQueue: false,
            normalizedType,
            amountDisplay,
            gbpAmount,
            originalAmount: converted.originalAmount,
            originalCurrency: converted.originalCurrency,
            shotCount: 0,
            items: [],
            reason: `Below 1-shot threshold (${mathDetail})`
        };
    }

    const baseShotLabel = settings.shotLabel || 'Shot';
    const bundledLabel = shotCount === 1 ? baseShotLabel : `${shotCount}x ${baseShotLabel}s`;

    const items = [
        {
            drinkType: 'shot',
            drinkLabel: bundledLabel,
            totalShots: shotCount
        }
    ];

    const summary = `${shotCount} Shot${shotCount > 1 ? 's' : ''}`;

    return {
        shouldQueue: true,
        normalizedType,
        amountDisplay,
        gbpAmount,
        originalAmount: converted.originalAmount,
        originalCurrency: converted.originalCurrency,
        shotCount,
        items,
        reason: `Matched GBP rule (${mathDetail})`,
        summary
    };
};

const recordDrinkDebugLog = async (entry) => {
    try {
        await DrinkDebugLog.create(entry);
        const total = await DrinkDebugLog.countDocuments();
        if (total > 60) {
            const oldest = await DrinkDebugLog.find().sort({ createdAt: -1 }).skip(50).select('_id');
            if (oldest.length > 0) {
                await DrinkDebugLog.deleteMany({ _id: { $in: oldest.map(d => d._id) } });
            }
        }
    } catch {
        // Non-fatal debug log failure
    }
};

const processDrinkEvent = async (type, user, amount, message = '', providerId = '', _tier = '1000', options = {}) => {
    const isTest = Boolean(options.isTest);
    const dryRun = Boolean(options.dryRun);
    const ignoreToggles = Boolean(options.ignoreToggles);
    const currency = normalizeDrinkCurrency(options.currency || 'USD');
    const sourceLabel = dryRun ? 'dry_run' : (isTest ? 'test' : 'live');

    if (providerId && !isTest && !dryRun) {
        if (drinkProcessedCache.has(providerId)) return null;
        drinkProcessedCache.add(providerId);
        setTimeout(() => drinkProcessedCache.delete(providerId), DRINK_CACHE_EXPIRY_MS);

        const existing = await DrinkQueueItem.findOne({ sourceEventId: providerId });
        if (existing) return null;
    }

    const settings = await getOrCreateDrinkSettings();
    const evalResult = await evaluateDrinkTrigger(
        settings,
        { type, user, amount, currency, message, isTest, ignoreToggles }
    );

    if (!evalResult.shouldQueue) {
        if (isTest || dryRun || evalResult.normalizedType === 'donation') {
            await recordDrinkDebugLog({
                source: sourceLabel,
                triggerType: evalResult.normalizedType,
                user: user || 'Anonymous',
                amountDisplay: evalResult.amountDisplay,
                outcome: dryRun ? 'dry_run' : 'skipped',
                reason: evalResult.reason,
                queuedSummary: 'None',
                isTest
            });
        }
        return evalResult;
    }

    if (dryRun) {
        await recordDrinkDebugLog({
            source: 'dry_run',
            triggerType: evalResult.normalizedType,
            user: user || 'Anonymous',
            amountDisplay: evalResult.amountDisplay,
            outcome: 'dry_run',
            reason: `Dry run (${evalResult.reason})`,
            queuedSummary: evalResult.summary,
            isTest: true
        });
        return evalResult;
    }

    const baseSourceId = providerId || `drink-${isTest ? 'test-' : ''}${Date.now()}-${Math.random()}`;
    const createdDocs = [];
    for (let idx = 0; idx < evalResult.items.length; idx++) {
        const entry = evalResult.items[idx];
        const doc = await DrinkQueueItem.create({
            user: user || 'Anonymous',
            drinkType: 'shot',
            drinkLabel: entry.drinkLabel,
            triggerType: evalResult.normalizedType,
            amountDisplay: evalResult.amountDisplay,
            message: message || '',
            totalShots: entry.totalShots || 1,
            servedShots: 0,
            skippedShots: 0,
            status: 'pending',
            isTest,
            sourceEventId: idx === 0 ? baseSourceId : `${baseSourceId}#${idx}`
        });
        createdDocs.push(doc);
    }

    console.log(`🥃 [Drinks/${sourceLabel}] ${user || 'Anonymous'} (${evalResult.amountDisplay}) -> ${evalResult.summary}`);
    await recordDrinkDebugLog({
        source: sourceLabel,
        triggerType: evalResult.normalizedType,
        user: user || 'Anonymous',
        amountDisplay: evalResult.amountDisplay,
        outcome: 'queued',
        reason: evalResult.reason,
        queuedSummary: evalResult.summary,
        isTest
    });

    return { ...evalResult, createdCount: createdDocs.length };
};

// --- Nisathon Event Processing Engine ---
const processEvent = async (stats, type, user, amount, message, providerId, tier = '1000', isManual = false, adminNote = '', myrAmount = 0) => {
    if (stats.eventListenerActive === false && !isManual) {
        console.log(`🔇 Nisathon Event Listener is OFF - ignoring ${type} from ${user}`);
        return 0;
    }

    let isNewEvent = true;
    if (providerId && !isManual) {
        const existing = await NisathonEvent.findOne({ providerId });
        if (existing) isNewEvent = false;
    }

    let earnedNisaballs = 0;
    let amountDisplay = '';
    let eventType = type;

    if (['subscriber', 'sub', 'resub', 'subscription'].includes(type)) {
        if (!isManual && ((message || '').includes('gift') || amount === 0)) {
            return 0;
        }

        let tVal = 1 / (stats.subsRate || 2);
        let tLbl = 'Tier 1';
        const tStr = String(tier).toLowerCase();
        if (tStr.includes('3000') || tStr === '3') { tVal = 4 * (1 / (stats.subsRate || 2)); tLbl = 'Tier 3'; }
        else if (tStr.includes('2000') || tStr === '2') { tVal = 2 * (1 / (stats.subsRate || 2)); tLbl = 'Tier 2'; }
        else if (tStr.includes('prime')) { tVal = 1 / (stats.subsRate || 2); tLbl = 'Prime'; }

        earnedNisaballs = tVal;
        amountDisplay = `${tLbl} Sub`;
        eventType = 'sub';
        if (isNewEvent && !stats.isEnded) {
            stats.currentSubs += 1;
            stats.nbFromSubs = (stats.nbFromSubs || 0) + earnedNisaballs;
        }
    } else if (type === 'gift') {
        earnedNisaballs = (1 / (stats.subsRate || 2)) * amount;
        amountDisplay = `${amount} Gift Sub${amount > 1 ? 's' : ''}`;
        if (isNewEvent && !stats.isEnded) {
            stats.currentSubs += amount;
            stats.nbFromSubs = (stats.nbFromSubs || 0) + earnedNisaballs;
        }
    } else if (['cheer', 'bits'].includes(type)) {
        earnedNisaballs = amount / (stats.bitsRate || 500);
        amountDisplay = `${amount} Bits`;
        eventType = 'bits';
        if (isNewEvent && !stats.isEnded) {
            stats.currentBits += amount;
            stats.nbFromBits = (stats.nbFromBits || 0) + earnedNisaballs;
        }
    } else if (['tip', 'donation'].includes(type)) {
        earnedNisaballs = amount / (stats.donationRate || 5);
        amountDisplay = `$${amount.toFixed(2)}`;
        eventType = 'donation';
        if (isNewEvent && !stats.isEnded) {
            stats.currentDonations += amount;
            stats.nbFromDonations = (stats.nbFromDonations || 0) + earnedNisaballs;
        }
    } else if (type === 'tip-myr') {
        earnedNisaballs = myrAmount / 9;
        amountDisplay = `$${amount.toFixed(2)}`;
        eventType = 'donation';
        if (isNewEvent && !stats.isEnded) {
            stats.currentDonations += amount;
            stats.nbFromDonations = (stats.nbFromDonations || 0) + earnedNisaballs;
        }
    } else if (['nisall', 'nisaball', 'nisaballs', 'code', 'redeem'].includes(type)) {
        earnedNisaballs = amount;
        amountDisplay = `${amount} Nisaballs`;
        eventType = 'nisaball';
    } else if (type === 'reward') {
        earnedNisaballs = amount;
        amountDisplay = message || `${amount} Nisaballs (Reward)`;
        eventType = 'reward';
    } else if (['shop', 'wheel', 'deduction'].includes(type)) {
        earnedNisaballs = amount;
        amountDisplay = message || `${amount} Nisaballs (Shop)`;
        eventType = 'shop';
    } else if (['follower', 'follow'].includes(type)) {
        earnedNisaballs = 0;
        amountDisplay = 'New Follower';
        eventType = 'follower';
    }

    const isNonNisathonType = ['reward', 'shop', 'wheel', 'deduction'].includes(eventType) ||
        (eventType === 'nisaball' && (amount < 0 || isManual));
    const isNisathonEvent = !isNonNisathonType;

    if (isNewEvent && isNisathonEvent) {
        const mult = stats.activeEvent === 'DOUBLE_TIMER' ? 2 : 1;
        const msAdd = earnedNisaballs * (stats.timePerNb || 10) * mult * 60000;

        if (stats.isEnded) {
            stats.remainingTimeMs = (stats.remainingTimeMs || 0) + msAdd;
            stats.lastActivityTime = new Date().toISOString();
        } else {
            stats.totalNisaballs = roundOneDecimal(stats.totalNisaballs + earnedNisaballs);
            if (earnedNisaballs > 0) {
                if (!stats.isPaused) {
                    const now = Date.now();
                    const curEnd = new Date(stats.timerEndTime).getTime();
                    stats.timerEndTime = new Date(Math.max(now, curEnd) + msAdd);
                } else {
                    stats.remainingTimeMs = (stats.remainingTimeMs || 0) + msAdd;
                }
            }
        }
    }

    const savedNisaballAmount = stats.isEnded ? 0 : earnedNisaballs;

    const eventData = {
        providerId: providerId || `sim-${Date.now()}`,
        user: user || 'Anonymous',
        type: eventType,
        amountDisplay,
        message,
        nisaballAmount: savedNisaballAmount,
        hidden: !isNisathonEvent,
        isNisathon: isNisathonEvent,
        adminNote: stats.isEnded
            ? (adminNote ? `${adminNote} (Return Timer)` : `(Return Timer +${(earnedNisaballs * (stats.timePerNb || 10)).toFixed(1)}m)`)
            : adminNote,
        createdAt: isNewEvent ? new Date() : undefined
    };
    Object.keys(eventData).forEach(k => eventData[k] === undefined && delete eventData[k]);

    const savedEvent = await NisathonEvent.findOneAndUpdate(
        { providerId: eventData.providerId },
        eventData,
        { upsert: true, new: true }
    );

    if (!stats.isEnded && isNewEvent && earnedNisaballs >= 5 && isNisathonEvent) {
        const spins = Math.floor(earnedNisaballs / 5);
        console.log(`🎡 Queueing ${spins} spins for ${user}`);
        for (let i = 0; i < spins; i++) {
            await SpinQueue.create({ user: user || 'Anon', sourceEventId: savedEvent._id, nisaballs: earnedNisaballs });
        }
    }

    if (isNewEvent) {
        if (stats.isEnded) {
            console.log(`✅ [RETURN TIMER EVENT] ${user} | (${eventType}) | Added ${(earnedNisaballs * (stats.timePerNb || 10)).toFixed(1)}m to Return Timer (0 NB to user)`);
        } else {
            console.log(`✅ [${isManual ? 'MANUAL' : 'AUTO'}] ${user} | (${eventType}) | +${earnedNisaballs}NB`);
        }
    }
    return earnedNisaballs;
};

// --- Gift Batching Buffer ---
const giftBuffer = {};

const processBufferedGift = async (sender, data) => {
    console.log(`🎁 Processing Bulk Gift: ${sender} gifted ${data.count} subs!`);
    try {
        const stats = await NisathonStats.findOne({ key: 'main' });
        const providerId = `bulk-gift-${Date.now()}-${sender}`;

        if (stats) {
            if (stats.eventListenerActive === false) {
                console.log('🛑 Nisathon Event Listener is OFF - Skipping Gift Buffer for Nisathon');
            } else {
                await processEvent(stats, 'gift', sender, data.count, `Gifted ${data.count} subs`, providerId, data.tier);
                await stats.save();
            }
        }
        await processSnakesEvent('gift', sender, data.count, providerId, data.tier, false, data.avatar);
        try {
            await processDrinkEvent('gift', sender, data.count, `Gifted ${data.count} subs`, providerId, data.tier);
        } catch (drinkErr) {
            console.error('[Drinks] Non-fatal gift buffer error:', drinkErr.message);
        }
    } catch (e) {
        console.error('Gift Buffer Error:', e);
    }
    delete giftBuffer[sender];
};

// --- StreamElements Real-Time Socket ---
let socket = null;

const connectSocket = () => {
    if (!SE_JWT) {
        console.log('❌ [Socket] No JWT');
        return;
    }

    const maskedJwt = SE_JWT.length > 20
        ? `${SE_JWT.substring(0, 10)}...${SE_JWT.substring(SE_JWT.length - 10)}`
        : '[Too Short / Invalid]';
    console.log(`🔌 [Socket] Connecting with JWT (Length: ${SE_JWT.length}, Masked: ${maskedJwt})`);

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

    socket.on('unauthorized', (err) => {
        console.error('❌ [Socket] Unauthorized error:', err);
    });

    socket.on('disconnect', (reason) => {
        console.log(`🔌 [Socket] Disconnected: ${reason}`);
    });

    socket.on('error', (err) => {
        console.error('❌ [Socket] Error:', err);
    });

    socket.on('event', async (data) => {
        if (!data || !data.type) return;
        if (!['subscriber', 'sub', 'resub', 'subscription', 'gift', 'tip', 'cheer', 'follower', 'follow'].includes(data.type)) return;

        try {
            const stats = await NisathonStats.findOne({ key: 'main' });
            const info = data.data;
            let amount = 1;
            let tier = '1000';
            let type = data.type;
            const username = info.username;

            if ((type === 'subscriber' || type === 'sub' || type === 'resub' || type === 'subscription') && info.gifted) {
                const sender = info.sender;
                if (giftBuffer[sender]) {
                    clearTimeout(giftBuffer[sender].timer);
                    giftBuffer[sender].count += 1;
                } else {
                    giftBuffer[sender] = { count: 1, tier: info.tier || '1000', timer: null, avatar: info.avatar };
                }

                giftBuffer[sender].timer = setTimeout(() => {
                    processBufferedGift(sender, giftBuffer[sender]);
                }, 2000);
                return;
            }

            if (type === 'subscriber' || type === 'sub' || type === 'resub' || type === 'subscription') {
                tier = info.tier || '1000';
                amount = info.amount || 1;
            } else if (type === 'tip' || type === 'cheer') {
                amount = info.amount;
            } else if (type === 'follow') {
                type = 'follower';
                amount = 0;
            }

            const providerId = data._id || `sock-${Date.now()}-${Math.random()}`;

            if (stats) {
                await processEvent(stats, type, username, amount, info.message || '', providerId, tier);
                await stats.save();
            }

            await processSnakesEvent(type, username, amount, providerId, tier, false, info.avatar);
            if (type === 'tip') {
                try {
                    await processDrinkEvent(type, username, amount, info.message || '', providerId, tier, {
                        currency: info.currency || 'USD'
                    });
                } catch (drinkErr) {
                    console.error('[Drinks] Non-fatal socket event error:', drinkErr.message);
                }
            }
        } catch (e) {
            console.error('Socket Error:', e);
        }
    });
};

// --- StreamElements REST Polling & Resolver ---
let cachedChannelId = null;

const resolveChannelId = async () => {
    if (cachedChannelId) return cachedChannelId;
    if (!SE_JWT) {
        console.log('❌ [resolveChannelId] STREAMELEMENTS_JWT is missing or empty.');
        return null;
    }

    console.log('🔌 [resolveChannelId] Resolving StreamElements channel ID...');
    try {
        const res = await axios.get(`https://api.streamelements.com/kappa/v2/channels/${TARGET_USERNAME}`, {
            headers: { Authorization: `Bearer ${SE_JWT}`, 'User-Agent': 'Mozilla/5.0' },
            timeout: 8000
        });
        if (res.data && res.data._id) {
            cachedChannelId = res.data._id;
            console.log(`✅ [resolveChannelId] Resolved channel ID: ${cachedChannelId} (Target: ${TARGET_USERNAME})`);
            return cachedChannelId;
        }
    } catch (e) {
        console.error(
            `⚠️ [resolveChannelId] Failed to resolve channel for ${TARGET_USERNAME}:`,
            e.response ? `Status ${e.response.status} - ${JSON.stringify(e.response.data)}` : e.message
        );
    }

    try {
        const me = await axios.get('https://api.streamelements.com/kappa/v2/channels/me', {
            headers: { Authorization: `Bearer ${SE_JWT}` },
            timeout: 8000
        });
        if (me.data && me.data._id) {
            cachedChannelId = me.data._id;
            console.log(`✅ [resolveChannelId] Resolved "me" channel ID: ${cachedChannelId}`);
            return cachedChannelId;
        }
    } catch (e) {
        console.error(
            '❌ [resolveChannelId] Failed to resolve channel for "me":',
            e.response ? `Status ${e.response.status} - ${JSON.stringify(e.response.data)}` : e.message
        );
    }

    return null;
};

const fetchAndProcess = async (channelId, _label, stats, limit = 25, offset = 0) => {
    if (!channelId) return [];

    try {
        const url = `https://api.streamelements.com/kappa/v2/activities/${channelId}`;
        const { data: activities } = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${SE_JWT}`,
                Accept: 'application/json',
                'User-Agent': 'UrnisaBot/1.0'
            },
            params: { limit, offset, types: 'subscriber,subscription,tip,cheer,follow,gift' },
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

                if (['subscriber', 'sub', 'resub', 'subscription'].includes(act.type)) {
                    amt = 1;
                    tier = act.data.tier || '1000';
                    if (act.data.gifted) {
                        username = act.data.sender;
                        type = 'gift';
                    }
                } else if (act.type === 'gift') {
                    amt = act.data.amount || 1;
                } else if (['cheer', 'tip'].includes(act.type)) {
                    amt = act.data.amount;
                } else if (act.type === 'follow') {
                    type = 'follower';
                    amt = 0;
                } else {
                    continue;
                }

                if (stats) {
                    const added = await processEvent(stats, type, username, amt, act.data.message, act._id, tier);
                    if (added > 0 || type === 'follower') changes = true;
                }

                await processSnakesEvent(type, username, amt, act._id, tier);
                if (type === 'tip') {
                    try {
                        await processDrinkEvent(type, username, amt, act.data.message || '', act._id, tier, {
                            currency: act.data.currency || 'USD'
                        });
                    } catch (drinkErr) {
                        console.error('[Drinks] Non-fatal poll event error:', drinkErr.message);
                    }
                }
            }
            return changes;
        }
        return activities;
    } catch {
        return [];
    }
};

const syncSessionFallback = async (channelId, stats) => {
    try {
        const { data: session } = await axios.get(`https://api.streamelements.com/kappa/v2/sessions/${channelId}`, {
            headers: { Authorization: `Bearer ${SE_JWT}` },
            timeout: 8000
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
            if (stats) await processEvent(stats, type, username, 1, '', `session-sub-${username}`, lastSub.tier);
            await processSnakesEvent(type, username, 1, `session-sub-${username}`, lastSub.tier, false, lastSub.avatar);
            try {
                await processDrinkEvent(type, username, 1, '', `session-sub-${username}`, lastSub.tier);
            } catch (drinkErr) {
                console.error('[Drinks] Non-fatal session sub sync error:', drinkErr.message);
            }
            changes = true;
        }

        const lastTip = session.data['latest-tip'];
        if (lastTip) {
            if (stats) await processEvent(stats, 'tip', lastTip.name, lastTip.amount, lastTip.message, `session-tip-${lastTip.name}-${lastTip.amount}`);
            await processSnakesEvent('tip', lastTip.name, lastTip.amount, `session-tip-${lastTip.name}-${lastTip.amount}`);
            try {
                await processDrinkEvent('tip', lastTip.name, lastTip.amount, lastTip.message || '', `session-tip-${lastTip.name}-${lastTip.amount}`);
            } catch (drinkErr) {
                console.error('[Drinks] Non-fatal session tip sync error:', drinkErr.message);
            }
            changes = true;
        }

        const lastCheer = session.data['latest-cheer'];
        if (lastCheer) {
            if (stats) await processEvent(stats, 'cheer', lastCheer.name, lastCheer.amount, lastCheer.message, `session-cheer-${lastCheer.name}-${lastCheer.amount}`);
            await processSnakesEvent('cheer', lastCheer.name, lastCheer.amount, `session-cheer-${lastCheer.name}-${lastCheer.amount}`);
            try {
                await processDrinkEvent('cheer', lastCheer.name, lastCheer.amount, lastCheer.message || '', `session-cheer-${lastCheer.name}-${lastCheer.amount}`);
            } catch (drinkErr) {
                console.error('[Drinks] Non-fatal session cheer sync error:', drinkErr.message);
            }
            changes = true;
        }

        if (changes) console.log('✅ Session Sync Processed');
    } catch {
        // Ignore transient session sync failures
    }
};

const runSync = async (forceDeep = false) => {
    if (mongoose.connection.readyState !== 1) return;
    if (!SE_JWT) return;

    try {
        let stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) stats = await NisathonStats.create({ key: 'main', timerEndTime: new Date(Date.now() + 3 * 3600000) });

        const resolvedId = (await resolveChannelId()) || ENV_CHANNEL_ID;
        if (resolvedId) {
            const limit = forceDeep ? 100 : 25;
            const c1 = await fetchAndProcess(resolvedId, 'AUTO-ID', stats, limit);
            if (!c1 && forceDeep) await syncSessionFallback(resolvedId, stats);
            if ((c1 || forceDeep) && stats) await stats.save();
        }
    } catch (e) {
        console.error('Loop Error:', e);
    }
};

// --- Rebuild & Repair Helpers ---
const rebuildEverything = async () => {
    const resolvedId = (await resolveChannelId()) || ENV_CHANNEL_ID;
    if (!resolvedId) return;
    console.log(`🔥 STARTING REBUILD for ${resolvedId}...`);

    await NisathonEvent.deleteMany({});
    await SpinQueue.deleteMany({});
    await SpinHistory.deleteMany({});

    let stats = await NisathonStats.findOne({ key: 'main' });
    if (!stats) stats = await NisathonStats.create({ key: 'main' });
    stats.currentSubs = 0;
    stats.currentBits = 0;
    stats.currentDonations = 0;
    stats.totalNisaballs = 0;
    stats.remainingTimeMs = 0;
    stats.isPaused = false;
    stats.isEnded = false;
    stats.timerEndTime = new Date(Date.now() + 3 * 60 * 60 * 1000);
    stats.lastActivityTime = new Date(0).toISOString();
    await stats.save();

    let allActivities = [];
    const limit = 100;
    const pagesToFetch = 10;

    for (let i = 0; i < pagesToFetch; i++) {
        const acts = await fetchAndProcess(resolvedId, 'REBUILD', null, limit, i * limit);
        if (Array.isArray(acts) && acts.length > 0) allActivities = allActivities.concat(acts);
        else break;
    }

    console.log(`   -> Processing ${allActivities.length} historical events...`);
    allActivities.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    for (const act of allActivities) {
        let amt = 0;
        let tier = '1000';
        let type = act.type;
        let user = act.data.username;

        if (['subscriber', 'sub', 'resub'].includes(act.type)) {
            amt = 1;
            tier = act.data.tier || '1000';
            if (act.data.gifted) {
                user = act.data.sender;
                type = 'gift';
            }
        } else if (act.type === 'gift') {
            amt = act.data.amount || 1;
        } else if (['cheer', 'tip'].includes(act.type)) {
            amt = act.data.amount;
        } else if (act.type === 'follow') {
            type = 'follower';
            amt = 0;
        } else {
            continue;
        }

        await processEvent(stats, type, user, amt, act.data.message, act._id, tier);
    }

    stats.lastActivityTime = new Date().toISOString();
    await stats.save();
    console.log('✅ REBUILD COMPLETE.');
};

const repairNisathonEvents = async () => {
    try {
        const stats = await NisathonStats.findOne({ key: 'main' });
        const subsRate = stats?.subsRate || 2;
        const bitsRate = stats?.bitsRate || 500;
        const donationRate = stats?.donationRate || 5;

        const events = await NisathonEvent.find({
            nisaballAmount: 0,
            type: { $nin: ['reward', 'shop', 'wheel', 'deduction', 'follower', 'follow'] }
        });

        if (events.length === 0) return;
        console.log(`🛠️ Repairing ${events.length} NisathonEvents with 0 nisaballAmount...`);
        let repaired = 0;

        for (const ev of events) {
            let amount = 0;
            const display = ev.amountDisplay || '';
            const t = (ev.type || '').toLowerCase();

            if (t === 'sub') {
                if (display.includes('Tier 3') || display.includes('3000')) amount = 4 / subsRate;
                else if (display.includes('Tier 2') || display.includes('2000')) amount = 2 / subsRate;
                else amount = 1 / subsRate;
            } else if (t === 'gift') {
                const match = display.match(/(\d+)/);
                const gifts = match ? parseInt(match[1], 10) : 1;
                amount = gifts / subsRate;
            } else if (t === 'bits' || t === 'cheer') {
                const match = display.match(/(\d+)/);
                const bits = match ? parseInt(match[1], 10) : 0;
                amount = bits / bitsRate;
            } else if (t === 'donation' || t === 'tip') {
                if (ev.adminNote && ev.adminNote.includes('RM')) {
                    const match = ev.adminNote.match(/RM([\d.]+)/);
                    const don = match ? parseFloat(match[1]) : 0;
                    amount = don / 9;
                } else if (display.includes('RM')) {
                    const match = display.match(/RM([\d.]+)/);
                    const don = match ? parseFloat(match[1]) : 0;
                    amount = don / 9;
                } else {
                    const match = display.match(/[$]?([\d.]+)/);
                    const don = match ? parseFloat(match[1]) : 0;
                    amount = don / donationRate;
                }
            } else if (t === 'nisaball' || t === 'nisaballs') {
                const match = display.match(/([\d.]+)/);
                amount = match ? parseFloat(match[1]) : 0;
            }

            if (amount > 0) {
                ev.nisaballAmount = roundOneDecimal(amount);
                await ev.save();
                repaired++;
            }
        }
        console.log(`✅ Repaired ${repaired} NisathonEvents!`);
    } catch (err) {
        console.error('❌ Error repairing NisathonEvents:', err);
    }
};

// --- Exchange Rate Cache (SociaBuzz) ---
let cachedRates = null;
let lastCacheTime = 0;

const getUSDRate = async (currency) => {
    const cur = String(currency || 'IDR').toUpperCase();
    if (cur === 'USD') return 1;

    const now = Date.now();
    if (cachedRates && (now - lastCacheTime < 3600000)) {
        return cachedRates[cur] || null;
    }

    try {
        console.log('🔌 [Exchange Rate] Fetching live rates from open.er-api.com...');
        const res = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 5000 });
        if (res.data && res.data.rates) {
            cachedRates = res.data.rates;
            lastCacheTime = now;
            return cachedRates[cur] || null;
        }
    } catch (e) {
        console.error('❌ [Exchange Rate] Error fetching exchange rates:', e.message);
    }

    const fallbacks = {
        IDR: 15000,
        SGD: 1.34,
        MYR: 4.70,
        PHP: 56.00,
        THB: 35.00,
        JPY: 155.00,
        KRW: 13500.00,
        EUR: 0.92,
        GBP: 0.79
    };
    return fallbacks[cur] || null;
};

// --- Pokemon Cache Engine ---
let POKEMON_CACHE = [];

const getDisplayName = (name) => {
    const overrides = {
        'ho-oh': 'Ho-Oh',
        'porygon-z': 'Porygon-Z',
        'jangmo-o': 'Jangmo-o',
        'hakamo-o': 'Hakamo-o',
        'kommo-o': 'Kommo-o',
        'type-null': 'Type: Null',
        'mr-mime': 'Mr. Mime',
        'mr-rime': 'Mr. Rime',
        'mime-jr': 'Mime Jr.',
        'tapu-koko': 'Tapu Koko',
        'tapu-lele': 'Tapu Lele',
        'tapu-bulu': 'Tapu Bulu',
        'tapu-fini': 'Tapu Fini',
        'chi-yu': 'Chi-Yu',
        'chien-pao': 'Chien-Pao',
        'ting-lu': 'Ting-Lu',
        'wo-chien': 'Wo-Chien'
    };
    if (overrides[name]) return overrides[name];

    const baseName = name.split('-')[0];
    const bases = [
        'palafin', 'minior', 'aegislash', 'giratina', 'darmanitan', 'basculin',
        'keldeo', 'meloetta', 'meowstic', 'pumpkaboo', 'gourgeist', 'oricorio',
        'lycanroc', 'wishiwashi', 'mimikyu', 'toxtricity', 'eiscue', 'morpeko',
        'urshifu', 'enamorus', 'oinkologne', 'maushold', 'squawkabilly',
        'dudunsparce', 'gimmighoul', 'tatsugiri', 'deoxys', 'wormadam',
        'shaymin', 'tornadus', 'thundurus', 'landorus'
    ];
    if (bases.includes(baseName)) {
        return baseName.charAt(0).toUpperCase() + baseName.slice(1);
    }

    return name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
};

const getFormattedName = (name) => {
    return name.toLowerCase()
        .replace(/[.']/g, '')
        .replace(/♀/g, '-f')
        .replace(/♂/g, '-m')
        .replace(/\s+/g, '-');
};

const fetchPokemonData = async () => {
    if (POKEMON_CACHE.length > 0) return POKEMON_CACHE;
    try {
        console.log('Downloading Pokemon Data...');
        const { data } = await axios.get('https://pokeapi.co/api/v2/pokemon?limit=1025', { timeout: 15000 });
        POKEMON_CACHE = data.results.map((p, index) => {
            const id = index + 1;
            const formattedName = getFormattedName(p.name);
            return {
                id,
                name: getDisplayName(p.name),
                sprite: `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/home/${id}.png`,
                cobbleSprite: `https://cobblemon.tools/pokedex/pokemon/${formattedName}/sprite.png`,
                types: []
            };
        });
        console.log(`✅ Cached ${POKEMON_CACHE.length} Pokemon`);
        return POKEMON_CACHE;
    } catch (e) {
        console.error('Pokemon Fetch Error:', e);
        return [];
    }
};

// --- Tournament Bracket & Season Helpers ---
const generateMatches = async (key, type, participants) => {
    await TournamentBracket.deleteMany({ key });

    const totalPlayers = participants.length;
    let size = 2;
    while (size < totalPlayers) size *= 2;

    const matches = [];

    if (type === 'SINGLE_ELIMINATION') {
        const numRounds = Math.log2(size);
        let roundMatches = [];

        for (let i = 0; i < size / 2; i++) {
            const p1 = participants[i * 2] || null;
            const p2 = participants[i * 2 + 1] || null;
            let winner = null;
            let status = 'PENDING';
            if (p1 && !p2) { winner = p1; status = 'COMPLETED'; }
            else if (!p1 && !p2) { status = 'COMPLETED'; }
            else if (p1 && p2) { status = 'READY'; }

            roundMatches.push({
                id: `R1-M${i + 1}`,
                bracketGroup: 'winners',
                round: 1,
                matchIndex: i,
                player1: p1,
                player2: p2,
                winner,
                status,
                score: '',
                nextMatchId: null
            });
        }
        matches.push(...roundMatches);

        let prevRoundMatches = roundMatches;
        for (let r = 2; r <= numRounds; r++) {
            const currentRoundMatches = [];
            const numMatchesInRound = size / Math.pow(2, r);
            for (let i = 0; i < numMatchesInRound; i++) {
                const matchId = `R${r}-M${i + 1}`;
                const prev1 = prevRoundMatches[i * 2];
                const prev2 = prevRoundMatches[i * 2 + 1];
                prev1.nextMatchId = matchId;
                prev2.nextMatchId = matchId;

                const p1 = prev1.winner;
                const p2 = prev2.winner;
                currentRoundMatches.push({
                    id: matchId,
                    bracketGroup: 'winners',
                    round: r,
                    matchIndex: i,
                    player1: p1,
                    player2: p2,
                    winner: null,
                    status: (p1 && p2) ? 'READY' : 'PENDING',
                    score: '',
                    nextMatchId: null
                });
            }
            matches.push(...currentRoundMatches);
            prevRoundMatches = currentRoundMatches;
        }
    } else if (type === 'DOUBLE_ELIMINATION') {
        if (size > 16) throw new Error('Double Elimination currently supports max 16 players.');

        const numWbRounds = Math.log2(size);
        let prevWbRound = [];

        for (let i = 0; i < size / 2; i++) {
            const p1 = participants[i * 2] || null;
            const p2 = participants[i * 2 + 1] || null;
            let winner = null;
            let status = 'PENDING';
            if (p1 && !p2) { winner = p1; status = 'COMPLETED'; }
            else if (!p1 && !p2) { status = 'COMPLETED'; }
            else if (p1 && p2) { status = 'READY'; }

            prevWbRound.push({
                id: `WB-R1-M${i + 1}`,
                bracketGroup: 'winners',
                round: 1,
                matchIndex: i,
                player1: p1,
                player2: p2,
                winner,
                status,
                score: '',
                nextMatchId: null,
                loserNextMatchId: null
            });
        }
        matches.push(...prevWbRound);

        for (let r = 2; r <= numWbRounds; r++) {
            const currentWbRound = [];
            const count = size / Math.pow(2, r);
            for (let i = 0; i < count; i++) {
                const matchId = `WB-R${r}-M${i + 1}`;
                const prev1 = prevWbRound[i * 2];
                const prev2 = prevWbRound[i * 2 + 1];
                prev1.nextMatchId = matchId;
                prev2.nextMatchId = matchId;

                const p1 = prev1.winner;
                const p2 = prev2.winner;
                currentWbRound.push({
                    id: matchId,
                    bracketGroup: 'winners',
                    round: r,
                    matchIndex: i,
                    player1: p1,
                    player2: p2,
                    winner: null,
                    status: (p1 && p2) ? 'READY' : 'PENDING',
                    score: '',
                    nextMatchId: null,
                    loserNextMatchId: null
                });
            }
            matches.push(...currentWbRound);
            prevWbRound = currentWbRound;
        }

        const lbMatches = [];
        const findMatch = (id) => matches.find(m => m.id === id);

        if (size === 4) {
            lbMatches.push({ id: 'LB-R1-M1', bracketGroup: 'losers', round: 1, matchIndex: 0, player1: null, player2: null, nextMatchId: 'LB-R2-M1' });
            findMatch('WB-R1-M1').loserNextMatchId = 'LB-R1-M1';
            findMatch('WB-R1-M2').loserNextMatchId = 'LB-R1-M1';
            lbMatches.push({ id: 'LB-R2-M1', bracketGroup: 'losers', round: 2, matchIndex: 0, player1: null, player2: null, nextMatchId: 'GF-M1' });
            findMatch('WB-R2-M1').loserNextMatchId = 'LB-R2-M1';
        } else if (size === 8) {
            lbMatches.push({ id: 'LB-R1-M1', bracketGroup: 'losers', round: 1, matchIndex: 0, nextMatchId: 'LB-R2-M1', player1: null, player2: null });
            lbMatches.push({ id: 'LB-R1-M2', bracketGroup: 'losers', round: 1, matchIndex: 1, nextMatchId: 'LB-R2-M2', player1: null, player2: null });
            findMatch('WB-R1-M1').loserNextMatchId = 'LB-R1-M1';
            findMatch('WB-R1-M2').loserNextMatchId = 'LB-R1-M1';
            findMatch('WB-R1-M3').loserNextMatchId = 'LB-R1-M2';
            findMatch('WB-R1-M4').loserNextMatchId = 'LB-R1-M2';

            lbMatches.push({ id: 'LB-R2-M1', bracketGroup: 'losers', round: 2, matchIndex: 0, nextMatchId: 'LB-R3-M1', player1: null, player2: null });
            lbMatches.push({ id: 'LB-R2-M2', bracketGroup: 'losers', round: 2, matchIndex: 1, nextMatchId: 'LB-R3-M1', player1: null, player2: null });
            findMatch('WB-R2-M1').loserNextMatchId = 'LB-R2-M2';
            findMatch('WB-R2-M2').loserNextMatchId = 'LB-R2-M1';

            lbMatches.push({ id: 'LB-R3-M1', bracketGroup: 'losers', round: 3, matchIndex: 0, nextMatchId: 'LB-R4-M1', player1: null, player2: null });
            lbMatches.push({ id: 'LB-R4-M1', bracketGroup: 'losers', round: 4, matchIndex: 0, nextMatchId: 'GF-M1', player1: null, player2: null });
            findMatch('WB-R3-M1').loserNextMatchId = 'LB-R4-M1';
        } else if (size === 16) {
            for (let i = 0; i < 4; i++) {
                lbMatches.push({ id: `LB-R1-M${i + 1}`, bracketGroup: 'losers', round: 1, matchIndex: i, nextMatchId: `LB-R2-M${Math.ceil((i + 1) / 2)}` });
                findMatch(`WB-R1-M${i * 2 + 1}`).loserNextMatchId = `LB-R1-M${i + 1}`;
                findMatch(`WB-R1-M${i * 2 + 2}`).loserNextMatchId = `LB-R1-M${i + 1}`;
            }
            for (let i = 0; i < 4; i++) {
                lbMatches.push({ id: `LB-R2-M${i + 1}`, bracketGroup: 'losers', round: 2, matchIndex: i, nextMatchId: `LB-R3-M${Math.ceil((i + 1) / 2)}` });
                findMatch(`WB-R2-M${4 - i}`).loserNextMatchId = `LB-R2-M${i + 1}`;
            }
            for (let i = 0; i < 2; i++) {
                lbMatches.push({ id: `LB-R3-M${i + 1}`, bracketGroup: 'losers', round: 3, matchIndex: i, nextMatchId: `LB-R4-M${i + 1}` });
            }
            for (let i = 0; i < 2; i++) {
                lbMatches.push({ id: `LB-R4-M${i + 1}`, bracketGroup: 'losers', round: 4, matchIndex: i, nextMatchId: 'LB-R5-M1' });
                findMatch(`WB-R3-M${2 - i}`).loserNextMatchId = `LB-R4-M${i + 1}`;
            }
            lbMatches.push({ id: 'LB-R5-M1', bracketGroup: 'losers', round: 5, matchIndex: 0, nextMatchId: 'LB-R6-M1' });
            lbMatches.push({ id: 'LB-R6-M1', bracketGroup: 'losers', round: 6, matchIndex: 0, nextMatchId: 'GF-M1' });
            findMatch('WB-R4-M1').loserNextMatchId = 'LB-R6-M1';
        }

        matches.push(...lbMatches);

        const gfMatch = {
            id: 'GF-M1',
            bracketGroup: 'finals',
            round: 1,
            matchIndex: 0,
            player1: null,
            player2: null,
            nextMatchId: null
        };
        findMatch(`WB-R${numWbRounds}-M1`).nextMatchId = 'GF-M1';
        matches.push(gfMatch);
    }

    await TournamentBracket.create({ key, type, matches });
};

const advanceBracketMatch = async (key, { matchId, winner, score, player1, player2 }) => {
    const bracket = await TournamentBracket.findOne({ key });
    if (!bracket) return { status: 404, body: { error: 'No bracket found' } };

    const matchIndex = bracket.matches.findIndex(m => m.id === matchId);
    if (matchIndex === -1) return { status: 404, body: { error: 'Match not found' } };

    const match = bracket.matches[matchIndex];
    if (player1 !== undefined) match.player1 = player1;
    if (player2 !== undefined) match.player2 = player2;
    if (winner !== undefined) match.winner = winner;
    if (score !== undefined) match.score = score;

    if (match.player1 && match.player2 && match.status === 'PENDING') match.status = 'READY';
    if (match.winner) match.status = 'COMPLETED';

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
    return { status: 200, body: { success: true } };
};

const initDefaultSeason = async () => {
    const existing = await TournamentSeason.findOne({ seasonId: 1 });
    if (!existing) {
        await TournamentSeason.create({
            seasonId: 1,
            name: 'Season 1',
            format: 'Singles 4v4',
            status: 'DRAFTING',
            isArchived: false,
            challongeUrl: ''
        });
        console.log('✅ Created default active Season 1');
    }
};

// --- Ranked ELO, Tier & Anti-Abuse Helpers ---
const TIERS = {
    UNRANKED: { name: 'Unranked', minElo: 0, minWins: 0, color: '#666666' },
    DIRT: { name: 'Dirt', minElo: 0, minWins: 1, color: '#D2691E' },
    CASUAL: { name: 'Casual', minElo: 0, minWins: 2, color: '#808080' },
    OMEGA: { name: 'Omega', minElo: 1100, color: '#55FF55' },
    BETA: { name: 'Beta', minElo: 1200, color: '#5555FF' },
    ALPHA: { name: 'Alpha', minElo: 1275, color: '#AA00AA' },
    LEGENDARY: { name: 'Legend', minElo: 1425, color: '#FFFF55' },
    MYTHIC: { name: 'Mythic', minElo: 1625, color: '#FF55FF' },
    ETERNAL: { name: 'Eternal', minElo: 1900, color: '#FF5555' }
};

const isPlayerBanned = async (playerUuid) => {
    const ban = await RankedBan.findOne({ playerUuid });
    if (!ban) return { banned: false };

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

const checkForfeitAbuse = async (playerUuid, playerName) => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentForfeits = await ForfeitHistory.find({
        playerUuid,
        forfeitedAt: { $gte: oneHourAgo }
    }).sort({ forfeitedAt: -1 });

    if (recentForfeits.length >= 3) {
        const existingBan = await RankedBan.findOne({ playerUuid });
        if (!existingBan) {
            await RankedBan.create({
                playerUuid,
                playerName,
                reason: 'Auto-ban: 3 forfeits within 1 hour',
                bannedBy: 'SYSTEM',
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
                isPermanent: false
            });
            console.log(`🚫 Auto-banned ${playerName} for 24h (forfeit abuse)`);
            return { banned: true, duration: '24 hours' };
        }
    }
    return { banned: false };
};

const getDiminishingMultiplier = async (playerUuid, opponentUuid) => {
    const now = new Date();
    const twelveHoursMs = 12 * 60 * 60 * 1000;
    const history = await OpponentHistory.findOne({ playerUuid, opponentUuid });

    if (!history) {
        return { multiplier: 1.0, matchCount: 0, onCooldown: false, cooldownRemaining: 0 };
    }

    const referenceTime = history.firstMatchAt || history.lastMatchAt;
    if (referenceTime && (now.getTime() - new Date(referenceTime).getTime() >= twelveHoursMs)) {
        history.matchCount = 0;
        history.firstMatchAt = null;
        history.cooldownUntil = null;
        await history.save();
        console.log(`🔄 Opponent history reset for ${playerUuid} vs ${opponentUuid} (12h passed)`);
        return { multiplier: 1.0, matchCount: 0, onCooldown: false, cooldownRemaining: 0 };
    }

    if (!referenceTime && history.matchCount >= 3) {
        console.log(`⚠️ Corrupted opponent history detected for ${playerUuid} vs ${opponentUuid}, resetting`);
        history.matchCount = 0;
        history.firstMatchAt = null;
        history.cooldownUntil = null;
        await history.save();
        return { multiplier: 1.0, matchCount: 0, onCooldown: false, cooldownRemaining: 0 };
    }

    const count = history.matchCount;
    if (history.cooldownUntil && now < new Date(history.cooldownUntil)) {
        const cooldownRemaining = Math.ceil((new Date(history.cooldownUntil).getTime() - now.getTime()) / 60000);
        return { multiplier: 0.25, matchCount: count, onCooldown: true, cooldownRemaining };
    }

    if (count < 3) {
        return { multiplier: 1.0, matchCount: count, onCooldown: false, cooldownRemaining: 0 };
    }

    const multiplier = count <= 4 ? 0.50 : 0.25;
    return { multiplier, matchCount: count, onCooldown: false, cooldownRemaining: 0 };
};

const updateOpponentHistory = async (playerUuid, opponentUuid) => {
    const now = new Date();
    const thirtyMinutesMs = 30 * 60 * 1000;
    const history = await OpponentHistory.findOne({ playerUuid, opponentUuid });

    if (!history) {
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

    history.matchCount += 1;
    history.lastMatchAt = now;
    if (!history.firstMatchAt) history.firstMatchAt = now;
    if (history.matchCount >= 3) {
        history.cooldownUntil = new Date(now.getTime() + thirtyMinutesMs);
    }
    await history.save();
};

const getUniqueOpponentBonus = async (playerUuid, opponentUuid) => {
    const today = new Date().toISOString().split('T')[0];
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

    const isNewOpponent = !stats.uniqueOpponents.includes(opponentUuid);
    if (isNewOpponent) stats.uniqueOpponents.push(opponentUuid);
    stats.matchesPlayed += 1;

    const uniqueCount = stats.uniqueOpponents.length;
    let bonusMultiplier = 1.0;
    let bonusApplied = false;

    if (uniqueCount >= 3 && !stats.bonusEarned) {
        bonusMultiplier = 1.15;
        bonusApplied = true;
        stats.bonusEarned = true;
    } else if (uniqueCount >= 3 && stats.bonusEarned) {
        bonusMultiplier = 1.05;
    }

    await stats.save();
    return { bonusMultiplier, bonusApplied, uniqueCount, isNewOpponent };
};

const getEloRangePenalty = (winnerElo, loserElo) => {
    const eloDiff = Math.abs(winnerElo - loserElo);
    if (eloDiff <= 200) return { multiplier: 1.0, reduced: false };
    if (eloDiff <= 400) return { multiplier: 0.75, reduced: true };
    if (eloDiff <= 600) return { multiplier: 0.50, reduced: true };
    return { multiplier: 0.25, reduced: true };
};

const calculateTier = (elo, wins) => {
    if (wins === 0) return 'UNRANKED';
    if (elo < 1000) return 'DIRT';
    if (wins === 1) return 'DIRT';
    if (elo >= 1900) return 'ETERNAL';
    if (elo >= 1625) return 'MYTHIC';
    if (elo >= 1425) return 'LEGENDARY';
    if (elo >= 1275) return 'ALPHA';
    if (elo >= 1200) return 'BETA';
    if (elo >= 1100) return 'OMEGA';
    return 'CASUAL';
};

const calculateEloChange = (winnerElo, loserElo, result) => {
    const K = 100;
    const LOSER_ELO_RATIO = 0.5;
    const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
    const expectedLoser = 1 - expectedWinner;

    const baseWinnerChange = K * (1 - expectedWinner);
    const baseLoserChange = K * (0 - expectedLoser);

    const aliveBonus = result.winnerTotalPokemon > 0
        ? (result.winnerAlivePokemon / result.winnerTotalPokemon) * 10.0
        : 0;
    const koBonus = result.loserTotalPokemon > 0
        ? (result.winnerKOs / result.loserTotalPokemon) * 10.0
        : 0;

    const formatMultiplier = result.battleType === '2v2' ? 1.1 : 1.0;

    let winnerMultiplier = 1.0;
    let loserMultiplier = 1.0;
    if (result.endReason === 'forfeit') {
        winnerMultiplier = 0.5;
        loserMultiplier = 1.5;
    } else if (result.endReason === 'disconnect') {
        winnerMultiplier = 0;
        loserMultiplier = 1.0;
    }

    const winnerChange = Math.round((baseWinnerChange * formatMultiplier + aliveBonus + koBonus) * winnerMultiplier);
    const loserChange = Math.round(baseLoserChange * formatMultiplier * loserMultiplier * LOSER_ELO_RATIO);
    return { winnerChange, loserChange };
};

// ==========================================
// 5. API ROUTES
// ==========================================

// --- Health, Root, Verification & Debug ---
app.get('/', (req, res) => res.send('Backend OK'));

app.get('/health', (req, res) => {
    res.status(200).json({
        ok: true,
        status: 'ok',
        service: 'urnisa-backend',
        uptime: Math.floor(process.uptime()),
        dbConnected: mongoose.connection.readyState === 1,
        seSocketConnected: Boolean(socket && socket.connected),
        timestamp: new Date().toISOString()
    });
});

app.post('/api/verify', (req, res) => {
    res.json(req.body.password === ADMIN_PASSWORD ? { success: true } : { error: 'Invalid' });
});

app.get('/api/debug/se-latest', async (req, res) => {
    if (!SE_JWT || !ENV_CHANNEL_ID) return res.json({ error: 'Missing Config' });
    let targetId = ENV_CHANNEL_ID;
    try {
        const r = await axios.get(`https://api.streamelements.com/kappa/v2/channels/${TARGET_USERNAME}`, {
            headers: { Authorization: `Bearer ${SE_JWT}` },
            timeout: 8000
        });
        targetId = r.data._id;
    } catch {
        // Fallback to ENV_CHANNEL_ID
    }

    try {
        const response = await axios.get(`https://api.streamelements.com/kappa/v2/activities/${targetId}`, {
            headers: { Authorization: `Bearer ${SE_JWT}` },
            params: { limit: 25 },
            timeout: 8000
        });
        res.json({ configId: targetId, data: response.data });
    } catch (e) {
        res.json({ error: e.message });
    }
});

// --- Webhooks (SociaBuzz) ---
app.post('/api/webhooks/sociabuzz', async (req, res) => {
    try {
        const payload = req.body;
        console.log('📥 [SociaBuzz Webhook] Received payload:', JSON.stringify(payload, null, 2));

        if (!payload) {
            return res.status(400).json({ error: 'Missing payload body' });
        }

        const name = payload.nama || payload.nama_penyumbang || payload.supporter || payload.name || payload.supporter_name || payload.donor_name || payload.username || payload.sender || 'Anonymous';
        const message = payload.pesan || payload.message || payload.pesan_penyumbang || payload.comment || '';
        const rawNominal = payload.nominal || payload.amount || payload.nominal_received || payload.gross_amount || payload.total || 0;

        let amount = 0;
        if (typeof rawNominal === 'string') {
            const cleaned = rawNominal.replace(/,/g, '.').replace(/[^\d.-]/g, '');
            amount = parseFloat(cleaned);
        } else {
            amount = parseFloat(rawNominal);
        }

        const currency = String(payload.currency || payload.mata_uang || payload.currency_code || 'IDR').toUpperCase();
        if (isNaN(amount) || amount <= 0) {
            console.log('⚠️ [SociaBuzz Webhook] Ignored non-positive or invalid donation amount:', rawNominal);
            return res.json({ success: true, message: 'No active donation amount processed' });
        }

        const rate = await getUSDRate(currency);
        let usdAmount = amount;
        if (rate && rate > 0) {
            usdAmount = amount / rate;
            console.log(`💵 [SociaBuzz Webhook] Converted ${amount} ${currency} to ${usdAmount.toFixed(2)} USD using rate 1 USD = ${rate} ${currency}`);
        } else {
            console.log(`⚠️ [SociaBuzz Webhook] Rate not found for currency ${currency}. Defaulting to fallbacks.`);
            usdAmount = currency === 'IDR' ? amount / 15000 : amount;
        }

        const stats = await NisathonStats.findOne({ key: 'main' });
        const providerId = payload.id || payload.transaction_id || payload.order_id || `sociabuzz-${Date.now()}-${Math.random()}`;
        const isMYR = currency === 'MYR' || currency === 'RM';

        if (stats) {
            if (isMYR) {
                const adminNote = `Converted from RM${amount.toFixed(2)}`;
                await processEvent(stats, 'tip-myr', name, usdAmount, message, providerId, '1000', false, adminNote, amount);
                await stats.save();
                console.log(`✅ [SociaBuzz Webhook] Processed Nisathon donation: ${name} | RM${amount.toFixed(2)} MYR | msg: ${message}`);
            } else {
                await processEvent(stats, 'tip', name, usdAmount, message, providerId);
                await stats.save();
                console.log(`✅ [SociaBuzz Webhook] Processed Nisathon donation: ${name} | $${usdAmount.toFixed(2)} USD | msg: ${message}`);
            }
        } else {
            console.log('⚠️ [SociaBuzz Webhook] Nisathon stats not found in database.');
        }

        try {
            const statsRate = stats ? (stats.donationRate || 5) : 5;
            const snakeUsdAmount = isMYR ? (amount / 9) * statsRate : usdAmount;
            await processSnakesEvent('tip', name, snakeUsdAmount, providerId, '1000', false, '');
            console.log(`✅ [SociaBuzz Webhook] Routed to Snakes event queue for ${name} using scaled amount ${snakeUsdAmount}`);
        } catch (snakesErr) {
            console.error('❌ [SociaBuzz Webhook] Error routing to Snakes:', snakesErr.message);
        }

        try {
            await processDrinkEvent('tip', name, amount, message, providerId, '1000', { currency });
        } catch (drinkErr) {
            console.error('❌ [SociaBuzz Webhook] Error routing to Drinks:', drinkErr.message);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('❌ [SociaBuzz Webhook] Critical Error processing webhook:', err);
        res.status(500).json({ error: err.message });
    }
});

// --- Nisathon & Activity Routes ---
app.get('/api/nisathon/stats', async (req, res) => {
    if (mongoose.connection.readyState !== 1) return res.json({});
    let stats = await NisathonStats.findOne({ key: 'main' });
    if (!stats) stats = await NisathonStats.create({ key: 'main' });

    if (stats.currentSubs > 0 && (!stats.nbFromSubs || stats.nbFromSubs < stats.currentSubs * 0.5)) {
        stats.nbFromSubs = stats.currentSubs / (stats.subsRate || 1);
        stats.nbFromBits = stats.currentBits / (stats.bitsRate || 500);
        stats.nbFromDonations = stats.currentDonations / (stats.donationRate || 5);
        await stats.save();
    }

    res.json(stats);
});

app.get('/api/nisathon/leaderboard', async (req, res) => {
    try {
        const lb = await NisathonEvent.aggregate([
            {
                $match: {
                    hidden: { $ne: true },
                    isNisathon: { $ne: false },
                    type: { $nin: ['reward', 'shop', 'wheel', 'deduction'] }
                }
            },
            { $group: { _id: '$user', total: { $sum: '$nisaballAmount' } } },
            { $sort: { total: -1 } },
            { $limit: 10 }
        ]);
        res.json(lb.map((x, i) => ({ rank: i + 1, user: x._id, totalNisaballs: roundOneDecimal(x.total) })));
    } catch {
        res.json([]);
    }
});

app.get('/api/nisathon/recent', async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 50;
    const events = await NisathonEvent.find({
        hidden: { $ne: true },
        isNisathon: { $ne: false },
        type: { $nin: ['reward', 'shop', 'wheel', 'deduction'] }
    }).sort({ createdAt: -1 }).limit(limit);
    res.json(events);
});

app.get('/api/nisathon/user/:username', async (req, res) => {
    try {
        const { username } = req.params;
        if (!username) return res.status(400).json({ error: 'Missing username' });

        const escapedUsername = escapeRegex(username.trim());
        const events = await NisathonEvent.find({
            user: { $regex: new RegExp(`^${escapedUsername}$`, 'i') }
        }).sort({ createdAt: -1 });

        const totalNisaballs = events.reduce((sum, e) => sum + (e.nisaballAmount || 0), 0);
        const nisathonContributionEvents = events.filter(e =>
            !e.hidden &&
            e.isNisathon !== false &&
            !['reward', 'shop', 'wheel', 'deduction'].includes(e.type)
        );

        res.json({
            user: username,
            totalNisaballs: Math.max(0, roundOneDecimal(totalNisaballs)),
            events: nisathonContributionEvents.map(e => ({
                id: e._id || e.providerId,
                type: e.type,
                amountDisplay: e.amountDisplay,
                message: e.message,
                nisaballAmount: e.nisaballAmount,
                createdAt: e.createdAt
            }))
        });
    } catch (e) {
        console.error('Error fetching user nisaball balance:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/nisathon/test-event', auth, async (req, res) => {
    const stats = await NisathonStats.findOne({ key: 'main' });
    await processEvent(stats, req.body.type, req.body.user, parseFloat(req.body.amount), 'Manual', null, req.body.tier, true);
    await stats.save();
    res.json({ success: true });
});

app.post('/api/nisathon/timer/set', auth, async (req, res) => {
    const stats = await NisathonStats.findOne({ key: 'main' });
    const ms = (req.body.hours * 3600 + req.body.minutes * 60 + req.body.seconds) * 1000;
    if (stats.isPaused) stats.remainingTimeMs = ms;
    else stats.timerEndTime = new Date(Date.now() + ms);
    await stats.save();
    res.json({ success: true });
});

app.post('/api/nisathon/timer/add', auth, async (req, res) => {
    const stats = await NisathonStats.findOne({ key: 'main' });
    const ms = req.body.minutes * 60000;
    if (stats.isPaused) {
        stats.remainingTimeMs += ms;
        if (stats.remainingTimeMs < 0) stats.remainingTimeMs = 0;
    } else {
        stats.timerEndTime = new Date(Math.max(Date.now(), new Date(stats.timerEndTime).getTime()) + ms);
    }
    await stats.save();
    res.json({ success: true });
});

app.post('/api/nisathon/timer/pause', auth, async (req, res) => {
    const stats = await NisathonStats.findOne({ key: 'main' });
    const now = Date.now();
    if (stats.isPaused) {
        stats.isPaused = false;
        stats.timerEndTime = new Date(now + stats.remainingTimeMs);
        stats.remainingTimeMs = 0;
    } else {
        stats.isPaused = true;
        stats.remainingTimeMs = Math.max(0, new Date(stats.timerEndTime).getTime() - now);
    }
    await stats.save();
    res.json({ success: true });
});

app.post('/api/nisathon/event', auth, async (req, res) => {
    await NisathonStats.findOneAndUpdate({ key: 'main' }, { activeEvent: req.body.activeEvent });
    res.json({ success: true });
});

app.post('/api/nisathon/toggle-listener', auth, async (req, res) => {
    try {
        let stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) stats = await NisathonStats.create({ key: 'main' });

        if (typeof req.body.active === 'boolean') {
            stats.eventListenerActive = req.body.active;
        } else {
            stats.eventListenerActive = stats.eventListenerActive === false;
        }

        await stats.save();
        console.log(`🎧 Nisathon Event Listener toggled: ${stats.eventListenerActive ? 'ACTIVE' : 'OFF'}`);
        res.json({ success: true, eventListenerActive: stats.eventListenerActive });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/nisathon/settings', auth, async (req, res) => {
    try {
        const { subsRate, bitsRate, donationRate, timePerNb, eventListenerActive } = req.body;
        const updateData = {};
        if (subsRate !== undefined) updateData.subsRate = subsRate;
        if (bitsRate !== undefined) updateData.bitsRate = bitsRate;
        if (donationRate !== undefined) updateData.donationRate = donationRate;
        if (timePerNb !== undefined) updateData.timePerNb = timePerNb;
        if (eventListenerActive !== undefined) updateData.eventListenerActive = eventListenerActive;

        const updated = await NisathonStats.findOneAndUpdate(
            { key: 'main' },
            { $set: updateData },
            { new: true, upsert: true }
        );
        res.json({ success: true, message: 'Settings Updated', stats: updated });
    } catch (e) {
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

app.post('/api/nisathon/reset', auth, async (req, res) => {
    await NisathonEvent.deleteMany({});
    await SpinQueue.deleteMany({});
    await SpinHistory.deleteMany({});
    await NisathonStats.findOneAndUpdate({ key: 'main' }, {
        currentSubs: 0,
        currentBits: 0,
        currentDonations: 0,
        totalNisaballs: 0,
        remainingTimeMs: 0,
        isPaused: false,
        isEnded: false,
        activeEvent: null,
        lastActivityTime: new Date().toISOString()
    });
    res.json({ success: true });
});

app.post('/api/nisathon/sync', auth, async (req, res) => {
    await runSync(true);
    res.json({ success: true });
});

app.post('/api/nisathon/rebuild', auth, async (req, res) => {
    rebuildEverything();
    res.json({ success: true, message: 'Rebuild Started' });
});

app.post('/api/nisathon/repair', auth, async (req, res) => {
    await repairNisathonEvents();
    res.json({ success: true, message: 'Repair Completed' });
});

app.post('/api/nisathon/end', auth, async (req, res) => {
    try {
        let stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) stats = await NisathonStats.create({ key: 'main' });

        const now = Date.now();
        let remaining = 0;
        if (req.body && req.body.remainingTimeMs !== undefined && Number(req.body.remainingTimeMs) > 0) {
            remaining = Number(req.body.remainingTimeMs);
        } else if (stats.isPaused) {
            remaining = stats.remainingTimeMs || 0;
        } else {
            const end = new Date(stats.timerEndTime).getTime();
            remaining = Math.max(0, end - now);
        }

        if (remaining <= 0 && (stats.remainingTimeMs || 0) > 0) {
            remaining = stats.remainingTimeMs;
        }

        stats.isEnded = true;
        stats.isPaused = true;
        stats.remainingTimeMs = remaining;
        await stats.save();

        console.log(`🛑 Nisathon Ended successfully! Preserved remainingTimeMs: ${remaining}ms`);
        res.json({ success: true, message: 'Nisathon Ended', stats, remainingTimeMs: remaining });
    } catch (e) {
        console.error('❌ Failed to end Nisathon:', e);
        res.status(500).json({ error: 'Failed to end Nisathon' });
    }
});

app.post('/api/nisathon/start', auth, async (req, res) => {
    try {
        const stats = await NisathonStats.findOneAndUpdate(
            { key: 'main' },
            { isEnded: false, isPaused: false },
            { upsert: true, new: true }
        );
        console.log('🟢 [Nisathon] Started / Resumed! Triggering sync...');
        runSync(true).catch(err => console.error('Error during manual startup sync:', err));
        res.json({ success: true, message: 'Nisathon Started', stats });
    } catch (e) {
        console.error('❌ Failed to start Nisathon:', e);
        res.status(500).json({ error: 'Failed to start Nisathon' });
    }
});

app.post('/api/nisathon/delete-event', auth, async (req, res) => {
    const { id, revert } = req.body;
    try {
        const event = await NisathonEvent.findById(id);
        if (!event) return res.status(404).json({ error: 'Not Found' });

        if (revert) {
            const stats = await NisathonStats.findOne({ key: 'main' });
            if (stats) {
                const subsRate = stats.subsRate || 2;
                const bitsRate = stats.bitsRate || 500;
                const donationRate = stats.donationRate || 5;

                if (event.type === 'sub') stats.currentSubs = Math.max(0, stats.currentSubs - 1);
                else if (event.type === 'gift') stats.currentSubs = Math.max(0, stats.currentSubs - (event.nisaballAmount * subsRate));
                else if (event.type === 'bits') stats.currentBits = Math.max(0, stats.currentBits - (event.nisaballAmount * bitsRate));
                else if (event.type === 'donation') stats.currentDonations = Math.max(0, stats.currentDonations - (event.nisaballAmount * donationRate));

                stats.totalNisaballs = Math.max(0, roundOneDecimal(stats.totalNisaballs - event.nisaballAmount));

                const msToRemove = event.nisaballAmount * (stats.timePerNb || 10) * 60 * 1000;
                if (stats.isPaused) stats.remainingTimeMs = Math.max(0, stats.remainingTimeMs - msToRemove);
                else stats.timerEndTime = new Date(new Date(stats.timerEndTime).getTime() - msToRemove);
                await stats.save();
            }
        }
        await SpinQueue.deleteMany({ sourceEventId: id });
        await NisathonEvent.findByIdAndDelete(id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/nisathon/merge-users', auth, async (req, res) => {
    const { sourceUser, targetUser } = req.body;
    if (!sourceUser || !targetUser) return res.status(400).json({ error: 'Invalid parameters' });

    const cleanSource = sourceUser.trim();
    const cleanTarget = targetUser.trim();

    try {
        const escapedSource = escapeRegex(cleanSource);
        const sourceRegex = new RegExp(`^\\s*${escapedSource}\\s*$`, 'i');

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

// --- Wheel Routes ---
app.get('/api/wheel/queue', async (req, res) => res.json(await SpinQueue.find().sort({ createdAt: 1 })));
app.get('/api/wheel/history', async (req, res) => res.json(await SpinHistory.find().sort({ timestamp: -1 })));
app.post('/api/wheel/spin-result', auth, async (req, res) => {
    await SpinHistory.create({ user: req.body.user, reward: req.body.reward });
    if (req.body.queueId) await SpinQueue.findByIdAndDelete(req.body.queueId);
    res.json({ success: true });
});

// --- Snakes & Ladders Routes ---
app.get('/api/snakes/state', async (req, res) => {
    try {
        const [queue, players, history, winners, settings, specialTiles] = await Promise.all([
            SnakesQueue.find().sort({ createdAt: 1 }),
            SnakesPlayer.find().sort({ lastMovedAt: -1 }),
            SnakesHistory.find().sort({ timestamp: -1 }).limit(50),
            SnakesWinner.find().sort({ winCount: -1 }).limit(10),
            SnakesSettings.findOne({ key: 'main' }),
            SnakesSpecialTile.find().sort({ tile: 1 })
        ]);
        res.json({
            queue,
            players,
            history,
            winners,
            specialTiles,
            isActive: settings?.isActive || false,
            board: SNAKES_AND_LADDERS
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/snakes/special-tiles', async (req, res) => {
    try {
        const tiles = await SnakesSpecialTile.find().sort({ tile: 1 });
        res.json(tiles);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/snakes/special-tiles', auth, async (req, res) => {
    try {
        const { tile, text } = req.body;
        if (!tile || !text) return res.status(400).json({ error: 'Tile number and text required' });
        if (tile < 1 || tile > 100) return res.status(400).json({ error: 'Tile must be 1-100' });

        const specialTile = await SnakesSpecialTile.findOneAndUpdate(
            { tile },
            { tile, text },
            { upsert: true, new: true }
        );
        console.log(`🎯 Special tile ${tile} set: "${text.substring(0, 50)}..."`);
        res.json({ success: true, specialTile });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/snakes/special-tiles/:tile', auth, async (req, res) => {
    try {
        const tile = parseInt(req.params.tile, 10);
        await SnakesSpecialTile.deleteOne({ tile });
        console.log(`🗑️ Special tile ${tile} removed`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

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

app.post('/api/snakes/move', auth, async (req, res) => {
    try {
        const queueItem = await SnakesQueue.findOne().sort({ createdAt: 1 });
        if (!queueItem) return res.status(400).json({ error: 'Queue is empty' });

        const roll = Math.floor(Math.random() * 6) + 1;
        let player = await SnakesPlayer.findOne({ user: queueItem.user });

        if (player && queueItem.avatarUrl && player.avatarUrl !== queueItem.avatarUrl) {
            player.avatarUrl = queueItem.avatarUrl;
        }
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

        if (newPosition > 100) {
            newPosition = 100 - (newPosition - 100);
        }

        if (SNAKES_AND_LADDERS.ladders[newPosition]) {
            specialMove = 'ladder';
            newPosition = SNAKES_AND_LADDERS.ladders[newPosition];
        } else if (SNAKES_AND_LADDERS.snakes[newPosition]) {
            specialMove = 'snake';
            newPosition = SNAKES_AND_LADDERS.snakes[newPosition];
        }

        player.position = newPosition;
        player.lastMovedAt = new Date();
        await player.save();

        await SnakesHistory.create({ user: queueItem.user, roll, fromPosition, toPosition: newPosition, specialMove });
        await SnakesQueue.findByIdAndDelete(queueItem._id);

        const isWinner = newPosition === 100;
        if (isWinner) {
            const winner = await SnakesWinner.findOneAndUpdate(
                { user: queueItem.user },
                { $inc: { winCount: 1 }, $set: { lastWinAt: new Date(), avatarUrl: queueItem.avatarUrl || player.avatarUrl } },
                { upsert: true, new: true }
            );
            console.log(`🏆 ${queueItem.user} recorded as winner! Total wins: ${winner.winCount}`);
            player.position = 0;
            await player.save();
        }

        let specialTileEvent = null;
        const specialTile = await SnakesSpecialTile.findOne({ tile: newPosition });
        if (specialTile) {
            specialTileEvent = { tile: specialTile.tile, text: specialTile.text };
        }

        res.json({
            success: true,
            user: queueItem.user,
            roll,
            fromPosition,
            toPosition: newPosition,
            specialMove,
            specialTileEvent,
            isWinner,
            avatarUrl: player.avatarUrl
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/snakes/admin/move', auth, async (req, res) => {
    try {
        const { user, spaces } = req.body;
        if (!user || spaces === undefined) return res.status(400).json({ error: 'User and spaces required' });

        const player = await SnakesPlayer.findOne({ user: new RegExp(`^${escapeRegex(user.trim())}$`, 'i') });
        if (!player) return res.status(404).json({ error: 'Player not found' });

        let newPosition = Math.max(0, Math.min(100, player.position + parseInt(spaces, 10)));
        let specialMove = null;

        if (SNAKES_AND_LADDERS.ladders[newPosition]) {
            specialMove = 'ladder';
            newPosition = SNAKES_AND_LADDERS.ladders[newPosition];
        } else if (SNAKES_AND_LADDERS.snakes[newPosition]) {
            specialMove = 'snake';
            newPosition = SNAKES_AND_LADDERS.snakes[newPosition];
        }

        player.position = newPosition;
        player.lastMovedAt = new Date();
        await player.save();

        const isWinner = newPosition === 100;
        if (isWinner) {
            await SnakesWinner.findOneAndUpdate(
                { user: player.user },
                { $inc: { winCount: 1 }, $set: { lastWinAt: new Date(), avatarUrl: player.avatarUrl } },
                { upsert: true, new: true }
            );
            player.position = 0;
            await player.save();
        }

        let specialTileEvent = null;
        const specialTile = await SnakesSpecialTile.findOne({ tile: newPosition });
        if (specialTile) {
            specialTileEvent = { tile: specialTile.tile, text: specialTile.text };
        }

        res.json({ success: true, newPosition, specialMove, specialTileEvent, isWinner });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/snakes/test-event', auth, async (req, res) => {
    try {
        const { user, amount = 1 } = req.body;
        if (!user) return res.status(400).json({ error: 'User required' });

        const batchId = `test-${Date.now()}`;
        for (let i = 0; i < amount; i++) {
            await SnakesQueue.create({
                user,
                avatarUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(user)}&background=random`,
                amount: 1,
                type: 'test',
                sourceEventId: batchId
            });
        }
        res.json({ success: true, added: amount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/snakes/reset', auth, async (req, res) => {
    try {
        await Promise.all([
            SnakesQueue.deleteMany({}),
            SnakesPlayer.deleteMany({}),
            SnakesHistory.deleteMany({}),
            SnakesWinner.deleteMany({})
        ]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/snakes/queue/:id', auth, async (req, res) => {
    try {
        await SnakesQueue.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/snakes/settings', async (req, res) => {
    try {
        let settings = await SnakesSettings.findOne({ key: 'main' });
        if (!settings) settings = await SnakesSettings.create({ key: 'main' });
        res.json(settings);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/snakes/toggle-listener', auth, async (req, res) => {
    try {
        const { target } = req.body;
        let settings = await SnakesSettings.findOne({ key: 'main' });
        if (!settings) settings = await SnakesSettings.create({ key: 'main' });

        if (target === 'subs') settings.subsActive = !settings.subsActive;
        else if (target === 'donations') settings.donationsActive = !settings.donationsActive;

        settings.isActive = settings.subsActive || settings.donationsActive;
        await settings.save();
        res.json({ success: true, settings });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/snakes/simulate-event', auth, async (req, res) => {
    const { type, user, amount, tier, avatarUrl } = req.body;
    try {
        const providerId = `man-snake-${Date.now()}`;
        await processSnakesEvent(type, user, amount || 1, providerId, tier, true, avatarUrl);
        res.json({ success: true, message: 'Simulated event processed' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Drinking Stream Event Routes (Shots-Only) ---
const serializeDrinkQueueItem = (doc) => {
    const obj = doc.toObject ? doc.toObject() : { ...doc };
    const total = obj.drinkType === 'water' ? 1 : Math.max(1, Number(obj.totalShots) || 1);
    const served = getDrinkServedShots(obj);
    const waterSwapped = Number(obj.waterSwappedShots) || (obj.status === 'water_swapped' && obj.drinkType !== 'water' ? total : 0);
    const skipped = Number(obj.skippedShots) || (obj.status === 'skipped' && obj.drinkType !== 'water' ? total : 0);
    const remainingShots = getDrinkRemainingShots(obj);
    return {
        ...obj,
        drinkType: obj.drinkType === 'water' ? 'water' : 'shot',
        totalShots: total,
        servedShots: served,
        waterSwappedShots: waterSwapped,
        skippedShots: skipped,
        remainingShots
    };
};

app.get('/api/drinks/state', async (req, res) => {
    try {
        const settings = await getOrCreateDrinkSettings();
        const [pendingDocs, historyDocs, allShotDocs, spinDocs] = await Promise.all([
            DrinkQueueItem.find({ status: 'pending', drinkType: 'shot' }).sort({ createdAt: 1 }).limit(100),
            DrinkQueueItem.find({
                drinkType: 'shot',
                $or: [
                    { status: { $in: ['completed', 'skipped'] } },
                    { servedShots: { $gt: 0 } }
                ]
            }).sort({ completedAt: -1, createdAt: -1 }).limit(40),
            DrinkQueueItem.find({ drinkType: 'shot' }).sort({ createdAt: -1 }).limit(1000),
            DrinkSpinHistory.find().sort({ startedAt: -1 }).limit(50)
        ]);

        const pendingQueue = pendingDocs.map(serializeDrinkQueueItem);
        const recentHistory = historyDocs.map(serializeDrinkQueueItem);

        let completedShots = 0;
        let pendingShotsCount = 0;

        const leaderboardMap = new Map();

        for (const doc of allShotDocs) {
            const item = serializeDrinkQueueItem(doc);
            completedShots += item.servedShots;
            if (item.status === 'pending') {
                pendingShotsCount += item.remainingShots;
            }

            const activeContribution = item.servedShots + (item.status === 'pending' ? item.remainingShots : 0);
            if (activeContribution > 0) {
                const rawUser = (item.user || 'Anonymous').trim() || 'Anonymous';
                const key = rawUser.toLowerCase();
                if (!leaderboardMap.has(key)) {
                    leaderboardMap.set(key, {
                        user: rawUser,
                        totalShots: 0,
                        servedShots: 0,
                        lastTrigger: item.amountDisplay || ''
                    });
                }
                const entry = leaderboardMap.get(key);
                entry.totalShots += activeContribution;
                entry.servedShots += item.servedShots;
            }
        }

        const shotsPerSpin = Math.max(0, Number(settings.shotsPerSpin) || 0);
        const unlockedSpins = shotsPerSpin > 0 ? Math.floor(completedShots / shotsPerSpin) : 0;
        const usedEarnedSpins = spinDocs.filter(s => !s.isFreeSpin).length;
        const availableSpins = Math.max(0, unlockedSpins - usedEarnedSpins);
        const shotsIntoCurrentSpin = shotsPerSpin > 0 ? (completedShots % shotsPerSpin) : 0;
        const nextSpinIn = shotsPerSpin > 0 ? (shotsPerSpin - shotsIntoCurrentSpin) : 0;

        const nowMs = Date.now();
        const latestSpinDoc = spinDocs[0] || null;
        const activeSpin = latestSpinDoc && nowMs <= new Date(latestSpinDoc.revealAt).getTime() + 4000
            ? {
                spinId: latestSpinDoc.spinId,
                winningIndex: latestSpinDoc.winningIndex,
                reward: latestSpinDoc.reward,
                isFreeSpin: latestSpinDoc.isFreeSpin,
                shotCountAtSpin: latestSpinDoc.shotCountAtSpin,
                startedAt: latestSpinDoc.startedAt,
                revealAt: latestSpinDoc.revealAt
            }
            : null;

        const spinHistory = spinDocs
            .filter(s => nowMs >= new Date(s.revealAt).getTime())
            .map(s => ({
                _id: s._id,
                spinId: s.spinId,
                winningIndex: s.winningIndex,
                reward: s.reward,
                isFreeSpin: s.isFreeSpin,
                shotCountAtSpin: s.shotCountAtSpin,
                spunBy: s.spunBy,
                startedAt: s.startedAt,
                revealAt: s.revealAt
            }));

        const leaderboard = Array.from(leaderboardMap.values())
            .filter(e => e.totalShots > 0)
            .sort((a, b) => (b.totalShots - a.totalShots) || (b.servedShots - a.servedShots))
            .slice(0, 20)
            .map((entry, idx) => ({ rank: idx + 1, ...entry }));

        const latestShotDoc = allShotDocs.find(d => d.status !== 'skipped') || null;

        res.json({
            settings,
            stats: {
                pendingCardsCount: pendingQueue.length,
                pendingShotsCount,
                completedShots,
                totalShotsQueued: completedShots + pendingShotsCount,
                shotsPerSpin,
                unlockedSpins,
                usedEarnedSpins,
                availableSpins,
                shotsIntoCurrentSpin,
                nextSpinIn,
                spinReady: availableSpins > 0
            },
            pendingQueue,
            recentHistory,
            leaderboard,
            latestTrigger: latestShotDoc ? serializeDrinkQueueItem(latestShotDoc) : null,
            activeSpin,
            spinHistory
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/drinks/settings', auth, async (req, res) => {
    try {
        const body = req.body || {};
        const settings = await getOrCreateDrinkSettings();

        if (typeof body.eventTitle === 'string') settings.eventTitle = body.eventTitle.trim() || 'Shots with Urnisa';
        if (typeof body.eventSubtitle === 'string') settings.eventSubtitle = body.eventSubtitle.trim();
        if (typeof body.donationsActive === 'boolean') settings.donationsActive = body.donationsActive;

        if (body.gbpPerShot !== undefined) settings.gbpPerShot = Math.max(0.5, parseFloat(body.gbpPerShot) || 3);
        if (body.shotsPerSpin !== undefined) settings.shotsPerSpin = Math.max(0, parseInt(body.shotsPerSpin, 10) || 0);
        if (typeof body.shotLabel === 'string' && body.shotLabel.trim()) settings.shotLabel = body.shotLabel.trim();

        if (Array.isArray(body.wheelItems)) {
            const cleanedItems = body.wheelItems
                .filter(w => w && typeof w.label === 'string' && w.label.trim())
                .map(w => ({ label: w.label.trim(), weight: Math.max(1, parseInt(w.weight, 10) || 10) }));
            if (cleanedItems.length > 0) {
                settings.wheelItems = cleanedItems;
            }
        }

        await settings.save();
        res.json({ success: true, settings });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/drinks/toggle-listener', auth, async (req, res) => {
    try {
        const settings = await getOrCreateDrinkSettings();
        settings.donationsActive = !settings.donationsActive;
        await settings.save();
        res.json({ success: true, settings });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/drinks/queue/:id/action', auth, async (req, res) => {
    try {
        const { action } = req.body || {};
        const item = await DrinkQueueItem.findById(req.params.id);
        if (!item) return res.status(404).json({ error: 'Queue item not found' });

        const remaining = getDrinkRemainingShots(item);
        if (remaining <= 0) {
            return res.json({ success: true, item: serializeDrinkQueueItem(item) });
        }

        if (action === 'complete_one') {
            item.servedShots = (Number(item.servedShots) || 0) + 1;
        } else if (action === 'complete_all' || action === 'complete') {
            item.servedShots = (Number(item.servedShots) || 0) + remaining;
        } else if (action === 'skip' || action === 'skip_all') {
            item.skippedShots = (Number(item.skippedShots) || 0) + remaining;
        } else {
            return res.status(400).json({ error: 'Invalid action' });
        }

        const leftAfter = getDrinkRemainingShots(item);
        if (leftAfter <= 0) {
            item.status = (item.servedShots || 0) > 0 ? 'completed' : 'skipped';
        }
        item.completedAt = new Date();
        await item.save();
        res.json({ success: true, item: serializeDrinkQueueItem(item) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/drinks/manual', auth, async (req, res) => {
    try {
        const { user = 'Urnisa', shotCount = 1, drinkLabel, message = '' } = req.body || {};
        const settings = await getOrCreateDrinkSettings();
        const safeCount = Math.max(1, parseInt(shotCount, 10) || 1);
        const baseShotLabel = settings.shotLabel || 'Shot';
        const resolvedLabel = (drinkLabel && String(drinkLabel).trim()) || (safeCount === 1 ? baseShotLabel : `${safeCount}x ${baseShotLabel}s`);

        const item = await DrinkQueueItem.create({
            user: (user || 'Admin').trim(),
            drinkType: 'shot',
            drinkLabel: resolvedLabel,
            triggerType: 'manual',
            amountDisplay: `Manual (${safeCount} Shot${safeCount > 1 ? 's' : ''})`,
            message: String(message || '').trim(),
            totalShots: safeCount,
            servedShots: 0,
            skippedShots: 0,
            status: 'pending',
            isTest: false,
            sourceEventId: `drink-manual-${Date.now()}-${Math.random()}`
        });

        await recordDrinkDebugLog({
            source: 'manual',
            triggerType: 'shot',
            user: item.user,
            amountDisplay: item.amountDisplay,
            outcome: 'queued',
            reason: 'Added manually from Admin',
            queuedSummary: item.drinkLabel,
            isTest: false
        });

        res.json({ success: true, item: serializeDrinkQueueItem(item) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/drinks/wheel/spin', auth, async (req, res) => {
    try {
        const { freeSpin = false } = req.body || {};
        const settings = await getOrCreateDrinkSettings();
        const items = Array.isArray(settings.wheelItems) && settings.wheelItems.length > 0
            ? settings.wheelItems
            : DEFAULT_DRINK_WHEEL_ITEMS;

        const [allShotDocs, spinDocs] = await Promise.all([
            DrinkQueueItem.find({ drinkType: 'shot' }).select('totalShots servedShots skippedShots status'),
            DrinkSpinHistory.find().sort({ startedAt: -1 }).limit(50)
        ]);

        let completedShots = 0;
        for (const doc of allShotDocs) {
            completedShots += getDrinkServedShots(doc);
        }

        const shotsPerSpin = Math.max(0, Number(settings.shotsPerSpin) || 0);
        const unlockedSpins = shotsPerSpin > 0 ? Math.floor(completedShots / shotsPerSpin) : 0;
        const usedEarnedSpins = spinDocs.filter(s => !s.isFreeSpin).length;
        const availableSpins = Math.max(0, unlockedSpins - usedEarnedSpins);

        const latestSpin = spinDocs[0] || null;
        if (latestSpin && Date.now() < new Date(latestSpin.revealAt).getTime()) {
            return res.status(409).json({ error: 'A wheel spin is already in progress. Wait a few seconds!' });
        }

        if (!freeSpin && availableSpins <= 0) {
            return res.status(400).json({ error: `No earned spins available yet (${completedShots} served shots)` });
        }

        const totalWeight = items.reduce((acc, item) => acc + Math.max(1, Number(item.weight) || 1), 0);
        let rand = Math.random() * totalWeight;
        let winningIndex = 0;
        for (let i = 0; i < items.length; i++) {
            const w = Math.max(1, Number(items[i].weight) || 1);
            if (rand < w) {
                winningIndex = i;
                break;
            }
            rand -= w;
        }

        const reward = items[winningIndex]?.label || 'Take a Shot';
        const now = new Date();
        const revealAt = new Date(now.getTime() + 6000);
        const spin = await DrinkSpinHistory.create({
            spinId: `dspin-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            winningIndex,
            reward,
            isFreeSpin: Boolean(freeSpin),
            shotCountAtSpin: completedShots,
            spunBy: 'Urnisa',
            startedAt: now,
            revealAt
        });

        await recordDrinkDebugLog({
            source: 'wheel',
            triggerType: freeSpin ? 'free_spin' : 'earned_spin',
            user: 'Urnisa',
            amountDisplay: `${completedShots} Shots Served`,
            outcome: 'queued',
            reason: `Wheel spun (${freeSpin ? 'Free Admin Spin' : `Every ${shotsPerSpin} Shots`})`,
            queuedSummary: reward,
            isTest: false
        });

        res.json({ success: true, spin });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/drinks/simulate', auth, async (req, res) => {
    try {
        const {
            user = 'TestDonor',
            amount = 5,
            currency = 'GBP',
            message = 'Test GBP donation!',
            dryRun = false,
            ignoreToggles = false
        } = req.body || {};

        const result = await processDrinkEvent(
            'donation',
            user,
            Number(amount) || 0,
            message,
            `drink-test-${Date.now()}-${Math.random()}`,
            '1000',
            {
                isTest: true,
                dryRun: Boolean(dryRun),
                ignoreToggles: Boolean(ignoreToggles),
                currency
            }
        );

        res.json({ success: true, dryRun: Boolean(dryRun), result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/drinks/debug', auth, async (req, res) => {
    try {
        const [settings, nisathonStats, logs, testCount] = await Promise.all([
            getOrCreateDrinkSettings(),
            NisathonStats.findOne({ key: 'main' }).select('eventListenerActive isEnded'),
            DrinkDebugLog.find().sort({ createdAt: -1 }).limit(25),
            DrinkQueueItem.countDocuments({ isTest: true })
        ]);

        res.json({
            seSocketConnected: Boolean(socket && socket.connected),
            seJwtConfigured: Boolean(SE_JWT),
            resolvedChannelId: cachedChannelId || ENV_CHANNEL_ID || null,
            nisathonListenerActive: nisathonStats ? nisathonStats.eventListenerActive !== false : true,
            nisathonEnded: Boolean(nisathonStats?.isEnded),
            drinkSettings: settings,
            testItemsCount: testCount,
            logs
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/drinks/clear-tests', auth, async (req, res) => {
    try {
        const [deletedItems] = await Promise.all([
            DrinkQueueItem.deleteMany({ isTest: true }),
            DrinkDebugLog.deleteMany({ isTest: true })
        ]);
        res.json({ success: true, deletedCount: deletedItems.deletedCount || 0 });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/drinks/reset', auth, async (req, res) => {
    try {
        await Promise.all([
            DrinkQueueItem.deleteMany({}),
            DrinkDebugLog.deleteMany({}),
            DrinkSpinHistory.deleteMany({})
        ]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Standalone Countdown Routes ---
app.get('/api/countdown/stats', async (req, res) => {
    if (mongoose.connection.readyState !== 1) return res.json({});
    let stats = await CountdownStats.findOne({ key: 'main' });
    if (!stats) stats = await CountdownStats.create({ key: 'main' });
    res.json(stats);
});

app.post('/api/countdown/set', auth, async (req, res) => {
    const stats = await CountdownStats.findOne({ key: 'main' });
    const ms = (req.body.hours * 3600 + req.body.minutes * 60 + req.body.seconds) * 1000;
    if (stats.isPaused) stats.remainingTimeMs = ms;
    else stats.timerEndTime = new Date(Date.now() + ms);
    await stats.save();
    res.json({ success: true });
});

app.post('/api/countdown/add', auth, async (req, res) => {
    const stats = await CountdownStats.findOne({ key: 'main' });
    const ms = req.body.minutes * 60000;
    if (stats.isPaused) stats.remainingTimeMs += ms;
    else stats.timerEndTime = new Date(Math.max(Date.now(), new Date(stats.timerEndTime).getTime()) + ms);
    await stats.save();
    res.json({ success: true });
});

app.post('/api/countdown/pause', auth, async (req, res) => {
    const stats = await CountdownStats.findOne({ key: 'main' });
    const now = Date.now();
    if (stats.isPaused) {
        stats.isPaused = false;
        stats.timerEndTime = new Date(now + stats.remainingTimeMs);
        stats.remainingTimeMs = 0;
    } else {
        stats.isPaused = true;
        stats.remainingTimeMs = Math.max(0, new Date(stats.timerEndTime).getTime() - now);
    }
    await stats.save();
    res.json({ success: true, isPaused: stats.isPaused });
});

app.post('/api/countdown/reset', auth, async (req, res) => {
    await CountdownStats.findOneAndUpdate({ key: 'main' }, { remainingTimeMs: 0, isPaused: true, timerEndTime: new Date() });
    res.json({ success: true });
});

// --- Site Content & Media Upload Routes ---
app.get('/api/goals', async (req, res) => {
    res.json({ goals: (await Setting.findOne({ key: 'nisathon_goals' }))?.value });
});
app.post('/api/goals', auth, async (req, res) => {
    await Setting.findOneAndUpdate({ key: 'nisathon_goals' }, { value: req.body.goals }, { upsert: true });
    res.json({ success: true });
});

app.get('/api/wheel', async (req, res) => {
    res.json({ items: (await Setting.findOne({ key: 'wheel_items' }))?.value });
});
app.post('/api/wheel', auth, async (req, res) => {
    await Setting.findOneAndUpdate({ key: 'wheel_items' }, { value: req.body.items }, { upsert: true });
    res.json({ success: true });
});

app.get('/api/profile', async (req, res) => {
    const [a, c, w] = await Promise.all([
        Setting.findOne({ key: 'profile_about' }),
        Setting.findOne({ key: 'profile_credits' }),
        Setting.findOne({ key: 'profile_artworks' })
    ]);
    res.json({ about: a?.value || [], credits: c?.value || [], artworks: w?.value || [] });
});
app.post('/api/profile', auth, async (req, res) => {
    await Setting.findOneAndUpdate({ key: `profile_${req.body.type}` }, { value: req.body.data }, { upsert: true });
    res.json({ success: true });
});

app.get('/api/schedule', async (req, res) => {
    const [urlDoc, configDoc] = await Promise.all([
        Setting.findOne({ key: 'schedule_url' }),
        Setting.findOne({ key: 'schedule_config' })
    ]);
    const cfg = (configDoc && typeof configDoc.value === 'object' && configDoc.value) ? configDoc.value : {};
    res.json({
        url: urlDoc?.value || DEFAULT_SCHEDULE_URL,
        mode: cfg.mode === 'countdown' ? 'countdown' : 'poster',
        countdownTitle: typeof cfg.countdownTitle === 'string' ? cfg.countdownTitle : '',
        countdownTarget: typeof cfg.countdownTarget === 'string' ? cfg.countdownTarget : '',
        countdownBackdropUrl: typeof cfg.countdownBackdropUrl === 'string' ? cfg.countdownBackdropUrl : '',
        countdownBackdropFit: cfg.countdownBackdropFit === 'contain' ? 'contain' : 'cover'
    });
});
app.post('/api/schedule', auth, async (req, res) => {
    const body = req.body || {};
    if (typeof body.url === 'string') {
        await Setting.findOneAndUpdate({ key: 'schedule_url' }, { value: body.url }, { upsert: true });
    }

    const existingDoc = await Setting.findOne({ key: 'schedule_config' });
    const existingCfg = (existingDoc && typeof existingDoc.value === 'object' && existingDoc.value) ? existingDoc.value : {};

    const nextCfg = {
        mode: body.mode === 'countdown' ? 'countdown' : (body.mode === 'poster' ? 'poster' : (existingCfg.mode === 'countdown' ? 'countdown' : 'poster')),
        countdownTitle: typeof body.countdownTitle === 'string' ? body.countdownTitle.trim() : (existingCfg.countdownTitle || ''),
        countdownTarget: typeof body.countdownTarget === 'string' ? body.countdownTarget.trim() : (existingCfg.countdownTarget || ''),
        countdownBackdropUrl: typeof body.countdownBackdropUrl === 'string' ? body.countdownBackdropUrl.trim() : (existingCfg.countdownBackdropUrl || ''),
        countdownBackdropFit: body.countdownBackdropFit === 'contain' ? 'contain' : (body.countdownBackdropFit === 'cover' ? 'cover' : (existingCfg.countdownBackdropFit === 'contain' ? 'contain' : 'cover'))
    };

    await Setting.findOneAndUpdate({ key: 'schedule_config' }, { value: nextCfg }, { upsert: true });
    const urlDoc = await Setting.findOne({ key: 'schedule_url' });

    res.json({
        success: true,
        url: urlDoc?.value || DEFAULT_SCHEDULE_URL,
        ...nextCfg
    });
});

app.post('/api/stream-status', auth, async (req, res) => {
    await Setting.findOneAndUpdate({ key: 'stream_status_override' }, { value: req.body.override }, { upsert: true });
    res.json({ success: true });
});
app.get('/api/stream-status', async (req, res) => {
    const s = await Setting.findOne({ key: 'stream_status_override' });
    res.json({ override: s?.value || 'auto' });
});

app.post('/api/public/upload-card', async (req, res) => {
    try {
        const { image, filename } = req.body;
        if (!image || !filename) return res.status(400).json({ error: 'Missing image/filename' });

        const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
        const safeName = filename.replace(/[^a-z0-9_-]/gi, '_') + '.png';
        const filePath = path.join(CARDS_DIR, safeName);

        fs.writeFileSync(filePath, base64Data, 'base64');
        const publicUrl = `${process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))}/cards/${safeName}`;
        res.json({ success: true, url: publicUrl });
    } catch (e) {
        console.error('Upload Error:', e);
        res.status(500).json({ error: 'Upload failed' });
    }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        let buffer;
        let fileName;
        let mimeType = 'image/png';

        if (req.file) {
            buffer = req.file.buffer;
            mimeType = req.file.mimetype;
            const originalName = req.file.originalname || 'upload.png';
            const ext = path.extname(originalName) || '.png';
            const baseName = path.basename(originalName, ext).replace(/[^a-z0-9_-]/gi, '_');
            fileName = `${baseName}_${Date.now()}${ext}`;
        } else if (req.body && req.body.image) {
            const { image } = req.body;
            const mimeMatch = image.match(/^data:([^;]+);base64,/);
            if (mimeMatch) mimeType = mimeMatch[1];
            const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
            buffer = Buffer.from(base64Data, 'base64');
            fileName = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.png`;
        } else {
            return res.status(400).json({ error: 'No file or image data provided' });
        }

        if (supabase) {
            const { error } = await supabase.storage
                .from(SUPABASE_BUCKET)
                .upload(fileName, buffer, { contentType: mimeType, upsert: true });

            if (!error) {
                const { data: { publicUrl } } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(fileName);
                return res.json({ success: true, url: publicUrl, data: { url: publicUrl } });
            }
            console.error('Supabase Storage Error:', error);
        }

        if (CLOUDINARY_CLOUD_NAME) {
            try {
                const ts = Math.round(Date.now() / 1000);
                const sig = crypto.createHash('sha1').update(`timestamp=${ts}${CLOUDINARY_API_SECRET}`).digest('hex');
                const base64Image = `data:${mimeType};base64,${buffer.toString('base64')}`;

                const f = new FormData();
                f.append('file', base64Image);
                f.append('api_key', CLOUDINARY_API_KEY);
                f.append('timestamp', ts);
                f.append('signature', sig);

                const r = await axios.post(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, f, { timeout: 15000 });
                return res.json({ success: true, url: r.data.secure_url, data: { url: r.data.secure_url } });
            } catch (e) {
                console.error('Cloudinary Fallback Error:', e.message);
            }
        }

        const safeName = fileName.replace(/[^a-z0-9_.-]/gi, '_');
        const filePath = path.join(CARDS_DIR, safeName);
        fs.writeFileSync(filePath, buffer);
        const publicUrl = `${process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))}/cards/${safeName}`;
        return res.json({ success: true, url: publicUrl, data: { url: publicUrl } });
    } catch (e) {
        console.error('Critical Upload Route Error:', e);
        res.status(500).json({ error: 'Upload failed: ' + e.message });
    }
});

// --- Bingo Routes ---
app.post('/api/bingo/save', async (req, res) => {
    const { discordId, name, cardId, gridData, marked } = req.body;
    if (!discordId || !name || !cardId || !gridData) {
        return res.status(400).json({ error: 'Missing required data' });
    }

    try {
        let card = await BingoCard.findOne({ discordId, name });
        if (!card) {
            let syncCode;
            let isUnique = false;
            while (!isUnique) {
                syncCode = crypto.randomBytes(3).toString('hex').toUpperCase();
                const existing = await BingoCard.findOne({ syncCode });
                if (!existing) isUnique = true;
            }
            card = await BingoCard.create({ discordId, name, cardId, gridData, marked, syncCode });
        } else {
            card = await BingoCard.findOneAndUpdate(
                { discordId, name },
                { cardId, gridData, marked, updatedAt: new Date() },
                { new: true }
            );
        }
        res.json({ success: true, message: 'Card saved successfully!', syncCode: card.syncCode });
    } catch (e) {
        console.error('Bingo Save Error:', e);
        res.status(500).json({ error: 'Failed to save card' });
    }
});

app.get('/api/bingo/list', async (req, res) => {
    const { discordId } = req.query;
    if (!discordId) return res.status(400).json({ error: 'Missing Discord ID' });
    try {
        const cards = await BingoCard.find({ discordId }).sort({ updatedAt: -1 });
        res.json(cards);
    } catch {
        res.status(500).json({ error: 'Failed to fetch cards' });
    }
});

app.get('/api/mod/bingo/:syncCode', async (req, res) => {
    try {
        const card = await BingoCard.findOne({ syncCode: req.params.syncCode.toUpperCase() });
        if (!card) return res.status(404).json({ error: 'Card not found. Invalid Sync Code.' });

        const cells = card.gridData.map((cell, index) => ({
            index,
            id: cell.id,
            name: cell.name,
            marked: card.marked[index]
        }));
        res.json({ discordId: card.discordId, name: card.name, cardId: card.cardId, cells });
    } catch (e) {
        console.error('Mod Bingo Fetch Error:', e);
        res.status(500).json({ error: 'Server Error' });
    }
});

app.post('/api/mod/bingo/:syncCode/mark', async (req, res) => {
    try {
        const { syncCode } = req.params;
        const { index } = req.body;
        const card = await BingoCard.findOne({ syncCode: syncCode.toUpperCase() });
        if (!card) return res.status(404).json({ error: 'Card not found.' });
        if (index < 0 || index > 24) return res.status(400).json({ error: 'Invalid index.' });

        const newMarked = [...card.marked];
        newMarked[index] = true;
        await BingoCard.findOneAndUpdate(
            { syncCode: syncCode.toUpperCase() },
            { marked: newMarked, updatedAt: new Date() }
        );
        res.json({ success: true, message: `Cell ${index} marked.` });
    } catch (e) {
        console.error('Mod Bingo Mark Error:', e);
        res.status(500).json({ error: 'Server Error' });
    }
});

app.post('/api/mod/bingo/:syncCode/unmark', async (req, res) => {
    try {
        const { syncCode } = req.params;
        const { index } = req.body;
        const card = await BingoCard.findOne({ syncCode: syncCode.toUpperCase() });
        if (!card) return res.status(404).json({ error: 'Card not found.' });
        if (index < 0 || index > 24) return res.status(400).json({ error: 'Invalid index.' });

        const newMarked = [...card.marked];
        newMarked[index] = false;
        await BingoCard.findOneAndUpdate(
            { syncCode: syncCode.toUpperCase() },
            { marked: newMarked, updatedAt: new Date() }
        );
        res.json({ success: true, message: `Cell ${index} unmarked.` });
    } catch (e) {
        console.error('Mod Bingo Unmark Error:', e);
        res.status(500).json({ error: 'Server Error' });
    }
});

app.post('/api/bingo/delete', async (req, res) => {
    const { discordId, name } = req.body;
    if (!discordId || !name) return res.status(400).json({ error: 'Missing data' });
    try {
        await BingoCard.findOneAndDelete({ discordId, name });
        res.json({ success: true, message: 'Card deleted' });
    } catch {
        res.status(500).json({ error: 'Failed to delete card' });
    }
});

app.get('/api/bingo/config', async (req, res) => {
    try {
        const config = await Setting.findOne({ key: 'bingo_config' });
        res.json(config ? config.value : { cardId: 'WEEK1', winCondition: '1 Line' });
    } catch {
        res.status(500).json({ error: 'Failed to fetch bingo config' });
    }
});

app.post('/api/bingo/config', auth, async (req, res) => {
    const { cardId, winCondition } = req.body;
    try {
        await Setting.findOneAndUpdate({ key: 'bingo_config' }, { value: { cardId, winCondition } }, { upsert: true });
        res.json({ success: true, message: 'Bingo config updated' });
    } catch {
        res.status(500).json({ error: 'Failed to update bingo config' });
    }
});

app.get('/api/bingo/definition', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing ID' });
    try {
        const def = await BingoDefinition.findOne({ cardId: id });
        if (def) return res.json(def);
        return res.status(404).json({ error: 'Not found' });
    } catch {
        return res.status(500).json({ error: 'Error' });
    }
});

app.post('/api/bingo/definition', async (req, res) => {
    const { cardId, gridData, difficulty } = req.body;
    if (!cardId || !gridData) return res.status(400).json({ error: 'Missing data' });

    try {
        const existing = await BingoDefinition.findOne({ cardId });
        if (existing) return res.json({ success: true, data: existing, message: 'Definition already exists' });

        const newDef = await BingoDefinition.create({ cardId, gridData, difficulty });
        res.json({ success: true, data: newDef });
    } catch (e) {
        if (e.code === 11000) {
            const existing = await BingoDefinition.findOne({ cardId });
            return res.json({ success: true, data: existing });
        }
        res.status(500).json({ error: 'Error saving definition' });
    }
});

app.get('/api/bingo/winners', async (req, res) => {
    try {
        const winners = await BingoWinner.find().sort({ linesCompleted: -1, completedAt: 1 });
        res.json(winners);
    } catch {
        res.status(500).json({ error: 'Failed to fetch winners' });
    }
});

app.post('/api/admin/bingo/winner', auth, async (req, res) => {
    const { discordId, minecraftUsername, cardId, linesCompleted, completedAt } = req.body;
    if (!discordId || !minecraftUsername || !cardId || linesCompleted === undefined) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    try {
        const winner = await BingoWinner.create({
            discordId,
            minecraftUsername,
            cardId,
            linesCompleted,
            completedAt: completedAt ? new Date(completedAt) : new Date()
        });
        res.json({ success: true, data: winner });
    } catch (e) {
        console.error('Add Winner Error:', e);
        res.status(500).json({ error: 'Failed to add winner' });
    }
});

app.post('/api/admin/bingo/winner/delete', auth, async (req, res) => {
    try {
        await BingoWinner.findByIdAndDelete(req.body.id);
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Failed to delete' });
    }
});

// --- Archive Routes ---
app.get('/api/archive/nisathon/stats', async (req, res) => {
    try {
        const snapshot = await ArchiveSnapshot.findOne().sort({ archivedAt: -1 });
        if (!snapshot) return res.status(404).json({ error: 'No archived Nisathon data found' });
        res.json({
            archiveId: snapshot.archiveId,
            eventName: snapshot.eventName,
            archivedAt: snapshot.archivedAt,
            ...snapshot.finalStats
        });
    } catch (e) {
        console.error('Archive Nisathon Stats Error:', e);
        res.status(500).json({ error: 'Failed to fetch archived stats' });
    }
});

app.get('/api/archive/nisathon/leaderboard', async (req, res) => {
    try {
        const snapshot = await ArchiveSnapshot.findOne().sort({ archivedAt: -1 });
        res.json(snapshot ? (snapshot.topContributors || []) : []);
    } catch (e) {
        console.error('Archive Nisathon Leaderboard Error:', e);
        res.status(500).json({ error: 'Failed to fetch archived leaderboard' });
    }
});

app.get('/api/archive/nisathon/events', async (req, res) => {
    try {
        const snapshot = await ArchiveSnapshot.findOne().sort({ archivedAt: -1 });
        res.json(snapshot ? (snapshot.events || []) : []);
    } catch (e) {
        console.error('Archive Nisathon Events Error:', e);
        res.status(500).json({ error: 'Failed to fetch archived events' });
    }
});

app.post('/api/admin/archive/nisathon/create', auth, async (req, res) => {
    try {
        const { archiveId, eventName, goalsAchieved } = req.body;
        const stats = await NisathonStats.findOne({ key: 'main' });
        if (!stats) return res.status(404).json({ error: 'No Nisathon stats found' });

        const lb = await NisathonEvent.aggregate([
            { $group: { _id: '$user', total: { $sum: '$nisaballAmount' } } },
            { $sort: { total: -1 } },
            { $limit: 10 }
        ]);
        const topContributors = lb.map((x, i) => ({
            rank: i + 1,
            user: x._id,
            totalNisaballs: roundOneDecimal(x.total)
        }));

        const events = await NisathonEvent.find().sort({ createdAt: -1 }).limit(100);
        const snapshot = await ArchiveSnapshot.create({
            archiveId: archiveId || `nisathon-${Date.now()}`,
            eventName: eventName || 'Birthday Nisathon',
            archivedAt: new Date(),
            finalStats: {
                currentSubs: stats.currentSubs,
                currentBits: stats.currentBits,
                currentDonations: stats.currentDonations,
                totalNisaballs: stats.totalNisaballs
            },
            topContributors,
            events: events.map(e => ({
                _id: e._id,
                user: e.user,
                type: e.type,
                amountDisplay: e.amountDisplay,
                message: e.message,
                createdAt: e.createdAt,
                nisaballAmount: e.nisaballAmount,
                adminNote: e.adminNote
            })),
            goalsAchieved: goalsAchieved || []
        });

        res.json({ success: true, archiveId: snapshot.archiveId });
    } catch (e) {
        console.error('Create Archive Snapshot Error:', e);
        res.status(500).json({ error: 'Failed to create archive snapshot' });
    }
});

app.get('/api/archive/wheel/history', async (req, res) => {
    try {
        const history = await SpinHistory.find().sort({ timestamp: -1 }).limit(200);
        const archivedAt = history.length > 0 ? history[0].timestamp : new Date();
        res.json({
            spins: history,
            info: { eventName: 'Spin The Wheel Archive', archivedAt, totalSpins: history.length }
        });
    } catch (e) {
        console.error('Archive Wheel History Error:', e);
        res.status(500).json({ error: 'Failed to fetch archived wheel data' });
    }
});

app.get('/api/archive/tournament/seasons', async (req, res) => {
    try {
        const seasons = await TournamentSeason.find({ isArchived: true })
            .sort({ seasonId: -1 })
            .select('seasonId name format status winners archivedAt challongeUrl createdAt');

        const formatted = seasons.map(s => ({
            seasonId: s.seasonId,
            name: s.name,
            format: s.format,
            status: s.status,
            winners: s.winners || [],
            archivedAt: s.archivedAt || s.createdAt,
            challongeUrl: s.challongeUrl
        }));
        res.json(formatted);
    } catch (e) {
        console.error('Archive Tournament Seasons Error:', e);
        res.status(500).json({ error: 'Failed to fetch archived tournaments' });
    }
});

app.get('/api/archive/rankings', async (req, res) => {
    try {
        const seasonId = parseInt(req.query.seasonId, 10) || 1;
        const archivedPlayers = await ArchiveRankedPlayer.find({ archiveId: `rankings_s${seasonId}` })
            .sort({ elo: -1, wins: -1 });

        if (archivedPlayers.length > 0) {
            const players = archivedPlayers.map((p, i) => ({
                rank: i + 1,
                uuid: p.uuid,
                minecraftName: p.minecraftName,
                elo: p.elo,
                wins: p.wins,
                losses: p.losses,
                tier: p.tier,
                tierInfo: TIERS[p.tier] || TIERS.DIRT,
                winRate: p.winRate,
                winStreak: p.winStreak,
                bestWinStreak: p.bestWinStreak
            }));

            return res.json({
                players,
                archiveInfo: {
                    seasonName: archivedPlayers[0].seasonName,
                    archivedAt: archivedPlayers[0].archivedAt,
                    totalMatches: players.reduce((sum, p) => sum + p.wins + p.losses, 0)
                }
            });
        }

        const players = await RankedPlayer.find({})
            .sort({ elo: -1, wins: -1 })
            .select('uuid minecraftName elo wins losses tier winStreak bestWinStreak');

        const formattedPlayers = players.map((p, i) => ({
            rank: i + 1,
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

        res.json({
            players: formattedPlayers,
            archiveInfo: {
                seasonName: 'Current Season',
                archivedAt: new Date().toISOString(),
                totalMatches: formattedPlayers.reduce((sum, p) => sum + p.wins + p.losses, 0)
            }
        });
    } catch (e) {
        console.error('Archive Rankings Error:', e);
        res.status(500).json({ error: 'Failed to fetch archived rankings' });
    }
});

app.post('/api/admin/archive/rankings/create', auth, async (req, res) => {
    try {
        const { seasonId, seasonName } = req.body;
        const targetSeasonId = seasonId || 1;
        const players = await RankedPlayer.find({}).sort({ elo: -1, wins: -1 });
        if (players.length === 0) return res.status(404).json({ error: 'No ranked players found' });

        const archiveEntries = players.map(p => ({
            archiveId: `rankings_s${targetSeasonId}`,
            seasonName: seasonName || 'Season 1',
            archivedAt: new Date(),
            uuid: p.uuid,
            minecraftName: p.minecraftName,
            elo: p.elo,
            wins: p.wins,
            losses: p.losses,
            tier: p.tier,
            winRate: p.wins + p.losses > 0 ? Math.round((p.wins / (p.wins + p.losses)) * 100) : 0,
            winStreak: p.winStreak,
            bestWinStreak: p.bestWinStreak
        }));

        await ArchiveRankedPlayer.deleteMany({ archiveId: `rankings_s${targetSeasonId}` });
        await ArchiveRankedPlayer.insertMany(archiveEntries);
        res.json({ success: true, count: archiveEntries.length });
    } catch (e) {
        console.error('Create Archive Rankings Error:', e);
        res.status(500).json({ error: 'Failed to create archive rankings' });
    }
});

// --- Pokemon & Image Utility Routes ---
app.get('/api/utils/check-image', async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== 'string' || !isSafeHttpUrl(url)) {
        return res.json({ valid: false });
    }
    try {
        const response = await axios.head(url, { timeout: 5000 });
        res.json({ valid: response.status === 200 });
    } catch {
        res.json({ valid: false });
    }
});

app.get('/api/pokemon', async (req, res) => {
    if (POKEMON_CACHE.length === 0) await fetchPokemonData();
    res.json(POKEMON_CACHE);
});

// --- Tournament Routes ---
app.post('/api/admin/tournament/config', auth, async (req, res) => {
    const { status, lockEnabled } = req.body;
    try {
        const newStatus = status || (lockEnabled ? 'LOCK_IN' : 'DRAFTING');
        await Setting.findOneAndUpdate(
            { key: 'tournament_config' },
            { value: { status: newStatus, lockEnabled: newStatus === 'LOCK_IN' } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Update failed' });
    }
});

app.get('/api/tournament/my-team', async (req, res) => {
    const { discordId, seasonId } = req.query;
    if (!discordId) return res.status(400).json({ error: 'Missing Discord ID' });
    try {
        const entry = await TournamentEntry.findOne({ discordId, seasonId: parseInt(seasonId, 10) || 1 });
        if (!entry) return res.json({ registered: false, team: new Array(6).fill(null), isLocked: false });
        res.json({ ...entry.toObject(), registered: true });
    } catch {
        res.status(500).json({ error: 'Fetch failed' });
    }
});

app.post('/api/tournament/register', async (req, res) => {
    const { discordId, minecraftUsername, team, seasonId, gimmickType, gimmickPokemonId } = req.body;
    if (!discordId || !minecraftUsername || !team) return res.status(400).json({ error: 'Missing Data' });

    try {
        const targetSeasonId = parseInt(seasonId, 10) || 1;
        let status = 'DRAFTING';
        const season = await TournamentSeason.findOne({ seasonId: targetSeasonId });

        if (season) {
            status = season.status || 'DRAFTING';
        } else {
            const config = await Setting.findOne({ key: 'tournament_config' });
            if (config && config.value) status = config.value.status;
        }

        if (status === 'ONGOING' || status === 'ENDED') {
            return res.status(403).json({ error: 'Tournament is ongoing/ended. Registration closed.' });
        }

        const isAdmin = req.headers['x-admin-override'] === ADMIN_OVERRIDE_TOKEN;
        const existing = await TournamentEntry.findOne({ discordId, seasonId: targetSeasonId });
        if (!isAdmin && existing && existing.isLocked) {
            return res.status(403).json({ error: 'Team is locked and cannot be edited.' });
        }

        await TournamentEntry.findOneAndUpdate(
            { discordId, seasonId: targetSeasonId },
            {
                minecraftUsername,
                team,
                gimmickType: gimmickType || null,
                gimmickPokemonId: gimmickPokemonId || null,
                updatedAt: new Date()
            },
            { upsert: true, new: true }
        );
        res.json({ success: true });
    } catch (e) {
        console.error('Register Error:', e);
        if (e.code === 11000) {
            return res.status(400).json({ error: 'You are already registered for this season. Please refresh.' });
        }
        res.status(500).json({ error: 'Save failed: ' + e.message });
    }
});

app.post('/api/tournament/lock', async (req, res) => {
    const { discordId, seasonId } = req.body;
    if (!discordId) return res.status(400).json({ error: 'Missing ID' });

    const targetSeasonId = parseInt(seasonId, 10) || 1;
    let currentStatus = 'DRAFTING';

    try {
        const season = await TournamentSeason.findOne({ seasonId: targetSeasonId });
        if (season) {
            currentStatus = season.status || 'DRAFTING';
        } else {
            const config = await Setting.findOne({ key: 'tournament_config' });
            currentStatus = config?.value?.status || (config?.value?.lockEnabled ? 'LOCK_IN' : 'DRAFTING');
        }

        if (currentStatus !== 'LOCK_IN') {
            return res.status(403).json({ error: 'Lock-ins are currently unavailable.' });
        }

        const entry = await TournamentEntry.findOne({ discordId, seasonId: targetSeasonId });
        if (!entry) return res.status(404).json({ error: 'No team found to lock.' });

        const validPokemon = entry.team.filter(p => p !== null).length;
        if (validPokemon === 0) return res.status(400).json({ error: 'Cannot lock an empty team.' });

        entry.isLocked = true;
        await entry.save();
        res.json({ success: true });
    } catch (e) {
        console.error('Lock Error:', e);
        res.status(500).json({ error: 'Lock failed' });
    }
});

app.post('/api/tournament/duo/save-team', async (req, res) => {
    const { discordId, duoId, team, teamName } = req.body;
    if (!discordId || !duoId || !team) return res.status(400).json({ error: 'Missing data' });

    try {
        const duo = await TournamentDuo.findOne({ duoId });
        if (!duo) return res.status(404).json({ error: 'Duo not found' });

        const isAdmin = req.headers['x-admin-override'] === ADMIN_OVERRIDE_TOKEN;
        if (!isAdmin && duo.player1DiscordId !== discordId && duo.player2DiscordId !== discordId) {
            return res.status(403).json({ error: 'You are not part of this duo.' });
        }
        if (!isAdmin && duo.isLocked) {
            return res.status(403).json({ error: 'Team is locked and cannot be edited.' });
        }

        let mergedTeam = [...(duo.team || [])];
        while (mergedTeam.length < 6) mergedTeam.push(null);

        if (isAdmin) {
            mergedTeam = team;
        } else {
            if (duo.player1DiscordId === discordId) {
                mergedTeam[0] = team[0] || null;
                mergedTeam[1] = team[1] || null;
                mergedTeam[2] = team[2] || null;
            }
            if (duo.player2DiscordId === discordId) {
                mergedTeam[3] = team[3] || null;
                mergedTeam[4] = team[4] || null;
                mergedTeam[5] = team[5] || null;
            }
        }

        duo.team = mergedTeam;
        if (teamName !== undefined) duo.teamName = teamName;
        await duo.save();
        res.json({ success: true });
    } catch (e) {
        console.error('Duo Save Team Error:', e);
        res.status(500).json({ error: 'Failed to save team' });
    }
});

app.post('/api/admin/tournament/duo/unlock', auth, async (req, res) => {
    const { duoId } = req.body;
    if (!duoId) return res.status(400).json({ error: 'Missing duoId' });
    try {
        const duo = await TournamentDuo.findOne({ duoId });
        if (!duo) return res.status(404).json({ error: 'Duo not found' });
        duo.isLocked = false;
        await duo.save();
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Failed to unlock duo' });
    }
});

app.post('/api/admin/tournament/duo/revoke', auth, async (req, res) => {
    const { duoId } = req.body;
    if (!duoId) return res.status(400).json({ error: 'Missing duoId' });
    try {
        await TournamentDuo.deleteOne({ duoId });
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Failed to revoke duo' });
    }
});

app.get('/api/tournament/my-duo', async (req, res) => {
    const { discordId, seasonId } = req.query;
    if (!discordId) return res.status(400).json({ error: 'Missing discordId' });
    try {
        const duo = await TournamentDuo.findOne({
            seasonId: parseInt(seasonId, 10) || 1,
            $or: [{ player1DiscordId: discordId }, { player2DiscordId: discordId }]
        });
        res.json(duo || null);
    } catch {
        res.status(500).json({ error: 'Failed to fetch duo' });
    }
});

app.get('/api/tournament/players', async (req, res) => {
    const { dev, seasonId } = req.query;
    const filter = dev === 'true' ? {} : { isDev: { $ne: true } };
    filter.seasonId = seasonId ? parseInt(seasonId, 10) : 1;

    try {
        const players = await TournamentEntry.find(filter).sort({ updatedAt: -1 });
        const sanitized = players.map(p => {
            if (p.isLocked) return p;
            return {
                _id: p._id,
                discordId: p.discordId,
                minecraftUsername: p.minecraftUsername,
                seasonId: p.seasonId,
                team: new Array(6).fill(null),
                isLocked: false,
                isDev: p.isDev,
                updatedAt: p.updatedAt
            };
        });
        res.json(sanitized);
    } catch {
        res.status(500).json({ error: 'Fetch failed' });
    }
});

app.get('/api/admin/tournament/all-players', auth, async (req, res) => {
    try {
        const players = await TournamentEntry.find().sort({ updatedAt: -1 });
        res.json(players);
    } catch {
        res.status(500).json({ error: 'Fetch failed' });
    }
});

app.post('/api/admin/tournament/unlock-team', auth, async (req, res) => {
    const { discordId } = req.body;
    if (!discordId) return res.status(400).json({ error: 'Missing Discord ID' });
    try {
        const result = await TournamentEntry.findOneAndUpdate(
            { discordId },
            { isLocked: false, team: new Array(6).fill(null), updatedAt: new Date() },
            { new: true }
        );
        if (!result) return res.status(404).json({ error: 'Player not found.' });
        res.json({ success: true, message: 'Team unlocked and reset successfully!' });
    } catch {
        res.status(500).json({ error: 'Action failed.' });
    }
});

app.post('/api/admin/tournament/revoke-registration', auth, async (req, res) => {
    const { discordId } = req.body;
    if (!discordId) return res.status(400).json({ error: 'Missing Discord ID' });
    try {
        const result = await TournamentEntry.findOneAndDelete({ discordId });
        if (!result) return res.status(404).json({ error: 'Player not found.' });
        res.json({ success: true, message: 'Registration revoked successfully!' });
    } catch {
        res.status(500).json({ error: 'Action failed.' });
    }
});

// Dev Bracket Endpoints (key='main')
app.get('/api/dev/tournament/bracket', async (req, res) => {
    try {
        const bracket = await TournamentBracket.findOne({ key: 'main' });
        res.json(bracket || { type: 'SINGLE_ELIMINATION', matches: [] });
    } catch {
        res.status(500).json({ error: 'Fetch failed' });
    }
});

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
        res.status(500).json({ error: 'Generation failed' });
    }
});

app.post('/api/dev/tournament/match/update', auth, async (req, res) => {
    try {
        const result = await advanceBracketMatch('main', req.body);
        res.status(result.status).json(result.body);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Update failed' });
    }
});

app.post('/api/dev/tournament/clear', auth, async (req, res) => {
    try {
        await TournamentBracket.deleteMany({ key: 'main' });
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Failed' });
    }
});

app.post('/api/dev/tournament/inject-players', auth, async (req, res) => {
    const { count } = req.body;
    try {
        const dummies = [];
        for (let i = 0; i < count; i++) {
            dummies.push({
                discordId: `dummy-${Date.now()}-${i}`,
                minecraftUsername: `Player_${Math.floor(Math.random() * 1000)}`,
                team: new Array(6).fill(null),
                isLocked: true,
                isDev: true,
                updatedAt: new Date()
            });
        }
        await TournamentEntry.insertMany(dummies);
        res.json({ success: true, count: dummies.length });
    } catch {
        res.status(500).json({ error: 'Failed' });
    }
});

// Production Bracket Endpoints (key='production')
app.get('/api/tournament/bracket', async (req, res) => {
    try {
        const seasonId = parseInt(req.query.seasonId, 10) || 1;
        const bracket = await TournamentBracket.findOne({ key: 'production', seasonId });
        res.json(bracket || { type: 'SINGLE_ELIMINATION', matches: [], seasonId });
    } catch {
        res.status(500).json({ error: 'Fetch failed' });
    }
});

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
        res.status(500).json({ error: 'Generation failed' });
    }
});

app.post('/api/admin/tournament/match/update', auth, async (req, res) => {
    try {
        const result = await advanceBracketMatch('production', req.body);
        res.status(result.status).json(result.body);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Update failed' });
    }
});

app.post('/api/admin/tournament/clear', auth, async (req, res) => {
    try {
        await TournamentBracket.deleteMany({ key: 'production' });
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Failed' });
    }
});

// Tournament Maintenance & Season Endpoints
app.post('/api/admin/maintenance/init-tournament', auth, async (req, res) => {
    try {
        await initDefaultSeason();
        res.json({ success: true, message: 'Tournament system successfully initialized (Default Season 1).' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to initialize tournament', details: e.message });
    }
});

app.post('/api/admin/maintenance/full-tournament-reset', auth, async (req, res) => {
    try {
        await TournamentEntry.deleteMany({});
        await TournamentBracket.deleteMany({});
        await DuoPartyData.deleteMany({});
        await TournamentDuo.deleteMany({});
        await TournamentSeason.deleteMany({});

        await TournamentSeason.create({
            seasonId: 1,
            name: 'Season 1',
            format: 'Singles 4v4',
            status: 'DRAFTING',
            isArchived: false,
            challongeUrl: ''
        });
        res.json({ success: true, message: 'Tournament data successfully wiped and reset to active Season 1.' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to reset tournament data', details: e.message });
    }
});

app.post('/api/admin/maintenance/wipe-minecraft-data', auth, async (req, res) => {
    const { scope } = req.body;
    try {
        const results = {};

        if (!scope || scope === 'all' || scope === 'bingo') {
            const [cardRes, defRes, winRes] = await Promise.all([
                BingoCard.deleteMany({}),
                BingoDefinition.deleteMany({}),
                BingoWinner.deleteMany({})
            ]);
            results.bingo = {
                success: true,
                cardsDeleted: cardRes.deletedCount,
                definitionsDeleted: defRes.deletedCount,
                winnersDeleted: winRes.deletedCount
            };
        }

        if (scope === 'nisaballs') {
            results.nisaballs = { success: true, message: 'Nisathon contribution events protected from wipe.' };
        }

        if (!scope || scope === 'all' || scope === 'tournament') {
            const activeSeasons = await TournamentSeason.find({ isArchived: { $ne: true } });
            const activeSeasonIds = activeSeasons.map(s => s.seasonId);

            const activeDuos = await TournamentDuo.find({ seasonId: { $in: activeSeasonIds } });
            const activeDuoIds = activeDuos.map(d => d.duoId);

            const [entryRes, bracketRes, partyRes, duoRes, seasonRes] = await Promise.all([
                TournamentEntry.deleteMany({ seasonId: { $in: activeSeasonIds } }),
                TournamentBracket.deleteMany({ seasonId: { $in: activeSeasonIds } }),
                DuoPartyData.deleteMany({ duoId: { $in: activeDuoIds } }),
                TournamentDuo.deleteMany({ seasonId: { $in: activeSeasonIds } }),
                TournamentSeason.deleteMany({ isArchived: { $ne: true } })
            ]);

            results.tournament = {
                success: true,
                activeSeasonIdsCleared: activeSeasonIds,
                entriesDeleted: entryRes.deletedCount,
                bracketsDeleted: bracketRes.deletedCount,
                duosDeleted: duoRes.deletedCount,
                partiesDeleted: partyRes.deletedCount,
                seasonsDeleted: seasonRes.deletedCount
            };
        }

        res.json({ success: true, results });
    } catch (e) {
        console.error('❌ Failed to wipe Minecraft/Bingo/Tournament data on Main Server:', e);
        res.status(500).json({ error: 'Failed to wipe data', details: e.message });
    }
});

app.get('/api/tournament/seasons', async (req, res) => {
    try {
        const seasons = await TournamentSeason.find().sort({ seasonId: -1 });
        res.json(seasons);
    } catch {
        res.status(500).json({ error: 'Fetch failed' });
    }
});

app.get('/api/tournament/active-season', async (req, res) => {
    try {
        let season = await TournamentSeason.findOne({ isArchived: false, isHidden: { $ne: true } }).sort({ seasonId: -1 });
        if (!season) season = await TournamentSeason.findOne({ isHidden: { $ne: true } }).sort({ seasonId: -1 });
        res.json(season || { seasonId: 1, name: 'Season 1', status: 'ENDED', format: 'Singles 4v4' });
    } catch {
        res.status(500).json({ error: 'Fetch failed' });
    }
});

app.get('/api/tournament/season/:id', async (req, res) => {
    try {
        const season = await TournamentSeason.findOne({ seasonId: parseInt(req.params.id, 10) });
        if (!season) return res.status(404).json({ error: 'Season not found' });
        res.json(season);
    } catch {
        res.status(500).json({ error: 'Fetch failed' });
    }
});

app.get('/api/tournament/config', async (req, res) => {
    try {
        const seasonId = parseInt(req.query.seasonId, 10) || null;
        let season;
        if (seasonId) {
            season = await TournamentSeason.findOne({ seasonId });
        } else {
            season = await TournamentSeason.findOne({ isArchived: false, isHidden: { $ne: true } }).sort({ seasonId: -1 });
            if (!season) season = await TournamentSeason.findOne({ isHidden: { $ne: true } }).sort({ seasonId: -1 });
        }
        if (!season) return res.json({ status: 'No Tournament', seasonId: 1 });
        res.json({
            status: season.status,
            seasonId: season.seasonId,
            name: season.name,
            format: season.format,
            challongeUrl: season.challongeUrl
        });
    } catch {
        res.status(500).json({ error: 'Fetch failed' });
    }
});

app.post('/api/admin/tournament/season/create', auth, async (req, res) => {
    const { name, format, challongeUrl, description, bannedPokemonIds, rules, isHidden } = req.body;
    try {
        const lastSeason = await TournamentSeason.findOne().sort({ seasonId: -1 });
        const newId = lastSeason ? lastSeason.seasonId + 1 : 1;

        const season = await TournamentSeason.create({
            seasonId: newId,
            name: name || `Season ${newId}`,
            format: format || 'Singles 4v4',
            status: 'DRAFTING',
            challongeUrl: challongeUrl || '',
            description: description !== undefined ? description : (lastSeason?.description || ''),
            bannedPokemonIds: bannedPokemonIds !== undefined ? bannedPokemonIds : (lastSeason?.bannedPokemonIds || []),
            rules: rules !== undefined ? rules : (lastSeason?.rules || []),
            isHidden: isHidden || false
        });
        res.json({ success: true, season });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to create season' });
    }
});

app.post('/api/admin/tournament/season/:id/update', auth, async (req, res) => {
    const { name, format, challongeUrl, status, description, bannedPokemonIds, rules, isHidden } = req.body;
    try {
        const update = {};
        if (name) update.name = name;
        if (format) update.format = format;
        if (challongeUrl !== undefined) update.challongeUrl = challongeUrl;
        if (status) update.status = status;
        if (description !== undefined) update.description = description;
        if (bannedPokemonIds !== undefined) update.bannedPokemonIds = bannedPokemonIds;
        if (rules !== undefined) update.rules = rules;
        if (isHidden !== undefined) update.isHidden = isHidden;

        const season = await TournamentSeason.findOneAndUpdate(
            { seasonId: parseInt(req.params.id, 10) },
            update,
            { new: true }
        );
        if (!season) return res.status(404).json({ error: 'Season not found' });
        res.json({ success: true, season });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Update failed' });
    }
});

app.post('/api/admin/fix-legacy-players', auth, async (req, res) => {
    try {
        const result = await TournamentEntry.updateMany({ seasonId: { $exists: false } }, { $set: { seasonId: 1 } });
        res.json({ success: true, modified: result.modifiedCount });
    } catch {
        res.status(500).json({ error: 'Migration failed' });
    }
});

app.post('/api/admin/tournament/season/:id/archive', auth, async (req, res) => {
    try {
        const season = await TournamentSeason.findOneAndUpdate(
            { seasonId: parseInt(req.params.id, 10) },
            { isArchived: true, status: 'ENDED', archivedAt: new Date() },
            { new: true }
        );
        if (!season) return res.status(404).json({ error: 'Season not found' });
        res.json({ success: true, season });
    } catch {
        res.status(500).json({ error: 'Archive failed' });
    }
});

app.get('/api/tournament/winners', async (req, res) => {
    try {
        const seasonId = parseInt(req.query.seasonId, 10);
        if (!seasonId) return res.status(400).json({ error: 'seasonId is required' });
        const season = await TournamentSeason.findOne({ seasonId });
        if (!season) return res.status(404).json({ error: 'Season not found' });
        res.json(season.winners || []);
    } catch {
        res.status(500).json({ error: 'Failed to fetch winners' });
    }
});

app.post('/api/admin/tournament/clear-winners', auth, async (req, res) => {
    try {
        const { seasonId } = req.body;
        if (!seasonId) return res.status(400).json({ error: 'seasonId is required' });
        const season = await TournamentSeason.findOneAndUpdate(
            { seasonId: parseInt(seasonId, 10) },
            { winners: [] },
            { new: true }
        );
        if (!season) return res.status(404).json({ error: 'Season not found' });
        res.json({ success: true, message: `Winners cleared for season ${seasonId}` });
    } catch {
        res.status(500).json({ error: 'Failed to clear winners' });
    }
});

// Duos Endpoints
app.get('/api/tournament/duos', async (req, res) => {
    try {
        const seasonId = parseInt(req.query.seasonId, 10) || 2;
        const duos = await TournamentDuo.find({ seasonId }).sort({ createdAt: -1 });
        res.json(duos);
    } catch {
        res.status(500).json({ error: 'Failed to fetch duos' });
    }
});

app.get('/api/tournament/duo/by-player', async (req, res) => {
    try {
        const { discordId, seasonId } = req.query;
        const duo = await TournamentDuo.findOne({
            seasonId: parseInt(seasonId, 10) || 2,
            $or: [{ player1DiscordId: discordId }, { player2DiscordId: discordId }]
        });
        res.json(duo || null);
    } catch {
        res.status(500).json({ error: 'Failed to fetch duo' });
    }
});

app.post('/api/admin/tournament/duo/create', auth, async (req, res) => {
    try {
        const seasonId = parseInt(req.body.seasonId, 10) || 2;
        const p1Id = req.body.player1DiscordId || req.body.player1?.discordId;
        const p1Name = req.body.player1Username || req.body.player1?.username || req.body.player1?.minecraftUsername;
        const p2Id = req.body.player2DiscordId || req.body.player2?.discordId;
        const p2Name = req.body.player2Username || req.body.player2?.username || req.body.player2?.minecraftUsername;

        if (!p1Id || !p2Id) {
            return res.status(400).json({ error: 'Missing player information for duo creation' });
        }

        let capId = req.body.captainDiscordId;
        if (!capId) capId = req.body.captain === 'player2' ? p2Id : p1Id;

        const existingDuo = await TournamentDuo.findOne({
            seasonId,
            $or: [
                { player1DiscordId: p1Id },
                { player2DiscordId: p1Id },
                { player1DiscordId: p2Id },
                { player2DiscordId: p2Id }
            ]
        });
        if (existingDuo) return res.status(400).json({ error: 'One or both players are already in a duo' });

        const duo = await TournamentDuo.create({
            duoId: `duo_${seasonId}_${Date.now()}`,
            seasonId,
            player1DiscordId: p1Id,
            player1Username: p1Name,
            player2DiscordId: p2Id,
            player2Username: p2Name,
            captainDiscordId: capId,
            team: [],
            isLocked: false
        });
        res.json({ success: true, duo });
    } catch (e) {
        console.error('Duo Create Error:', e);
        res.status(500).json({ error: 'Failed to create duo: ' + e.message });
    }
});

app.post('/api/admin/tournament/duo/delete', auth, async (req, res) => {
    try {
        await TournamentDuo.deleteOne({ duoId: req.body.duoId });
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Failed to delete duo' });
    }
});

app.post('/api/admin/tournament/duo/update-captain', auth, async (req, res) => {
    const duoId = req.body.duoId;
    const captainDiscordId = req.body.captainDiscordId || req.body.newCaptainDiscordId;
    try {
        const duo = await TournamentDuo.findOneAndUpdate({ duoId }, { captainDiscordId }, { new: true });
        if (!duo) return res.status(404).json({ error: 'Duo not found' });
        res.json({ success: true, duo });
    } catch {
        res.status(500).json({ error: 'Failed to update captain' });
    }
});

app.post('/api/tournament/duo/update-team', async (req, res) => {
    const { duoId, discordId, team } = req.body;
    try {
        const duo = await TournamentDuo.findOne({ duoId });
        if (!duo) return res.status(404).json({ error: 'Duo not found' });
        if (duo.captainDiscordId !== discordId) return res.status(403).json({ error: 'Only the captain can update the team' });
        if (duo.isLocked) return res.status(400).json({ error: 'Team is already locked' });

        duo.team = team;
        await duo.save();
        res.json({ success: true, duo });
    } catch {
        res.status(500).json({ error: 'Failed to update team' });
    }
});

app.post('/api/tournament/duo/lock', async (req, res) => {
    const { duoId, discordId } = req.body;
    try {
        const duo = await TournamentDuo.findOne({ duoId });
        if (!duo) return res.status(404).json({ error: 'Duo not found' });
        if (duo.player1DiscordId !== discordId && duo.player2DiscordId !== discordId) {
            return res.status(403).json({ error: 'You are not part of this duo' });
        }
        if (duo.team.length < 6) {
            return res.status(400).json({ error: 'Team must have 6 Pokemon before locking' });
        }
        duo.isLocked = true;
        await duo.save();
        res.json({ success: true, duo });
    } catch {
        res.status(500).json({ error: 'Failed to lock team' });
    }
});

app.post('/api/admin/tournament/end', auth, async (req, res) => {
    const { winners, seasonId } = req.body;
    try {
        const targetSeasonId = seasonId || (await TournamentSeason.findOne({ isArchived: false }).sort({ seasonId: -1 }))?.seasonId || 1;
        await TournamentSeason.findOneAndUpdate(
            { seasonId: targetSeasonId },
            { status: 'ENDED', winners: winners || [] },
            { upsert: true }
        );
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Failed to end tournament' });
    }
});

app.post('/api/admin/tournament/status', auth, async (req, res) => {
    const { status, seasonId } = req.body;
    try {
        const targetSeasonId = seasonId || (await TournamentSeason.findOne({ isArchived: false }).sort({ seasonId: -1 }))?.seasonId || 1;
        await TournamentSeason.findOneAndUpdate({ seasonId: targetSeasonId }, { status }, { upsert: true });
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Failed update status' });
    }
});

app.post('/api/admin/tournament/publish', auth, async (req, res) => {
    const { seasonId } = req.body;
    try {
        const targetSeasonId = seasonId || (await TournamentSeason.findOne({ isArchived: false }).sort({ seasonId: -1 }))?.seasonId || 1;
        const devBracket = await TournamentBracket.findOne({ key: 'main', seasonId: targetSeasonId });
        if (!devBracket) return res.status(404).json({ error: 'Dev bracket empty for this season' });

        await TournamentBracket.findOneAndUpdate(
            { key: 'production', seasonId: targetSeasonId },
            {
                key: 'production',
                seasonId: targetSeasonId,
                type: devBracket.type,
                matches: devBracket.matches,
                updatedAt: new Date()
            },
            { upsert: true, new: true }
        );
        res.json({ success: true, message: 'Bracket Published to Public' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Publish failed' });
    }
});

// Duo Party Data Routes
app.get('/api/tournament/duo-parties', async (req, res) => {
    try {
        const parties = await DuoPartyData.find({}).sort({ lastUpdated: -1 });
        res.json(parties);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/tournament/parse-duo-logs', auth, async (req, res) => {
    try {
        const { logText, duoId, player1Username, player2Username } = req.body;
        if (!logText) return res.status(400).json({ error: 'Log text is required' });

        const pokemonRegex = /(?:^|\s*-?\s*)([A-Z][a-z]+(?:[A-Z][a-z]*)*)\s*(?:\()?(?:Lv\.?|Level\s*)(\d+)/gmi;
        const allPokemon = [];
        let match;
        while ((match = pokemonRegex.exec(logText)) !== null) {
            allPokemon.push({ name: match[1], level: parseInt(match[2], 10) });
        }

        const player1Picks = allPokemon.slice(0, 3);
        const player2Picks = allPokemon.slice(3, 6);

        if (player1Picks.length === 0 && player2Picks.length === 0) {
            return res.status(400).json({
                error: 'Could not parse any Pokemon from logs. Expected format: "Pikachu (Lv.50)"',
                parsed: allPokemon
            });
        }

        if (duoId) {
            const data = await DuoPartyData.findOneAndUpdate(
                { duoId },
                {
                    duoId,
                    player1Username: player1Username || 'Player 1',
                    player2Username: player2Username || 'Player 2',
                    player1Picks,
                    player2Picks,
                    rawLogData: logText,
                    lastUpdated: new Date()
                },
                { upsert: true, new: true }
            );
            return res.json({ success: true, data, parsed: { player1Picks, player2Picks } });
        }

        let matchedDuo = null;
        if (player1Username || player2Username) {
            const orFilters = [];
            if (player1Username) orFilters.push({ player1Username: { $regex: new RegExp(escapeRegex(player1Username), 'i') } });
            if (player2Username) orFilters.push({ player2Username: { $regex: new RegExp(escapeRegex(player2Username), 'i') } });
            if (orFilters.length > 0) {
                matchedDuo = await TournamentDuo.findOne({ $or: orFilters });
            }
        }

        if (matchedDuo) {
            const data = await DuoPartyData.findOneAndUpdate(
                { duoId: matchedDuo.duoId },
                {
                    duoId: matchedDuo.duoId,
                    player1Username: matchedDuo.player1Username,
                    player2Username: matchedDuo.player2Username,
                    player1Picks,
                    player2Picks,
                    rawLogData: logText,
                    lastUpdated: new Date()
                },
                { upsert: true, new: true }
            );
            return res.json({ success: true, data, matched: matchedDuo.duoId, parsed: { player1Picks, player2Picks } });
        }

        res.json({
            success: true,
            message: 'Parsed but no duo matched - provide duoId or matching username',
            parsed: { player1Picks, player2Picks }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/tournament/duo-party/set', auth, async (req, res) => {
    try {
        const { duoId, player1Username, player2Username, player1Picks, player2Picks } = req.body;
        if (!duoId) return res.status(400).json({ error: 'duoId is required' });

        const data = await DuoPartyData.findOneAndUpdate(
            { duoId },
            {
                duoId,
                player1Username: player1Username || '',
                player2Username: player2Username || '',
                player1Picks: player1Picks || [],
                player2Picks: player2Picks || [],
                lastUpdated: new Date()
            },
            { upsert: true, new: true }
        );
        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/tournament/duo-party/clear', auth, async (req, res) => {
    try {
        const { duoId } = req.body;
        if (!duoId) return res.status(400).json({ error: 'duoId is required' });
        await DuoPartyData.deleteOne({ duoId });
        res.json({ success: true, message: 'Party data cleared' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Cobblemon Ranked Routes ---
app.post('/api/ranked/match', rankedAuth, async (req, res) => {
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

        let winner = await RankedPlayer.findOne({ uuid: winnerUuid });
        let loser = await RankedPlayer.findOne({ uuid: loserUuid });

        if (!winner) winner = await RankedPlayer.create({ uuid: winnerUuid, minecraftName: winnerName });
        if (!loser) loser = await RankedPlayer.create({ uuid: loserUuid, minecraftName: loserName });

        if (winnerName) winner.minecraftName = winnerName;
        if (loserName) loser.minecraftName = loserName;

        if (endReason === 'timeout') {
            const match = await RankedMatch.create({
                winnerUuid,
                winnerName,
                loserUuid,
                loserName,
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
            return res.status(200).json({
                success: true,
                matchId: match._id,
                draw: true,
                reason: 'timeout',
                message: 'Battle timed out - no ELO changes'
            });
        }

        const winnerDiminishing = await getDiminishingMultiplier(winnerUuid, loserUuid);
        await getDiminishingMultiplier(loserUuid, winnerUuid);
        const eloRangePenalty = getEloRangePenalty(winner.elo, loser.elo);
        const winnerUniqueBonus = await getUniqueOpponentBonus(winnerUuid, loserUuid);
        await getUniqueOpponentBonus(loserUuid, winnerUuid);

        const baseEloChanges = calculateEloChange(winner.elo, loser.elo, {
            winnerAlivePokemon: winnerAlivePokemon || 0,
            winnerTotalPokemon: winnerTotalPokemon || 1,
            loserTotalPokemon: loserTotalPokemon || 1,
            winnerKOs: winnerKOs || 0,
            battleType: battleType || '1v1',
            endReason: endReason || 'normal'
        });

        let finalWinnerChange = baseEloChanges.winnerChange;
        finalWinnerChange *= winnerDiminishing.multiplier;
        finalWinnerChange *= eloRangePenalty.multiplier;
        finalWinnerChange *= winnerUniqueBonus.bonusMultiplier;
        finalWinnerChange = Math.round(finalWinnerChange);

        const finalLoserChange = Math.round(baseEloChanges.loserChange);
        const winnerEloBefore = winner.elo;
        const loserEloBefore = loser.elo;

        const format = (battleType || '1v1').toLowerCase();
        const is1v1 = format === '1v1';

        winner.elo = Math.max(0, winner.elo + finalWinnerChange);
        winner.wins += 1;
        winner.winStreak += 1;
        winner.bestWinStreak = Math.max(winner.bestWinStreak, winner.winStreak);
        winner.totalKOs += (winnerKOs || 0);
        winner.totalDeaths += (winnerTotalPokemon - winnerAlivePokemon) || 0;
        winner.tier = calculateTier(winner.elo, winner.wins);
        winner.lastMatchAt = new Date();
        winner.updatedAt = new Date();

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

        loser.elo = Math.max(0, loser.elo + finalLoserChange);
        loser.losses += 1;
        loser.winStreak = 0;
        loser.totalKOs += (loserKOs || 0);
        loser.totalDeaths += (loserTotalPokemon - loserAlivePokemon) || 0;
        loser.tier = calculateTier(loser.elo, loser.wins);
        loser.lastMatchAt = new Date();
        loser.updatedAt = new Date();

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
        await updateOpponentHistory(winnerUuid, loserUuid);
        await updateOpponentHistory(loserUuid, winnerUuid);

        const match = await RankedMatch.create({
            winnerUuid,
            winnerName,
            loserUuid,
            loserName,
            winnerAlivePokemon,
            winnerTotalPokemon,
            loserAlivePokemon,
            loserTotalPokemon,
            winnerKOs,
            loserKOs,
            battleType,
            endReason,
            winnerEloChange: finalWinnerChange,
            loserEloChange: finalLoserChange,
            winnerEloBefore,
            loserEloBefore,
            diminishingMultiplier: winnerDiminishing.multiplier,
            uniqueOpponentBonus: winnerUniqueBonus.bonusApplied,
            eloRangeReduced: eloRangePenalty.reduced,
            winnerPokemon: winnerPokemon || [],
            loserPokemon: loserPokemon || []
        });

        let forfeitBan = null;
        if (endReason === 'forfeit') {
            await ForfeitHistory.create({ playerUuid: loserUuid, matchId: match._id.toString(), opponent: winnerUuid });
            forfeitBan = await checkForfeitAbuse(loserUuid, loserName);
            const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
            await ForfeitHistory.deleteMany({ forfeitedAt: { $lt: twelveHoursAgo } });
        }

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
            antiAbuse: {
                diminishingMultiplier: winnerDiminishing.multiplier,
                sameOpponentCount: winnerDiminishing.matchCount + 1,
                eloRangeReduced: eloRangePenalty.reduced,
                uniqueOpponentBonus: winnerUniqueBonus.bonusApplied,
                uniqueOpponentsToday: winnerUniqueBonus.uniqueCount,
                forfeitBan
            }
        });
    } catch (e) {
        console.error('Ranked match error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/ranked/ban/:uuid', async (req, res) => {
    try {
        res.json(await isPlayerBanned(req.params.uuid));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ranked/ban', rankedAuth, async (req, res) => {
    try {
        const { playerUuid, playerName, reason, duration, bannedBy, isPermanent } = req.body;
        const existing = await RankedBan.findOne({ playerUuid });
        if (existing) return res.json({ success: false, message: 'Player is already banned' });

        let expiresAt = null;
        if (!isPermanent && duration) {
            expiresAt = new Date(Date.now() + duration * 60 * 60 * 1000);
        }

        await RankedBan.create({
            playerUuid,
            playerName: playerName || 'Unknown',
            reason: reason || 'Manual ban',
            bannedBy: bannedBy || 'OP',
            expiresAt,
            isPermanent: isPermanent || false
        });

        res.json({ success: true, expiresAt, isPermanent: isPermanent || false });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/ranked/ban/:uuid', rankedAuth, async (req, res) => {
    try {
        const ban = await RankedBan.findOneAndDelete({ playerUuid: req.params.uuid });
        if (!ban) return res.json({ success: false, message: 'Player is not banned' });
        res.json({ success: true, playerName: ban.playerName });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/ranked/bans', rankedAuth, async (req, res) => {
    try {
        await RankedBan.deleteMany({ expiresAt: { $ne: null, $lt: new Date() } });
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

app.get('/api/ranked/leaderboard', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 1000);
        const offset = parseInt(req.query.offset, 10) || 0;

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

app.get('/api/ranked/player/:uuid', async (req, res) => {
    try {
        const player = await RankedPlayer.findOne({ uuid: req.params.uuid });
        if (!player) {
            return res.json({ uuid: req.params.uuid, elo: 0, wins: 0, losses: 0, tier: 'DIRT', tierInfo: TIERS.DIRT });
        }

        const rank = await RankedPlayer.countDocuments({
            $or: [{ elo: { $gt: player.elo } }, { elo: player.elo, wins: { $gt: player.wins } }],
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
            winRate: player.wins + player.losses > 0 ? Math.round((player.wins / (player.wins + player.losses)) * 100) : 0,
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

app.get('/api/ranked/player/:uuid/history', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
        const page = parseInt(req.query.page, 10) || 1;
        const skip = (page - 1) * limit;

        const filter = { $or: [{ winnerUuid: req.params.uuid }, { loserUuid: req.params.uuid }] };
        const [matches, total] = await Promise.all([
            RankedMatch.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
            RankedMatch.countDocuments(filter)
        ]);

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
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/ranked/match/:id', async (req, res) => {
    try {
        const match = await RankedMatch.findById(req.params.id);
        if (!match) return res.status(404).json({ error: 'Match not found' });

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

app.get('/api/ranked/player/:uuid/rank', async (req, res) => {
    try {
        const player = await RankedPlayer.findOne({ uuid: req.params.uuid });
        if (!player) return res.json({ tier: 'DIRT', tierInfo: TIERS.DIRT, elo: 0 });
        res.json({ tier: player.tier, tierInfo: TIERS[player.tier] || TIERS.DIRT, elo: player.elo });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ranked/reset', auth, async (req, res) => {
    try {
        await RankedPlayer.deleteMany({});
        await RankedMatch.deleteMany({});
        res.json({ success: true, message: 'All ranked data cleared' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ranked/admin/modify-elo', rankedAuth, async (req, res) => {
    try {
        const { playerUuid, playerName, eloChange, modifiedBy } = req.body;
        let player = await RankedPlayer.findOne({ uuid: playerUuid });
        if (!player) player = await RankedPlayer.create({ uuid: playerUuid, minecraftName: playerName });

        const oldElo = player.elo;
        player.elo = Math.max(0, player.elo + eloChange);
        player.tier = calculateTier(player.elo, player.wins);
        player.updatedAt = new Date();
        await player.save();

        console.log(`⚙️ Admin ELO Modify: ${playerName} ${eloChange >= 0 ? '+' : ''}${eloChange} (${oldElo} → ${player.elo}) by ${modifiedBy}`);
        res.json({ success: true, oldElo, newElo: player.elo, tier: player.tier });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ranked/admin/set-elo', rankedAuth, async (req, res) => {
    try {
        const { playerUuid, playerName, newElo, modifiedBy } = req.body;
        let player = await RankedPlayer.findOne({ uuid: playerUuid });
        if (!player) player = await RankedPlayer.create({ uuid: playerUuid, minecraftName: playerName });

        const oldElo = player.elo;
        player.elo = Math.max(0, newElo);
        player.tier = calculateTier(player.elo, player.wins);
        player.updatedAt = new Date();
        await player.save();

        console.log(`⚙️ Admin ELO Set: ${playerName} ${oldElo} → ${player.elo} by ${modifiedBy}`);
        res.json({ success: true, oldElo, newElo: player.elo, tier: player.tier });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ranked/admin/reset-player', rankedAuth, async (req, res) => {
    try {
        const { playerUuid, playerName, resetBy } = req.body;
        const player = await RankedPlayer.findOne({ uuid: playerUuid });
        if (!player) return res.json({ success: false, message: 'Player not found' });

        const oldStats = { elo: player.elo, wins: player.wins, losses: player.losses };
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

        await OpponentHistory.deleteMany({ $or: [{ playerUuid }, { opponentUuid: playerUuid }] });
        console.log(`⚙️ Admin Reset: ${playerName} stats reset by ${resetBy}`);
        res.json({ success: true, oldStats, message: `${playerName}'s stats have been reset` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/ranked/admin/player-info/:uuid', async (req, res) => {
    try {
        const { uuid } = req.params;
        const player = await RankedPlayer.findOne({ uuid });
        if (!player) return res.json({ found: false });

        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const [banStatus, opponentHistoryCount, recentForfeits] = await Promise.all([
            isPlayerBanned(uuid),
            OpponentHistory.countDocuments({ $or: [{ playerUuid: uuid }, { opponentUuid: uuid }] }),
            ForfeitHistory.countDocuments({ playerUuid: uuid, forfeitedAt: { $gte: oneHourAgo } })
        ]);

        res.json({
            found: true,
            uuid: player.uuid,
            name: player.minecraftName,
            elo: player.elo,
            tier: player.tier,
            wins: player.wins,
            losses: player.losses,
            winRate: player.wins + player.losses > 0 ? Math.round((player.wins / (player.wins + player.losses)) * 100) : 0,
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

app.post('/api/ranked/admin/clear-history', rankedAuth, async (req, res) => {
    try {
        const { player1Uuid, player2Uuid, clearedBy } = req.body;
        const result = await OpponentHistory.deleteMany({
            $or: [
                { playerUuid: player1Uuid, opponentUuid: player2Uuid },
                { playerUuid: player2Uuid, opponentUuid: player1Uuid }
            ]
        });
        console.log(`⚙️ Admin Clear History: ${player1Uuid} <-> ${player2Uuid} by ${clearedBy} (${result.deletedCount} records)`);
        res.json({ success: true, deletedCount: result.deletedCount, message: `Cleared ${result.deletedCount} opponent history records` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ranked/admin/clear-all-opponent-history', rankedAuth, async (req, res) => {
    try {
        const result = await OpponentHistory.deleteMany({});
        console.log(`🗑️ ADMIN: ALL opponent history cleared by ${req.body.clearedBy || 'Unknown'} (${result.deletedCount} records)`);
        res.json({
            success: true,
            deletedCount: result.deletedCount,
            message: `Cleared ALL ${result.deletedCount} opponent history records. All diminishing returns reset.`
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// 6. STARTUP, KEEP-ALIVE & GRACEFUL SHUTDOWN
// ==========================================
let server = null;
let syncInterval = null;
let keepAliveInitialTimer = null;
let keepAliveInterval = null;

const pingDBot = async () => {
    try {
        await axios.get(`${DBOT_URL}/health`, { timeout: 10000 });
    } catch (err) {
        console.warn(`⚠️ [Keep-Alive] Ping to ${DBOT_URL}/health failed: ${err.message}`);
    }
};

const startKeepAlive = () => {
    if (!DBOT_URL || DBOT_URL.includes('localhost') || DBOT_URL.includes('127.0.0.1')) return;
    keepAliveInitialTimer = setTimeout(pingDBot, 45 * 1000);
    keepAliveInterval = setInterval(pingDBot, KEEP_ALIVE_INTERVAL_MS);
    console.log(`🔁 [Keep-Alive] Mutual ping active -> ${DBOT_URL}/health (every ${KEEP_ALIVE_INTERVAL_MS / 60000}m)`);
};

const startServer = () => {
    fetchPokemonData();

    server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Server on ${PORT}`);
        startKeepAlive();
    });

    if (!MONGO_URI) {
        console.error('❌ MONGO_URI Missing');
        return;
    }

    mongoose.set('strictQuery', false);
    mongoose.connect(MONGO_URI)
        .then(async () => {
            console.log('✅ MongoDB Connected');
            try {
                await TournamentEntry.syncIndexes();
                console.log('✅ TournamentEntry Indexes Synced');
            } catch (idxErr) {
                console.error('⚠️ Index Sync Warning:', idxErr.message);
            }

            await resolveChannelId();
            connectSocket();
            console.log('🚀 Startup Deep Sync...');
            await runSync(true);
            syncInterval = setInterval(() => runSync(false), 30000);
        })
        .catch(err => console.error('❌ DB Connection Failed:', err.message));
};

const gracefulShutdown = async (signal) => {
    console.log(`🛑 Received ${signal}. Shutting down cleanly...`);
    if (syncInterval) clearInterval(syncInterval);
    if (keepAliveInitialTimer) clearTimeout(keepAliveInitialTimer);
    if (keepAliveInterval) clearInterval(keepAliveInterval);

    Object.values(giftBuffer).forEach(entry => {
        if (entry && entry.timer) clearTimeout(entry.timer);
    });

    if (socket) {
        try {
            socket.close();
        } catch {
            // Ignore socket close errors
        }
    }

    if (server) {
        server.close(async () => {
            try {
                if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
            } catch (e) {
                console.error('Error closing MongoDB:', e.message);
            }
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

startServer();
