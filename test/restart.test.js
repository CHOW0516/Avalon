// Checks that a game survives a server restart when the room store is set up.
// A small fake of the Upstash REST API stands in for the real service.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const GAME_PORT = 3991;
const STORE_PORT = 3992;
const TINY_JPEG = `data:image/jpeg;base64,${Buffer.from('not really a photo').toString('base64')}`;

function startFakeStore() {
  const saved = new Map();
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const [name, ...parts] = JSON.parse(body);
      let result = null;
      if (name === 'SET') { saved.set(parts[0], parts[1]); result = 'OK'; }
      if (name === 'GET') result = saved.get(parts[0]) || null;
      if (name === 'MGET') result = parts.map((key) => saved.get(key) || null);
      if (name === 'DEL') result = saved.delete(parts[0]) ? 1 : 0;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ result }));
    });
  });
  return new Promise((resolve) => server.listen(STORE_PORT, () => resolve(server)));
}

function startGameServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: GAME_PORT, UPSTASH_REDIS_REST_URL: `http://localhost:${STORE_PORT}`, UPSTASH_REDIS_REST_TOKEN: 'test-token' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve) => {
    child.stdout.on('data', (text) => { if (String(text).includes('running')) resolve(child); });
  });
}

function stopGameServer(child) {
  return new Promise((resolve) => {
    child.on('exit', resolve);
    child.kill();
  });
}

// Opens a connection and keeps the latest "joined" and "state" messages.
function openPhone() {
  const socket = new WebSocket(`ws://localhost:${GAME_PORT}`);
  const phone = { socket, joined: null, state: null, expired: false };
  socket.on('message', (raw) => {
    const message = JSON.parse(raw);
    if (message.type === 'joined') phone.joined = message;
    if (message.type === 'state') phone.state = message.state;
    if (message.type === 'sessionExpired') phone.expired = true;
  });
  phone.send = (message) => socket.send(JSON.stringify(message));
  return new Promise((resolve) => socket.on('open', () => resolve(phone)));
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Timed out waiting');
}

test('a game in progress survives a server restart', async () => {
  const fakeStore = await startFakeStore();
  let gameServer = await startGameServer();
  try {
    const phones = [];
    const host = await openPhone();
    host.send({ type: 'create', name: 'Player0' });
    await waitFor(() => host.joined);
    phones.push(host);
    for (let index = 1; index < 5; index++) {
      const phone = await openPhone();
      phone.send({ type: 'join', code: host.joined.code, name: `Player${index}` });
      await waitFor(() => phone.joined);
      phones.push(phone);
    }
    host.send({ type: 'setPhoto', dataUrl: TINY_JPEG });
    host.send({ type: 'start' });
    await waitFor(() => phones.every((phone) => phone.state && phone.state.phase === 'team'));
    const rolesBefore = phones.map((phone) => phone.state.game.myRole);
    const leaderBefore = host.state.game.leaderId;
    await new Promise((resolve) => setTimeout(resolve, 200)); // let the save finish

    await stopGameServer(gameServer);
    gameServer = await startGameServer();

    const phonesAfter = [];
    for (const oldPhone of phones) {
      const phone = await openPhone();
      phone.send({ type: 'rejoin', code: oldPhone.joined.code, playerId: oldPhone.joined.playerId, token: oldPhone.joined.token });
      phonesAfter.push(phone);
    }
    await waitFor(() => phonesAfter.every((phone) => phone.state));
    assert.deepStrictEqual(phonesAfter.map((phone) => phone.state.game.myRole), rolesBefore);
    assert.strictEqual(phonesAfter[0].state.game.leaderId, leaderBefore);
    assert.strictEqual(phonesAfter[0].state.phase, 'team');
    assert.strictEqual(phonesAfter[0].state.players.length, 5);

    const photoResponse = await fetch(`http://localhost:${GAME_PORT}/photo/${host.joined.code}/${host.joined.playerId}`);
    assert.strictEqual(photoResponse.status, 200);
    assert.strictEqual(Buffer.from(await photoResponse.arrayBuffer()).toString(), 'not really a photo');

    // A wrong token is still refused after a restart.
    const stranger = await openPhone();
    stranger.send({ type: 'rejoin', code: host.joined.code, playerId: host.joined.playerId, token: 'wrong' });
    await waitFor(() => stranger.expired);

    for (const phone of [...phonesAfter, stranger]) phone.socket.close();
  } finally {
    await stopGameServer(gameServer);
    fakeStore.close();
  }
});
