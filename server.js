require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Spotify Auth (Client Credentials) ───────────────────────────────────────
let spotifyToken = null;
let tokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < tokenExpiry) return spotifyToken;
  const creds = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post('https://accounts.spotify.com/api/token',
    'grant_type=client_credentials',
    { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  spotifyToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return spotifyToken;
}

// ─── Spotify search helpers ───────────────────────────────────────────────────
const THEMES = {
  'rap-fr':    'genre:"rap français" country:FR',
  'hip-hop':   'genre:"hip hop"',
  '80s':       'year:1980-1989',
  '90s':       'year:1990-1999',
  '2000s':     'year:2000-2009',
  'rock':      'genre:"rock"',
  'electro':   'genre:"electronic"',
  'rnb':       'genre:"r&b"',
  'variete-fr':'genre:"french pop"',
  'pop':       'genre:"pop"',
  'reggae':    'genre:"reggae"',
  'metal':     'genre:"metal"',
};

async function searchTracks(mode, theme, artists, offset = 0) {
  const token = await getSpotifyToken();
  let q;
  if (mode === 'random') q = 'year:2010-2024';
  else if (mode === 'theme') q = THEMES[theme] || theme;
  else if (mode === 'artist') q = artists.map(a => `artist:"${a}"`).join(' OR ');

  const res = await axios.get('https://api.spotify.com/v1/search', {
    headers: { Authorization: `Bearer ${token}` },
    params: { q, type: 'track', limit: 50, offset, market: 'FR' }
  });

  return res.data.tracks.items
    .filter(t => t.preview_url)
    .map(t => ({
      id: t.id,
      title: t.name,
      artist: t.artists.map(a => a.name).join(', '),
      album: t.album.name,
      year: t.album.release_date?.slice(0, 4),
      preview: t.preview_url,
      cover: t.album.images[1]?.url || t.album.images[0]?.url,
    }));
}

// ─── REST endpoints ───────────────────────────────────────────────────────────
app.get('/api/tracks', async (req, res) => {
  try {
    const { mode, theme, artists } = req.query;
    const artistList = artists ? JSON.parse(artists) : [];
    // Fetch 2 pages for more variety
    const [page1, page2] = await Promise.allSettled([
      searchTracks(mode, theme, artistList, 0),
      searchTracks(mode, theme, artistList, 50),
    ]);
    let tracks = [
      ...(page1.status === 'fulfilled' ? page1.value : []),
      ...(page2.status === 'fulfilled' ? page2.value : []),
    ];
    // Dedupe
    const seen = new Set();
    tracks = tracks.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });
    // Shuffle
    tracks.sort(() => Math.random() - 0.5);
    res.json({ tracks: tracks.slice(0, 100) });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/search-artist', async (req, res) => {
  try {
    const token = await getSpotifyToken();
    const r = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: { q: req.query.q, type: 'artist', limit: 5, market: 'FR' }
    });
    res.json(r.data.artists.items.map(a => ({ id: a.id, name: a.name, image: a.images[2]?.url })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Room state ───────────────────────────────────────────────────────────────
const rooms = new Map();

function generateCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildQuestion(tracks, usedIds) {
  const pool = tracks.filter(t => !usedIds.has(t.id));
  if (pool.length < 4) return null;
  const correct = pool[Math.floor(Math.random() * pool.length)];
  const wrongPool = tracks.filter(t => t.id !== correct.id && t.artist !== correct.artist);
  const wrongs = shuffle(wrongPool).slice(0, 3);
  return {
    correct,
    options: shuffle([correct, ...wrongs]).map(t => ({ id: t.id, title: t.title, artist: t.artist })),
    preview: correct.preview,
    cover: null, // revealed after answer
    realCover: correct.cover,
    year: correct.year,
    album: correct.album,
  };
}

// ─── Socket.io ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // Create room
  socket.on('create-room', ({ playerName, settings }) => {
    const code = generateCode();
    const room = {
      code,
      host: socket.id,
      players: [{ id: socket.id, name: playerName, score: 0, answered: false, correct: false }],
      settings,
      tracks: [],
      usedIds: new Set(),
      currentQ: 0,
      question: null,
      phase: 'lobby', // lobby | question | reveal | results
      answerTimeout: null,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('room-created', { code });
    emitRoomState(code);
  });

  // Join room
  socket.on('join-room', ({ code, playerName }) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) { socket.emit('error', { msg: 'Salle introuvable.' }); return; }
    if (room.phase !== 'lobby') { socket.emit('error', { msg: 'La partie a déjà commencé.' }); return; }
    if (room.players.find(p => p.name.toLowerCase() === playerName.toLowerCase())) {
      socket.emit('error', { msg: 'Ce pseudo est déjà pris.' }); return;
    }
    room.players.push({ id: socket.id, name: playerName, score: 0, answered: false, correct: false });
    socket.join(code.toUpperCase());
    socket.emit('joined-room', { code: code.toUpperCase() });
    emitRoomState(code.toUpperCase());
  });

  // Start game (host only)
  socket.on('start-game', async ({ code, tracks }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    room.tracks = tracks;
    room.phase = 'question';
    room.currentQ = 0;
    room.usedIds = new Set();
    room.players.forEach(p => { p.score = 0; p.answered = false; });
    await sendNextQuestion(code);
  });

  // Player answer
  socket.on('answer', ({ code, trackId }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'question') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.answered) return;

    player.answered = true;
    player.correct = (trackId === room.question.correct.id);
    if (player.correct) {
      // Bonus for speed: more points if answered early
      const elapsed = Date.now() - room.questionStartTime;
      const bonus = Math.max(0, Math.floor((20000 - elapsed) / 2000));
      player.score += 10 + bonus;
    }

    // Tell this player their result immediately
    socket.emit('answer-result', { correct: player.correct, correctId: room.question.correct.id });

    // Broadcast updated player list (scores hidden until reveal)
    io.to(code).emit('players-update', { players: room.players.map(p => ({ id: p.id, name: p.name, answered: p.answered, score: p.score })) });

    // If everyone answered → reveal early
    if (room.players.every(p => p.answered)) {
      clearTimeout(room.answerTimeout);
      revealQuestion(code);
    }
  });

  // Host: next question
  socket.on('next-question', async ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    room.currentQ++;
    const maxQ = room.settings.nbQuestions === 999 ? Infinity : room.settings.nbQuestions;
    if (room.currentQ >= maxQ || !room.tracks.length) {
      endGame(code);
    } else {
      await sendNextQuestion(code);
    }
  });

  socket.on('disconnect', () => {
    rooms.forEach((room, code) => {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) { rooms.delete(code); return; }
      // Transfer host if needed
      if (room.host === socket.id) room.host = room.players[0].id;
      emitRoomState(code);
    });
  });
});

async function sendNextQuestion(code) {
  const room = rooms.get(code);
  if (!room) return;
  room.players.forEach(p => { p.answered = false; p.correct = false; });
  room.phase = 'question';

  const q = buildQuestion(room.tracks, room.usedIds);
  if (!q) { endGame(code); return; }
  room.usedIds.add(q.correct.id);
  room.question = q;
  room.questionStartTime = Date.now();

  const maxQ = room.settings.nbQuestions === 999 ? '∞' : room.settings.nbQuestions;
  io.to(code).emit('new-question', {
    qNumber: room.currentQ + 1,
    qTotal: maxQ,
    preview: q.preview,
    options: q.options,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, answered: false })),
  });

  // Auto-reveal after 25s
  room.answerTimeout = setTimeout(() => revealQuestion(code), 25000);
}

function revealQuestion(code) {
  const room = rooms.get(code);
  if (!room || room.phase !== 'question') return;
  room.phase = 'reveal';
  clearTimeout(room.answerTimeout);

  const maxQ = room.settings.nbQuestions === 999 ? '∞' : room.settings.nbQuestions;
  io.to(code).emit('reveal', {
    correctId: room.question.correct.id,
    correctTitle: room.question.correct.title,
    correctArtist: room.question.correct.artist,
    cover: room.question.realCover,
    year: room.question.year,
    album: room.question.album,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, correct: p.correct, answered: p.answered })),
    qNumber: room.currentQ + 1,
    qTotal: maxQ,
    isHost: null, // set per-client
  });
}

function endGame(code) {
  const room = rooms.get(code);
  if (!room) return;
  room.phase = 'results';
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  io.to(code).emit('game-over', { players: sorted });
}

function emitRoomState(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('room-state', {
    code,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
    host: room.host,
    settings: room.settings,
    phase: room.phase,
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎵 Blind Test server running on port ${PORT}`));
