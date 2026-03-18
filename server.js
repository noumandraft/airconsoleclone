const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const whitelist = ['https://joypad.fun', 'https://www.joypad.fun', 'http://localhost:3000', 'http://127.0.0.1:3000'];

app.use(cors({ origin: whitelist }));

const server = http.createServer(app);
const io = new Server(server, { 
  cors: { 
    origin: whitelist, 
    methods: ['GET', 'POST'] 
  } 
});
const PORT = process.env.PORT || 3000;

// ── Supabase ───────────────────────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase;
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log(`[supabase] Client initialized successfully, connected to: ${supabaseUrl}`);
  } catch (err) {
    console.error(`[supabase] Failed to initialize client:`, err.message);
  }
} else {
  console.warn(`[supabase] Warning: SUPABASE_URL or SUPABASE_KEY is missing. Leaderboard will be disabled.`);
}

async function lbInsert(playerName, score, game) {
  if (!supabase) return;
  const { error } = await supabase.from('leaderboard').insert({ player_name: playerName, score, game_played: game });
  if (error) console.error('[supabase] insert:', error.message);
  else console.log(`[supabase] saved ${playerName} ${score}pts (${game})`);
}

async function lbFetch() {
  if (!supabase) return [];
  const { data, error } = await supabase.from('leaderboard')
    .select('player_name,score,game_played,created_at')
    .order('score', { ascending: false }).limit(10);
  if (error) { console.error('[supabase] fetch:', error.message); return []; }
  return (data || []).map(row => ({
    player_name: row.player_name,
    score: row.score,
    game: row.game_played,
    created_at: row.created_at
  }));
}

// ── Game constants ─────────────────────────────────────────────────────────────
const PLAYER_COLORS = ['#FF4757','#1E90FF','#2ED573','#FFA502','#A29BFE','#FF6B81','#00D2D3','#ECCC68'];
const VALID_GAMES   = ['kites', 'trivia', 'drawing', 'buzzer'];
const DRAWING_WORDS = [
  // Animals
  'cat','dog','fish','bird','lion','tiger','bear','wolf','fox','deer',
  'horse','rabbit','monkey','elephant','giraffe','penguin','dolphin','shark','owl','eagle',
  'crocodile','parrot','kangaroo','panda','zebra','octopus','flamingo','jellyfish','crab','turtle',
  // Food & Drink
  'pizza','apple','banana','cake','bread','coffee','cookie','burger','taco','sushi',
  'ice cream','sandwich','strawberry','watermelon','lemon','pineapple','donut','waffle','egg','cheese',
  'chocolate','popcorn','hotdog','grapes','carrot','mushroom','avocado','pancake','noodles','mango',
  // Objects & Places
  'house','car','boat','rocket','airplane','train','bicycle','umbrella','guitar','crown',
  'clock','phone','book','lamp','chair','table','door','window','bridge','ladder',
  'castle','lighthouse','igloo','windmill','tent','fire hydrant','mailbox','telescope','anchor','compass',
  // Nature
  'sun','moon','star','cloud','rain','snow','tree','flower','mountain','volcano',
  'river','ocean','island','forest','desert','cave','rainbow','lightning','wave','cactus',
  // Activities & Characters
  'robot','alien','ghost','dragon','wizard','knight','ninja','cowboy','pirate','mermaid',
  'swimming','dancing','sleeping','cooking','painting','fishing','skiing','surfing','skateboard','parachute',
  // Misc
  'balloon','kite','candle','mirror','key','bell','lantern','hourglass','magnet','trophy',
];
const ROUND_TIME = 60;
const rooms = {};

app.get('/', (req, res) => res.send('Joypad backend is running ✅'));

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcastPlayerList(room) {
  io.to(room.screenSocketId).emit('player-list', {
    players:      room.players.map(({ playerId, label, color }) => ({ playerId, label, color })),
    hostPlayerId: room.hostPlayerId,
    gameState:    room.gameState,
    activeGame:   room.activeGame,
  });
}
function buildJoinedPayload(room, playerId, label, color) {
  return {
    playerLabel: label, playerId, color,
    roomCode:     Object.keys(rooms).find(k => rooms[k] === room),
    hostPlayerId: room.hostPlayerId,
    gameState:    room.gameState,
    activeGame:   room.activeGame,
  };
}
function findPlayerSocket(room, playerId) {
  const e = room.players.find(p => p.playerId === playerId);
  return e ? io.sockets.sockets.get(e.socketId) : null;
}
function emitToControllers(room, event, payload) {
  room.players.forEach(({ socketId }) => {
    const s = io.sockets.sockets.get(socketId);
    if (s) s.emit(event, payload);
  });
}

// ── Drawing game logic ────────────────────────────────────────────────────────
function startDrawingRound(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.gameState !== 'playing' || room.activeGame !== 'drawing') return;
  const dg = room.drawing;

  if (dg.artistIndex >= dg.artistQueue.length) { endDrawingGame(roomCode); return; }

  dg.currentArtistId = dg.artistQueue[dg.artistIndex++];
  dg.currentWord     = DRAWING_WORDS[Math.floor(Math.random() * DRAWING_WORDS.length)].toLowerCase();
  dg.roundStartTime  = Date.now();

  const artist      = room.players.find(p => p.playerId === dg.currentArtistId);
  const artistName  = artist?.label || 'Someone';
  const artistColor = artist?.color || '#fff';

  console.log(`[drawing] Round ${dg.artistIndex}/${dg.artistQueue.length} — Artist:${artistName} Word:${dg.currentWord}`);

  io.to(room.screenSocketId).emit('drawing-round-start', {
    artistId: dg.currentArtistId, artistName, artistColor,
    roundIndex: dg.artistIndex, totalRounds: dg.artistQueue.length,
    timeLimit: ROUND_TIME, wordLength: dg.currentWord.length,
  });

  room.players.forEach(({ socketId, playerId }) => {
    const s = io.sockets.sockets.get(socketId); if (!s) return;
    if (playerId === dg.currentArtistId)
      s.emit('drawing-role', { role: 'artist', word: dg.currentWord, artistName, artistColor });
    else
      s.emit('drawing-role', { role: 'guesser', artistName, artistColor });
  });

  if (dg.roundTimer) clearTimeout(dg.roundTimer);
  dg.roundTimer = setTimeout(() => {
    const r2 = rooms[roomCode];
    if (!r2 || r2.drawing?.currentWord !== dg.currentWord) return;
    const word = dg.currentWord; dg.currentWord = null;
    io.to(r2.screenSocketId).emit('drawing-round-timeout', { word, artistName });
    emitToControllers(r2, 'drawing-round-timeout', { word });
    setTimeout(() => startDrawingRound(roomCode), 4000);
  }, ROUND_TIME * 1000);
}

async function endDrawingGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const scores = room.drawing?.scores || {};
  io.to(room.screenSocketId).emit('drawing-game-end', { scores });
  emitToControllers(room, 'drawing-game-end', { scores });
  // Save winner to leaderboard
  const sorted = Object.entries(scores).sort(([,a],[,b]) => b - a);
  if (sorted.length > 0) {
    const [winnerId, winnerScore] = sorted[0];
    const winnerPlayer = room.players.find(p => p.playerId === winnerId);
    if (winnerPlayer && winnerScore > 0) await lbInsert(winnerPlayer.label, winnerScore, 'drawing');
  }
}

// ── Socket logic ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect]    ${socket.id}`);

  socket.on('create-room', ({ roomCode }) => {
    if (!roomCode || roomCode.length !== 4) { socket.emit('error', { message: 'Room code must be 4 digits.' }); return; }
    rooms[roomCode] = { screenSocketId: socket.id, hostPlayerId: null, gameState: 'lobby', activeGame: 'kites', players: [], drawing: null };
    socket.join(roomCode);
    socket.emit('room-created', { roomCode });
    console.log(`[create-room] ${roomCode}`);
  });

  socket.on('join-room', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room)                             { socket.emit('error', { message: `Room ${roomCode} does not exist.` }); return; }
    if (room.gameState === 'playing')      { socket.emit('error', { message: 'Match in progress. Wait for next round.' }); return; }
    if (room.players.length >= PLAYER_COLORS.length) { socket.emit('error', { message: 'Room is full.' }); return; }

    const rawName     = (typeof playerName === 'string') ? playerName.trim().replace(/[<>&"']/g, '').slice(0, 18) : '';
    const playerLabel = rawName || `Player ${room.players.length + 1}`;
    const playerColor = PLAYER_COLORS[room.players.length];
    const playerId    = socket.id;

    room.players.push({ socketId: socket.id, playerId, label: playerLabel, color: playerColor });
    socket.join(roomCode);
    if (room.players.length === 1) room.hostPlayerId = playerId;

    socket.data.roomCode = roomCode; socket.data.playerId = playerId;
    socket.data.playerLabel = playerLabel; socket.data.playerColor = playerColor;

    console.log(`[join-room]  ${playerLabel} → room ${roomCode}`);
    socket.emit('joined', buildJoinedPayload(room, playerId, playerLabel, playerColor));
    broadcastPlayerList(room);
  });

  socket.on('select-game', ({ roomCode, game }) => {
    const room = rooms[roomCode];
    if (!room || socket.data.playerId !== room.hostPlayerId) return;
    if (room.gameState === 'playing' || !VALID_GAMES.includes(game)) return;
    room.activeGame = game;
    io.to(room.screenSocketId).emit('game-selected', { activeGame: game });
    emitToControllers(room, 'game-selected', { activeGame: game });
  });

  socket.on('start-match', ({ roomCode, category, difficulty }) => {
    const room = rooms[roomCode];
    if (!room || socket.data.playerId !== room.hostPlayerId) return;
    if (room.gameState === 'playing') return;
    room.gameState = 'playing';
    console.log(`[start-match] Room ${roomCode} playing ${room.activeGame}`);
    io.to(room.screenSocketId).emit('match-started', { category, difficulty });
    emitToControllers(room, 'match-started', {});
    if (room.activeGame === 'drawing') {
      const shuffled = [...room.players.map(p => p.playerId)].sort(() => Math.random() - 0.5);
      room.drawing = {
        artistQueue: shuffled, artistIndex: 0,
        currentArtistId: null, currentWord: null,
        scores: {}, roundTimer: null, roundStartTime: null,
      };
      room.players.forEach(p => { room.drawing.scores[p.playerId] = 0; });
      setTimeout(() => startDrawingRound(roomCode), 1200);
    } else if (room.activeGame === 'buzzer') {
      room.buzzer = { locked: false, currentWinner: null, scores: {} };
      room.players.forEach(p => { room.buzzer.scores[p.playerId] = 0; });
    }
  });

  // Kites relay
  socket.on('jump', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing') return;
    io.to(room.screenSocketId).emit('player-jumped', {
      playerId: socket.data.playerId, playerLabel: socket.data.playerLabel, color: socket.data.playerColor,
    });
  });

  // Kites: screen reports winner for leaderboard
  socket.on('report-winner', async ({ roomCode, game, winnerLabel, winnerScore }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.screenSocketId) return;
    if (typeof winnerScore !== 'number' || winnerScore <= 0) return;
    await lbInsert(String(winnerLabel).slice(0, 40), Math.round(winnerScore), String(game));
    // Refresh leaderboard on screen after save
    const entries = await lbFetch();
    io.to(room.screenSocketId).emit('leaderboard-data', { entries });
  });

  // Leaderboard request (host controller or screen)
  socket.on('request-leaderboard', async ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const entries = await lbFetch();
    io.to(room.screenSocketId).emit('leaderboard-data', { entries });
  });

  // Drawing relay — artist-only
  socket.on('draw-start', ({ roomCode, x, y }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing' || room.activeGame !== 'drawing') return;
    if (socket.data.playerId !== room.drawing?.currentArtistId) return;
    const nx = Math.max(0, Math.min(1, Number(x)||0)), ny = Math.max(0, Math.min(1, Number(y)||0));
    io.to(room.screenSocketId).emit('draw-start', {
      playerId: socket.data.playerId, label: socket.data.playerLabel,
      color: socket.data.playerColor, x: nx, y: ny,
    });
  });
  socket.on('draw-move', ({ roomCode, x, y }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing' || room.activeGame !== 'drawing') return;
    if (socket.data.playerId !== room.drawing?.currentArtistId) return;
    const nx = Math.max(0, Math.min(1, Number(x)||0)), ny = Math.max(0, Math.min(1, Number(y)||0));
    io.to(room.screenSocketId).emit('draw-move', { playerId: socket.data.playerId, x: nx, y: ny });
  });
  socket.on('draw-end', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing' || room.activeGame !== 'drawing') return;
    if (socket.data.playerId !== room.drawing?.currentArtistId) return;
    io.to(room.screenSocketId).emit('draw-end', { playerId: socket.data.playerId });
  });

  // Drawing guess
  socket.on('drawing-guess', ({ roomCode, guess }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing' || room.activeGame !== 'drawing') return;
    const dg = room.drawing;
    if (!dg?.currentWord || !dg.currentArtistId) return;
    if (socket.data.playerId === dg.currentArtistId) return;
    const safe = (typeof guess === 'string') ? guess.trim().replace(/[<>&"']/g, '').slice(0, 40) : '';
    if (!safe) return;
    if (safe.toLowerCase() === dg.currentWord) {
      clearTimeout(dg.roundTimer);
      const word = dg.currentWord; dg.currentWord = null;
      dg.scores[socket.data.playerId]  = (dg.scores[socket.data.playerId]  || 0) + 100;
      dg.scores[dg.currentArtistId]    = (dg.scores[dg.currentArtistId]    || 0) + 50;
      const timeMs = dg.roundStartTime ? Date.now() - dg.roundStartTime : 0;
      io.to(room.screenSocketId).emit('drawing-round-win', {
        word, winner: { playerId: socket.data.playerId, label: socket.data.playerLabel, color: socket.data.playerColor },
        artistId: dg.currentArtistId, scores: { ...dg.scores }, timeMs,
      });
      emitToControllers(room, 'drawing-round-win', {
        word, winnerLabel: socket.data.playerLabel, winnerPlayerId: socket.data.playerId,
        scores: { ...dg.scores },
      });
      setTimeout(() => startDrawingRound(roomCode), 5000);
    } else {
      const safeGuess = safe.slice(0, 30);
      io.to(room.screenSocketId).emit('drawing-guess-feed', {
        playerId: socket.data.playerId, label: socket.data.playerLabel,
        color: socket.data.playerColor, guess: safeGuess,
      });
    }
  });

  // Trivia events
  socket.on('trivia-question', ({ roomCode, questionIndex, question, options, timeLimit }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.screenSocketId) return;
    emitToControllers(room, 'trivia-question', { questionIndex, question, options, timeLimit });
  });
  socket.on('trivia-answer', ({ roomCode, answerIndex, timeMs }) => {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(room.screenSocketId).emit('trivia-answer', {
      playerId: socket.data.playerId, playerLabel: socket.data.playerLabel,
      color: socket.data.playerColor, answerIndex, timeMs,
    });
  });
  socket.on('trivia-result', ({ roomCode, correctIndex, scores, answers }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.screenSocketId) return;
    emitToControllers(room, 'trivia-result', { correctIndex, scores, answers });
  });
  socket.on('trivia-final', async ({ roomCode, finalScores }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.screenSocketId) return;
    emitToControllers(room, 'trivia-final', { finalScores });
    // Save trivia winner to leaderboard
    const sorted = Object.entries(finalScores).sort(([,a],[,b]) => b - a);
    if (sorted.length > 0) {
      const [winnerId, winnerScore] = sorted[0];
      const winnerPlayer = room.players.find(p => p.playerId === winnerId);
      if (winnerPlayer && winnerScore > 0) {
        await lbInsert(winnerPlayer.label, winnerScore, 'trivia');
        const entries = await lbFetch();
        io.to(room.screenSocketId).emit('leaderboard-data', { entries });
      }
    }
  });

  // Kites elimination relay
  socket.on('player-eliminated', ({ roomCode, playerId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const t = findPlayerSocket(room, playerId);
    if (t) t.emit('player-eliminated');
  });

  // Buzzer events
  socket.on('buzzer-press', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing' || room.activeGame !== 'buzzer' || !room.buzzer) return;
    if (!room.buzzer.locked) {
      room.buzzer.locked = true;
      room.buzzer.currentWinner = { id: socket.data.playerId, name: socket.data.playerLabel, color: socket.data.playerColor };
      io.to(room.screenSocketId).emit('buzzer-locked', { winnerName: socket.data.playerLabel, winnerId: socket.data.playerId, color: socket.data.playerColor });
      emitToControllers(room, 'buzzer-locked', { winnerName: socket.data.playerLabel, winnerId: socket.data.playerId, color: socket.data.playerColor });
    }
  });

  socket.on('buzzer-judge', ({ roomCode, correct }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing' || room.activeGame !== 'buzzer' || !room.buzzer) return;
    if (socket.data.playerId !== room.hostPlayerId) return;
    if (!room.buzzer.locked || !room.buzzer.currentWinner) return;

    const winnerId = room.buzzer.currentWinner.id;
    if (correct) {
      room.buzzer.scores[winnerId] = (room.buzzer.scores[winnerId] || 0) + 100;
    } else {
      room.buzzer.scores[winnerId] = (room.buzzer.scores[winnerId] || 0) - 50;
    }

    const { currentWinner } = room.buzzer;
    room.buzzer.locked = false;
    room.buzzer.currentWinner = null;
    io.to(room.screenSocketId).emit('buzzer-judged', { correct, scores: room.buzzer.scores, prevWinner: currentWinner });
    emitToControllers(room, 'buzzer-unlocked', { scores: room.buzzer.scores });
  });

  socket.on('buzzer-end-game', async ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing' || room.activeGame !== 'buzzer' || !room.buzzer) return;
    if (socket.data.playerId !== room.hostPlayerId) return;

    const scores = room.buzzer.scores;
    const sorted = Object.entries(scores).sort(([,a],[,b]) => b - a);
    if (sorted.length > 0) {
      const [winnerId, winnerScore] = sorted[0];
      const winnerPlayer = room.players.find(p => p.playerId === winnerId);
      if (winnerPlayer && winnerScore > 0) {
        await lbInsert(winnerPlayer.label, winnerScore, 'buzzer');
      }
    }
    room.gameState = 'lobby';
    emitToControllers(room, 'game-reset', { hostPlayerId: room.hostPlayerId });
    io.to(room.screenSocketId).emit('buzzer-ended', { scores });
    // update screen leaderboard
    const entries = await lbFetch();
    io.to(room.screenSocketId).emit('leaderboard-data', { entries });
  });

  // Lobby reset
  socket.on('game-reset', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.drawing?.roundTimer) clearTimeout(room.drawing.roundTimer);
    room.drawing   = null;
    room.buzzer    = null;
    room.gameState = 'lobby';
    console.log(`[game-reset] Room ${roomCode} → LOBBY`);
    emitToControllers(room, 'game-reset', { hostPlayerId: room.hostPlayerId });
    broadcastPlayerList(room);
  });

  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    for (const [code, room] of Object.entries(rooms)) {
      if (room.screenSocketId === socket.id) {
        if (room.drawing?.roundTimer) clearTimeout(room.drawing.roundTimer);
        delete rooms[code]; return;
      }
    }
    const rc = socket.data.roomCode;
    if (rc && rooms[rc]) {
      const room = rooms[rc];
      room.players = room.players.filter(p => p.socketId !== socket.id);
      if (room.hostPlayerId === socket.data.playerId && room.players.length > 0) {
        room.hostPlayerId = room.players[0].playerId;
        const nh = io.sockets.sockets.get(room.players[0].socketId);
        if (nh) nh.emit('host-assigned');
      }
      broadcastPlayerList(room);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Joypad server listening on 0.0.0.0:${PORT}`));
