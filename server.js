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


// ─── Spotify Auth (Client Credentials — lecture seule) ───────────────────────
let spotifyToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;
  const creds = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');
  const res = await axios.post(
    'https://accounts.spotify.com/api/token',
    'grant_type=client_credentials',
    { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  spotifyToken = res.data.access_token;
  spotifyTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return spotifyToken;
}

// Extract playlist ID from Spotify URL or raw ID
function parseSpotifyPlaylistId(input) {
  const match = input.match(/playlist[/:]([A-Za-z0-9]+)/);
  return match ? match[1] : input.trim();
}

// Fetch Spotify playlist tracks then match on Deezer
async function loadSpotifyPlaylist(playlistId) {
  const token = await getSpotifyToken();
  let tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&fields=items(track(name,artists,album(name)))`;

  while (url && tracks.length < 200) {
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });
    const items = (res.data.items || [])
      .filter(i => i.track && i.track.name)
      .map(i => ({ title: i.track.name, artist: i.track.artists[0]?.name || '' }));
    tracks.push(...items);
    url = res.data.next || null;
  }
  return tracks;
}

// Match a Spotify track on Deezer to get a preview URL
async function matchOnDeezer(title, artist) {
  try {
    const q = `track:"${title}" artist:"${artist}"`;
    const res = await axios.get(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=3`, { timeout: 6000 });
    const hit = (res.data.data || []).find(t => t.preview);
    if (hit) return {
      id: String(hit.id), title: hit.title, artist: hit.artist.name,
      album: hit.album?.title || '', year: null,
      preview: hit.preview, cover: hit.album?.cover_medium || null,
    };
    // Fallback: simpler search
    const q2 = `${title} ${artist}`;
    const res2 = await axios.get(`https://api.deezer.com/search?q=${encodeURIComponent(q2)}&limit=3`, { timeout: 6000 });
    const hit2 = (res2.data.data || []).find(t => t.preview);
    if (hit2) return {
      id: String(hit2.id), title: hit2.title, artist: hit2.artist.name,
      album: hit2.album?.title || '', year: null,
      preview: hit2.preview, cover: hit2.album?.cover_medium || null,
    };
  } catch(e) {}
  return null;
}


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
    // Check if it's a Spotify or Deezer URL
    if (theme.includes('spotify.com') || theme.includes('spotify:')) {
      const playlistId = parseSpotifyPlaylistId(theme);
      const result = await loadSpotifyPlaylist(playlistId);
      // Match on Deezer
      const BATCH = 5;
      const toMatch = result.sort(() => Math.random() - 0.5).slice(0, 80);
      for (let i = 0; i < toMatch.length; i += BATCH) {
        const batch = toMatch.slice(i, i + BATCH);
        const results = await Promise.allSettled(batch.map(t => matchOnDeezer(t.title, t.artist)));
        for (const r of results) { if (r.status === 'fulfilled' && r.value) tracks.push(r.value); }
        if (i + BATCH < toMatch.length) await new Promise(r => setTimeout(r, 150));
      }
    } else {
      // Deezer playlist
      const match = theme.match(/playlist\/(\d+)/);
      const playlistId = match ? match[1] : theme.trim();
      tracks = await deezerPlaylistTracks(playlistId);
    }
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

app.get('/api/search-artist', async (req, res) => {
  try {
    const q = req.query.q || '';
    const r = await axios.get(`https://api.deezer.com/search/artist?q=${encodeURIComponent(q)}&limit=12`, { timeout: 8000 });
    const artists = (r.data.data || []).map(a => ({
      id: String(a.id),
      name: a.name,
      image: a.picture_medium || a.picture || null,
    }));
    res.json(artists);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/spotify-playlist', async (req, res) => {
  try {
    const playlistId = parseSpotifyPlaylistId(req.query.url || '');
    if (!playlistId) return res.status(400).json({ error: 'URL invalide' });

    // 1. Get track list from Spotify
    const spotifyTracks = await loadSpotifyPlaylist(playlistId);
    if (!spotifyTracks.length) return res.status(404).json({ error: 'Playlist vide ou introuvable' });

    // 2. Match on Deezer in batches (avoid rate limiting)
    const matched = [];
    const shuffled = spotifyTracks.sort(() => Math.random() - 0.5);
    const toMatch = shuffled.slice(0, 80); // max 80 tracks

    const BATCH = 5;
    for (let i = 0; i < toMatch.length; i += BATCH) {
      const batch = toMatch.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(t => matchOnDeezer(t.title, t.artist))
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) matched.push(r.value);
      }
      if (i + BATCH < toMatch.length) await new Promise(r => setTimeout(r, 200));
    }

    if (matched.length < 4) {
      return res.status(404).json({ error: `Seulement ${matched.length} morceaux trouvés sur Deezer. Essaie une autre playlist.` });
    }

    // Dedupe
    const seen = new Set();
    const unique = matched.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });

    res.json({ tracks: unique, total: spotifyTracks.length, matched: unique.length });
  } catch(e) {
    console.error('Spotify playlist error:', e.message);
    if (e.response?.status === 404) return res.status(404).json({ error: "Playlist introuvable. Vérifie que le lien est correct et que la playlist est publique." });
    if (e.response?.status === 403) return res.status(403).json({ error: "Accès refusé par Spotify. La playlist doit être publique (pas privée ni collaborative)." });
    if (e.response?.status === 401) return res.status(401).json({ error: "Erreur authentification Spotify. Vérifie les credentials Railway." });
    res.status(500).json({ error: e.message });
  }
});


app.get('/api/top-artists', async (req, res) => {
  try {
    // Deezer chart - top tracks, extract unique artists
    const [chart, rapFr] = await Promise.allSettled([
      axios.get('https://api.deezer.com/chart/0/artists?limit=50', { timeout: 10000 }),
      axios.get('https://api.deezer.com/search/artist?q=rap+francais&limit=20', { timeout: 10000 }),
    ]);

    let artists = [];

    if (chart.status === 'fulfilled') {
      const chartArtists = (chart.value.data?.data || []).map(a => ({
        id: String(a.id), name: a.name,
        image: a.picture_medium || a.picture || null,
      }));
      artists.push(...chartArtists);
    }

    if (rapFr.status === 'fulfilled') {
      const frArtists = (rapFr.value.data?.data || []).map(a => ({
        id: String(a.id), name: a.name,
        image: a.picture_medium || a.picture || null,
      }));
      artists.push(...frArtists);
    }

    // Dedupe by id
    const seen = new Set();
    artists = artists.filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true; });

    res.json(artists.slice(0, 60));
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
    if (room.players.length >= 20) { socket.emit('error', { msg: 'La salle est pleine (20 joueurs max).' }); return; }
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

  // Rematch - host restarts with optional new settings
  socket.on('rematch', async ({ code, tracks }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    room.tracks = tracks;
    room.phase = 'question';
    room.currentQ = 0;
    room.usedIds = new Set();
    room.players.forEach(p => { p.score = 0; p.answered = false; p.correct = false; });
    io.to(code).emit('rematch-starting', {});
    await sendNextQuestion(code);
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

  room.answerTimeout = setTimeout(() => revealQuestion(code), 12000);
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
    host: room.host,
    settings: room.settings, // includes gameMode
    phase: room.phase,
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎵 Blind Test server running on port ${PORT}`));
