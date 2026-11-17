const test = require('node:test');
const assert = require('node:assert');
const game = require('../game');

function makeRoom(playerCount, settings = {}) {
  const players = [];
  for (let index = 0; index < playerCount; index++) players.push({ id: `p${index}` });
  return { players, settings: { percival: false, morgana: false, mordred: false, oberon: false, lady: false, ...settings }, phase: 'lobby', game: null };
}

function idsWithRole(room, predicate) {
  return Object.keys(room.game.roles).filter((id) => predicate(room.game.roles[id]));
}

function proposeAndVote(room, team, approve) {
  const leader = game.leaderId(room.game);
  assert.strictEqual(game.handleAction(room, leader, { type: 'proposeTeam', team }), null);
  for (const id of room.game.seatOrder) game.handleAction(room, id, { type: 'vote', approve });
}

function runQuest(room, team, failingIds = []) {
  proposeAndVote(room, team, true);
  for (const id of team) {
    assert.strictEqual(game.handleAction(room, id, { type: 'playQuest', success: !failingIds.includes(id) }), null);
  }
}

function goodTeam(room) {
  const size = game.TEAM_SIZES_BY_PLAYERS[room.game.seatOrder.length][room.game.questIndex];
  return idsWithRole(room, (role) => !game.isEvil(role)).slice(0, size);
}

test('good/evil counts match the rules table for 5-10 players', () => {
  const expected = { 5: [3, 2], 6: [4, 2], 7: [4, 3], 8: [5, 3], 9: [6, 3], 10: [6, 4] };
  for (const [count, [good, evil]] of Object.entries(expected)) {
    const room = makeRoom(Number(count));
    assert.strictEqual(game.startGame(room), null);
    assert.strictEqual(idsWithRole(room, (role) => !game.isEvil(role)).length, good);
    assert.strictEqual(idsWithRole(room, game.isEvil).length, evil);
    assert.strictEqual(idsWithRole(room, (role) => role === 'merlin').length, 1);
    assert.strictEqual(idsWithRole(room, (role) => role === 'assassin').length, 1);
  }
});

test('cannot start with too few or too many players, or too many evil roles', () => {
  assert.ok(game.startGame(makeRoom(4)));
  assert.ok(game.startGame(makeRoom(11)));
  assert.ok(game.startGame(makeRoom(5, { morgana: true, mordred: true })));
  assert.strictEqual(game.startGame(makeRoom(10, { morgana: true, mordred: true, oberon: true })), null);
});

test('secret knowledge: Merlin misses Mordred, Evil misses Oberon, Percival sees Merlin and Morgana', () => {
  const room = makeRoom(10, { percival: true, morgana: true, mordred: true, oberon: true });
  game.startGame(room);
  const [merlin] = idsWithRole(room, (role) => role === 'merlin');
  const [mordred] = idsWithRole(room, (role) => role === 'mordred');
  const [oberon] = idsWithRole(room, (role) => role === 'oberon');
  const [morgana] = idsWithRole(room, (role) => role === 'morgana');
  const [percival] = idsWithRole(room, (role) => role === 'percival');
  const [servant] = idsWithRole(room, (role) => role === 'servant');

  const merlinSees = game.knowledgeFor(room.game, merlin).ids;
  assert.ok(!merlinSees.includes(mordred));
  assert.ok(merlinSees.includes(oberon));
  assert.strictEqual(merlinSees.length, 3);

  const morganaSees = game.knowledgeFor(room.game, morgana).ids;
  assert.ok(morganaSees.includes(mordred));
  assert.ok(!morganaSees.includes(oberon));

  assert.strictEqual(game.knowledgeFor(room.game, oberon), null);
  assert.strictEqual(game.knowledgeFor(room.game, servant), null);
  assert.deepStrictEqual(new Set(game.knowledgeFor(room.game, percival).ids), new Set([merlin, morgana]));
});

test('players never see other roles before the game ends', () => {
  const room = makeRoom(5);
  game.startGame(room);
  const view = game.gameViewFor(room, 'p0');
  assert.strictEqual(view.allRoles, null);
  assert.ok(!JSON.stringify(view).includes('"roles"'));
});

test('only the leader can propose, and team size must match', () => {
  const room = makeRoom(5);
  game.startGame(room);
  const leader = game.leaderId(room.game);
  const other = room.game.seatOrder.find((id) => id !== leader);
  assert.ok(game.handleAction(room, other, { type: 'proposeTeam', team: ['p0', 'p1'] }));
  assert.ok(game.handleAction(room, leader, { type: 'proposeTeam', team: ['p0', 'p1', 'p2'] }));
  assert.ok(game.handleAction(room, leader, { type: 'proposeTeam', team: ['p0', 'p0'] }));
  assert.strictEqual(game.handleAction(room, leader, { type: 'proposeTeam', team: ['p0', 'p1'] }), null);
  assert.strictEqual(room.phase, 'vote');
});

test('a tied vote is a rejection and passes the leader', () => {
  const room = makeRoom(6);
  game.startGame(room);
  const firstLeaderSeat = room.game.leaderSeat;
  game.handleAction(room, game.leaderId(room.game), { type: 'proposeTeam', team: ['p0', 'p1'] });
  room.game.seatOrder.forEach((id, seat) => game.handleAction(room, id, { type: 'vote', approve: seat < 3 }));
  assert.strictEqual(room.phase, 'team');
  assert.strictEqual(room.game.rejectCount, 1);
  assert.strictEqual(room.game.leaderSeat, (firstLeaderSeat + 1) % 6);
});

test('five rejected teams in a row: Evil wins', () => {
  const room = makeRoom(5);
  game.startGame(room);
  for (let attempt = 0; attempt < 5; attempt++) proposeAndVote(room, ['p0', 'p1'], false);
  assert.strictEqual(room.phase, 'end');
  assert.strictEqual(room.game.winner, 'evil');
});

test('good players cannot play Fail', () => {
  const room = makeRoom(5);
  game.startGame(room);
  const team = goodTeam(room);
  proposeAndVote(room, team, true);
  assert.ok(game.handleAction(room, team[0], { type: 'playQuest', success: false }));
});

test('quest 4 with 7+ players needs two fails', () => {
  const room = makeRoom(7);
  game.startGame(room);
  const evil = idsWithRole(room, game.isEvil);
  runQuest(room, goodTeam(room));
  runQuest(room, [evil[0], ...goodTeam(room).slice(0, 2)], [evil[0]]);
  runQuest(room, [evil[0], ...goodTeam(room).slice(0, 2)], [evil[0]]);
  // Quest 4 (4 players): one fail is not enough.
  runQuest(room, [evil[0], ...goodTeam(room).slice(0, 3)], [evil[0]]);
  assert.strictEqual(room.game.questResults[3].success, true);
  assert.strictEqual(room.game.questResults[3].failCount, 1);
});

test('reject counter resets after a quest', () => {
  const room = makeRoom(5);
  game.startGame(room);
  proposeAndVote(room, ['p0', 'p1'], false);
  assert.strictEqual(room.game.rejectCount, 1);
  runQuest(room, goodTeam(room));
  assert.strictEqual(room.game.rejectCount, 0);
});

test('three failed quests: Evil wins', () => {
  const room = makeRoom(5);
  game.startGame(room);
  const [evilId] = idsWithRole(room, game.isEvil);
  for (let quest = 0; quest < 3; quest++) {
    const size = game.TEAM_SIZES_BY_PLAYERS[5][room.game.questIndex];
    runQuest(room, [evilId, ...goodTeam(room).slice(0, size - 1)], [evilId]);
  }
  assert.strictEqual(room.game.winner, 'evil');
});

test('three successes go to the assassin; finding Merlin wins for Evil, missing wins for Good', () => {
  for (const guessMerlin of [true, false]) {
    const room = makeRoom(5);
    game.startGame(room);
    for (let quest = 0; quest < 3; quest++) runQuest(room, goodTeam(room));
    assert.strictEqual(room.phase, 'assassin');
    const [assassin] = idsWithRole(room, (role) => role === 'assassin');
    const [merlin] = idsWithRole(room, (role) => role === 'merlin');
    const [servant] = idsWithRole(room, (role) => role === 'servant');
    const [notAssassin] = idsWithRole(room, (role) => role !== 'assassin');
    assert.ok(game.handleAction(room, notAssassin, { type: 'assassinate', targetId: merlin }));
    game.handleAction(room, assassin, { type: 'assassinate', targetId: guessMerlin ? merlin : servant });
    assert.strictEqual(room.game.winner, guessMerlin ? 'evil' : 'good');
    assert.ok(game.gameViewFor(room, 'p0').allRoles);
  }
});

test('lady of the lake: starts right of leader, used after quests 2-4, cannot target past holders', () => {
  const room = makeRoom(8, { lady: true });
  game.startGame(room);
  const seats = room.game.seatOrder;
  assert.strictEqual(room.game.ladyHolder, seats[(room.game.leaderSeat - 1 + 8) % 8]);

  const [evilId] = idsWithRole(room, game.isEvil);
  runQuest(room, goodTeam(room));
  assert.strictEqual(room.phase, 'team'); // no lady after quest 1
  runQuest(room, [evilId, ...goodTeam(room).slice(0, 3)], [evilId]);
  assert.strictEqual(room.phase, 'lady');

  const holder = room.game.ladyHolder;
  assert.ok(game.handleAction(room, holder, { type: 'ladyCheck', targetId: holder }));
  const target = seats.find((id) => id !== holder);
  const otherPlayer = seats.find((id) => id !== holder && id !== target);
  assert.strictEqual(game.handleAction(room, holder, { type: 'ladyCheck', targetId: target }), null);
  assert.strictEqual(room.game.ladyHolder, target);
  assert.strictEqual(room.phase, 'team');

  // Only the old holder sees the answer.
  assert.strictEqual(typeof game.gameViewFor(room, holder).ladyChecks[0].targetIsEvil, 'boolean');
  assert.strictEqual(game.gameViewFor(room, otherPlayer).ladyChecks[0].targetIsEvil, undefined);

  runQuest(room, goodTeam(room));
  assert.strictEqual(room.phase, 'lady');
  assert.ok(game.handleAction(room, target, { type: 'ladyCheck', targetId: holder }));
});

test('everyone sees the leader\'s picks before the team is confirmed', () => {
  const room = makeRoom(5);
  game.startGame(room);
  const leader = game.leaderId(room.game);
  const other = room.game.seatOrder.find((id) => id !== leader);
  assert.ok(game.handleAction(room, other, { type: 'selectTeam', team: ['p0'] }));
  assert.ok(game.handleAction(room, leader, { type: 'selectTeam', team: ['p0', 'p1', 'p2'] }));
  assert.strictEqual(game.handleAction(room, leader, { type: 'selectTeam', team: ['p0'] }), null);
  assert.deepStrictEqual(game.gameViewFor(room, other).draftTeam, ['p0']);
  // After a rejected vote the next leader starts with no picks.
  proposeAndVote(room, ['p0', 'p1'], false);
  assert.deepStrictEqual(room.game.draftTeam, []);
});

test('history keeps every vote and the quest result', () => {
  const room = makeRoom(5);
  game.startGame(room);
  proposeAndVote(room, ['p0', 'p1'], false);
  runQuest(room, goodTeam(room));
  const history = game.gameViewFor(room, 'p0').history;
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].approved, false);
  assert.strictEqual(history[0].success, null);
  assert.strictEqual(history[1].approved, true);
  assert.strictEqual(history[1].success, true);
  assert.strictEqual(history[1].failCount, 0);
  assert.strictEqual(Object.keys(history[1].votes).length, 5);
});
