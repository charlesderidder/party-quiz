'use strict';

let Homey;
try {
  Homey = require('homey');
} catch (err) {
  Homey = global.__HOMEY_SHIM__ || { App: class {} };
}

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server: SocketIOServer } = require('socket.io');

const PushManager = require('./lib/PushManager');
const QuizEngine = require('./lib/QuizEngine');
const FileImporter = require('./lib/FileImporter');
const AdminSecurity = require('./lib/AdminSecurity');

class PartyQuizApp extends Homey.App {
  async onInit() {
    this.log('====================================================');
    this.log('🎉 Party Quiz (SDK v3 / SHS) wordt gestart...');
    this.log('====================================================');

    this.userdataDir = this._resolveUserdataDir();
    this.quizzesFilePath = path.join(this.userdataDir, 'quizzes.json');

    // 1. Load quizzes & settings
    this.quizzes = this._loadQuizzes();
    this.serverConfig = this._loadServerConfig();
    this.adminSecurity = new AdminSecurity(this.homey.settings);
    this.playerSecrets = new Map();
    this.removedPlayerIds = new Set();
    this.playerPushTests = new Map();
    if (!this.adminSecurity.isConfigured() && process.env.PARTY_QUIZ_ADMIN_PASSWORD) {
      this.adminSecurity.setPassword(process.env.PARTY_QUIZ_ADMIN_PASSWORD);
    }

    // 2. Initialize Web Push Manager (auto-generates VAPID keys on first start)
    this.pushManager = new PushManager({
      homey: this.homey,
      log: (...args) => this.log(...args),
      onRealtimePush: (targetPlayerId, payload) => {
        if (!this.io) return;
        if (targetPlayerId === 'ALL') {
          this.io.emit('push_notification', payload);
        } else {
          const player = this.quizEngine && this.quizEngine.players.get(targetPlayerId);
          if (player && player.socketId) {
            this.io.to(player.socketId).emit('push_notification', { ...payload, targetPlayerId });
          }
        }
      }
    });
    this.pushManager.init();

    // 3. Initialize Quiz Engine
    this.triggerCards = {};
    this.quizEngine = new QuizEngine({
      pushManager: this.pushManager,
      log: (...args) => this.log(...args),
      onStateChange: state => {
        if (this.io) {
          this.io.emit('quiz_state', state);
        }
      },
      onFlowTrigger: (triggerId, tokens, state, logEntry) => {
        this._fireHomeyFlowTrigger(triggerId, tokens, state);
        if (this.io) {
          for (const socket of this.io.sockets.sockets.values()) {
            if (this.adminSecurity.sessionFromRequest(socket.request)) {
              socket.emit('flow_event', logEntry);
            }
          }
        }
      }
    });

    this.quizEngine.on('timer_tick', tickData => {
      if (this.io) {
        this.io.emit('timer_tick', tickData);
      }
    });

    this.quizEngine.on('fastest_correct', ({ playerId, roundId }) => {
      const player = this.quizEngine.players.get(playerId);
      if (this.io && player && player.connected && player.socketId) {
        this.io.to(player.socketId).emit('fastest_correct', { roundId });
      }
    });

    // Select the configured quiz into the lobby, or the first available quiz.
    if (this.quizzes.length > 0) {
      const defaultQuiz = this.quizzes.find(q => q.id === this.serverConfig.defaultQuizId);
      this.quizEngine.selectQuizForLobby(defaultQuiz || this.quizzes[0]);
    }

    // 4. Register all Homey SDK v3 Flow Cards (ALS, EN, DAN)
    this._registerFlowCards();

    // 5. Start Express + Socket.io Server
    await this._startWebServer();
  }

  _resolveUserdataDir() {
    // On Homey Self-Hosted Server / Homey Pro, /userdata is persistent
    const candidates = [
      '/userdata',
      path.join(__dirname, 'userdata')
    ];
    for (const dir of candidates) {
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.accessSync(dir, fs.constants.W_OK);
        return dir;
      } catch (e) {
        // Try next candidate
      }
    }
    return path.join(__dirname, 'userdata');
  }

  _loadQuizzes() {
    // Prefer Homey.settings or /userdata/quizzes.json
    try {
      if (fs.existsSync(this.quizzesFilePath)) {
        const raw = fs.readFileSync(this.quizzesFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.homey.settings.set('quizzes', parsed);
          return parsed;
        }
      }
    } catch (err) {
      this.log('[Storage] Fout bij lezen quizzes.json:', err.message);
    }

    const fromSettings = this.homey.settings.get('quizzes');
    if (Array.isArray(fromSettings) && fromSettings.length > 0) {
      return fromSettings;
    }

    // Fallback bundled starter quiz
    const defaultPath = path.join(__dirname, 'userdata', 'quizzes.json');
    if (fs.existsSync(defaultPath)) {
      const defaults = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
      this._saveQuizzes(defaults);
      return defaults;
    }
    return [];
  }

  _saveQuizzes(quizzesArray) {
    this.quizzes = quizzesArray;
    this.homey.settings.set('quizzes', this.quizzes);
    try {
      fs.writeFileSync(this.quizzesFilePath, JSON.stringify(this.quizzes, null, 2), 'utf8');
    } catch (err) {
      this.log('[Storage] Kon quizzes.json niet schrijven:', err.message);
    }
  }

  _loadServerConfig() {
    const saved = this.homey.settings.get('serverConfig') || {};
    const config = {
      publicBaseUrl: saved.publicBaseUrl || '',
      serverPort: Number(process.env.PORT || saved.serverPort || 3456),
      soundEnabled: saved.soundEnabled !== undefined ? Boolean(saved.soundEnabled) : true,
      vapidSubject: saved.vapidSubject || 'mailto:partyquiz@homey.local',
      defaultQuizId: saved.defaultQuizId || ''
    };
    this.homey.settings.set('serverConfig', config);
    return config;
  }

  _saveServerConfig(newPartial) {
    const allowed = ['publicBaseUrl', 'serverPort', 'soundEnabled', 'vapidSubject', 'defaultQuizId'];
    const updates = Object.fromEntries(allowed.filter(key => Object.prototype.hasOwnProperty.call(newPartial, key))
      .map(key => [key, newPartial[key]]));
    let defaultQuiz;
    if (Object.prototype.hasOwnProperty.call(updates, 'defaultQuizId')) {
      if (typeof updates.defaultQuizId !== 'string') throw new Error('Ongeldige standaardquiz.');
      defaultQuiz = this.quizzes.find(q => q.id === updates.defaultQuizId);
      if (updates.defaultQuizId && !defaultQuiz) throw new Error('Standaardquiz niet gevonden.');
    }
    this.serverConfig = {
      ...this.serverConfig,
      ...updates
    };
    this.homey.settings.set('serverConfig', this.serverConfig);
    if (newPartial.vapidSubject) {
      this.homey.settings.set('vapidSubject', newPartial.vapidSubject);
    }
    if (defaultQuiz && this.quizEngine && this.quizEngine.phase === 'lobby' &&
        (!this.quizEngine.activeQuiz || this.quizEngine.activeQuiz.id !== defaultQuiz.id)) {
      this.quizEngine.selectQuizForLobby(defaultQuiz);
    }
    return this.serverConfig;
  }

  getAppSettings() {
    return {
      serverConfig: this.serverConfig,
      vapidPublicKey: this.pushManager.getPublicKey(),
      detectedLanIp: this.getDetectedLanIp(),
      subscriptionCount: this.pushManager.subscriptions.size
    };
  }

  async sendTestPush({ playerId, message }) {
    const payload = {
      title: '🔔 Party Quiz Test Push',
      body: message || 'Web Push notificaties werken perfect op jouw toestel!',
      tag: 'test-push'
    };
    if (playerId && playerId !== 'ALL') {
      const result = await this.pushManager.sendToPlayer(playerId, payload);
      return { success: true, result };
    }
    const activeIds = this.quizEngine.getLeaderboard().map(p => p.id);
    const result = await this.pushManager.sendToAll(
      payload,
      activeIds.length > 0 ? activeIds : null
    );
    return { success: true, result };
  }

  getDetectedLanIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
  }

  resolvePublicOrigin(req) {
    if (this.serverConfig.publicBaseUrl && this.serverConfig.publicBaseUrl.trim()) {
      return this.serverConfig.publicBaseUrl.trim().replace(/\/+$/, '');
    }
    if (req && req.headers && req.headers.host) {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
      return `${proto}://${req.headers.host}`;
    }
    const lanIp = this.getDetectedLanIp();
    return `http://${lanIp}:${this.serverConfig.serverPort}`;
  }

  // =========================================================================
  // HOMEY FLOW CARDS REGISTRATION (ALS, EN, DAN)
  // =========================================================================
  _registerFlowCards() {
    if (!this.homey || !this.homey.flow) return;

    const triggerIds = [
      'quiz_started',
      'quiz_finished',
      'question_asked',
      'question_time_up',
      'player_answered_correct',
      'player_answered_wrong',
      'player_rank_up',
      'player_entered_top3',
      'player_left_top3',
      'player_is_first',
      'player_won'
    ];

    for (const id of triggerIds) {
      try {
        this.triggerCards[id] = this.homey.flow.getTriggerCard(id);
      } catch (err) {
        this.log(`[Flow] Trigger card ${id} kon niet worden geregistreerd:`, err.message);
      }
    }

    // Condition cards (EN)
    const conditionIds = [
      'is_player_winner',
      'is_last_answer_correct',
      'is_last_answer_wrong',
      'is_last_answer_missing',
      'did_player_rank_up',
      'is_player_in_top3',
      'is_player_outside_top3',
      'is_player_first'
    ];

    const playerAutocompleteHandler = async query => {
      const q = (query || '').toLowerCase();
      const baseOption = [
        {
          id: '__trigger__',
          name: '⚡ Speler uit ALS-kaart (Trigger-context)',
          description: 'Controleer automatisch de speler die deze Flow activeerde'
        }
      ];
      const activePlayers = this.quizEngine.getLeaderboard().map(p => ({
        id: p.id,
        name: `${p.avatar || '🎉'} ${p.name}`,
        description: `Plek #${p.position} • ${p.score} pt`
      }));
      return [...baseOption, ...activePlayers].filter(
        item => item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q)
      );
    };

    for (const condId of conditionIds) {
      try {
        const card = this.homey.flow.getConditionCard(condId);
        card.registerRunListener(async (args, state) => {
          return this.quizEngine.evaluateCondition(condId, args, state);
        });
        card.registerArgumentAutocompleteListener('player', playerAutocompleteHandler);
      } catch (err) {
        this.log(`[Flow] Condition card ${condId} fout:`, err.message);
      }
    }

    // Action cards (DAN)
    try {
      // 1. start_quiz
      const startQuizCard = this.homey.flow.getActionCard('start_quiz');
      startQuizCard.registerRunListener(async args => {
        const quizId = args.quiz_naam && args.quiz_naam.id ? args.quiz_naam.id : args.quiz_naam;
        const quiz =
          this.quizzes.find(
            q => q.id === quizId || q.title.toLowerCase() === String(quizId).toLowerCase()
          ) || this.quizzes[0];
        if (!quiz) throw new Error('Quiz niet gevonden.');
        this.quizEngine.startQuiz(quiz, true);
        return true;
      });
      startQuizCard.registerArgumentAutocompleteListener('quiz_naam', async query => {
        const q = (query || '').toLowerCase();
        return this.quizzes
          .filter(quiz => quiz.title.toLowerCase().includes(q))
          .map(quiz => ({
            id: quiz.id,
            name: quiz.title,
            description: `${(quiz.questions || []).length} vragen`
          }));
      });

      // 2. next_question
      const nextQuestionCard = this.homey.flow.getActionCard('next_question');
      nextQuestionCard.registerRunListener(async () => {
        this.quizEngine.nextStep();
        return true;
      });

      // 3. give_bonus_points
      const giveBonusCard = this.homey.flow.getActionCard('give_bonus_points');
      giveBonusCard.registerRunListener(async args => {
        const target = args.speler && args.speler.id ? args.speler.id : args.speler;
        const amount = Number(args.aantal) || 0;
        this.quizEngine.giveBonusPoints(target, amount);
        return true;
      });
      giveBonusCard.registerArgumentAutocompleteListener('speler', async query => {
        const q = (query || '').toLowerCase();
        return this.quizEngine
          .getLeaderboard()
          .filter(p => p.name.toLowerCase().includes(q))
          .map(p => ({
            id: p.id,
            name: `${p.avatar || '🎉'} ${p.name}`,
            description: `Huidige score: ${p.score} pt (Plek #${p.position})`
          }));
      });

      // 4. send_push_all
      const sendPushAllCard = this.homey.flow.getActionCard('send_push_all');
      sendPushAllCard.registerRunListener(async args => {
        const text = String(args.tekst || 'Bericht van Party Quiz!');
        const activeIds = this.quizEngine.getLeaderboard().map(p => p.id);
        await this.pushManager.sendToAll(
          {
            title: '📢 Party Quiz',
            body: text,
            tag: 'flow-broadcast'
          },
          activeIds.length > 0 ? activeIds : null
        );
        return true;
      });

      // 5. send_push_player
      const sendPushPlayerCard = this.homey.flow.getActionCard('send_push_player');
      sendPushPlayerCard.registerRunListener(async args => {
        const target = args.speler && args.speler.id ? args.speler.id : args.speler;
        const player = this.quizEngine.findPlayer(target);
        if (!player) throw new Error('Speler niet gevonden.');
        const text = String(args.tekst || 'Persoonlijk bericht van Homey!');
        await this.pushManager.sendToPlayer(player.id, {
          title: `💬 Bericht voor ${player.name}`,
          body: text,
          tag: 'flow-direct'
        });
        return true;
      });
      sendPushPlayerCard.registerArgumentAutocompleteListener('speler', async query => {
        const q = (query || '').toLowerCase();
        return this.quizEngine
          .getLeaderboard()
          .filter(p => p.name.toLowerCase().includes(q))
          .map(p => ({
            id: p.id,
            name: `${p.avatar || '🎉'} ${p.name}`,
            description: `Plek #${p.position} • ${p.score} pt`
          }));
      });
    } catch (err) {
      this.log('[Flow] Action cards registratie fout:', err.message);
    }
  }

  _fireHomeyFlowTrigger(triggerId, tokens = {}, state = {}) {
    this.log(`[Flow Trigger] 🔔 ${triggerId} ->`, JSON.stringify(tokens));
    const card = this.triggerCards[triggerId];
    if (card && typeof card.trigger === 'function') {
      card.trigger(tokens, state).catch(err => {
        this.log(`[Flow Trigger Fout] ${triggerId}:`, err.message);
      });
    }
  }

  // =========================================================================
  // WIDGET & API BRIDGE METHODS
  // =========================================================================
  getWidgetStatus(req = null) {
    const pub = this.quizEngine.getPublicState();
    const origin = this.resolvePublicOrigin(req);
    return {
      phase: pub.phase,
      quizId: pub.quizId,
      quizName: pub.quizTitle,
      currentQuestionIndex: pub.currentQuestionIndex,
      totalQuestions: pub.totalQuestions,
      remainingSeconds: pub.remainingSeconds,
      playerCount: pub.totalPlayers,
      top3: pub.top3,
      hostUrl: `${origin}/host`,
      playUrl: `${origin}/play`
    };
  }

  advanceQuizFromWidget() {
    this.quizEngine.nextStep();
    return this.getWidgetStatus();
  }

  startQuizFromWidget(quizId = null) {
    const quiz =
      (quizId && this.quizzes.find(q => q.id === quizId)) ||
      this.quizEngine.activeQuiz ||
      this.quizzes[0];
    if (quiz) {
      this.quizEngine.startQuiz(quiz, true);
    }
    return this.getWidgetStatus();
  }

  // =========================================================================
  // EXPRESS & SOCKET.IO REALTIME SERVER
  // =========================================================================
  async _startWebServer({ host = '0.0.0.0', port = this.serverConfig.serverPort || 3456 } = {}) {
    this.expressApp = express();
    this.httpServer = http.createServer(this.expressApp);
    this.io = new SocketIOServer(this.httpServer, {
      allowRequest: (req, callback) => callback(null, this._sameOrigin(req))
    });

    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 }
    });

    this.expressApp.use(express.json({ limit: '5mb' }));
    this.expressApp.use(express.urlencoded({ extended: true }));

    this.expressApp.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !this._sameOrigin(req)) {
        return res.status(403).json({ error: 'Ongeldige oorsprong.' });
      }
      next();
    });

    this.expressApp.get('/login', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'login.html'));
    });
    this.expressApp.post('/api/login', (req, res) => {
      if (!req.is('application/json')) return res.status(415).json({ error: 'JSON vereist.' });
      if (!this.adminSecurity.authenticate(req.body && req.body.password, req.socket.remoteAddress)) {
        return res.status(401).json({ error: 'Ongeldig wachtwoord, niet ingesteld of te veel pogingen.' });
      }
      const token = this.adminSecurity.createSession();
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader('Set-Cookie', `party_quiz_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? '; Secure' : ''}`);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true });
    });
    this.expressApp.post('/api/logout', (req, res) => {
      const match = /(?:^|;\s*)party_quiz_admin=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
      if (match) this.adminSecurity.sessions.delete(match[1]);
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader('Set-Cookie', `party_quiz_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true });
    });
    this.expressApp.get('/api/admin/session', (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ authenticated: this.adminSecurity.sessionFromRequest(req) });
    });
    this.expressApp.use((req, res, next) => {
      const requestPath = req.path.toLowerCase().replace(/\/+$/, '') || '/';
      const publicApi = (req.method === 'GET' && ['/api/state', '/api/qr', '/api/vapid-public-key', '/api/widget/status'].includes(requestPath)) ||
        (req.method === 'POST' && ['/api/push/subscribe', '/api/push/player-test', '/api/player/reset'].includes(requestPath));
      const adminPage = /^\/(admin|host|settings)(\/|$)/.test(requestPath);
      if ((requestPath.startsWith('/api/') && !publicApi) || adminPage) {
        res.setHeader('Cache-Control', 'no-store');
        if (!this.adminSecurity.sessionFromRequest(req)) {
          if (adminPage && req.method === 'GET') return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
          return res.status(401).json({ error: 'Meld je aan als beheerder.' });
        }
      }
      next();
    });

    // Service Worker at root scope (/sw.js) so it can control /play
    this.expressApp.get('/sw.js', (req, res) => {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(__dirname, 'public', 'sw.js'));
    });

    this.expressApp.get('/admin-navigation.js', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'admin-navigation.js'));
    });

    // Pretty URLs: /host, /play, /admin, /settings, /widget -> map naar index.html
    const uiIndexRoutes = {
      '/host': path.join('public', 'host', 'index.html'),
      '/play': path.join('public', 'play', 'index.html'),
      '/admin': path.join('public', 'admin', 'index.html'),
      '/settings': path.join('settings', 'index.html'),
      '/widget': path.join('widgets', 'quiz-status', 'public', 'index.html')
    };
    for (const [route, file] of Object.entries(uiIndexRoutes)) {
      this.expressApp.get(route, (req, res) => res.sendFile(path.join(__dirname, file)));
    }

    // Static assets & 4 UI interfaces
    this.expressApp.use('/css', express.static(path.join(__dirname, 'public', 'css')));
    this.expressApp.use('/assets', express.static(path.join(__dirname, 'assets')));
    this.expressApp.use('/host', express.static(path.join(__dirname, 'public', 'host')));
    this.expressApp.use('/play', express.static(path.join(__dirname, 'public', 'play')));
    this.expressApp.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
    this.expressApp.use(
      '/widget',
      express.static(path.join(__dirname, 'widgets', 'quiz-status', 'public'))
    );
    this.expressApp.use('/settings', express.static(path.join(__dirname, 'settings')));

    // API: Live State & QR Code
    this.expressApp.get('/api/state', (req, res) => {
      res.json({
        ...this.quizEngine.getPublicState(),
        quizzes: this.quizzes.map(q => ({
          id: q.id,
          title: q.title,
          description: q.description,
          questionCount: (q.questions || []).length
        })),
        serverConfig: this.serverConfig,
        playUrl: `${this.resolvePublicOrigin(req)}/play`,
        hostUrl: `${this.resolvePublicOrigin(req)}/host`
      });
    });

    this.expressApp.get('/api/qr', async (req, res) => {
      try {
        const playUrl = req.query.url || `${this.resolvePublicOrigin(req)}/play`;
        const dataUrl = await QRCode.toDataURL(playUrl, {
          width: 1024,
          margin: 1,
          color: {
            dark: '#0F172A',
            light: '#FFFFFF'
          }
        });
        res.json({ playUrl, qrDataUrl: dataUrl });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // API: Web Push VAPID & Subscription
    this.expressApp.get('/api/vapid-public-key', (req, res) => {
      res.json({
        publicKey: this.pushManager.getPublicKey()
      });
    });

    this.expressApp.post('/api/push/subscribe', (req, res) => {
      const { playerId, playerSecret, subscription } = req.body || {};
      if (!playerSecret || this.playerSecrets.get(playerId) !== playerSecret) {
        return res.status(401).json({ error: 'Meld je eerst aan als speler.' });
      }
      if (!PushManager.isAllowedSubscription(subscription)) {
        return res.status(400).json({ error: 'Ongeldige push-provider.' });
      }
      const ok = this.pushManager.saveSubscription(playerId, subscription);
      if (!ok) return res.status(400).json({ error: 'Ongeldig push-abonnement.' });
      res.json({ success: true });
    });

    this.expressApp.post('/api/player/reset', (req, res) => {
      const { playerId, playerSecret } = req.body || {};
      if (typeof playerId !== 'string' || !playerId) {
        return res.status(400).json({ error: 'Ongeldig spelersprofiel.' });
      }
      try {
        const result = this._resetPlayerSession(playerId, playerSecret);
        res.status(result.success ? 200 : 401).json(result);
      } catch (err) {
        this.log('[Spelers] Sessie beëindigen mislukt:', err.message);
        res.status(500).json({ success: false, error: 'De spelerssessie kon niet worden beëindigd.' });
      }
    });

    this.expressApp.post('/api/push/player-test', async (req, res) => {
      const { playerId, playerSecret } = req.body || {};
      if (!playerSecret || this.playerSecrets.get(playerId) !== playerSecret) {
        return res.status(401).json({ error: 'Meld je eerst aan als speler.' });
      }
      if (!this.pushManager.subscriptions.has(playerId)) {
        return res.status(400).json({ error: 'Er is geen push-abonnement voor deze speler.' });
      }
      const now = Date.now();
      if (now - (this.playerPushTests.get(playerId) || 0) < 10000) {
        return res.status(429).json({ error: 'Wacht 10 seconden voor een nieuwe testmelding.' });
      }
      this.playerPushTests.set(playerId, now);
      try {
        const result = await this.pushManager.sendToPlayer(playerId, {
          title: '🔔 Party Quiz testmelding',
          body: 'Web Push is gekoppeld aan jouw speler.',
          tag: 'test-push'
        }, { realtime: false });
        if (!result.sent) return res.status(502).json({ error: 'De testmelding kon niet worden verzonden. Controleer je pushinstellingen en probeer opnieuw.' });
        res.json({ success: true });
      } catch (err) {
        this.log('[Push] Testmelding mislukt:', err.message);
        res.status(500).json({ error: 'De testmelding kon niet worden verzonden.' });
      }
    });

    this.expressApp.post('/api/push/regenerate-vapid', (req, res) => {
      const newPublicKey = this.pushManager.regenerateVapidKeys();
      res.json({ success: true, publicKey: newPublicKey });
    });

    this.expressApp.post('/api/push/test', async (req, res, next) => {
      try {
        res.json(await this.sendTestPush(req.body || {}));
      } catch (err) {
        next(err);
      }
    });

    // API: Widget endpoints
    this.expressApp.get('/api/widget/status', (req, res) => {
      res.json(this.getWidgetStatus(req));
    });

    this.expressApp.post('/api/widget/next', (req, res) => {
      res.json(this.advanceQuizFromWidget());
    });

    // API: Quizzes CRUD
    this.expressApp.get('/api/quizzes', (req, res) => {
      res.json({
        quizzes: this.quizzes,
        activeQuizId: this.quizEngine.activeQuiz ? this.quizEngine.activeQuiz.id : null
      });
    });

    this.expressApp.post('/api/quizzes', (req, res) => {
      try {
        const body = req.body || {};
        if (!body.title || !Array.isArray(body.questions) || body.questions.length === 0) {
          return res.status(400).json({ error: 'Geef een titel en minimaal 1 vraag op.' });
        }
        const normalized = FileImporter.normalizeJsonQuiz(body, body.title);
        const existingIndex = this.quizzes.findIndex(q => q.id === normalized.id);
        if (existingIndex >= 0) {
          this.quizzes[existingIndex] = normalized;
        } else {
          this.quizzes.push(normalized);
        }
        this._saveQuizzes(this.quizzes);

        // Update lobby if this quiz is currently active in lobby
        if (
          !this.quizEngine.activeQuiz ||
          (this.quizEngine.activeQuiz.id === normalized.id && this.quizEngine.phase === 'lobby')
        ) {
          this.quizEngine.selectQuizForLobby(normalized);
        }

        res.json({ success: true, quiz: normalized, quizzes: this.quizzes });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    this.expressApp.delete('/api/quizzes/:id', (req, res) => {
      const id = req.params.id;
      this.quizzes = this.quizzes.filter(q => q.id !== id);
      this._saveQuizzes(this.quizzes);
      if (this.quizEngine.activeQuiz && this.quizEngine.activeQuiz.id === id) {
        if (this.quizzes.length > 0) {
          this.quizEngine.selectQuizForLobby(this.quizzes[0]);
        }
      }
      res.json({ success: true, quizzes: this.quizzes });
    });

    // API: File Import (.xlsx, .csv, .json) & Sample downloads
    this.expressApp.post('/api/import', upload.single('file'), (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: 'Geen bestand geüpload.' });
        }
        const customTitle = req.body && req.body.title ? req.body.title : '';
        const importedQuiz = FileImporter.parseQuizFile(
          req.file.buffer,
          req.file.originalname,
          customTitle
        );
        this.quizzes.push(importedQuiz);
        this._saveQuizzes(this.quizzes);
        res.json({
          success: true,
          quiz: importedQuiz,
          quizzes: this.quizzes
        });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    this.expressApp.get('/api/samples/:format', (req, res) => {
      const fmt = (req.params.format || '').toLowerCase();
      if (fmt === 'json') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="homey-party-quiz-voorbeeld.json"'
        );
        return res.send(FileImporter.generateSampleJson());
      }
      if (fmt === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="homey-party-quiz-voorbeeld.csv"'
        );
        return res.send(FileImporter.generateSampleCsv());
      }
      if (fmt === 'xlsx') {
        const buf = FileImporter.generateSampleXlsxBuffer();
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="homey-party-quiz-voorbeeld.xlsx"'
        );
        return res.send(buf);
      }
      res.status(400).json({ error: 'Ongeldig formaat. Kies xlsx, csv of json.' });
    });

    // API: Server & Reverse-Proxy Settings
    this.expressApp.get('/api/settings', (req, res) => {
      res.json(this.getAppSettings());
    });

    this.expressApp.post('/api/settings/password', (req, res) => {
      try {
        this.adminSecurity.setPassword(req.body && req.body.newPassword);
        res.setHeader('Set-Cookie', 'party_quiz_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        res.json({ success: true });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    this.expressApp.post('/api/settings', (req, res) => {
      try {
        const updated = this._saveServerConfig(req.body || {});
        res.json({ success: true, serverConfig: updated });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    // API: Game Controls & Flow Action/Condition Tester
    this.expressApp.post('/api/control/select-quiz', (req, res) => {
      const { quizId } = req.body || {};
      const quiz = this.quizzes.find(q => q.id === quizId);
      if (!quiz) return res.status(404).json({ error: 'Quiz niet gevonden.' });
      this.quizEngine.selectQuizForLobby(quiz);
      res.json({ success: true, state: this.quizEngine.getPublicState() });
    });

    this.expressApp.post('/api/control/start', (req, res) => {
      try {
        const { quizId, startImmediately } = req.body || {};
        const quiz =
          (quizId && this.quizzes.find(q => q.id === quizId)) ||
          this.quizEngine.activeQuiz ||
          this.quizzes[0];
        if (!quiz) return res.status(404).json({ error: 'Geen quiz gevonden.' });
        const state = this.quizEngine.startQuiz(
          quiz,
          startImmediately !== undefined ? Boolean(startImmediately) : true
        );
        res.json({ success: true, state });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    this.expressApp.post('/api/control/next', (req, res) => {
      try {
        const state = this.quizEngine.nextStep();
        res.json({ success: true, state });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    this.expressApp.post('/api/control/bonus', (req, res) => {
      try {
        const { playerId, points } = req.body || {};
        const player = this.quizEngine.giveBonusPoints(playerId, points);
        res.json({ success: true, player, state: this.quizEngine.getPublicState() });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    this.expressApp.post('/api/flow/evaluate-condition', (req, res) => {
      const { conditionId, playerId } = req.body || {};
      const result = this.quizEngine.evaluateCondition(
        conditionId,
        { player: { id: playerId } },
        { playerId }
      );
      res.json({ conditionId, playerId, result });
    });

    this.expressApp.get('/api/flow/history', (req, res) => {
      res.json({ flowHistory: this.quizEngine.flowHistory.slice(0, 20) });
    });

    // Demo Party Bot helper so users can test full multi-player podiums & rank triggers immediately
    this.expressApp.post('/api/demo/add-bots', (req, res) => {
      const demoPlayers = [
        { id: 'bot_sophie', name: 'Sophie', avatar: '🦊', color: '#00A4E8' },
        { id: 'bot_daan', name: 'Daan', avatar: '🚀', color: '#10B981' },
        { id: 'bot_milan', name: 'Milan', avatar: '⚡', color: '#F59E0B' },
        { id: 'bot_emma', name: 'Emma', avatar: '🦄', color: '#8B5CF6' }
      ];
      for (const b of demoPlayers) {
        this.quizEngine.joinOrReconnectPlayer({ ...b, socketId: null, isBot: true });
      }
      res.json({ success: true, state: this.quizEngine.getPublicState() });
    });

    this.expressApp.post('/api/demo/bot-answers', (req, res) => {
      if (this.quizEngine.phase !== 'question') {
        return res.status(400).json({ error: 'Start eerst een vraag om bots te laten antwoorden.' });
      }
      const q = this.quizEngine.activeQuiz.questions[this.quizEngine.currentQuestionIndex];
      const correctIdx = Number(q.correctIndex);

      // Alle spelers die als demo-bot zijn aangemaakt en nog niet hebben geantwoord
      const bots = Array.from(this.quizEngine.players.values()).filter(
        p => (p.isBot || String(p.id).startsWith('bot_')) && p.lastAnswerIndex === null
      );
      bots.forEach((bot, idx) => {
        setTimeout(() => {
          if (this.quizEngine.phase === 'question' &&
              this.quizEngine.activeQuiz.questions[this.quizEngine.currentQuestionIndex] === q) {
            // 70% kans dat een bot het juiste antwoord kiest
            const pick =
              Math.random() < 0.7 ? correctIdx : Math.floor(Math.random() * 4);
            this.quizEngine.submitAnswer(bot.id, pick);
          }
        }, idx * 350);
      });
      res.json({ success: true, triggeredBots: bots.length });
    });

    // Root hub page
    this.expressApp.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

    // Socket.io Realtime Handlers
    this._setupSocketHandlers();

    await new Promise(resolve => {
      this.httpServer.listen(port, host, () => {
        this.log(`🚀 Party Quiz Webserver & Socket.io actief op http://0.0.0.0:${port}`);
        this.log(`   📺 Host / TV scherm : http://${this.getDetectedLanIp()}:${port}/host`);
        this.log(`   📱 Spelersscherm    : http://${this.getDetectedLanIp()}:${port}/play`);
        this.log(`   ⚙️  Beheer & Editor  : http://${this.getDetectedLanIp()}:${port}/admin`);
        this.log(`   📊 Dashboard Widget : http://${this.getDetectedLanIp()}:${port}/widget`);
        resolve();
      });
    });
  }

  _sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase();
    } catch (err) {
      return false;
    }
  }

  _removePlayers(playerIds) {
    const players = playerIds.map(id => this.quizEngine.players.get(id)).filter(Boolean);
    const ids = players.map(player => player.id);
    this.pushManager.removeSubscriptions(ids);
    for (const player of players) {
      this.removedPlayerIds.add(player.id);
      this.playerSecrets.delete(player.id);
      this.playerPushTests.delete(player.id);
    }
    const removedIds = new Set(ids);
    for (const socket of this.io.sockets.sockets.values()) {
      if (removedIds.has(socket.data.playerId)) {
        socket.emit('player_removed');
        delete socket.data.playerId;
      }
    }
    return this.quizEngine.removePlayers(ids);
  }

  _resetPlayerSession(playerId, playerSecret, boundPlayerId = null) {
    if (!this.playerSecrets.has(playerId)) return { success: true };
    if (playerId !== boundPlayerId && this.playerSecrets.get(playerId) !== playerSecret) {
      return { success: false, error: 'Deze spelerssessie kan niet worden beëindigd.' };
    }
    this.pushManager.removeSubscriptions([playerId]);
    this.playerSecrets.delete(playerId);
    this.removedPlayerIds.add(playerId);
    this.playerPushTests.delete(playerId);
    for (const socket of this.io.sockets.sockets.values()) {
      if (socket.data.playerId === playerId) {
        delete socket.data.playerId;
        socket.emit('player_session_ended');
        this.quizEngine.handleDisconnect(socket.id);
      }
    }
    return { success: true };
  }

  _setupSocketHandlers() {
    this.io.on('connection', socket => {
      // Immediately send current quiz state on connect
      socket.emit('quiz_state', this.quizEngine.getPublicState());

      socket.on('player_join', (payload, ack) => {
        try {
          if (!payload || typeof payload.name !== 'string' || !payload.name.trim()) {
            throw new Error('Vul je naam in.');
          }
          let playerId = payload.playerId;
          let playerSecret = payload.playerSecret;
          if (playerId && this.removedPlayerIds.has(playerId)) {
            if (typeof ack === 'function') ack({ success: false, code: 'player_removed', error: 'Je bent uit de quiz verwijderd.' });
            return;
          }
          if (playerId && this.playerSecrets.has(playerId)) {
            if (!playerSecret || this.playerSecrets.get(playerId) !== playerSecret) {
              throw new Error('Deze speler kan niet worden hersteld.');
            }
          } else {
            playerId = `p_${crypto.randomBytes(16).toString('hex')}`;
            playerSecret = crypto.randomBytes(32).toString('hex');
            this.playerSecrets.set(playerId, playerSecret);
          }
          const player = this.quizEngine.joinOrReconnectPlayer({
            playerId,
            name: payload.name,
            avatar: typeof payload.avatar === 'string' ? payload.avatar.slice(0, 8) : undefined,
            color: typeof payload.color === 'string' && /^#[a-f0-9]{6}$/i.test(payload.color) ? payload.color : undefined,
            socketId: socket.id
          });
          socket.data.playerId = player.id;
          if (typeof ack === 'function') {
            ack({ success: true, player, playerSecret, state: this.quizEngine.getPublicState() });
          }
        } catch (err) {
          if (typeof ack === 'function') {
            ack({ success: false, error: err.message });
          }
        }
      });

      socket.on('submit_answer', (payload, ack) => {
        const { playerId, answerIndex } = payload || {};
        if (!playerId || this.quizEngine.socketToPlayer.get(socket.id) !== playerId) {
          if (typeof ack === 'function') ack({ accepted: false, reason: 'Meld je eerst aan als speler.' });
          return;
        }
        const result = this.quizEngine.submitAnswer(playerId, answerIndex);
        if (typeof ack === 'function') {
          ack(result);
        }
      });

      socket.on('player_reset', (payload, ack) => {
        const boundPlayerId = socket.data.playerId;
        const playerId = boundPlayerId || (payload && payload.playerId);
        if (!playerId) {
          if (typeof ack === 'function') ack({ success: true });
          return;
        }
        try {
          const result = this._resetPlayerSession(playerId, payload && payload.playerSecret, boundPlayerId);
          if (typeof ack === 'function') ack(result);
        } catch (err) {
          this.log('[Spelers] Sessie beëindigen mislukt:', err.message);
          if (typeof ack === 'function') ack({ success: false, error: 'De spelerssessie kon niet worden beëindigd.' });
        }
      });

      socket.on('host_select_quiz', (payload, ack) => {
        if (!this.adminSecurity.sessionFromRequest(socket.request)) {
          if (typeof ack === 'function') ack({ success: false, error: 'Meld je aan als beheerder.' });
          return;
        }
        const quiz = this.quizzes.find(q => q.id === (payload && payload.quizId));
        if (quiz) {
          this.quizEngine.selectQuizForLobby(quiz);
        }
        if (typeof ack === 'function') {
          ack({ success: Boolean(quiz), state: this.quizEngine.getPublicState() });
        }
      });

      socket.on('host_start_quiz', (payload, ack) => {
        if (!this.adminSecurity.sessionFromRequest(socket.request)) {
          if (typeof ack === 'function') ack({ success: false, error: 'Meld je aan als beheerder.' });
          return;
        }
        try {
          const quizId = payload && payload.quizId;
          const quiz =
            (quizId && this.quizzes.find(q => q.id === quizId)) ||
            this.quizEngine.activeQuiz ||
            this.quizzes[0];
          const state = this.quizEngine.startQuiz(quiz, true);
          if (typeof ack === 'function') ack({ success: true, state });
        } catch (err) {
          if (typeof ack === 'function') ack({ success: false, error: err.message });
        }
      });

      socket.on('host_next_step', (payload, ack) => {
        if (!this.adminSecurity.sessionFromRequest(socket.request)) {
          if (typeof ack === 'function') ack({ success: false, error: 'Meld je aan als beheerder.' });
          return;
        }
        try {
          const state = this.quizEngine.nextStep();
          if (typeof ack === 'function') ack({ success: true, state });
        } catch (err) {
          if (typeof ack === 'function') ack({ success: false, error: err.message });
        }
      });

      socket.on('host_kick_player', (payload, ack) => {
        if (!this.adminSecurity.sessionFromRequest(socket.request)) {
          if (typeof ack === 'function') ack({ success: false, error: 'Meld je aan als beheerder.' });
          return;
        }
        try {
          const removed = this._removePlayers([payload && payload.playerId]);
          if (typeof ack === 'function') ack({ success: removed > 0 });
        } catch (err) {
          this.log('[Spelers] Verwijderen mislukt:', err.message);
          if (typeof ack === 'function') ack({ success: false, error: 'Speler verwijderen mislukt.' });
        }
      });

      socket.on('host_clear_players', (payload, ack) => {
        if (!this.adminSecurity.sessionFromRequest(socket.request)) {
          if (typeof ack === 'function') ack({ success: false, error: 'Meld je aan als beheerder.' });
          return;
        }
        try {
          const removed = this._removePlayers(Array.from(this.quizEngine.players.keys()));
          if (typeof ack === 'function') ack({ success: true, removed });
        } catch (err) {
          this.log('[Spelers] Verwijderen mislukt:', err.message);
          if (typeof ack === 'function') ack({ success: false, error: 'Spelers verwijderen mislukt.' });
        }
      });

      socket.on('disconnect', () => {
        this.quizEngine.handleDisconnect(socket.id);
      });
    });
  }
}

module.exports = PartyQuizApp;
