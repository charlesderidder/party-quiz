'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createPlayer({ audio = true, storageFails = false, joinState = null, deferredJoin = false, resetFails = false } = {}) {
  const elements = new Map();
  const listeners = {};
  const storage = new Map([['unrelated', 'preserve']]);
  const errors = [];
  let tones = 0;
  let disconnected = false;
  let reloaded = false;
  const joins = [];
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '', checked: false, textContent: '', style: {}, dataset: {},
        listeners: {}, classList: { add() {}, remove() {} },
        addEventListener(name, fn) { this.listeners[name] = fn; },
        querySelectorAll() { return []; }
      });
    }
    return elements.get(id);
  }
  const socket = {
    connected: true,
    on(name, fn) { listeners[name] = fn; },
    timeout() { return this; },
    disconnect() { disconnected = true; },
    emit(name, payload, callback) {
      if (name === 'player_join') {
        const respond = () => callback({
          success: true,
          player: { id: 'player', name: payload.name, position: 1, score: 0 },
          playerSecret: 'secret',
          state: joinState
        });
        joins.push(respond);
        if (!deferredJoin) respond();
      } else if (name === 'player_reset') {
        if (resetFails) callback(new Error('timeout'));
        else {
          if (listeners.player_session_ended) listeners.player_session_ended();
          callback(null, { success: true });
        }
      }
    }
  };
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    createOscillator() {
      return {
        frequency: { setValueAtTime() {} }, connect() {},
        start() { tones++; }, stop() {}
      };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
  }
  const context = {
    io: () => socket,
    document: { getElementById: element, body: { classList: { toggle() {} } } },
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem(key) {
        if (storageFails) throw new Error('Storage unavailable');
        storage.delete(key);
      }
    },
    location: { reload() { reloaded = true; } },
    navigator: {},
    setTimeout: () => 1,
    clearTimeout() {},
    console: { warn() {}, error: (...args) => errors.push(args) }
  };
  context.window = context;
  if (audio) context.AudioContext = AudioContext;
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'play', 'play.js'), 'utf8');
  vm.runInNewContext(source, context);
  element('inputPlayerName').value = 'Speler';
  return { element, listeners, storage, errors, context, socket, joins, tones: () => tones, disconnected: () => disconnected, reloaded: () => reloaded };
}

async function resetPlayer(player) {
  player.element('btnResetPlayer').listeners.click();
  await player.element('btnConfirmReset').listeners.click();
}

test('winner sound requires joining and plays only once per round', () => {
  const player = createPlayer();
  player.listeners.fastest_correct({ roundId: 'one' });
  assert.equal(player.tones(), 0);
  player.element('btnJoinGame').listeners.click();
  assert.equal(player.tones(), 0);
  player.listeners.fastest_correct({ roundId: 'one' });
  assert.equal(player.tones(), 3);
  assert.match(player.element('pushBannerTitle').textContent, /snelst/);
  player.listeners.fastest_correct({ roundId: 'one' });
  assert.equal(player.tones(), 3);
  player.listeners.fastest_correct({ roundId: 'two' });
  assert.equal(player.tones(), 6);
});

test('winner still sees feedback when audio is unavailable', () => {
  const player = createPlayer({ audio: false });
  player.element('btnJoinGame').listeners.click();
  player.listeners.fastest_correct({ roundId: 'one' });
  assert.equal(player.tones(), 0);
  assert.match(player.element('pushBannerBody').textContent, /geluid/);
});

test('reset ends the session and returns to an empty player profile', async () => {
  const player = createPlayer();
  player.element('btnJoinGame').listeners.click();
  assert.ok(player.storage.has('homey_party_quiz_player_v1'));
  await resetPlayer(player);
  assert.equal(player.storage.has('homey_party_quiz_player_v1'), false);
  assert.equal(player.storage.get('unrelated'), 'preserve');
  assert.equal(player.element('screenJoin').style.display, 'flex');
  assert.equal(player.element('inputPlayerName').value, '');
  player.listeners.connect();
  assert.equal(player.joins.length, 1);
});

test('cancelling or failing server reset keeps the player session', async () => {
  const cancelled = createPlayer();
  cancelled.element('btnJoinGame').listeners.click();
  cancelled.element('btnResetPlayer').listeners.click();
  assert.equal(cancelled.element('resetConfirm').hidden, false);
  cancelled.element('btnCancelReset').listeners.click();
  assert.equal(cancelled.element('resetConfirm').hidden, true);
  assert.ok(cancelled.storage.has('homey_party_quiz_player_v1'));
  assert.equal(cancelled.disconnected(), false);
  assert.equal(cancelled.reloaded(), false);

  const failed = createPlayer({ resetFails: true });
  failed.element('btnJoinGame').listeners.click();
  await resetPlayer(failed);
  assert.ok(failed.storage.has('homey_party_quiz_player_v1'));
  assert.equal(failed.disconnected(), false);
  assert.equal(failed.reloaded(), false);
  assert.match(failed.element('pushBannerTitle').textContent, /mislukt/);
  assert.equal(failed.errors.length, 1);
});

test('reset reports storage failure after ending the server session', async () => {
  const player = createPlayer({ storageFails: true });
  player.element('btnJoinGame').listeners.click();
  await resetPlayer(player);
  assert.equal(player.element('screenJoin').style.display, 'flex');
  assert.equal(player.element('inputPlayerName').value, '');
  assert.match(player.element('pushBannerTitle').textContent, /niet gewist/);
  assert.equal(player.errors.length, 1);
});

test('reset during a pending join ignores its delayed acknowledgement', async () => {
  const player = createPlayer({ deferredJoin: true });
  player.element('btnJoinGame').listeners.click();
  await resetPlayer(player);
  player.joins[0]();
  assert.equal(player.element('screenJoin').style.display, 'flex');
  assert.equal(player.element('inputPlayerName').value, '');
  assert.equal(player.storage.has('homey_party_quiz_player_v1'), false);
});

test('reset works on the empty join screen', async () => {
  const player = createPlayer();
  await resetPlayer(player);
  assert.equal(player.element('inputPlayerName').value, '');
  assert.equal(player.element('screenJoin').style.display, 'flex');
});

test('reset uses the player secret when the socket is disconnected', async () => {
  const player = createPlayer();
  player.element('btnJoinGame').listeners.click();
  player.socket.connected = false;
  player.listeners.disconnect();
  let credentials;
  player.context.fetch = async (url, options) => {
    assert.equal(url, '/api/player/reset');
    credentials = JSON.parse(options.body);
    return { ok: true, json: async () => ({ success: true }) };
  };
  await resetPlayer(player);
  assert.equal(credentials.playerSecret, 'secret');
  assert.equal(player.storage.has('homey_party_quiz_player_v1'), false);
  assert.equal(player.element('screenJoin').style.display, 'flex');
});

test('reset reports a server connection error without erasing the session', async () => {
  const player = createPlayer();
  player.element('btnJoinGame').listeners.click();
  player.socket.connected = false;
  player.listeners.disconnect();
  player.context.fetch = async () => { throw new Error('Offline'); };
  await resetPlayer(player);
  assert.equal(player.storage.has('homey_party_quiz_player_v1'), true);
  assert.match(player.element('pushBannerTitle').textContent, /mislukt/);
  assert.match(player.element('pushBannerBody').textContent, /Offline/);
  assert.equal(player.element('resetError').hidden, false);
});

test('finished standings stay visible while push permission is delayed', async () => {
  const player = createPlayer({ joinState: { phase: 'lobby', leaderboard: [] } });
  let resolvePermission;
  player.context.PushManager = function () {};
  player.context.Notification = { requestPermission: () => new Promise(resolve => { resolvePermission = resolve; }) };
  player.context.navigator.serviceWorker = {};
  player.element('chkEnablePush').checked = true;
  player.element('btnJoinGame').listeners.click();
  assert.equal(player.element('screenLobbyWait').style.display, 'flex');
  const standings = [
    { id: 'other1', name: 'Eerste', score: 100, position: 1 },
    { id: 'other2', name: 'Tweede', score: 90, position: 2 },
    { id: 'other3', name: 'Derde', score: 80, position: 3 },
    { id: 'player', name: '<Speler>', score: 70, position: 4, rankDelta: 0, gapToFirst: 30 }
  ];
  player.listeners.quiz_state({ phase: 'finished', leaderboard: standings, top3: standings.slice(0, 3) });
  assert.equal(player.element('resultRankValue').textContent, '#4');
  assert.match(player.element('resultHeadline').textContent, /Eindstand/);
  assert.match(player.element('resultTop3List').innerHTML, /Derde/);
  assert.doesNotMatch(player.element('resultTop3List').innerHTML, /Speler/);
  assert.match(player.element('resultLeaderboardList').innerHTML, /&lt;Speler&gt;/);
  resolvePermission('denied');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(player.element('screenRoundResult').style.display, 'flex');
  assert.match(player.element('resultHeadline').textContent, /Eindstand/);
});

test('removed players leave the game and cannot automatically reconnect', () => {
  const player = createPlayer();
  player.element('btnJoinGame').listeners.click();
  player.listeners.player_removed();
  assert.equal(player.storage.has('homey_party_quiz_player_v1'), false);
  assert.equal(player.element('screenJoin').style.display, 'flex');
  assert.equal(player.element('inputPlayerName').value, '');
  player.listeners.connect();
  assert.equal(player.storage.has('homey_party_quiz_player_v1'), false);
});

test('join waits for a connection and stale acknowledgements cannot restore an old session', () => {
  const player = createPlayer({ deferredJoin: true, joinState: { phase: 'lobby', leaderboard: [] } });
  player.socket.connected = false;
  player.element('btnJoinGame').listeners.click();
  assert.equal(player.joins.length, 0);
  assert.equal(player.element('screenReconnect').style.display, 'flex');
  player.socket.connected = true;
  player.listeners.connect();
  assert.equal(player.joins.length, 1);
  player.socket.connected = false;
  player.listeners.disconnect();
  player.socket.connected = true;
  player.listeners.connect();
  assert.equal(player.joins.length, 2);
  player.joins[0]();
  assert.equal(player.element('screenReconnect').style.display, 'flex');
  player.joins[1]();
  assert.equal(player.element('screenLobbyWait').style.display, 'flex');
});

test('push test reuses a subscription and reports server failure', async () => {
  const player = createPlayer();
  const requests = [];
  const subscription = { options: { applicationServerKey: Uint8Array.from([1, 2, 3]).buffer } };
  player.context.PushManager = function () {};
  player.context.Notification = { requestPermission: () => Promise.resolve('granted') };
  player.context.atob = value => Buffer.from(value, 'base64').toString('binary');
  player.context.navigator.serviceWorker = {
    register: async () => ({ pushManager: {
      getSubscription: async () => subscription,
      subscribe: async () => { throw new Error('Bestaand abonnement niet hergebruikt'); }
    } }),
    ready: Promise.resolve()
  };
  player.context.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url === '/api/vapid-public-key') return { ok: true, json: async () => ({ publicKey: 'AQID' }) };
    if (url === '/api/push/subscribe') return { ok: true };
    return { ok: false, json: async () => ({ error: 'Testmelding mislukt' }) };
  };
  player.element('btnJoinGame').listeners.click();
  await player.element('btnRequestPushAgain').listeners.click();
  assert.deepEqual(requests.map(request => request.url), ['/api/vapid-public-key', '/api/push/subscribe', '/api/push/player-test']);
  assert.equal(JSON.parse(requests[2].options.body).playerSecret, 'secret');
  assert.match(player.element('pushBannerTitle').textContent, /mislukt/);
});

test('push test renews subscriptions after a VAPID key change', async () => {
  const player = createPlayer();
  const calls = [];
  player.context.PushManager = function () {};
  player.context.Notification = { requestPermission: () => { calls.push('permission'); return Promise.resolve('granted'); } };
  player.context.atob = value => Buffer.from(value, 'base64').toString('binary');
  player.context.navigator.serviceWorker = {
    register: async () => ({ pushManager: {
      getSubscription: async () => ({
        options: { applicationServerKey: Uint8Array.from([9]).buffer },
        unsubscribe: async () => { calls.push('unsubscribe'); return true; }
      }),
      subscribe: async () => { calls.push('subscribe'); return { endpoint: 'new' }; }
    } }),
    ready: Promise.resolve()
  };
  player.context.fetch = async url => {
    calls.push(url);
    if (url === '/api/vapid-public-key') return { ok: true, json: async () => ({ publicKey: 'AQID' }) };
    return { ok: true, json: async () => ({ success: true }) };
  };
  player.element('btnJoinGame').listeners.click();
  const testPush = player.element('btnRequestPushAgain').listeners.click();
  assert.equal(calls[0], 'permission');
  await testPush;
  assert.deepEqual(calls, ['permission', '/api/vapid-public-key', 'unsubscribe', 'subscribe', '/api/push/subscribe', '/api/push/player-test']);
  assert.match(player.element('pushBannerTitle').textContent, /verzonden/);
});
