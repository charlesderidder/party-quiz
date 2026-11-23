'use strict';

/**
 * End-to-end integratietest voor de Party Quiz.
 * Gebruikt de Socket.io / Engine.io polling-transport via HTTP (geen extra dependencies nodig).
 * Gebruikt de globale WebSocket uit Node 22+ indien aanwezig.
 */

const BASE = process.env.PARTY_QUIZ_TEST_URL || 'http://127.0.0.1:3456';
let adminCookie = '';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function api(path, options) {
  const headers = { ...((options && options.headers) || {}), ...(adminCookie ? { Cookie: adminCookie } : {}) };
  const res = await fetch(BASE + path, { ...options, headers });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = text;
  }
  return { status: res.status, data };
}

const received = { quiz_state: [], timer_tick: [], flow_event: [], push_notification: [], fastest_correct: [] };

async function run() {
  const password = process.env.PARTY_QUIZ_TEST_PASSWORD;
  if (!password) throw new Error('Stel PARTY_QUIZ_TEST_PASSWORD in voor de aparte testinstantie.');
  const login = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  if (!login.ok) throw new Error(`Beheerder aanmelden mislukt: HTTP ${login.status}`);
  adminCookie = login.headers.get('set-cookie').split(';')[0];
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, ok, extra });
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  };

  // ---- 1. Health ----
  const state0 = await api('/api/state');
  check('/api/state bereikbaar', state0.status === 200 && state0.data.phase);


  // ---- 2. Socket.io client ----
  const { io } = require('socket.io-client');
  const socket = io(BASE, { transports: ['websocket'], extraHeaders: { Cookie: adminCookie } });
  const playerObserver = io(BASE, { transports: ['websocket'] });
  const publicFlowEvents = [];
  const otherFastestEvents = [];
  playerObserver.on('flow_event', event => publicFlowEvents.push(event));
  playerObserver.on('fastest_correct', event => otherFastestEvents.push(event));

  socket.on('quiz_state', s => received.quiz_state.push(s));
  socket.on('timer_tick', t => received.timer_tick.push(t));
  socket.on('flow_event', e => received.flow_event.push(e));
  socket.on('push_notification', p => received.push_notification.push(p));
  socket.on('fastest_correct', event => received.fastest_correct.push(event));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket timeout')), 8000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  check('Socket.io verbinding', socket.connected, socket.id);

  await sleep(300);
  check('quiz_state ontvangen bij connect', received.quiz_state.length > 0);

  // ---- 3. Demo spelers toevoegen ----
  await api('/api/demo/add-bots', { method: 'POST' });
  let st = (await api('/api/state')).data;
  check('Demo-spelers toegevoegd aan lobby', st.totalPlayers >= 4, `${st.totalPlayers} spelers`);

  // ---- 4. Speler joinen via socket ----
  const joinRes = await new Promise(resolve =>
    socket.emit(
      'player_join',
      { playerId: 'test_sanne', name: 'Sanne', avatar: '🦄', color: '#8B5CF6' },
      resolve
    )
  );
  check('Speler kan joinen via socket', joinRes.success === true, joinRes.player && joinRes.player.name);
  const playerId = joinRes.player.id;
  const playerSecret = joinRes.playerSecret;

  // ---- 5. Quiz starten ----
  const quizzes = (await api('/api/quizzes')).data.quizzes;
  const quiz = quizzes[0];
  const startRes = await api('/api/control/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quizId: quiz.id })
  });
  check('Quiz gestart (fase question)', startRes.data.state.phase === 'question');

  // Timer ticks
  await sleep(2300);
  const ticks = received.timer_tick;
  check('timer_tick events ontvangen', ticks.length > 0, `${ticks.length} ticks`);
  const lastTick = ticks[ticks.length - 1];
  check(
    '1000 punten in seconde 1, daarna aflopend',
    ticks[0].currentAvailablePoints === 1000 && lastTick.currentAvailablePoints < 1000,
    `eerste=${ticks[0].currentAvailablePoints} laatste=${lastTick.currentAvailablePoints}`
  );
  check(
    'Lineaire afbouw naar 0 bij 20s',
    ticks.some(t => t.elapsedSeconds >= 2 && t.currentAvailablePoints < 1000)
  );

  // ---- 6. Antwoorden ----
  st = (await api('/api/state')).data;
  const correctIdx = quiz.questions[0].correctIndex;
  const wrongIdx = (correctIdx + 1) % 4;

  // Speler moet eerst (opnieuw) joinen; state kan door eerdere stappen zijn gereset
  await new Promise(resolve =>
    socket.emit('player_join', { playerId, playerSecret, name: 'Sanne', avatar: '🦄', color: '#8B5CF6' }, resolve)
  );

  const ansCorrect = await new Promise(resolve =>
    socket.emit('submit_answer', { playerId, answerIndex: correctIdx }, resolve)
  );
  check('Correct antwoord geaccepteerd', ansCorrect.accepted === true, `+${ansCorrect.pointsEarned || '?'} pt`);
  check('Snelste speler wordt pas bij de uitslag gemeld', received.fastest_correct.length === 0);

  const ansDup = await new Promise(resolve =>
    socket.emit('submit_answer', { playerId, answerIndex: wrongIdx }, resolve)
  );
  check('Tweede antwoord geweigerd', ansDup.accepted === false, ansDup.reason || '');

  await api('/api/demo/bot-answers', { method: 'POST' });
  await sleep(1800);

  st = (await api('/api/state')).data;
  check('Live antwoordteller werkt', st.answeredCount >= 2, `${st.answeredCount} antwoorden`);

  // ---- 7. Reveal (vraag sluit automatisch zodra iedereen antwoordde) ----
  await sleep(600);
  st = (await api('/api/state')).data;
  if (st.phase !== 'reveal') {
    st = (await api('/api/control/next', { method: 'POST' })).data.state;
  }
  check('Naar tussenstand (reveal)', st.phase === 'reveal', `fase=${st.phase}`);
  check('Alleen de snelste juiste speler ontvangt een geluidssignaal',
    received.fastest_correct.length === 1 && otherFastestEvents.length === 0);
  check('Juiste antwoord zichtbaar in reveal', st.question.correctIndex === correctIdx);
  check('Top 3 gevuld', st.top3.length === 3, st.top3.map(p => `${p.name}:${p.score}`).join(', '));
  check(
    'Stijgers/dalers bijgehouden',
    st.leaderboard.every(p => typeof p.rankDelta === 'number' && typeof p.previousPosition === 'number')
  );
  await sleep(400);
  check('Flow triggers afgevuurd', received.flow_event.length > 0, received.flow_event.map(f => f.triggerId).join(', '));

  const trigIds = new Set(received.flow_event.map(f => f.triggerId));
  check('quiz_started trigger', trigIds.has('quiz_started'));
  check('question_asked trigger', trigIds.has('question_asked'));
  check(
    'player_answered_correct/wrong trigger',
    trigIds.has('player_answered_correct') || trigIds.has('player_answered_wrong')
  );

  // ---- 8. Volgende vraag ----
  let q2 = (await api('/api/control/next', { method: 'POST' })).data.state;
  if (q2.phase !== 'question') {
    q2 = (await api('/api/control/next', { method: 'POST' })).data.state;
  }
  check('Volgende vraag gestart', q2.phase === 'question' && q2.currentQuestionIndex === 1, `fase=${q2.phase}, idx=${q2.currentQuestionIndex}`);

  // ---- 9. Bonuspunten (DAN-actie give_bonus_points) ----
  const before = (await api('/api/state')).data.leaderboard.find(p => p.id === playerId);
  const bonus = await api('/api/control/bonus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, points: 250 })
  });
  const after = bonus.data.state.leaderboard.find(p => p.id === playerId);
  check('Bonuspunten toegekend', after.score === before.score + 250, `${before.score} → ${after.score}`);

  // ---- 10. EN-condities ----
  for (const cond of [
    'is_player_in_top3',
    'is_player_outside_top3',
    'is_player_first',
    'did_player_rank_up',
    'is_last_answer_correct',
    'is_last_answer_wrong',
    'is_player_winner'
  ]) {
    const r = await api('/api/flow/evaluate-condition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conditionId: cond, playerId })
    });
    check(`EN-conditie ${cond}`, r.status === 200 && typeof r.data.result === 'boolean', String(r.data.result));
  }

  // ---- 11. Quiz uitspelen tot finished ----
  let guard = 0;
  while (guard++ < 40) {
    const cur = (await api('/api/state')).data;
    if (cur.phase === 'finished') break;
    if (cur.phase === 'question') await api('/api/demo/bot-answers', { method: 'POST' });
    await api('/api/control/next', { method: 'POST' });
    await sleep(120);
  }
  const fin = (await api('/api/state')).data;
  check('Quiz eindigt in finished-fase', fin.phase === 'finished');
  await sleep(400);
  check('player_won trigger afgevuurd', received.flow_event.some(f => f.triggerId === 'player_won'));
  check('Flow-logboek is niet publiek', publicFlowEvents.length === 0);

  // ---- 12. CRUD ----
  const newQuiz = {
    id: 'quiz_test_crud',
    title: 'Testquiz CRUD',
    description: 'Aangemaakt door integratietest',
    questions: [
      {
        id: 'q1',
        question: 'Wat is 2 + 2?',
        options: ['3', '4', '5', '6'],
        correctIndex: 1,
        timeLimit: 15,
        points: 1000
      }
    ]
  };
  const saved = await api('/api/quizzes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newQuiz)
  });
  check(
    'Quiz aanmaken (POST /api/quizzes)',
    saved.status === 200 && saved.data.quiz.id === 'quiz_test_crud',
    saved.status !== 200 ? JSON.stringify(saved.data) : ''
  );

  const list = (await api('/api/quizzes')).data.quizzes;
  check('Quiz zichtbaar in lijst', list.some(q => q.id === 'quiz_test_crud'));

  const del = await api('/api/quizzes/quiz_test_crud', { method: 'DELETE' });
  check('Quiz verwijderen (DELETE)', del.status === 200);

  // ---- 13. Import tests ----
  const csv =
    'vraag,optie_1,optie_2,optie_3,optie_4,juist_antwoord,tijdslimiet,punten\n' +
    'Wat is de Homey-kleur?,Blauw,Groen,Rood,Geel,1,20,1000\n' +
    'Hoe heet de hub?,Homey Pro,Homey Mini,Homey Max,Homey Air,1,15,1000\n';

  let form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'test-quiz.csv');
  form.append('title', 'CSV Import Test');
  const csvImport = await api('/api/import', { method: 'POST', body: form });
  check(
    'CSV import werkt',
    csvImport.status === 200 && csvImport.data.quiz.questions.length === 2,
    csvImport.data.quiz ? `${csvImport.data.quiz.questions.length} vragen` : JSON.stringify(csvImport.data)
  );

  const sampleXlsx = await fetch(BASE + '/api/samples/xlsx', { headers: { Cookie: adminCookie } }).then(r => r.arrayBuffer());
  form = new FormData();
  form.append('file', new Blob([sampleXlsx]), 'voorbeeld.xlsx');
  const xlsxImport = await api('/api/import', { method: 'POST', body: form });
  check(
    'XLSX import werkt',
    xlsxImport.status === 200 && xlsxImport.data.quiz.questions.length > 0,
    xlsxImport.data.quiz ? `${xlsxImport.data.quiz.questions.length} vragen` : JSON.stringify(xlsxImport.data)
  );

  const sampleJson = await fetch(BASE + '/api/samples/json', { headers: { Cookie: adminCookie } }).then(r => r.text());
  form = new FormData();
  form.append('file', new Blob([sampleJson], { type: 'application/json' }), 'voorbeeld.json');
  const jsonImport = await api('/api/import', { method: 'POST', body: form });
  check(
    'JSON import werkt',
    jsonImport.status === 200 && jsonImport.data.quiz.questions.length > 0,
    jsonImport.data.quiz ? `${jsonImport.data.quiz.questions.length} vragen` : JSON.stringify(jsonImport.data)
  );

  // cleanup imported
  for (const id of [csvImport.data.quiz.id, xlsxImport.data.quiz.id, jsonImport.data.quiz.id]) {
    await api(`/api/quizzes/${id}`, { method: 'DELETE' });
  }

  // ---- 14. Settings & VAPID ----
  const setRes = await api('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicBaseUrl: 'https://quiz.example.nl', vapidSubject: 'mailto:test@example.nl' })
  });
  check(
    'Instellingen opslaan (publieke URL / HTTPS)',
    setRes.data.serverConfig.publicBaseUrl === 'https://quiz.example.nl'
  );

  const qr = (await api('/api/qr')).data;
  check('QR-code gebruikt publieke HTTPS URL', qr.playUrl === 'https://quiz.example.nl/play', qr.playUrl);

  const vapid = (await api('/api/vapid-public-key')).data;
  check('VAPID public key aanwezig', typeof vapid.publicKey === 'string' && vapid.publicKey.length > 60);

  const sub = await api('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerId,
      playerSecret,
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/FAKE-ENDPOINT-FOR-TEST',
        keys: { p256dh: 'BFakeKey', auth: 'FakeAuth' }
      }
    })
  });
  check('Push-abonnement opgeslagen', sub.data.success === true);
  const settingsAfter = (await api('/api/settings')).data;
  check('Abonnement geteld', settingsAfter.subscriptionCount === 1, String(settingsAfter.subscriptionCount));

  // reset settings
  await api('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicBaseUrl: '', vapidSubject: 'mailto:partyquiz@homey.local' })
  });

  // ---- 15. Widget API ----
  const widget = (await api('/api/widget/status')).data;
  check(
    'Widget status API',
    widget.quizName && typeof widget.playerCount === 'number' && Array.isArray(widget.top3),
    `${widget.playerCount} spelers, ${widget.top3.length} in top3`
  );

  // ---- 16. Reconnect (sessiebehoud na refresh) ----
  const rejoin = await new Promise(resolve =>
    socket.emit(
      'player_join',
      { playerId, playerSecret, name: 'Sanne', avatar: '🦄', color: '#8B5CF6' },
      resolve
    )
  );
  const stAfter = (await api('/api/state')).data;
  const sanneCount = stAfter.leaderboard.filter(p => p.name === 'Sanne').length;
  check(
    'Sessiebehoud na refresh (zelfde player-ID)',
    rejoin.success === true && sanneCount === 1 && rejoin.player.score > 0,
    `score=${rejoin.player.score}, uniek=${sanneCount}`
  );

  socket.close();
  playerObserver.close();

  const failed = results.filter(r => !r.ok);
  console.log('\n============================================');
  console.log(
    `${results.length - failed.length}/${results.length} tests geslaagd` +
      (failed.length ? ` — ${failed.length} mislukt: ${failed.map(f => f.name).join(', ')}` : ' 🎉')
  );
  console.log('============================================');
  process.exit(failed.length ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
