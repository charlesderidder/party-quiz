'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { io } = require('socket.io-client');
const PartyQuizApp = require('../app');
const QuizEngine = require('../lib/QuizEngine');
const PushManager = require('../lib/PushManager');
const AdminSecurity = require('../lib/AdminSecurity');
const homeyApi = require('../api');

test('quiz backup is private and restores complete quizzes as independent copies', async t => {
  const values = {};
  const settings = { get: key => values[key], set: (key, value) => { values[key] = value; } };
  const app = new PartyQuizApp();
  app.homey = { settings };
  app.log = () => {};
  app.adminSecurity = new AdminSecurity(settings);
  app.adminSecurity.setPassword('initial-password');
  app.playerSecrets = new Map();
  app.removedPlayerIds = new Set();
  app.playerPushTests = new Map();
  app.serverConfig = { serverPort: 0 };
  app.quizzes = [
    { id: 'one', title: 'Eerste', description: 'Beschrijving', questions: [
      { id: 'q1', question: 'Vraag?', options: ['A', 'B', 'C', 'D'], correctIndex: 2, timeLimit: 15, points: 500 }
    ] },
    { id: 'two', title: 'Tweede', questions: [
      { id: 'q2', question: 'Andere vraag?', options: ['1', '2', '3', '4'], correctIndex: 0, timeLimit: 20, points: 1000 }
    ] }
  ];
  app.quizEngine = new QuizEngine({});
  app.quizEngine.selectQuizForLobby(app.quizzes[0]);
  app.pushManager = { getPublicKey: () => 'key', subscriptions: new Map() };
  let saveFails = false;
  app._saveQuizzes = (quizzes, options) => {
    assert.equal(options.requireFile, true);
    if (saveFails) throw new Error('Storage unavailable');
    app.quizzes = quizzes;
  };
  await app._startWebServer({ host: '127.0.0.1', port: 0 });
  t.after(() => app.io.close());
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;
  const upload = (data, cookie) => {
    const form = new FormData();
    form.append('file', new Blob([typeof data === 'string' ? data : JSON.stringify(data)], { type: 'application/json' }), 'backup.json');
    return fetch(base + '/api/backup/restore', { method: 'POST', headers: cookie ? { Cookie: cookie } : {}, body: form });
  };
  assert.equal((await fetch(base + '/api/backup')).status, 401);
  assert.equal((await upload('{}')).status, 401);
  const login = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'initial-password' })
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(base + '/api/backup', { headers: { Cookie: cookie } });
  assert.match(response.headers.get('content-disposition'), /attachment/);
  const backup = await response.json();
  assert.deepEqual(backup, { format: 'party-quiz-backup', version: 1, quizzes: app.quizzes });
  const originals = JSON.parse(JSON.stringify(app.quizzes));
  app.quizzes = [...originals, { title: 'Ongeldig', questions: [{}] }];
  assert.equal((await fetch(base + '/api/backup', { headers: { Cookie: cookie } })).status, 422);
  app.quizzes = originals;
  assert.equal((await upload('{', cookie)).status, 400);
  assert.equal((await upload({ ...backup, version: 2 }, cookie)).status, 400);
  assert.equal((await upload({ ...backup, quizzes: [backup.quizzes[0], { title: 'Ongeldig', questions: [{}] }] }, cookie)).status, 400);
  assert.deepEqual(app.quizzes, originals);
  saveFails = true;
  assert.equal((await upload(backup, cookie)).status, 500);
  assert.deepEqual(app.quizzes, originals);
  saveFails = false;
  const restored = await (await upload(backup, cookie)).json();
  assert.equal(restored.imported, 2);
  assert.equal(app.quizzes.length, 4);
  assert.deepEqual(app.quizzes.slice(0, 2), originals);
  for (let i = 0; i < originals.length; i++) {
    const copy = restored.quizzes[i];
    assert.notEqual(copy.id, originals[i].id);
    assert.notEqual(copy.questions[0].id, originals[i].questions[0].id);
    assert.deepEqual({ ...copy, id: originals[i].id, questions: copy.questions.map((q, idx) => ({ ...q, id: originals[i].questions[idx].id })) }, originals[i]);
  }
  const again = await (await upload(backup, cookie)).json();
  assert.notEqual(again.quizzes[0].id, restored.quizzes[0].id);
  assert.equal(app.quizEngine.phase, 'lobby');
});

test('backup restoration persists safely and reports storage failures', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'party-quiz-backup-test-'));
  const file = path.join(dir, 'quizzes.json');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir); });
  const old = [{ id: 'old' }];
  const next = [{ id: 'new' }];
  fs.writeFileSync(file, JSON.stringify(old));
  let saved = old;
  let fail = false;
  const app = new PartyQuizApp();
  app.quizzesFilePath = file;
  app.quizzes = old;
  app.log = () => {};
  app.homey = { settings: { set(key, value) {
    if (fail) { fail = false; throw new Error('Storage unavailable'); }
    saved = value;
  } } };
  fail = true;
  assert.throws(() => app._saveQuizzes(next, { requireFile: true }), /Storage unavailable/);
  assert.deepEqual(app.quizzes, old);
  assert.deepEqual(saved, old);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), old);
  assert.deepEqual(fs.readdirSync(dir), ['quizzes.json']);
  app._saveQuizzes(next, { requireFile: true });
  assert.deepEqual(app.quizzes, next);
  assert.deepEqual(saved, next);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), next);
});

test('beheer is afgeschermd voor web, sockets en Homey API', async t => {
  const values = {};
  const settings = { get: key => values[key], set: (key, value) => { values[key] = value; } };
  const app = new PartyQuizApp();
  app.homey = { settings };
  app.log = () => {};
  app.adminSecurity = new AdminSecurity(settings);
  app.playerSecrets = new Map();
  app.removedPlayerIds = new Set();
  app.playerPushTests = new Map();
  app.serverConfig = { serverPort: 0 };
  app.quizzes = [{ id: 'quiz', title: 'Quiz', questions: [
    { id: 'q1', question: 'Vraag?', options: ['A', 'B', 'C', 'D'], correctIndex: 1, timeLimit: 20 }
  ] }];
  app.quizEngine = new QuizEngine({});
  app.quizEngine.selectQuizForLobby(app.quizzes[0]);
  const subscriptions = new Map();
  let pushResult = { sent: true };
  const pushCalls = [];
  app.pushManager = {
    getPublicKey: () => 'key', subscriptions,
    saveSubscription(id, sub) { subscriptions.set(id, sub); return true; },
    removeSubscriptions(ids) { ids.forEach(id => subscriptions.delete(id)); },
    async sendToPlayer(id, payload, options) { pushCalls.push({ id, options }); return pushResult; }
  };
  app._saveQuizzes = () => {};
  app.adminSecurity.setPassword('initial-password');
  await app._startWebServer({ host: '127.0.0.1', port: 0 });
  t.after(() => {
    app.quizEngine._clearTimers();
    app.io.close();
  });
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;
  const request = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
  const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  assert.equal((await request('/play')).status, 200);
  const anonymousSession = await request('/api/admin/session');
  assert.equal(anonymousSession.headers.get('cache-control'), 'no-store');
  assert.equal((await anonymousSession.json()).authenticated, false);
  const publicState = await request('/api/state');
  assert.equal(publicState.status, 200);
  assert.equal((await publicState.json()).flowHistory, undefined);
  assert.equal((await request('/admin')).status, 302);
  for (const [path, options] of [
    ['/admin/index.html', {}], ['/settings/index.html', {}], ['/api/quizzes', {}],
    ['/api/settings', {}], ['/api/flow/history', {}], ['/api/control/start', json({})],
    ['/api/push/test', json({})]
  ]) {
    const response = await request(path, options);
    assert.ok(response.status === 401 || response.status === 302, `${path}: ${response.status}`);
  }
  assert.equal((await request('/api/login', { ...json({ password: 'initial-password' }), headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' } })).status, 403);
  assert.equal((await request('/api/login', json({ password: 'incorrect' }))).status, 401);
  const login = await request('/api/login', json({ password: 'initial-password' }));
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const [path, options] of [
    ['/widget', {}], ['/widget/index.html', {}], ['/api/widget/status', {}],
    ['/api/widget/next', { method: 'POST' }]
  ]) {
    assert.equal((await request(path, { ...options, headers: { Cookie: cookie } })).status, 404, path);
  }
  assert.equal(app.quizEngine.phase, 'lobby');
  assert.equal((await (await request('/api/admin/session', { headers: { Cookie: cookie } })).json()).authenticated, true);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await request('/api/quizzes', { headers: { Cookie: cookie } })).status, 200);
  const saved = await request('/api/settings', { ...json({ adminPasswordHash: 'evil', soundEnabled: false }), headers: { 'Content-Type': 'application/json', Cookie: cookie } });
  assert.equal(saved.status, 200);
  assert.equal(app.serverConfig.adminPasswordHash, undefined);
  assert.notEqual(JSON.stringify(values.adminPasswordHash).includes('initial-password'), true);

  const playerSocket = io(base, { transports: ['websocket'] });
  const adminSocket = io(base, { transports: ['websocket'], extraHeaders: { Cookie: cookie } });
  t.after(() => { playerSocket.disconnect(); adminSocket.disconnect(); });
  await Promise.all([playerSocket, adminSocket].map(socket => new Promise(resolve => socket.on('connect', resolve))));
  const emit = (socket, event, payload) => new Promise(resolve => socket.emit(event, payload, resolve));
  assert.equal((await emit(playerSocket, 'host_start_quiz', {})).success, false);
  const player = await emit(playerSocket, 'player_join', { name: 'Speler' });
  assert.equal(player.success, true);
  assert.equal((await emit(adminSocket, 'player_join', { name: 'Andere', playerId: player.player.id })).success, false);
  assert.equal((await emit(adminSocket, 'submit_answer', { playerId: player.player.id, answerIndex: 1 })).accepted, false);
  assert.equal((await request('/api/push/subscribe', json({ playerId: player.player.id, playerSecret: player.playerSecret, subscription: { endpoint: 'https://127.0.0.1/push' } }))).status, 400);
  assert.equal((await emit(adminSocket, 'host_start_quiz', {})).success, true);
  const secondSession = io(base, { transports: ['websocket'] });
  t.after(() => secondSession.disconnect());
  await new Promise(resolve => secondSession.on('connect', resolve));
  assert.equal((await emit(secondSession, 'player_join', {
    name: 'Speler', playerId: player.player.id, playerSecret: player.playerSecret
  })).success, true);
  assert.equal((await emit(playerSocket, 'submit_answer', { playerId: player.player.id, answerIndex: 1 })).accepted, true);
  assert.equal((await emit(secondSession, 'submit_answer', { playerId: player.player.id, answerIndex: 1 })).accepted, false);

  const pushRequest = secret => json({ playerId: player.player.id, playerSecret: secret });
  assert.equal((await request('/api/push/player-test', pushRequest('incorrect'))).status, 401);
  assert.equal((await request('/api/push/player-test', pushRequest(player.playerSecret))).status, 400);
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/test' };
  assert.equal((await request('/api/push/subscribe', json({ playerId: player.player.id, playerSecret: player.playerSecret, subscription: sub }))).status, 200);
  assert.equal((await request('/api/push/player-test', pushRequest(player.playerSecret))).status, 200);
  assert.deepEqual(pushCalls[0], { id: player.player.id, options: { realtime: false } });
  assert.equal((await request('/api/push/player-test', pushRequest(player.playerSecret))).status, 429);
  app.playerPushTests.delete(player.player.id);
  pushResult = { sent: false, reason: 'failed' };
  assert.equal((await request('/api/push/player-test', pushRequest(player.playerSecret))).status, 502);

  const offlineSocket = io(base, { transports: ['websocket'] });
  t.after(() => offlineSocket.disconnect());
  await new Promise(resolve => offlineSocket.on('connect', resolve));
  const offline = await emit(offlineSocket, 'player_join', { name: 'Offline' });
  offlineSocket.disconnect();
  assert.equal((await emit(playerSocket, 'host_clear_players', {})).success, false);
  assert.equal(app.quizEngine.players.size, 2);
  const removedEvent = new Promise(resolve => playerSocket.once('player_removed', resolve));
  const secondRemovedEvent = new Promise(resolve => secondSession.once('player_removed', resolve));
  const cleared = await emit(adminSocket, 'host_clear_players', {});
  await Promise.all([removedEvent, secondRemovedEvent]);
  assert.equal(cleared.success, true);
  assert.equal(cleared.removed, 2);
  assert.equal(app.quizEngine.players.size, 0);
  assert.equal(app.quizEngine.socketToPlayer.size, 0);
  assert.equal(subscriptions.size, 0);
  assert.equal((await request('/api/push/player-test', pushRequest(player.playerSecret))).status, 401);
  assert.equal((await emit(playerSocket, 'submit_answer', { playerId: player.player.id, answerIndex: 1 })).accepted, false);
  assert.equal((await emit(playerSocket, 'player_join', { name: 'Offline', playerId: offline.player.id, playerSecret: offline.playerSecret })).code, 'player_removed');
  const fresh = await emit(playerSocket, 'player_join', { name: 'Nieuwe speler' });
  assert.equal(fresh.success, true);
  assert.equal((await emit(adminSocket, 'player_reset', { playerId: fresh.player.id, playerSecret: 'wrong' })).success, false);
  const mirror = io(base, { transports: ['websocket'] });
  t.after(() => mirror.disconnect());
  await new Promise(resolve => mirror.on('connect', resolve));
  assert.equal((await emit(mirror, 'player_join', {
    name: 'Nieuwe speler', playerId: fresh.player.id, playerSecret: fresh.playerSecret
  })).success, true);
  subscriptions.set(fresh.player.id, sub);
  app.quizEngine.players.get(fresh.player.id).score = 123;
  const ended = new Promise(resolve => playerSocket.once('player_session_ended', resolve));
  const mirrorEnded = new Promise(resolve => mirror.once('player_session_ended', resolve));
  assert.equal((await emit(playerSocket, 'player_reset', {})).success, true);
  await Promise.all([ended, mirrorEnded]);
  assert.equal(app.quizEngine.players.get(fresh.player.id).score, 123);
  assert.equal(app.quizEngine.players.get(fresh.player.id).connected, false);
  assert.equal(subscriptions.has(fresh.player.id), false);
  assert.equal((await request('/api/push/subscribe', json({ playerId: fresh.player.id, playerSecret: fresh.playerSecret, subscription: sub }))).status, 401);
  assert.equal((await emit(mirror, 'submit_answer', { playerId: fresh.player.id, answerIndex: 1 })).accepted, false);
  assert.equal((await emit(mirror, 'player_join', { name: 'Nieuwe speler', playerId: fresh.player.id, playerSecret: fresh.playerSecret })).code, 'player_removed');
  const offlineReset = await emit(playerSocket, 'player_join', { name: 'Offline reset' });
  assert.equal((await request('/api/player/reset', json({ playerId: offlineReset.player.id, playerSecret: 'wrong' }))).status, 401);
  assert.equal((await request('/api/player/reset', json({ playerId: offlineReset.player.id, playerSecret: offlineReset.playerSecret }))).status, 200);
  assert.equal((await emit(playerSocket, 'player_join', { name: 'Offline reset', playerId: offlineReset.player.id, playerSecret: offlineReset.playerSecret })).code, 'player_removed');

  await assert.rejects(homeyApi.getAdminData({ homey: { app }, body: {} }), /wachtwoord/);
  assert.equal((await homeyApi.getAdminData({ homey: { app }, body: { adminPassword: 'initial-password' } })).quizzes.length, 1);
  const changed = await request('/api/settings/password', { ...json({ newPassword: 'replacement-password' }), headers: { 'Content-Type': 'application/json', Cookie: cookie } });
  assert.equal(changed.status, 200);
  assert.equal((await request('/api/quizzes', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await (await request('/api/admin/session', { headers: { Cookie: cookie } })).json()).authenticated, false);
  assert.equal((await emit(adminSocket, 'host_next_step', {})).success, false);
  assert.equal((await request('/api/login', json({ password: 'initial-password' }))).status, 401);
  const replacementLogin = await request('/api/login', json({ password: 'replacement-password' }));
  assert.equal(replacementLogin.status, 200);
  const replacementCookie = replacementLogin.headers.get('set-cookie').split(';')[0];
  const loggedInSocket = io(base, { transports: ['websocket'], extraHeaders: { Cookie: replacementCookie } });
  t.after(() => loggedInSocket.disconnect());
  await new Promise(resolve => loggedInSocket.on('connect', resolve));
  assert.equal((await emit(loggedInSocket, 'host_clear_players', {})).success, true);
  const logout = await request('/api/logout', { method: 'POST', headers: { Cookie: replacementCookie, 'X-Forwarded-Proto': 'https' } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0; Secure/);
  assert.equal((await (await request('/api/admin/session', { headers: { Cookie: replacementCookie } })).json()).authenticated, false);
  assert.equal((await emit(loggedInSocket, 'host_clear_players', {})).success, false);
});

test('eerste Homey-wachtwoord en mislukte inlogpogingen', async () => {
  const values = {};
  const security = new AdminSecurity({ get: key => values[key], set: (key, value) => { values[key] = value; } });
  const homey = { app: { adminSecurity: security } };
  await assert.rejects(homeyApi.setAdminPassword({ homey, body: { newPassword: 'short' } }), /12/);
  await homeyApi.setAdminPassword({ homey, body: { newPassword: 'first-password' } });
  await assert.rejects(homeyApi.setAdminPassword({ homey, body: { newPassword: 'other-password' } }), /wachtwoord/);
  for (let i = 0; i < 5; i++) assert.equal(security.authenticate('wrong', 'test'), false);
  assert.equal(security.authenticate('first-password', 'test'), false);
  assert.equal(security.authenticate('first-password', 'other'), true);
});

test('push subscriptions remain intact when bulk removal cannot be persisted', () => {
  const manager = new PushManager({
    homey: { settings: { set() { throw new Error('Storage unavailable'); } } },
    log() {}
  });
  manager.subscriptions.set('player', { endpoint: 'https://fcm.googleapis.com/test' });
  assert.throws(() => manager.removeSubscriptions(['player']), /Storage unavailable/);
  assert.equal(manager.subscriptions.has('player'), true);
});
