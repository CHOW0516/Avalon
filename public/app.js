// Avalon phone client. Talks to the server over WebSocket and redraws the page on every update.

const ROLE_INFO = {
  merlin: { name: 'Merlin', icon: '🧙', side: 'good', text: 'You know who is Evil. Guide Good quietly. If the Assassin finds you at the end, Evil wins.' },
  percival: { name: 'Percival', icon: '🛡️', side: 'good', text: 'You know who Merlin is. If Morgana is in the game, she looks like Merlin too. Protect Merlin.' },
  servant: { name: 'Loyal Servant', icon: '⚔️', side: 'good', text: 'You serve King Arthur. Find the Evil players and keep them off quests.' },
  assassin: { name: 'Assassin', icon: '🗡️', side: 'evil', text: 'Fail quests. If Good wins three quests, you get one guess at who Merlin is. Guess right and Evil wins.' },
  morgana: { name: 'Morgana', icon: '🔮', side: 'evil', text: 'You look like Merlin to Percival. Use it to confuse Good.' },
  mordred: { name: 'Mordred', icon: '🐍', side: 'evil', text: 'Merlin cannot see you. Fail quests without being caught.' },
  oberon: { name: 'Oberon', icon: '🌑', side: 'evil', text: 'You are Evil, but you do not know the other Evil players and they do not know you.' },
  minion: { name: 'Minion of Mordred', icon: '💀', side: 'evil', text: 'Fail quests without being caught. Work with your fellow Evil players.' },
};

const OPTIONAL_ROLES = [
  { key: 'percival', label: 'Percival', side: 'good', hint: 'Good. Sees Merlin.' },
  { key: 'morgana', label: 'Morgana', side: 'evil', hint: 'Evil. Looks like Merlin to Percival.' },
  { key: 'mordred', label: 'Mordred', side: 'evil', hint: 'Evil. Hidden from Merlin.' },
  { key: 'oberon', label: 'Oberon', side: 'evil', hint: 'Evil. Unknown to other Evil players.' },
  { key: 'lady', label: 'Lady of the Lake', side: 'neutral', hint: 'Check one player\'s loyalty after quests 2, 3 and 4. Best for 7+ players.' },
];

const EVIL_COUNT_BY_PLAYERS = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 };
const PHOTO_SIZE = 200;

const appElement = document.getElementById('app');
const toastElement = document.getElementById('toast');
const bannerElement = document.getElementById('connection-banner');

let socket = null;
let roomState = null; // latest state from the server, null when not in a room
let roleVisible = false;
let selectedTeam = new Set();
let selectedTarget = null;
let selectionKey = '';
let photoUploadedThisConnection = false;
let reconnectTimer = null;
let historyOpen = false;
let lastTurnKey = '';
let seatLinkInfo = null; // { playerId, link } while the host is sharing a rejoin link

// ---------- Local storage helpers (they can fail in private mode, so always wrapped) ----------

function readStorage(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function writeStorage(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* ignore */ }
}

// ---------- Small helpers ----------

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function showToast(message) {
  toastElement.textContent = message;
  toastElement.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toastElement.hidden = true; }, 3500);
}

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  } else {
    showToast('Not connected. Trying again…');
  }
}

function playerById(id) {
  return roomState.players.find((player) => player.id === id) || { id, name: '?', photoVersion: 0 };
}

function nameOf(id) {
  return id === roomState.you ? 'You' : escapeHtml(playerById(id).name);
}

function avatarHtml(id, sizeClass = '') {
  const player = playerById(id);
  if (player.photoVersion > 0) {
    return `<img class="avatar ${sizeClass}" src="/photo/${roomState.code}/${player.id}?v=${player.photoVersion}" alt="">`;
  }
  let hue = 0;
  for (const character of player.name) hue = (hue * 31 + character.charCodeAt(0)) % 360;
  return `<div class="avatar placeholder ${sizeClass}" style="background:hsl(${hue} 45% 38%)">${escapeHtml(player.name.charAt(0).toUpperCase())}</div>`;
}

function chipList(ids) {
  return `<div class="chips">${ids.map((id) => `<span class="chip">${avatarHtml(id, 'small')}${nameOf(id)}</span>`).join('')}</div>`;
}

// Shrinks a photo on the phone to a small square JPEG before sending it.
function resizePhoto(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      const side = Math.min(image.width, image.height);
      const canvas = document.createElement('canvas');
      canvas.width = PHOTO_SIZE;
      canvas.height = PHOTO_SIZE;
      canvas.getContext('2d').drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
      URL.revokeObjectURL(objectUrl);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read that photo. Try a JPEG or PNG.'));
    };
    image.src = objectUrl;
  });
}

async function handlePhotoInput(input, onDone) {
  const file = input.files && input.files[0];
  if (!file) return;
  try {
    const dataUrl = await resizePhoto(file);
    writeStorage('avalonPhoto', dataUrl);
    onDone(dataUrl);
  } catch (error) {
    showToast(error.message);
  }
  input.value = '';
}

// ---------- Connection ----------

function connect() {
  clearTimeout(reconnectTimer);
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${location.host}`);
  photoUploadedThisConnection = false;

  socket.onopen = () => {
    bannerElement.hidden = true;
    const session = readStorage('avalonSession');
    if (session) send({ type: 'rejoin', code: session.code, playerId: session.playerId, token: session.token });
  };

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'joined') {
      writeStorage('avalonSession', { code: message.code, playerId: message.playerId, token: message.token });
      history.replaceState(null, '', '/');
    } else if (message.type === 'state') {
      receiveState(message.state);
    } else if (message.type === 'seatLink') {
      const session = readStorage('avalonSession');
      seatLinkInfo = { playerId: message.playerId, link: `${location.origin}/?room=${session.code}&seat=${message.playerId}&key=${message.token}` };
      render();
    } else if (message.type === 'error') {
      showToast(message.message);
    } else if (message.type === 'sessionExpired' || message.type === 'left') {
      if (message.type === 'sessionExpired' && readStorage('avalonSession')) showToast('That room has ended, or your seat moved to another phone.');
      writeStorage('avalonSession', null);
      roomState = null;
      renderHome();
    }
  };

  socket.onclose = () => {
    if (readStorage('avalonSession')) bannerElement.hidden = false;
    reconnectTimer = setTimeout(connect, 1500);
  };
}

// Phones pause pages in the background; reconnect as soon as the page is visible again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') connect();
});

function receiveState(state) {
  roomState = state;

  // Upload the saved photo once if the server does not have one for me yet.
  const me = state.players.find((player) => player.id === state.you);
  const savedPhoto = readStorage('avalonPhoto');
  if (me && me.photoVersion === 0 && savedPhoto && !photoUploadedThisConnection) {
    photoUploadedThisConnection = true;
    send({ type: 'setPhoto', dataUrl: savedPhoto });
  }

  // Clear selections whenever a new choice starts.
  const game = state.game;
  const newKey = game ? `${state.phase}-${game.questIndex}-${game.rejectCount}-${game.leaderId}` : state.phase;
  if (newKey !== selectionKey) {
    selectionKey = newKey;
    // A reloaded leader gets back the picks they already made.
    selectedTeam = new Set(game ? game.draftTeam : []);
    selectedTarget = null;
  }
  if (!game) roleVisible = false;
  if (seatLinkInfo && playerById(seatLinkInfo.playerId).connected) seatLinkInfo = null;

  // Tell the player when the game is waiting for them.
  const myTurn = isMyTurn();
  const turnKey = myTurn ? newKey : '';
  if (myTurn && turnKey !== lastTurnKey && navigator.vibrate) navigator.vibrate([200, 100, 200]);
  lastTurnKey = turnKey;
  document.title = myTurn ? '● Your turn · Avalon Night' : 'Avalon Night';

  render();
}

function isMyTurn() {
  const game = roomState && roomState.game;
  if (!game || !game.myRole) return false;
  const you = roomState.you;
  switch (roomState.phase) {
    case 'team': return game.leaderId === you;
    case 'vote': return game.myVote === null;
    case 'quest': return game.team.includes(you) && !game.myQuestCardPlayed;
    case 'lady': return game.ladyHolder === you;
    case 'assassin': return game.myRole === 'assassin';
    default: return false;
  }
}

// Shown to everyone but the host when the host's phone is offline.
function renderHostOffline() {
  const host = playerById(roomState.hostId);
  if (host.connected || roomState.hostId === roomState.you) return '';
  return `<section class="panel">
    <p>The host (${escapeHtml(host.name)}) is offline.</p>
    <button class="secondary wide" data-action="claimHost">Become host</button>
  </section>`;
}

function renderSeatLink() {
  if (!seatLinkInfo) return '';
  const name = escapeHtml(playerById(seatLinkInfo.playerId).name);
  return `<section class="panel highlight">
    <h2>Rejoin link for ${name}</h2>
    <p>Send this link to ${name}. Opening it on any phone takes over their seat. Their old phone is signed out. Everyone can see that you made this link.</p>
    <input readonly value="${escapeHtml(seatLinkInfo.link)}">
    <div class="row two seat-link-buttons">
      <button class="primary" data-action="shareSeatLink">Share link</button>
      <button class="secondary" data-action="closeSeatLink">Done</button>
    </div>
  </section>`;
}

// ---------- Home screen ----------

function renderHome() {
  const savedName = readStorage('avalonName') || '';
  const savedPhoto = readStorage('avalonPhoto');
  const codeFromLink = (new URLSearchParams(location.search).get('room') || '').toUpperCase();

  appElement.innerHTML = `
    <section class="hero">
      <div class="hero-sword">⚔️</div>
      <h1>Avalon Night</h1>
      <p class="muted">A game of loyalty and lies for 5 to 10 friends.</p>
    </section>

    <section class="card">
      <label class="photo-picker">
        <input type="file" accept="image/*" id="home-photo" hidden>
        <span class="photo-preview" id="home-photo-preview">
          ${savedPhoto ? `<img class="avatar large" src="${savedPhoto}" alt="">` : '<span class="avatar large placeholder">📷</span>'}
        </span>
        <span class="link">${savedPhoto ? 'Change photo' : 'Add your photo'}</span>
      </label>
      <label class="field-label" for="home-name">Your name</label>
      <input id="home-name" maxlength="20" autocomplete="nickname" placeholder="e.g. Sam" value="${escapeHtml(savedName)}">
    </section>

    <section class="card">
      <label class="field-label" for="home-code">Join a room</label>
      <div class="row">
        <input id="home-code" maxlength="4" placeholder="CODE" autocapitalize="characters" autocomplete="off" value="${escapeHtml(codeFromLink)}">
        <button class="primary" data-action="join">Join</button>
      </div>
      <div class="divider"><span>or</span></div>
      <button class="secondary wide" data-action="create">Create a new room</button>
    </section>
  `;

  document.getElementById('home-photo').addEventListener('change', (event) => {
    handlePhotoInput(event.target, (dataUrl) => {
      document.getElementById('home-photo-preview').innerHTML = `<img class="avatar large" src="${dataUrl}" alt="">`;
    });
  });
}

function readHomeName() {
  const name = document.getElementById('home-name').value.trim();
  if (!name) {
    showToast('Please enter your name.');
    return null;
  }
  writeStorage('avalonName', name);
  return name;
}

// ---------- Lobby ----------

function renderLobby() {
  const { players, settings, hostId, you, code } = roomState;
  const isHost = hostId === you;
  const playerCount = players.length;
  const evilCount = EVIL_COUNT_BY_PLAYERS[playerCount];
  const specialEvilCount = 1 + ['morgana', 'mordred', 'oberon'].filter((key) => settings[key]).length;

  const warnings = [];
  if (evilCount && specialEvilCount > evilCount) warnings.push(`Too many Evil roles for ${playerCount} players (only ${evilCount} Evil).`);
  if (settings.percival && playerCount === 5 && !settings.morgana && !settings.mordred) warnings.push('With 5 players and Percival, the rules suggest adding Morgana or Mordred.');
  if (settings.lady && playerCount < 7) warnings.push('Lady of the Lake works best with 7 or more players.');

  appElement.innerHTML = `
    <header class="top-bar">
      <div><span class="muted">Room</span> <span class="room-code">${code}</span></div>
      <button class="small secondary" data-action="share">Invite</button>
    </header>

    ${renderHostOffline()}
    <section class="card">
      <h2>Players <span class="muted">(${playerCount}/10)</span></h2>
      <ul class="player-list">
        ${players.map((player) => `
          <li class="player-row">
            ${avatarHtml(player.id)}
            <span class="player-name">${escapeHtml(player.name)}${player.id === you ? ' <span class="muted">(you)</span>' : ''}</span>
            ${player.id === hostId ? '<span class="badge">Host</span>' : ''}
            ${player.connected ? '' : '<span class="badge offline">Offline</span>'}
            ${isHost && player.id !== you ? `<button class="small ghost" data-action="kick" data-id="${player.id}">Remove</button>` : ''}
          </li>`).join('')}
      </ul>
      <label class="link photo-change">
        <input type="file" accept="image/*" id="lobby-photo" hidden>
        Change my photo
      </label>
    </section>

    <section class="card">
      <h2>Roles</h2>
      <p class="muted">${evilCount ? `${playerCount} players: <b class="good-text">${playerCount - evilCount} Good</b>, <b class="evil-text">${evilCount} Evil</b>` : 'Need 5 to 10 players.'}</p>
      <p class="muted">Always in: <b class="good-text">Merlin</b> and <b class="evil-text">Assassin</b>.</p>
      ${OPTIONAL_ROLES.map((role) => `
        <label class="toggle ${role.side}">
          <input type="checkbox" data-setting="${role.key}" ${settings[role.key] ? 'checked' : ''} ${isHost ? '' : 'disabled'}>
          <span><b>${role.label}</b><br><span class="muted">${role.hint}</span></span>
        </label>`).join('')}
      ${warnings.map((warning) => `<p class="warning">${warning}</p>`).join('')}
    </section>

    ${isHost
      ? `<button class="primary wide" data-action="start" ${evilCount ? '' : 'disabled'}>Start game</button>`
      : '<p class="center muted">Waiting for the host to start…</p>'}
    <button class="ghost wide" data-action="leave">Leave room</button>
  `;

  document.getElementById('lobby-photo').addEventListener('change', (event) => {
    handlePhotoInput(event.target, (dataUrl) => send({ type: 'setPhoto', dataUrl }));
  });
  appElement.querySelectorAll('[data-setting]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => send({ type: 'setSettings', settings: { [checkbox.dataset.setting]: checkbox.checked } }));
  });
}

// ---------- Game ----------

function renderBoard(game) {
  const quests = game.teamSizes.map((size, index) => {
    const result = game.questResults[index];
    let stateClass = '';
    if (result) stateClass = result.success ? 'success' : 'fail';
    else if (index === game.questIndex && roomState.phase !== 'end') stateClass = 'current';
    const symbol = result ? (result.success ? '✓' : '✗') : size;
    return `<div class="quest ${stateClass}">
      <span class="quest-symbol">${symbol}</span>
      ${game.failsNeeded[index] === 2 ? '<span class="quest-note">2 fails</span>' : ''}
    </div>`;
  }).join('');
  const rejectDots = [1, 2, 3, 4, 5].map((number) => `<span class="dot ${number <= game.rejectCount ? 'filled' : ''}"></span>`).join('');
  return `
    <section class="board">
      <div class="quests">${quests}</div>
      <div class="reject-track"><span class="muted">Rejected teams</span> ${rejectDots} <span class="muted">5 = Evil wins</span></div>
    </section>`;
}

function renderRoleCard(game) {
  if (!game.myRole) return '';
  if (!roleVisible) {
    return '<button class="role-toggle" data-action="toggleRole">🔒 Tap to see your secret role</button>';
  }
  const info = ROLE_INFO[game.myRole];
  const knowledge = game.myKnowledge;
  const myChecks = game.ladyChecks.filter((check) => check.holderId === roomState.you);
  return `
    <section class="role-card ${info.side}" data-action="toggleRole">
      <div class="role-icon">${info.icon}</div>
      <div class="role-side">${info.side === 'good' ? 'Good · Loyal to Arthur' : 'Evil · Minion of Mordred'}</div>
      <h2>${info.name}</h2>
      <p>${info.text}</p>
      ${knowledge ? `<p class="knowledge-title">${knowledge.text}</p>${knowledge.ids.length ? chipList(knowledge.ids) : '<p class="muted">No one.</p>'}` : ''}
      ${myChecks.map((check) => `<p class="knowledge-title">Lady of the Lake: ${nameOf(check.targetId)} is <b>${check.targetIsEvil ? 'Evil' : 'Good'}</b>.</p>`).join('')}
      <p class="muted small-text">Tap to hide</p>
    </section>`;
}

function waitingFor(ids) {
  if (!ids.length) return '';
  return `<p class="muted">Waiting for: ${ids.map(nameOf).join(', ')}</p>`;
}

function renderPhasePanel(game) {
  const { phase, you } = roomState;
  const questNumber = game.questIndex + 1;
  const teamSize = game.teamSizes[game.questIndex];
  const isLeader = game.leaderId === you;

  if (phase === 'team') {
    if (isLeader) {
      return `<section class="panel highlight">
        <h2>You are the leader</h2>
        <p>Pick <b>${teamSize}</b> players for Quest ${questNumber}. Tap players below. You can pick yourself.</p>
        <button class="primary wide" data-action="proposeTeam" ${selectedTeam.size === teamSize ? '' : 'disabled'}>Propose team (${selectedTeam.size}/${teamSize})</button>
      </section>`;
    }
    const picked = game.draftTeam;
    return `<section class="panel"><h2>Quest ${questNumber}</h2>
      <p>${nameOf(game.leaderId)} is picking ${teamSize} players. Discuss!</p>
      <p class="muted">Picked so far (${picked.length}/${teamSize}):</p>
      ${picked.length ? chipList(picked) : '<p class="muted">No one yet.</p>'}
    </section>`;
  }

  if (phase === 'vote') {
    const votedNo = game.myVote === false;
    const votedYes = game.myVote === true;
    const notVoted = game.seatOrder.filter((id) => !game.votedIds.includes(id));
    return `<section class="panel highlight">
      <h2>Vote on ${nameOf(game.leaderId)}'s team</h2>
      ${chipList(game.team)}
      <div class="row two">
        <button class="vote approve ${votedYes ? 'chosen' : ''}" data-action="vote" data-approve="1">👍 Approve</button>
        <button class="vote reject ${votedNo ? 'chosen' : ''}" data-action="vote" data-approve="0">👎 Reject</button>
      </div>
      <p class="muted">${game.myVote === null ? 'Your vote is secret until everyone has voted.' : 'Vote saved. You can change it until everyone votes.'}</p>
      ${waitingFor(notVoted)}
    </section>`;
  }

  if (phase === 'quest') {
    const onTeam = game.team.includes(you);
    const notPlayed = game.team.filter((id) => !game.playedIds.includes(id));
    const twoFailsNote = game.failsNeeded[game.questIndex] === 2 ? '<p class="warning">This quest needs 2 Fail cards to fail.</p>' : '';
    if (onTeam && !game.myQuestCardPlayed) {
      return `<section class="panel highlight">
        <h2>Quest ${questNumber}: play your card</h2>
        <p>Hide your screen. Good players must play Success.</p>
        ${twoFailsNote}
        <div class="row two">
          <button class="quest-card success" data-action="playQuest" data-success="1">🏆<br>Success</button>
          <button class="quest-card fail" data-action="playQuest" data-success="0">🔥<br>Fail</button>
        </div>
      </section>`;
    }
    return `<section class="panel">
      <h2>Quest ${questNumber} in progress</h2>
      ${chipList(game.team)}
      ${twoFailsNote}
      ${onTeam ? '<p>Card played.</p>' : ''}
      ${waitingFor(notPlayed)}
    </section>`;
  }

  if (phase === 'lady') {
    if (game.ladyHolder === you) {
      const choices = game.seatOrder.filter((id) => id !== you && !game.ladyPastHolders.includes(id));
      return `<section class="panel highlight">
        <h2>🌊 Lady of the Lake</h2>
        <p>Pick a player to secretly see if they are Good or Evil. Tap a player below.</p>
        <p class="muted">Can pick: ${choices.map(nameOf).join(', ')}</p>
        <button class="primary wide" data-action="ladyCheck" ${selectedTarget ? '' : 'disabled'}>Look at ${selectedTarget ? nameOf(selectedTarget) : '…'}</button>
      </section>`;
    }
    return `<section class="panel"><h2>🌊 Lady of the Lake</h2><p>${nameOf(game.ladyHolder)} is choosing someone to look at.</p></section>`;
  }

  if (phase === 'assassin') {
    if (game.myRole === 'assassin') {
      return `<section class="panel highlight evil-panel">
        <h2>🗡️ Find Merlin</h2>
        <p>Good won 3 quests. Talk with your Evil team, then tap who you think is Merlin. You get one guess.</p>
        <button class="danger wide" data-action="assassinate" ${selectedTarget ? '' : 'disabled'}>Assassinate ${selectedTarget ? nameOf(selectedTarget) : '…'}</button>
      </section>`;
    }
    return `<section class="panel"><h2>Good won 3 quests!</h2><p>Evil has one last chance: the Assassin will try to name Merlin.</p></section>`;
  }

  return '';
}

function renderHistory(game) {
  const parts = [];
  const lastResult = game.questResults[game.questResults.length - 1];
  if (lastResult && roomState.phase !== 'quest') {
    const number = game.questResults.length;
    parts.push(`<p><b>Quest ${number}:</b> ${lastResult.success ? '<span class="good-text">Success</span>' : '<span class="evil-text">Failed</span>'} with ${lastResult.failCount} Fail card${lastResult.failCount === 1 ? '' : 's'}.</p>`);
  }
  if (game.lastVote && roomState.phase !== 'vote') {
    const vote = game.lastVote;
    const approveCount = Object.values(vote.votes).filter(Boolean).length;
    const rejectCount = Object.values(vote.votes).length - approveCount;
    parts.push(`<p><b>Last vote</b> on ${nameOf(vote.leaderId)}'s team: ${vote.approved ? '<span class="good-text">Approved</span>' : '<span class="evil-text">Rejected</span>'} ${approveCount}–${rejectCount}</p>
      <div class="chips">${game.seatOrder.map((id) => `<span class="chip ${vote.votes[id] ? 'yes' : 'no'}">${avatarHtml(id, 'small')}${nameOf(id)} ${vote.votes[id] ? '👍' : '👎'}</span>`).join('')}</div>`);
  }
  for (const check of game.ladyChecks) {
    parts.push(`<p class="muted">🌊 ${nameOf(check.holderId)} looked at ${nameOf(check.targetId)}.</p>`);
  }
  for (const id of game.seatHandoffs) {
    parts.push(`<p class="muted">🔗 The host made a rejoin link for ${nameOf(id)}.</p>`);
  }
  if (game.history.length) {
    const names = (ids) => (ids.length ? ids.map(nameOf).join(', ') : 'no one');
    const entries = game.history.map((entry) => {
      let outcome = '<span class="evil-text">Team rejected</span>';
      if (entry.approved && entry.success === null) outcome = 'Team approved';
      else if (entry.approved && entry.success) outcome = `<span class="good-text">Quest succeeded</span>${entry.failCount ? ` (${entry.failCount} Fail)` : ''}`;
      else if (entry.approved) outcome = `<span class="evil-text">Quest failed</span> (${entry.failCount} Fail)`;
      return `<div class="log-entry">
        <p><b>Quest ${entry.questIndex + 1}</b> · Leader: ${nameOf(entry.leaderId)} · ${outcome}</p>
        <p class="muted">Team: ${names(entry.team)}</p>
        <p class="muted">👍 ${names(game.seatOrder.filter((id) => entry.votes[id]))}</p>
        <p class="muted">👎 ${names(game.seatOrder.filter((id) => !entry.votes[id]))}</p>
      </div>`;
    }).join('');
    parts.push(`<details class="log" ${historyOpen ? 'open' : ''}><summary>Full history (${game.history.length} vote${game.history.length === 1 ? '' : 's'})</summary>${entries}</details>`);
  }
  return parts.length ? `<section class="card history">${parts.join('')}</section>` : '';
}

function renderPlayers(game) {
  const { phase, you } = roomState;
  const teamSize = game.teamSizes[game.questIndex];
  let pickable = () => false;
  if (phase === 'team' && game.leaderId === you) pickable = () => true;
  if (phase === 'lady' && game.ladyHolder === you) pickable = (id) => id !== you && !game.ladyPastHolders.includes(id);
  if (phase === 'assassin' && game.myRole === 'assassin') pickable = (id) => id !== you && !game.myKnowledge.ids.includes(id);

  const rows = game.seatOrder.map((id) => {
    const player = playerById(id);
    const isLeaderPicking = phase === 'team' && game.leaderId === you;
    let selected = selectedTarget === id;
    if (isLeaderPicking) selected = selectedTeam.has(id);
    else if (phase === 'team') selected = game.draftTeam.includes(id);
    const onTeam = ['vote', 'quest'].includes(phase) && game.team.includes(id);
    const badges = [];
    if (id === game.leaderId) badges.push('<span class="badge leader">Leader</span>');
    if (phase === 'team' && selected) badges.push('<span class="badge team">Picked</span>');
    if (onTeam) badges.push('<span class="badge team">On quest</span>');
    if (id === game.ladyHolder) badges.push('<span class="badge lady">🌊 Lady</span>');
    if (phase === 'vote' && game.votedIds.includes(id)) badges.push('<span class="badge done">Voted</span>');
    if (phase === 'quest' && game.playedIds.includes(id)) badges.push('<span class="badge done">Played</span>');
    if (!player.connected) badges.push('<span class="badge offline">Offline</span>');
    if (!player.connected && roomState.hostId === you && id !== you) badges.push(`<button class="small secondary" data-action="seatLink" data-id="${id}">Rejoin link</button>`);
    const canPick = pickable(id);
    return `<li class="player-row ${canPick ? 'pickable' : ''} ${selected ? 'selected' : ''}" ${canPick ? `data-action="pick" data-id="${id}"` : ''}>
      ${avatarHtml(id)}
      <span class="player-name">${escapeHtml(player.name)}${id === you ? ' <span class="muted">(you)</span>' : ''}</span>
      ${badges.join('')}
      ${canPick ? `<span class="check">${selected ? '✓' : ''}</span>` : ''}
    </li>`;
  }).join('');
  const hint = phase === 'team' && game.leaderId === you ? ` <span class="muted">(${selectedTeam.size}/${teamSize} picked)</span>` : '';
  return `<section class="card"><h2>Players${hint}</h2><ul class="player-list">${rows}</ul></section>`;
}

function renderEnd(game) {
  const { hostId, you } = roomState;
  const goodWon = game.winner === 'good';
  const target = game.assassinTarget;
  return `
    <section class="end-banner ${goodWon ? 'good' : 'evil'}">
      <div class="role-icon">${goodWon ? '🏰' : '🐍'}</div>
      <h1>${goodWon ? 'Good wins!' : 'Evil wins!'}</h1>
      <p>${escapeHtml(game.endReason)}</p>
      ${target ? `<p>The Assassin chose ${nameOf(target)} (${ROLE_INFO[game.allRoles[target]].name}).</p>` : ''}
    </section>
    <section class="card">
      <h2>Everyone's roles</h2>
      <ul class="player-list">
        ${game.seatOrder.map((id) => {
          const info = ROLE_INFO[game.allRoles[id]];
          return `<li class="player-row">${avatarHtml(id)}
            <span class="player-name">${escapeHtml(playerById(id).name)}</span>
            <span class="badge ${info.side}">${info.icon} ${info.name}</span></li>`;
        }).join('')}
      </ul>
    </section>
    ${hostId === you ? '<button class="primary wide" data-action="backToLobby">Play again</button>' : '<p class="center muted">The host can start another game.</p>'}
    <button class="ghost wide" data-action="leave">Leave room</button>`;
}

function renderGame() {
  const game = roomState.game;
  const header = `
    <header class="top-bar">
      <div><span class="muted">Room</span> <span class="room-code">${roomState.code}</span></div>
      <div class="muted">${roomState.phase === 'end' ? 'Game over' : `Quest ${game.questIndex + 1} of 5`}</div>
    </header>`;
  if (roomState.phase === 'end') {
    appElement.innerHTML = header + renderBoard(game) + renderHostOffline() + renderEnd(game) + renderHistory(game);
    return;
  }
  const turnBanner = isMyTurn() ? '<div class="turn-banner">Your turn</div>' : '';
  appElement.innerHTML = header + turnBanner + renderBoard(game) + renderHostOffline() + renderSeatLink() + renderPhasePanel(game) + renderRoleCard(game) + renderPlayers(game) + renderHistory(game);
}

function render() {
  if (!roomState) return renderHome();
  if (roomState.phase === 'lobby') return renderLobby();
  return renderGame();
}

// ---------- Button handling ----------

appElement.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const action = target.dataset.action;

  switch (action) {
    case 'create': {
      const name = readHomeName();
      if (name) send({ type: 'create', name });
      break;
    }
    case 'join': {
      const name = readHomeName();
      const code = document.getElementById('home-code').value.trim().toUpperCase();
      if (!name) break;
      if (code.length !== 4) {
        showToast('Room codes have 4 letters.');
        break;
      }
      send({ type: 'join', code, name });
      break;
    }
    case 'share': {
      const link = `${location.origin}/?room=${roomState.code}`;
      try {
        if (navigator.share) await navigator.share({ title: 'Join my Avalon game', text: `Room code ${roomState.code}`, url: link });
        else {
          await navigator.clipboard.writeText(link);
          showToast('Invite link copied.');
        }
      } catch { /* the person closed the share sheet */ }
      break;
    }
    case 'claimHost':
      send({ type: 'claimHost' });
      break;
    case 'seatLink':
      send({ type: 'seatLink', playerId: target.dataset.id });
      break;
    case 'shareSeatLink':
      try {
        if (navigator.share) await navigator.share({ title: 'Rejoin our Avalon game', url: seatLinkInfo.link });
        else {
          await navigator.clipboard.writeText(seatLinkInfo.link);
          showToast('Rejoin link copied.');
        }
      } catch { /* the person closed the share sheet */ }
      break;
    case 'closeSeatLink':
      seatLinkInfo = null;
      render();
      break;
    case 'kick':
      send({ type: 'kick', playerId: target.dataset.id });
      break;
    case 'start':
      send({ type: 'start' });
      break;
    case 'leave':
      send({ type: 'leave' });
      break;
    case 'backToLobby':
      send({ type: 'backToLobby' });
      break;
    case 'toggleRole':
      roleVisible = !roleVisible;
      render();
      break;
    case 'pick': {
      const id = target.dataset.id;
      if (roomState.phase === 'team') {
        const teamSize = roomState.game.teamSizes[roomState.game.questIndex];
        if (selectedTeam.has(id)) selectedTeam.delete(id);
        else if (selectedTeam.size < teamSize) selectedTeam.add(id);
        else showToast(`The team has ${teamSize} players. Tap someone to remove them first.`);
        send({ type: 'selectTeam', team: [...selectedTeam] });
      } else {
        selectedTarget = selectedTarget === id ? null : id;
      }
      render();
      break;
    }
    case 'proposeTeam':
      send({ type: 'proposeTeam', team: [...selectedTeam] });
      break;
    case 'vote':
      send({ type: 'vote', approve: target.dataset.approve === '1' });
      break;
    case 'playQuest':
      send({ type: 'playQuest', success: target.dataset.success === '1' });
      break;
    case 'ladyCheck':
      send({ type: 'ladyCheck', targetId: selectedTarget });
      break;
    case 'assassinate':
      send({ type: 'assassinate', targetId: selectedTarget });
      break;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.id === 'home-code') appElement.querySelector('[data-action="join"]').click();
});

// Remember whether the history list is open, so it stays open across updates.
appElement.addEventListener('toggle', (event) => {
  if (event.target.classList.contains('log')) historyOpen = event.target.open;
}, true);

// A rejoin link from the host signs this phone in to that player's seat.
const linkParams = new URLSearchParams(location.search);
if (linkParams.get('room') && linkParams.get('seat') && linkParams.get('key')) {
  writeStorage('avalonSession', { code: linkParams.get('room').toUpperCase(), playerId: linkParams.get('seat'), token: linkParams.get('key') });
  history.replaceState(null, '', '/');
}

renderHome();
connect();
