require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Deezer search (no API key needed) ───────────────────────────────────────
const THEMES = {
  'rap-fr':     'rap français',
  'hip-hop':    'hip hop',
  '80s':        'hits 80s',
  '90s':        'hits 90s',
  '2000s':      'hits 2000s',
  'rock':       'rock',
  'electro':    'electro dance',
  'rnb':        'rnb soul',
  'variete-fr': 'variété française',
  'pop':        'pop',
  'reggae':     'reggae',
  'metal':      'metal',
};

async function deezerSearch(q, index = 0) {
  const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=50&index=${index}`;
  const res = await axios.get(url, { timeout: 8000 });
  return (res.data.data || [])
    .filter(t => t.preview)
    .map(t => ({
      id: String(t.id),
      title: t.title,
      artist: t.artist.name,
      album: t.album.title,
      year: null,
      preview: t.preview,
      cover: t.album.cover_medium || t.album.cover,
    }));
}

async function deezerPlaylistTracks(playlistId) {
  try {
    const res = await axios.get(`https://api.deezer.com/playlist/${playlistId}/tracks?limit=100`, { timeout: 10000 });
    return (res.data.data || []).filter(t => t.preview).map(t => ({
      id: String(t.id),
      title: t.title,
      artist: t.artist.name,
      album: t.album?.title || '',
      year: null,
      preview: t.preview,
      cover: t.album?.cover_medium || t.album?.cover || null,
    }));
  } catch(e) {
    console.error('Playlist fetch error:', e.message);
    return [];
  }
}

async function deezerArtistTracks(artistName) {
  try {
    // Simple search with artist filter - most reliable approach
    const [r1, r2] = await Promise.allSettled([
      axios.get(`https://api.deezer.com/search?q=artist:"${encodeURIComponent(artistName)}"&limit=50&index=0`, { timeout: 10000 }),
      axios.get(`https://api.deezer.com/search?q=artist:"${encodeURIComponent(artistName)}"&limit=50&index=50`, { timeout: 10000 }),
    ]);

    let tracks = [];
    for (const r of [r1, r2]) {
      if (r.status === 'fulfilled') {
        const items = (r.value.data?.data || []).filter(t => t.preview && 
          t.artist.name.toLowerCase().includes(artistName.toLowerCase().split(' ')[0]));
        tracks.push(...items);
      }
    }

    return tracks.map(t => ({
      id: String(t.id),
      title: t.title,
      artist: t.artist.name,
      album: t.album?.title || '',
      year: null,
      preview: t.preview,
      cover: t.album?.cover_medium || t.album?.cover || null,
    }));
  } catch(e) {
    console.error('Artist search error:', e.message);
    return [];
  }
}

async function loadTracks(mode, theme, artists) {
  let tracks = [];

  if (mode === 'random') {
    const results = await Promise.allSettled([
      deezerSearch('hits', 0),
      deezerSearch('top songs', 0),
      deezerSearch('popular music', 50),
      deezerSearch('chart hits', 0),
    ]);
    tracks = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  } else if (mode === 'theme') {
    const q = THEMES[theme] || theme;
    const results = await Promise.allSettled([
      deezerSearch(q, 0),
      deezerSearch(q, 50),
    ]);
    tracks = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  } else if (mode === 'artist') {
    const results = await Promise.allSettled(
      artists.map(a => deezerArtistTracks(a))
    );
    tracks = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  } else if (mode === 'custom') {
    // Free text search
    const [r1, r2] = await Promise.allSettled([
      deezerSearch(theme, 0),
      deezerSearch(theme, 50),
    ]);
    tracks = [...(r1.status==='fulfilled'?r1.value:[]), ...(r2.status==='fulfilled'?r2.value:[])];

  } else if (mode === 'playlist') {
    // Extract playlist ID from Deezer URL or raw ID
    const match = theme.match(/playlist\/(\d+)/);
    const playlistId = match ? match[1] : theme.trim();
    tracks = await deezerPlaylistTracks(playlistId);
  }

  // Dedupe by id
  const seen = new Set();
  tracks = tracks.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });

  // Shuffle
  tracks.sort(() => Math.random() - 0.5);
  return tracks.slice(0, 150);
}

// ─── REST endpoints ───────────────────────────────────────────────────────────
app.get('/api/tracks', async (req, res) => {
  try {
    const { mode, theme, artists } = req.query;
    const artistList = artists ? JSON.parse(artists) : [];
    const tracks = await loadTracks(mode, theme, artistList);
    if (tracks.length < 4) throw new Error('Pas assez de morceaux trouvés. Essaie un autre thème ou artiste.');
    res.json({ tracks });
  } catch (e) {
    console.error(e.message);
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

  // Try different artists first, fall back to different titles (single-artist mode)
  let wrongPool = tracks.filter(t => t.id !== correct.id && t.artist !== correct.artist);
  if (wrongPool.length < 3) wrongPool = tracks.filter(t => t.id !== correct.id);
  if (wrongPool.length < 3) return null;

  const wrongs = shuffle(wrongPool).slice(0, 3);
  return {
    correct,
    options: shuffle([correct, ...wrongs]).map(t => ({ id: t.id, title: t.title, artist: t.artist })),
    preview: correct.preview,
    realCover: correct.cover,
    year: correct.year,
    album: correct.album,
  };
}

// ─── Socket.io ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('create-room', ({ playerName, settings }) => {
    const code = generateCode();
    const room = {
      code, host: socket.id,
      players: [{ id: socket.id, name: playerName, score: 0, answered: false, correct: false }],
      settings, tracks: [], usedIds: new Set(),
      currentQ: 0, question: null, phase: 'lobby', answerTimeout: null,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('room-created', { code });
    emitRoomState(code);
  });

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

  socket.on('answer', ({ code, trackId }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'question') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.answered) return;

    player.answered = true;
    player.correct = (trackId === room.question.correct.id);
    if (player.correct) {
      const elapsed = Date.now() - room.questionStartTime;
      const bonus = Math.max(0, Math.floor((20000 - elapsed) / 2000));
      player.score += 10 + bonus;
    }

    socket.emit('answer-result', { correct: player.correct, correctId: room.question.correct.id });
    io.to(code).emit('players-update', { players: room.players.map(p => ({ id: p.id, name: p.name, answered: p.answered, score: p.score })) });

    if (room.players.every(p => p.answered)) {
      clearTimeout(room.answerTimeout);
      revealQuestion(code);
    }
  });

  socket.on('next-question', async ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    room.currentQ++;
    const maxQ = room.settings.nbQuestions === 999 ? Infinity : room.settings.nbQuestions;
    if (room.currentQ >= maxQ) { endGame(code); }
    else { await sendNextQuestion(code); }
  });

  socket.on('disconnect', () => {
    rooms.forEach((room, code) => {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) { rooms.delete(code); return; }
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
    qNumber: room.currentQ + 1, qTotal: maxQ,
    preview: q.preview, options: q.options,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, answered: false })),
  });

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
    qNumber: room.currentQ + 1, qTotal: maxQ,
  });
}

function endGame(code) {
  const room = rooms.get(code);
  if (!room) return;
  room.phase = 'results';
  io.to(code).emit('game-over', { players: [...room.players].sort((a, b) => b.score - a.score) });
}

function emitRoomState(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('room-state', {
    code,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
    host: room.host, settings: room.settings, phase: room.phase,
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎵 Blind Test server running on port ${PORT}`));
