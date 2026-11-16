// Avalon game rules. Pure logic: no networking here, so it is easy to test.

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 10;

const EVIL_COUNT_BY_PLAYERS = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 };

const TEAM_SIZES_BY_PLAYERS = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};

const EVIL_ROLES = ['assassin', 'morgana', 'mordred', 'oberon', 'minion'];
const MAX_REJECTED_TEAMS = 5;
const QUESTS_TO_WIN = 3;
// Lady of the Lake is used right after quests 2, 3 and 4 (index 1, 2, 3).
const LADY_AFTER_QUEST_INDEXES = [1, 2, 3];

function isEvil(role) {
  return EVIL_ROLES.includes(role);
}

// Quest 4 (index 3) needs two Fail cards when there are 7 or more players.
function failsNeededToFail(playerCount, questIndex) {
  return questIndex === 3 && playerCount >= 7 ? 2 : 1;
}

function shuffle(list, random = Math.random) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function buildRoleList(playerCount, settings) {
  const evilCount = EVIL_COUNT_BY_PLAYERS[playerCount];
  const goodRoles = ['merlin'];
  if (settings.percival) goodRoles.push('percival');
  const evilRoles = ['assassin'];
  for (const role of ['morgana', 'mordred', 'oberon']) {
    if (settings[role]) evilRoles.push(role);
  }
  if (evilRoles.length > evilCount) {
    return { error: `Too many Evil roles: ${playerCount} players only have ${evilCount} Evil players (Assassin is always one).` };
  }
  while (goodRoles.length < playerCount - evilCount) goodRoles.push('servant');
  while (evilRoles.length < evilCount) evilRoles.push('minion');
  return { roles: goodRoles.concat(evilRoles) };
}

function startGame(room, random = Math.random) {
  const playerCount = room.players.length;
  if (playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
    return `Need ${MIN_PLAYERS} to ${MAX_PLAYERS} players to start.`;
  }
  const built = buildRoleList(playerCount, room.settings);
  if (built.error) return built.error;

  const shuffledRoles = shuffle(built.roles, random);
  const seatOrder = room.players.map((player) => player.id);
  const roles = {};
  seatOrder.forEach((playerId, seat) => { roles[playerId] = shuffledRoles[seat]; });

  const leaderSeat = Math.floor(random() * playerCount);
  // Lady of the Lake starts with the player to the right of the first leader.
  const ladyHolder = room.settings.lady ? seatOrder[(leaderSeat - 1 + playerCount) % playerCount] : null;

  room.game = {
    seatOrder,
    roles,
    leaderSeat,
    questIndex: 0,
    questResults: [],
    rejectCount: 0,
    team: [],
    draftTeam: [], // the leader's picks so far, shown to everyone before confirming
    votes: {},
    lastVote: null,
    questCards: {},
    ladyHolder,
    ladyPastHolders: ladyHolder ? [ladyHolder] : [],
    ladyChecks: [],
    assassinTarget: null,
    winner: null,
    endReason: '',
  };
  room.phase = 'team';
  return null;
}

function leaderId(game) {
  return game.seatOrder[game.leaderSeat];
}

function passLeaderAndStartTeamPhase(room) {
  const game = room.game;
  game.leaderSeat = (game.leaderSeat + 1) % game.seatOrder.length;
  game.team = [];
  game.draftTeam = [];
  game.votes = {};
  room.phase = 'team';
}

function endGame(room, winner, reason) {
  room.game.winner = winner;
  room.game.endReason = reason;
  room.phase = 'end';
}

function resolveVote(room) {
  const game = room.game;
  const approvals = Object.values(game.votes).filter(Boolean).length;
  const approved = approvals > game.seatOrder.length / 2; // a tie is a rejection
  game.lastVote = {
    leaderId: leaderId(game),
    team: [...game.team],
    votes: { ...game.votes },
    approved,
    questIndex: game.questIndex,
  };
  game.votes = {};
  if (approved) {
    game.questCards = {};
    room.phase = 'quest';
    return;
  }
  game.rejectCount += 1;
  if (game.rejectCount >= MAX_REJECTED_TEAMS) {
    endGame(room, 'evil', 'Five teams in a row were rejected.');
    return;
  }
  passLeaderAndStartTeamPhase(room);
}

function resolveQuest(room) {
  const game = room.game;
  const failCount = Object.values(game.questCards).filter((success) => !success).length;
  const needed = failsNeededToFail(game.seatOrder.length, game.questIndex);
  game.questResults.push({
    team: [...game.team],
    failCount,
    success: failCount < needed,
  });
  game.questCards = {};

  const successCount = game.questResults.filter((result) => result.success).length;
  const failedCount = game.questResults.length - successCount;
  if (failedCount >= QUESTS_TO_WIN) {
    endGame(room, 'evil', 'Three quests failed.');
    return;
  }
  if (successCount >= QUESTS_TO_WIN) {
    room.phase = 'assassin';
    return;
  }

  const finishedQuestIndex = game.questIndex;
  game.questIndex += 1;
  game.rejectCount = 0;
  if (game.ladyHolder && LADY_AFTER_QUEST_INDEXES.includes(finishedQuestIndex)) {
    room.phase = 'lady';
    return;
  }
  passLeaderAndStartTeamPhase(room);
}

// Applies one player action. Returns an error message, or null on success.
function handleAction(room, playerId, action) {
  const game = room.game;
  if (!game || !game.roles[playerId]) return 'You are not in this game.';

  switch (action.type) {
    case 'selectTeam': {
      if (room.phase !== 'team') return 'It is not time to pick a team.';
      if (leaderId(game) !== playerId) return 'Only the leader can pick the team.';
      const draftTeam = Array.isArray(action.team) ? [...new Set(action.team)] : [];
      const teamSize = TEAM_SIZES_BY_PLAYERS[game.seatOrder.length][game.questIndex];
      if (draftTeam.length > teamSize) return `The team has only ${teamSize} players.`;
      if (!draftTeam.every((id) => game.roles[id])) return 'Unknown player on the team.';
      game.draftTeam = draftTeam;
      return null;
    }

    case 'proposeTeam': {
      if (room.phase !== 'team') return 'It is not time to pick a team.';
      if (leaderId(game) !== playerId) return 'Only the leader can pick the team.';
      const team = Array.isArray(action.team) ? [...new Set(action.team)] : [];
      const teamSize = TEAM_SIZES_BY_PLAYERS[game.seatOrder.length][game.questIndex];
      if (team.length !== teamSize) return `The team needs exactly ${teamSize} players.`;
      if (!team.every((id) => game.roles[id])) return 'Unknown player on the team.';
      game.team = team;
      game.draftTeam = [];
      game.votes = {};
      room.phase = 'vote';
      return null;
    }

    case 'vote': {
      if (room.phase !== 'vote') return 'There is no vote right now.';
      game.votes[playerId] = Boolean(action.approve);
      if (Object.keys(game.votes).length === game.seatOrder.length) resolveVote(room);
      return null;
    }

    case 'playQuest': {
      if (room.phase !== 'quest') return 'There is no quest right now.';
      if (!game.team.includes(playerId)) return 'You are not on this quest.';
      if (playerId in game.questCards) return 'You already played your card.';
      const success = Boolean(action.success);
      if (!success && !isEvil(game.roles[playerId])) return 'Good players must play Success.';
      game.questCards[playerId] = success;
      if (Object.keys(game.questCards).length === game.team.length) resolveQuest(room);
      return null;
    }

    case 'ladyCheck': {
      if (room.phase !== 'lady') return 'Lady of the Lake is not being used now.';
      if (game.ladyHolder !== playerId) return 'You do not hold the Lady of the Lake.';
      const targetId = action.targetId;
      if (!game.roles[targetId] || targetId === playerId) return 'Pick another player.';
      if (game.ladyPastHolders.includes(targetId)) return 'That player already held the Lady of the Lake.';
      game.ladyChecks.push({ holderId: playerId, targetId, targetIsEvil: isEvil(game.roles[targetId]) });
      game.ladyHolder = targetId;
      game.ladyPastHolders.push(targetId);
      passLeaderAndStartTeamPhase(room);
      return null;
    }

    case 'assassinate': {
      if (room.phase !== 'assassin') return 'It is not time to assassinate.';
      if (game.roles[playerId] !== 'assassin') return 'Only the Assassin can choose.';
      const targetId = action.targetId;
      if (!game.roles[targetId] || targetId === playerId) return 'Pick another player.';
      if (knowledgeFor(game, playerId).ids.includes(targetId)) return 'That player is on your Evil team.';
      game.assassinTarget = targetId;
      if (game.roles[targetId] === 'merlin') {
        endGame(room, 'evil', 'The Assassin found Merlin.');
      } else {
        endGame(room, 'good', 'Three quests succeeded and Merlin stayed hidden.');
      }
      return null;
    }

    default:
      return 'Unknown action.';
  }
}

// What a player secretly knows at the start, based on their role.
function knowledgeFor(game, playerId) {
  const role = game.roles[playerId];
  const others = game.seatOrder.filter((id) => id !== playerId);
  if (role === 'merlin') {
    const mordredNote = Object.values(game.roles).includes('mordred') ? ' (Mordred is hidden from you)' : '';
    return { text: `These players are Evil${mordredNote}:`, ids: others.filter((id) => isEvil(game.roles[id]) && game.roles[id] !== 'mordred') };
  }
  if (role === 'percival') {
    const ids = others.filter((id) => ['merlin', 'morgana'].includes(game.roles[id]));
    const text = ids.length === 2 ? 'One of these is Merlin, the other is Morgana:' : 'This is Merlin:';
    return { text, ids };
  }
  if (isEvil(role) && role !== 'oberon') {
    const oberonNote = Object.values(game.roles).includes('oberon') ? ' (Oberon is hidden from you)' : '';
    return { text: `Your fellow Evil players${oberonNote}:`, ids: others.filter((id) => isEvil(game.roles[id]) && game.roles[id] !== 'oberon') };
  }
  return null;
}

// The game state one player is allowed to see.
function gameViewFor(room, playerId) {
  const game = room.game;
  if (!game) return null;
  const playerCount = game.seatOrder.length;
  const isPlayer = Boolean(game.roles[playerId]);
  const view = {
    seatOrder: game.seatOrder,
    leaderId: leaderId(game),
    questIndex: game.questIndex,
    teamSizes: TEAM_SIZES_BY_PLAYERS[playerCount],
    failsNeeded: [0, 1, 2, 3, 4].map((index) => failsNeededToFail(playerCount, index)),
    questResults: game.questResults,
    rejectCount: game.rejectCount,
    team: game.team,
    draftTeam: game.draftTeam,
    votedIds: Object.keys(game.votes),
    lastVote: game.lastVote,
    playedIds: Object.keys(game.questCards),
    ladyHolder: game.ladyHolder,
    ladyPastHolders: game.ladyPastHolders,
    ladyChecks: game.ladyChecks.map((check) => ({
      holderId: check.holderId,
      targetId: check.targetId,
      // Only the player who used the Lady sees the answer.
      targetIsEvil: check.holderId === playerId ? check.targetIsEvil : undefined,
    })),
    myRole: isPlayer ? game.roles[playerId] : null,
    myKnowledge: isPlayer ? knowledgeFor(game, playerId) : null,
    myVote: playerId in game.votes ? game.votes[playerId] : null,
    myQuestCardPlayed: playerId in game.questCards,
    winner: game.winner,
    endReason: game.endReason,
    assassinTarget: game.assassinTarget,
    allRoles: room.phase === 'end' ? game.roles : null,
  };
  return view;
}

module.exports = {
  MIN_PLAYERS,
  MAX_PLAYERS,
  EVIL_COUNT_BY_PLAYERS,
  TEAM_SIZES_BY_PLAYERS,
  isEvil,
  failsNeededToFail,
  buildRoleList,
  startGame,
  handleAction,
  knowledgeFor,
  gameViewFor,
  leaderId,
};
