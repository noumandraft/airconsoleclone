const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// ─── CORS: allow any origin ───────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: '*',          // swap for your Hostinger domain in production
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3000;

// ─── Player colour palette (up to 8 players) ─────────────────────────────────
const PLAYER_COLORS = [
  '#FF4757', // Player 1 – Red
  '#1E90FF', // Player 2 – Blue
  '#2ED573', // Player 3 – Green
  '#FFA502', // Player 4 – Orange
  '#A29BFE', // Player 5 – Lavender
  '#FF6B81', // Player 6 – Pink
  '#00D2D3', // Player 7 – Cyan
  '#ECCC68', // Player 8 – Yellow
];

// ─── In-memory room store ─────────────────────────────────────────────────────
// rooms[code] = {
//   screenSocketId: string,
//   hostPlayerId:   string,        ← NEW: playerId of the host
//   gameState:      'lobby'|'playing', ← NEW
//   players: [{ socketId, playerId, label, color }]
// }
const rooms = {};

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('AirConsole backend is running ✅'));

// ─── Helper: broadcast full player-list (with host & gameState) to the screen ─
function broadcastPlayerList(room) {
  io.to(room.screenSocketId).emit('player-list', {
    players:    room.players.map(({ playerId, label, color }) => ({ playerId, label, color })),
    hostPlayerId: room.hostPlayerId,
    gameState:  room.gameState,
  });
}

// ─── Helper: build the joined payload ─────────────────────────────────────────
function buildJoinedPayload(room, playerId, playerLabel, playerColor) {
  return {
    playerLabel,
    playerId,
    color:        playerColor,
    roomCode:     Object.keys(rooms).find(k => rooms[k] === room),
    hostPlayerId: room.hostPlayerId,
    gameState:    room.gameState,
  };
}

// ─── Helper: find a player socket inside a room ───────────────────────────────
function findPlayerSocket(room, playerId) {
  const entry = room.players.find((p) => p.playerId === playerId);
  return entry ? io.sockets.sockets.get(entry.socketId) : null;
}

// ─── Socket.io logic ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect]    socket ${socket.id}`);

  // ── Screen creates a room ───────────────────────────────────────────────────
  socket.on('create-room', ({ roomCode }) => {
    if (!roomCode || roomCode.length !== 4) {
      socket.emit('error', { message: 'Room code must be exactly 4 digits.' });
      return;
    }
    rooms[roomCode] = {
      screenSocketId: socket.id,
      hostPlayerId:   null,          // set when first controller joins
      gameState:      'lobby',
      players:        [],
    };
    socket.join(roomCode);
    console.log(`[create-room] Room ${roomCode} created by screen ${socket.id}`);
    socket.emit('room-created', { roomCode });
  });

  // ── Controller joins a room ─────────────────────────────────────────────────
  socket.on('join-room', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('error', { message: `Room ${roomCode} does not exist.` });
      return;
    }
    if (room.gameState === 'playing') {
      socket.emit('error', { message: 'Match already in progress. Wait for the next round.' });
      return;
    }
    if (room.players.length >= PLAYER_COLORS.length) {
      socket.emit('error', { message: 'Room is full (max 8 players).' });
      return;
    }

    const playerNumber = room.players.length + 1;
    const playerLabel  = `Player ${playerNumber}`;
    const playerColor  = PLAYER_COLORS[room.players.length];
    const playerId     = socket.id;

    room.players.push({ socketId: socket.id, playerId, label: playerLabel, color: playerColor });
    socket.join(roomCode);

    // First player becomes host
    if (room.players.length === 1) {
      room.hostPlayerId = playerId;
      console.log(`[host]       ${playerLabel} is now host of room ${roomCode}`);
    }

    socket.data.roomCode    = roomCode;
    socket.data.playerId    = playerId;
    socket.data.playerLabel = playerLabel;
    socket.data.playerColor = playerColor;

    console.log(`[join-room]  ${playerLabel} (${playerId}) joined room ${roomCode} as ${playerColor}`);

    // Tell the joining controller who they are, who the host is, and current state
    socket.emit('joined', buildJoinedPayload(room, playerId, playerLabel, playerColor));

    // Broadcast updated list (includes hostPlayerId + gameState) to the screen
    broadcastPlayerList(room);
  });

  // ── Host fires start-match ──────────────────────────────────────────────────
  // Payload: { roomCode }
  socket.on('start-match', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    // Only accept from the host
    if (socket.data.playerId !== room.hostPlayerId) {
      socket.emit('error', { message: 'Only the host can start the match.' });
      return;
    }
    if (room.gameState === 'playing') return; // idempotent guard

    room.gameState = 'playing';
    console.log(`[start-match] Room ${roomCode} is now PLAYING`);

    // Notify the screen
    io.to(room.screenSocketId).emit('match-started');

    // Notify every controller in the room
    room.players.forEach(({ socketId }) => {
      const controllerSocket = io.sockets.sockets.get(socketId);
      if (controllerSocket) controllerSocket.emit('match-started');
    });
  });

  // ── Controller fires JUMP ───────────────────────────────────────────────────
  socket.on('jump', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing') return;

    const { playerId, playerLabel, playerColor } = socket.data;
    console.log(`[jump]       ${playerLabel} jumped in room ${roomCode}`);

    io.to(room.screenSocketId).emit('player-jumped', {
      playerId,
      playerLabel,
      color: playerColor,
    });
  });

  // ── Screen relays player-eliminated to that specific controller ─────────────
  socket.on('player-eliminated', ({ roomCode, playerId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    console.log(`[eliminated] ${playerId} eliminated in room ${roomCode}`);
    const targetSocket = findPlayerSocket(room, playerId);
    if (targetSocket) targetSocket.emit('player-eliminated');
  });

  // ── Screen signals end-of-round → move room back to lobby ──────────────────
  // Payload: { roomCode }
  socket.on('game-reset', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.gameState = 'lobby';
    console.log(`[game-reset] Room ${roomCode} returned to LOBBY`);

    // Tell every controller: round over → back to lobby, here's who's host
    room.players.forEach(({ socketId, playerId }) => {
      const controllerSocket = io.sockets.sockets.get(socketId);
      if (controllerSocket) {
        controllerSocket.emit('game-reset', {
          hostPlayerId: room.hostPlayerId,
        });
      }
    });

    // Refresh screen's player list with updated gameState
    broadcastPlayerList(room);
  });

  // ── Cleanup on disconnect ───────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[disconnect] socket ${socket.id}`);

    // If screen disconnects → destroy room
    for (const [code, room] of Object.entries(rooms)) {
      if (room.screenSocketId === socket.id) {
        console.log(`[cleanup]    Room ${code} removed (screen left)`);
        delete rooms[code];
        return;
      }
    }

    // If controller disconnects → remove from list, reassign host if needed
    const roomCode = socket.data.roomCode;
    if (roomCode && rooms[roomCode]) {
      const room = rooms[roomCode];
      room.players = room.players.filter((p) => p.socketId !== socket.id);

      // If host left, promote next player
      if (room.hostPlayerId === socket.data.playerId && room.players.length > 0) {
        room.hostPlayerId = room.players[0].playerId;
        console.log(`[host-swap]  New host: ${room.hostPlayerId} in room ${roomCode}`);
        // Tell new host they're now host
        const newHostSocket = io.sockets.sockets.get(room.players[0].socketId);
        if (newHostSocket) newHostSocket.emit('host-assigned');
      }

      broadcastPlayerList(room);
    }
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
