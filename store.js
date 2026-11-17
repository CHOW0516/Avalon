// Optional backup of rooms in Upstash Redis (free plan), so games survive a server restart.
// It uses the Upstash REST API with Node's built-in fetch, so there is no extra dependency.
// Without the two environment variables below, rooms are kept in memory only.

const STORE_URL = process.env.UPSTASH_REDIS_REST_URL;
const STORE_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const enabled = Boolean(STORE_URL && STORE_TOKEN);
const ROOM_LIFETIME_SECONDS = 24 * 60 * 60;

// Sends one Redis command, for example ['GET', 'room:ABCD'].
async function runCommand(command) {
  const response = await fetch(STORE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STORE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`Room store answered ${response.status}`);
  return (await response.json()).result;
}

function roomKey(code) {
  return `room:${code}`;
}

function photoKey(code, playerId) {
  return `photo:${code}:${playerId}`;
}

// Everything about a room except live connections and photo bytes (photos are saved on their own).
function serializeRoom(room) {
  return JSON.stringify({
    code: room.code,
    hostId: room.hostId,
    settings: room.settings,
    phase: room.phase,
    game: room.game,
    players: room.players.map((player) => ({
      id: player.id,
      token: player.token,
      name: player.name,
      photoType: player.photoType,
      photoVersion: player.photoVersion,
    })),
  });
}

// Saves the room if it changed since the last save. Errors are logged; the game goes on in memory.
// Saves for one room run one at a time, so an older save can never overwrite a newer one.
async function saveRoom(room) {
  if (!enabled) return;
  if (room.saveInProgress) {
    room.saveAgain = true;
    return;
  }
  room.saveInProgress = true;
  do {
    room.saveAgain = false;
    const serialized = serializeRoom(room);
    if (serialized === room.lastSavedJson) continue;
    try {
      await runCommand(['SET', roomKey(room.code), serialized, 'EX', ROOM_LIFETIME_SECONDS]);
      room.lastSavedJson = serialized;
    } catch (error) {
      console.error('Could not save room', room.code, error.message);
    }
  } while (room.saveAgain);
  room.saveInProgress = false;
}

async function savePhoto(room, player) {
  if (!enabled) return;
  try {
    await runCommand(['SET', photoKey(room.code, player.id), player.photo.toString('base64'), 'EX', ROOM_LIFETIME_SECONDS]);
  } catch (error) {
    console.error('Could not save photo', error.message);
  }
}

async function deleteRoom(room) {
  if (!enabled) return;
  try {
    await runCommand(['DEL', roomKey(room.code)]);
  } catch (error) {
    console.error('Could not delete room', room.code, error.message);
  }
}

// Returns the saved room, or null if there is none.
async function loadRoom(code) {
  if (!enabled) return null;
  try {
    const serialized = await runCommand(['GET', roomKey(code)]);
    if (!serialized) return null;
    const room = JSON.parse(serialized);
    room.lastSavedJson = serialized;
    room.lastActive = Date.now();
    const playersWithPhoto = room.players.filter((player) => player.photoVersion > 0);
    const photos = playersWithPhoto.length
      ? await runCommand(['MGET', ...playersWithPhoto.map((player) => photoKey(code, player.id))])
      : [];
    for (const player of room.players) {
      const photoIndex = playersWithPhoto.indexOf(player);
      const savedPhoto = photoIndex >= 0 ? photos[photoIndex] : null;
      player.photo = savedPhoto ? Buffer.from(savedPhoto, 'base64') : null;
      if (!player.photo) player.photoVersion = 0;
      player.connections = 0;
    }
    return room;
  } catch (error) {
    console.error('Could not load room', code, error.message);
    return null;
  }
}

module.exports = { enabled, saveRoom, savePhoto, deleteRoom, loadRoom };
