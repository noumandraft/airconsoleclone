const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const PORT = process.env.PORT || 3000;

const PLAYER_COLORS = ['#FF4757','#1E90FF','#2ED573','#FFA502','#A29BFE','#FF6B81','#00D2D3','#ECCC68'];
const VALID_GAMES   = ['kites', 'trivia', 'drawing'];
const rooms = {};

app.get('/', (req, res) => res.send('AirConsole backend is running ✅'));

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

// ── Socket logic ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect]    ${socket.id}`);

  socket.on('create-room', ({ roomCode }) => {
    if (!roomCode || roomCode.length !== 4) { socket.emit('error', { message: 'Room code must be 4 digits.' }); return; }
    rooms[roomCode] = { screenSocketId: socket.id, hostPlayerId: null, gameState: 'lobby', activeGame: 'kites', players: [] };
    socket.join(roomCode);
    socket.emit('room-created', { roomCode });
    console.log(`[create-room] ${roomCode}`);
  });

  socket.on('join-room', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room)                             { socket.emit('error', { message: `Room ${roomCode} does not exist.` }); return; }
    if (room.gameState === 'playing')      { socket.emit('error', { message: 'Match in progress. Wait for next round.' }); return; }
    if (room.players.length >= PLAYER_COLORS.length) { socket.emit('error', { message: 'Room is full.' }); return; }

    const rawName    = (typeof playerName === 'string') ? playerName.trim().replace(/[<>&"']/g, '').slice(0, 18) : '';
    const playerLabel = rawName || `Player ${room.players.length + 1}`;
    const playerColor = PLAYER_COLORS[room.players.length];
    const playerId    = socket.id;

    room.players.push({ socketId: socket.id, playerId, label: playerLabel, color: playerColor });
    socket.join(roomCode);
    if (room.players.length === 1) { room.hostPlayerId = playerId; }

    socket.data.roomCode = roomCode; socket.data.playerId = playerId;
    socket.data.playerLabel = playerLabel; socket.data.playerColor = playerColor;

    console.log(`[join-room]  ${playerLabel} → room ${roomCode}`);
    socket.emit('joined', buildJoinedPayload(room, playerId, playerLabel, playerColor));
    broadcastPlayerList(room);
  });

  // Host picks which game to queue
  socket.on('select-game', ({ roomCode, game }) => {
    const room = rooms[roomCode];
    if (!room || socket.data.playerId !== room.hostPlayerId) return;
    if (room.gameState === 'playing' || !VALID_GAMES.includes(game)) return;
    room.activeGame = game;
    console.log(`[select-game] Room ${roomCode} → ${game}`);
    io.to(room.screenSocketId).emit('game-selected', { activeGame: game });
    emitToControllers(room, 'game-selected', { activeGame: game });
  });

  socket.on('start-match', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || socket.data.playerId !== room.hostPlayerId) return;
    if (room.gameState === 'playing') return;
    room.gameState = 'playing';
    console.log(`[start-match] Room ${roomCode} playing ${room.activeGame}`);
    io.to(room.screenSocketId).emit('match-started');
    emitToControllers(room, 'match-started', {});
  });

  // Kites: controller → screen
  socket.on('jump', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing') return;
    io.to(room.screenSocketId).emit('player-jumped', {
      playerId: socket.data.playerId, playerLabel: socket.data.playerLabel, color: socket.data.playerColor,
    });
  });

  // Trivia: screen broadcasts question to all controllers
  socket.on('trivia-question', ({ roomCode, questionIndex, question, options, timeLimit }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.screenSocketId) return;
    emitToControllers(room, 'trivia-question', { questionIndex, question, options, timeLimit });
  });

  // Trivia: controller answer → screen
  socket.on('trivia-answer', ({ roomCode, answerIndex, timeMs }) => {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(room.screenSocketId).emit('trivia-answer', {
      playerId: socket.data.playerId, playerLabel: socket.data.playerLabel,
      color: socket.data.playerColor, answerIndex, timeMs,
    });
  });

  // Trivia: screen broadcasts results to all controllers
  socket.on('trivia-result', ({ roomCode, correctIndex, scores, answers }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.screenSocketId) return;
    emitToControllers(room, 'trivia-result', { correctIndex, scores, answers });
  });

  // Trivia: screen broadcasts final standings
  socket.on('trivia-final', ({ roomCode, finalScores }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.screenSocketId) return;
    emitToControllers(room, 'trivia-final', { finalScores });
  });

  // Kites: screen relays elimination to specific controller
  socket.on('player-eliminated', ({ roomCode, playerId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const t = findPlayerSocket(room, playerId);
    if (t) t.emit('player-eliminated');
  });

  // Any game: screen → server → controllers, lobby reset
  socket.on('game-reset', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.gameState = 'lobby';
    console.log(`[game-reset] Room ${roomCode} back to LOBBY`);
    emitToControllers(room, 'game-reset', { hostPlayerId: room.hostPlayerId });
    broadcastPlayerList(room);
  });

  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    for (const [code, room] of Object.entries(rooms)) {
      if (room.screenSocketId === socket.id) { delete rooms[code]; return; }
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

server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
