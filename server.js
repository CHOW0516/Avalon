// Avalon web server: serves the page, room photos, and live game updates over WebSocket.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const game = require('./game');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PHOTO_BYTES = 300 * 1024;
const MAX_NAME_LENGTH = 20;
const ROOM_IDLE_LIMIT_MS = 3 * 60 * 60 * 1000; // empty rooms are removed after 3 hours
const ROOM_CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, they look like 1 and 0

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml' },
};

const rooms = new Map(); // room code -> room
const DEFAULT_SETTINGS = { percival: false, morgana: false, mordred: false, oberon: false, lady: false };

// ---------- HTTP ----------

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');

  if (url.pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('ok');
    return;
  }

  const photoMatch = url.pathname.match(/^\/photo\/([A-Z]{4})\/([a-f0-9]+)$/);
  if (photoMatch) {
    const room = await findRoom(photoMatch[1]);
    const player = room && room.players.find((candidate) => candidate.id === photoMatch[2]);
    if (!player || !player.photo) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': player.photoType, 'Cache-Control': 'public, max-age=86400' });
    response.end(player.photo);
    return;
  }

  const staticFile = STATIC_FILES[url.pathname];
  if (!staticFile) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  fs.readFile(path.join(PUBLIC_DIR, staticFile.file), (error, content) => {
    if (error) {
      response.writeHead(500);
      response.end('Server error');
      return;
    }
    response.writeHead(200, { 'Content-Type': staticFile.type, 'Cache-Control': 'no-cache' });
    response.end(content);
  });
});

// ---------- Rooms ----------

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function newRoomCode() {
  for (;;) {
    let code = '';
    for (let index = 0; index < 4; index++) {
      code += ROOM_CODE_LETTERS[crypto.randomInt(ROOM_CODE_LETTERS.length)];
    }
    if (!rooms.has(code)) return code;
  }
}

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

function addPlayer(room, name) {
  const player = { id: newId(), token: newId(), name, photo: null, photoType: null, photoVersion: 0, connections: 0 };
  room.players.push(player);
  return player;
}

function roomViewFor(room, playerId) {
  return {
    code: room.code,
    you: playerId,
    hostId: room.hostId,
    phase: room.phase,
    settings: room.settings,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      photoVersion: player.photoVersion,
      connected: player.connections > 0,
    })),
    game: game.gameViewFor(room, playerId),
  };
}

// Finds a room in memory. After a server restart it is loaded back from the room store.
const roomsBeingLoaded = new Map(); // room code -> promise, so many phones rejoining share one load
async function findRoom(code) {
  if (typeof code !== 'string' || !/^[A-Z]{4}$/.test(code)) return null;
  if (rooms.has(code)) return rooms.get(code);
  if (!store.enabled) return null;
  if (!roomsBeingLoaded.has(code)) {
    roomsBeingLoaded.set(code, store.loadRoom(code).then((room) => {
      roomsBeingLoaded.delete(code);
      if (room && !rooms.has(code)) rooms.set(code, room);
      return rooms.get(code) || null;
    }));
  }
  return roomsBeingLoaded.get(code);
}

function broadcast(room) {
  room.lastActive = Date.now();
  store.saveRoom(room);
  for (const [socket, session] of sessions) {
    if (session.roomCode === room.code && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: 'state', state: roomViewFor(room, session.playerId) }));
    }
  }
}

function removePlayer(room, playerId) {
  room.players = room.players.filter((player) => player.id !== playerId);
  for (const [socket, session] of sessions) {
    if (session.roomCode === room.code && session.playerId === playerId) {
      sessions.delete(socket);
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'left' }));
    }
  }
  if (room.players.length === 0) {
    rooms.delete(room.code);
    store.deleteRoom(room);
    return;
  }
  if (room.hostId === playerId) room.hostId = room.players[0].id;
  broadcast(room);
}

// ---------- WebSocket ----------

const sessions = new Map(); // socket -> { roomCode, playerId }
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });

function sendError(socket, message) {
  socket.send(JSON.stringify({ type: 'error', message }));
}

function attach(socket, room, player) {
  const previous = sessions.get(socket);
  if (previous) detach(socket);
  sessions.set(socket, { roomCode: room.code, playerId: player.id });
  player.connections += 1;
  socket.send(JSON.stringify({ type: 'joined', code: room.code, playerId: player.id, token: player.token }));
  broadcast(room);
}

function detach(socket) {
  const session = sessions.get(socket);
  if (!session) return;
  sessions.delete(socket);
  const room = rooms.get(session.roomCode);
  const player = room && room.players.find((candidate) => candidate.id === session.playerId);
  if (player) {
    player.connections = Math.max(0, player.connections - 1);
    broadcast(room);
  }
}

async function handleMessage(socket, message) {
  // Messages that do not need a room yet.
  if (message.type === 'create') {
    const name = cleanName(message.name);
    if (!name) return sendError(socket, 'Please enter your name.');
    const code = newRoomCode();
    const room = { code, hostId: null, players: [], settings: { ...DEFAULT_SETTINGS }, phase: 'lobby', game: null, lastActive: Date.now() };
    rooms.set(code, room);
    const player = addPlayer(room, name);
    room.hostId = player.id;
    return attach(socket, room, player);
  }

  if (message.type === 'join') {
    const name = cleanName(message.name);
    const room = await findRoom(String(message.code || '').toUpperCase().trim());
    if (socket.readyState !== socket.OPEN) return;
    if (!name) return sendError(socket, 'Please enter your name.');
    if (!room) return sendError(socket, 'Room not found. Check the code.');
    if (room.phase !== 'lobby') return sendError(socket, 'That game has already started.');
    if (room.players.length >= game.MAX_PLAYERS) return sendError(socket, 'That room is full (10 players).');
    if (room.players.some((player) => player.name.toLowerCase() === name.toLowerCase())) {
      return sendError(socket, 'Someone in the room already has that name.');
    }
    return attach(socket, room, addPlayer(room, name));
  }

  if (message.type === 'rejoin') {
    const room = await findRoom(message.code);
    if (socket.readyState !== socket.OPEN) return;
    const player = room && room.players.find((candidate) => candidate.id === message.playerId);
    if (!player || player.token !== message.token) {
      return socket.send(JSON.stringify({ type: 'sessionExpired' }));
    }
    return attach(socket, room, player);
  }

  // Everything below needs the player to be in a room.
  const session = sessions.get(socket);
  const room = session && rooms.get(session.roomCode);
  const player = room && room.players.find((candidate) => candidate.id === session.playerId);
  if (!player) return sendError(socket, 'You are not in a room.');
  const isHost = room.hostId === player.id;

  switch (message.type) {
    case 'setPhoto': {
      const match = String(message.dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
      if (!match) return sendError(socket, 'That photo could not be read.');
      const photo = Buffer.from(match[2], 'base64');
      if (photo.length > MAX_PHOTO_BYTES) return sendError(socket, 'That photo is too big.');
      player.photo = photo;
      player.photoType = match[1];
      player.photoVersion += 1;
      store.savePhoto(room, player);
      return broadcast(room);
    }

    case 'leave': {
      if (room.phase !== 'lobby') {
        // Mid-game the seat stays, so the game can still finish.
        detach(socket);
        return socket.send(JSON.stringify({ type: 'left' }));
      }
      player.connections = Math.max(0, player.connections - 1);
      return removePlayer(room, player.id);
    }

    case 'kick': {
      if (!isHost) return sendError(socket, 'Only the host can remove players.');
      if (room.phase !== 'lobby') return sendError(socket, 'You can only remove players before the game starts.');
      if (message.playerId === player.id) return sendError(socket, 'Use Leave to leave the room.');
      return removePlayer(room, message.playerId);
    }

    case 'setSettings': {
      if (!isHost) return sendError(socket, 'Only the host can change roles.');
      if (room.phase !== 'lobby') return sendError(socket, 'The game has started.');
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (key in (message.settings || {})) room.settings[key] = Boolean(message.settings[key]);
      }
      return broadcast(room);
    }

    case 'start': {
      if (!isHost) return sendError(socket, 'Only the host can start the game.');
      if (room.phase !== 'lobby') return sendError(socket, 'The game has already started.');
      const error = game.startGame(room);
      if (error) return sendError(socket, error);
      return broadcast(room);
    }

    case 'claimHost': {
      const host = room.players.find((candidate) => candidate.id === room.hostId);
      if (host && host.connections > 0) return sendError(socket, 'The host is still online.');
      room.hostId = player.id;
      return broadcast(room);
    }

    // Lets another phone take over the seat of a player who dropped out mid-game.
    case 'seatLink': {
      if (!isHost) return sendError(socket, 'Only the host can make a rejoin link.');
      if (!room.game) return sendError(socket, 'The game has not started.');
      const target = room.players.find((candidate) => candidate.id === message.playerId);
      if (!target) return sendError(socket, 'Unknown player.');
      if (target.connections > 0) return sendError(socket, 'That player is online.');
      target.token = newId(); // the old phone can no longer rejoin
      room.game.seatHandoffs.push(target.id);
      socket.send(JSON.stringify({ type: 'seatLink', playerId: target.id, token: target.token }));
      return broadcast(room);
    }

    case 'backToLobby': {
      if (!isHost) return sendError(socket, 'Only the host can start a new game.');
      if (room.phase !== 'end') return sendError(socket, 'The game is not over yet.');
      room.phase = 'lobby';
      room.game = null;
      return broadcast(room);
    }

    default: {
      const error = game.handleAction(room, player.id, message);
      if (error) return sendError(socket, error);
      return broadcast(room);
    }
  }
}

wss.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;
    handleMessage(socket, message).catch((error) => {
      console.error(error);
      if (socket.readyState === socket.OPEN) sendError(socket, 'Something went wrong.');
    });
  });
  socket.on('close', () => detach(socket));
});

// Ping every 30 seconds so dead phone connections are noticed and hosting proxies keep the line open.
setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30 * 1000);

// Remove rooms nobody has used for a while.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyoneConnected = room.players.some((player) => player.connections > 0);
    if (!anyoneConnected && now - room.lastActive > ROOM_IDLE_LIMIT_MS) rooms.delete(room.code);
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Avalon server running on http://localhost:${PORT}`);
  console.log(store.enabled ? 'Rooms are backed up to the room store.' : 'Rooms are kept in memory only.');
});
