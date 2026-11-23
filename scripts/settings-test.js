'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const api = require('../api');
const PartyQuizApp = require('../app');
const QuizEngine = require('../lib/QuizEngine');

function createSettingsPage({ standalone = false, failSettings = false } = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '', checked: false, textContent: '', style: {}, children: [], listeners: {},
        addEventListener(event, listener) { this.listeners[event] = listener; },
        replaceChildren() { this.children = []; },
        appendChild(child) {
          this.children.push(child);
          if (child.selected) this.value = child.value;
        }
      });
    }
    return elements.get(id);
  }

  const calls = [];
  const config = {
    publicBaseUrl: 'https://quiz.example', serverPort: 3456,
    vapidSubject: 'mailto:test@example.com', soundEnabled: true, defaultQuizId: 'two'
  };
  const quizzes = [{ id: 'one', title: 'Eerste quiz' }, { id: 'two', title: 'Tweede quiz' }];
  const settings = { serverConfig: config, vapidPublicKey: 'public', detectedLanIp: '192.0.2.1', subscriptionCount: 1 };
  const homey = {
    ready() { calls.push('ready'); },
    openURL(url) { calls.push(['openURL', url]); },
    api(method, url, body, callback) {
      calls.push([method, url, body]);
      if (failSettings && url === '/settings/access') return callback(new Error('Homey niet bereikbaar'));
      if (url === '/settings/access') return callback(null, { settings, quizzes });
      callback(null, { success: true });
    }
  };
  const context = {
    document: { getElementById: element, createElement: () => ({}), head: { appendChild() {} } },
    confirm: () => true,
    homeyScriptFailed: standalone,
    fetch: async (url, options) => {
      calls.push([(options && options.method) || 'GET', url]);
      const data = url === '/api/quizzes' ? { quizzes } : settings;
      return { ok: true, text: async () => JSON.stringify(data) };
    }
  };
  context.window = context;
  const html = fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/);
  assert.ok(script, 'Settings script ontbreekt');
  vm.runInNewContext(script[1], context);
  return { context, homey, calls, element };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('new Homey flow cards register and use player context and quiz completion', async t => {
  const app = new PartyQuizApp();
  const triggers = new Map();
  const conditions = new Map();
  const fired = [];
  const card = () => ({
    registerRunListener(listener) { this.run = listener; },
    registerArgumentAutocompleteListener(name, listener) { this.autocomplete = listener; },
    async trigger(tokens, state) { fired.push({ tokens, state }); }
  });
  app.homey = { flow: {
    getTriggerCard(id) { const result = card(); triggers.set(id, result); return result; },
    getConditionCard(id) { const result = card(); conditions.set(id, result); return result; },
    getActionCard() { return card(); }
  } };
  app.log = () => {};
  app.triggerCards = {};
  app.quizEngine = new QuizEngine({
    onFlowTrigger: (id, tokens, state) => app._fireHomeyFlowTrigger(id, tokens, state)
  });
  t.after(() => app.quizEngine._clearTimers());
  app._registerFlowCards();

  const missing = conditions.get('is_last_answer_missing');
  assert.ok(missing && triggers.has('quiz_finished'));
  app.quizEngine.selectQuizForLobby({ id: 'quiz', title: 'Testquiz', questions: [
    { id: 'q', question: 'Vraag?', options: ['A', 'B', 'C', 'D'], correctIndex: 0 }
  ] });
  app.quizEngine.joinOrReconnectPlayer({ playerId: 'player', name: 'Speler', socketId: 'one' });
  assert.ok((await missing.autocomplete('Speler')).some(player => player.id === 'player'));
  app.quizEngine.nextStep();
  assert.equal(await missing.run({ player: { id: '__trigger__' } }, { playerId: 'player' }), true);
  app.quizEngine.nextStep();
  const beforeFinish = fired.length;
  app.quizEngine.nextStep();
  assert.equal(fired.length, beforeFinish + 2);
  assert.deepEqual(fired[fired.length - 1], { tokens: { quiz_naam: 'Testquiz' }, state: {} });
});

test('Homey settings view becomes ready and uses its API for loading and saving', async () => {
  const page = createSettingsPage();
  assert.equal(page.calls.length, 0);
  page.context.onHomeyReady(page.homey);
  page.element('inputCurrentPassword').value = 'a secure password';
  page.element('btnUnlock').listeners.click();
  await flush();
  assert.equal(page.calls[0], 'ready');
  assert.equal(page.element('selectDefaultQuiz').value, 'two');
  assert.equal(page.element('inputPublicUrl').value, 'https://quiz.example');
  page.element('selectDefaultQuiz').value = 'one';
  await page.element('btnSaveAll').listeners.click();
  const save = page.calls.find(call => Array.isArray(call) && call[0] === 'POST' && call[1] === '/settings');
  assert.equal(save[2].defaultQuizId, 'one');
  await page.element('btnTestPush').listeners.click();
  assert.ok(page.calls.some(call => Array.isArray(call) && call[1] === '/settings/push/test'));
  await page.element('btnRegenKeys').listeners.click();
  assert.ok(page.calls.some(call => Array.isArray(call) && call[1] === '/settings/push/regenerate'));
  page.element('linkAdmin').listeners.click({ preventDefault() {} });
  assert.ok(page.calls.some(call => Array.isArray(call) && call[1] === 'https://quiz.example/admin'));
});

test('Homey API failures are displayed rather than using the standalone API', async () => {
  const page = createSettingsPage({ failSettings: true });
  page.context.onHomeyReady(page.homey);
  page.element('btnUnlock').listeners.click();
  await flush();
  assert.match(page.element('settingsSavedMsg').textContent, /Homey niet bereikbaar/);
  assert.ok(!page.calls.some(call => Array.isArray(call) && call[1].startsWith('/api/')));
});

test('standalone settings use the existing web API', async () => {
  const page = createSettingsPage({ standalone: true });
  await flush();
  assert.equal(page.element('selectDefaultQuiz').value, 'two');
  assert.ok(page.calls.some(call => call[1] === '/api/settings'));
  assert.ok(page.calls.some(call => call[1] === '/api/quizzes'));
});

test('Homey API uses app settings and push operations', async () => {
  let saved;
  const app = {
    adminSecurity: { authenticate: password => password === 'a secure password' },
    quizzes: [],
    getAppSettings: () => ({ serverConfig: { defaultQuizId: 'two' } }),
    _saveServerConfig: body => { saved = body; return body; },
    sendTestPush: async body => ({ success: true, result: body }),
    pushManager: { regenerateVapidKeys: () => 'new-public-key' }
  };
  const homey = { app };
  const credentials = { adminPassword: 'a secure password' };
  assert.equal((await api.getAdminData({ homey, body: credentials })).settings.serverConfig.defaultQuizId, 'two');
  await assert.rejects(api.getAdminData({ homey, body: {} }), /wachtwoord/);
  await api.saveSettings({ homey, body: { ...credentials, defaultQuizId: 'one' } });
  assert.equal(saved.defaultQuizId, 'one');
  assert.equal((await api.testPush({ homey, body: { ...credentials, message: 'test' } })).result.message, 'test');
  assert.equal((await api.regenerateVapid({ homey, body: credentials })).publicKey, 'new-public-key');
});

test('configured default quiz survives loading server settings', () => {
  const app = new PartyQuizApp();
  let stored = { defaultQuizId: 'two' };
  app.homey = { settings: { get: () => stored, set: (key, value) => { stored = value; } } };
  const config = app._loadServerConfig();
  assert.equal(config.defaultQuizId, 'two');
  assert.equal(stored.defaultQuizId, 'two');
});

test('configured default quiz is selected when the app starts', async () => {
  const app = new PartyQuizApp();
  const values = {};
  app.homey = { settings: { get: key => values[key], set: (key, value) => { values[key] = value; } } };
  app.log = () => {};
  app._resolveUserdataDir = () => '.';
  app._loadQuizzes = () => [
    { id: 'one', title: 'Eerste quiz', questions: [] },
    { id: 'two', title: 'Tweede quiz', questions: [] }
  ];
  app._loadServerConfig = () => ({ defaultQuizId: 'two' });
  app._registerFlowCards = () => {};
  app._startWebServer = async () => {};
  await app.onInit();
  assert.equal(app.quizEngine.activeQuiz.id, 'two');
});

test('saving the default selects it in the lobby without interrupting an active quiz', () => {
  const app = new PartyQuizApp();
  const values = {};
  app.homey = { settings: { set: (key, value) => { values[key] = value; } } };
  app.serverConfig = { defaultQuizId: 'one' };
  app.quizzes = [{ id: 'one', title: 'Eerste', questions: [] }, { id: 'two', title: 'Tweede', questions: [] }];
  const selected = [];
  app.quizEngine = {
    phase: 'lobby',
    activeQuiz: app.quizzes[0],
    selectQuizForLobby(quiz) { selected.push(quiz.id); this.activeQuiz = quiz; }
  };
  app._saveServerConfig({ defaultQuizId: 'two' });
  assert.deepEqual(selected, ['two']);
  assert.equal(values.serverConfig.defaultQuizId, 'two');
  app._saveServerConfig({ defaultQuizId: 'two' });
  assert.deepEqual(selected, ['two']);
  app.quizEngine.phase = 'question';
  app._saveServerConfig({ defaultQuizId: 'one' });
  assert.deepEqual(selected, ['two']);
  assert.equal(values.serverConfig.defaultQuizId, 'one');
  assert.throws(() => app._saveServerConfig({ defaultQuizId: 'missing' }), /niet gevonden/);
  assert.equal(values.serverConfig.defaultQuizId, 'one');
});

test('navigation is only shown for an admin session and marks the current page', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-navigation.js'), 'utf8');
  async function render(authenticated, logoutFails = false) {
    const body = [];
    const redirects = [];
    const document = {
      head: { appendChild() {} },
      body: { prepend: node => body.push(node) },
      createElement: () => ({
        children: [], attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(name, fn) { this[name] = fn; },
        appendChild(node) { this.children.push(node); }
      })
    };
    vm.runInNewContext(source, {
      document, location: { pathname: '/settings/index.html', replace: url => redirects.push(url) },
      fetch: async url => url === '/api/logout'
        ? { ok: !logoutFails, status: 500 }
        : { ok: true, json: async () => ({ authenticated }) },
      console: { error() {} }
    });
    await flush();
    return { body, redirects };
  }
  assert.equal((await render(false)).body.length, 0);
  const { body, redirects } = await render(true);
  const [nav] = body;
  assert.deepEqual(nav.children.slice(0, 6).map(link => link.href),
    ['/', '/play', '/host', '/admin', '/settings', '/widget']);
  assert.equal(nav.children.find(link => link.href === '/settings').attributes['aria-current'], 'page');
  assert.equal(nav.children[6].textContent, 'Afmelden');
  await nav.children[6].click();
  assert.deepEqual(redirects, ['/']);
  const failed = await render(true, true);
  await failed.body[0].children[6].click();
  assert.equal(failed.body[0].children[7].hidden, false);
  assert.match(failed.body[0].children[7].textContent, /mislukt/);
  assert.deepEqual(failed.redirects, []);
});

test('widget reports connection failures and recovers with actual Homey status', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'widgets', 'quiz-status', 'public', 'index.html'), 'utf8');
  const source = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const intervals = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      style: {}, textContent: '', innerHTML: '', addEventListener() {}
    });
    return elements.get(id);
  }
  const context = {
    document: { getElementById: element },
    window: { addEventListener() {} },
    setInterval: fn => { intervals.push(fn); return intervals.length; },
    clearInterval() {},
    console: { error() {} }
  };
  vm.runInNewContext(source, context);
  let fails = true;
  const homey = {
    getSettings: () => ({}), ready() {},
    api: async () => {
      if (fails) throw new Error('offline');
      return { quizName: 'Quiz', phase: 'lobby', playerCount: 1, top3: [{ name: 'Sanne', score: 100 }] };
    }
  };
  context.onHomeyReady(homey);
  await flush();
  assert.match(element('top3Container').textContent, /niet beschikbaar/);
  assert.equal(element('playerCountBadge').textContent, '👥 —');
  fails = false;
  await intervals[0]();
  assert.match(element('top3Container').innerHTML, /Sanne/);
  assert.equal(element('playerCountBadge').textContent, '👥 1');
});
