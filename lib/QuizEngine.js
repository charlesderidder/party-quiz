'use strict';

const EventEmitter = require('events');
const { randomUUID } = require('crypto');

class QuizEngine extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.pushManager - PushManager instance
   * @param {function} options.onStateChange - Callback when state changes
   * @param {function} options.onFlowTrigger - Callback(triggerId, tokens, state)
   * @param {function} options.log - Logger function
   */
  constructor({ pushManager, onStateChange, onFlowTrigger, log }) {
    super();
    this.pushManager = pushManager;
    this.onStateChange = onStateChange || (() => {});
    this.onFlowTrigger = onFlowTrigger || (() => {});
    this.log = log || console.log;

    // Active game state
    this.phase = 'lobby'; // 'lobby' | 'question' | 'reveal' | 'finished'
    this.activeQuiz = null;
    this.currentQuestionIndex = -1;
    this.questionStartedAt = null;
    this.questionTimeLimit = 20;
    this.remainingSeconds = 0;
    this.currentAvailablePoints = 1000;
    this.fastestCorrectPlayerId = null;
    this.roundId = null;

    // Players map: playerId -> PlayerState
    this.players = new Map();
    this.socketToPlayer = new Map();

    // Timers
    this.tickInterval = null;
    this.allAnsweredTimeout = null;
    this.flowHistory = [];
  }

  /**
   * Requirement #8:
   * Start altijd met 1000 punten de eerste seconde dat het antwoord getoond wordt (0.0s t/m 1.0s),
   * laat daarna vanaf seconde 2 tot 20 (maximale tijd om de vraag te beantwoorden) de score aflopen naar 0.
   */
  static calculateTimeScore(elapsedSeconds, maxTime = 20, maxPoints = 1000) {
    const effectiveMaxTime = Math.max(2, Number(maxTime) || 20);
    const effectiveMaxPoints = Math.max(100, Number(maxPoints) || 1000);

    if (elapsedSeconds <= 1.0) {
      return effectiveMaxPoints;
    }
    if (elapsedSeconds >= effectiveMaxTime) {
      return 0;
    }

    // Vanaf t = 1.0s (begin van seconde 2) tot t = effectiveMaxTime (bijv. 20s) lineair aflopend naar 0
    const decayDuration = effectiveMaxTime - 1.0;
    const decayElapsed = elapsedSeconds - 1.0;
    const ratio = 1 - decayElapsed / decayDuration;
    return Math.max(0, Math.min(effectiveMaxPoints, Math.round(effectiveMaxPoints * ratio)));
  }

  /**
   * Selects a quiz into the lobby without starting Question 1 yet
   */
  selectQuizForLobby(quiz) {
    if (!quiz) return false;
    this._clearTimers();
    this.activeQuiz = JSON.parse(JSON.stringify(quiz));
    this.phase = 'lobby';
    this.currentQuestionIndex = -1;
    this.questionStartedAt = null;
    this.remainingSeconds = 0;
    this.currentAvailablePoints = 1000;
    this.fastestCorrectPlayerId = null;
    this.roundId = null;

    // Reset player scores for the new lobby session while keeping connected players
    let idx = 1;
    for (const player of this.players.values()) {
      player.score = 0;
      player.position = idx;
      player.previousPosition = idx;
      player.rankDelta = 0;
      player.lastAnswerIndex = null;
      player.lastAnswerCorrect = false;
      player.lastPointsEarned = 0;
      player.lastAnswerTimeSec = null;
      player.streak = 0;
      idx++;
    }

    this._broadcastState();
    return true;
  }

  /**
   * Registers or reconnects a player (supports browser refresh recovery via playerId)
   */
  joinOrReconnectPlayer({ playerId, name, avatar, color, socketId, isBot }) {
    const cleanId = String(playerId || `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    const cleanName = String(name || 'Speler').trim().slice(0, 24) || 'Speler';
    const previousPlayerId = socketId && this.socketToPlayer.get(socketId);
    if (previousPlayerId && previousPlayerId !== cleanId) this.handleDisconnect(socketId);

    let player = this.players.get(cleanId);
    if (player) {
      // Session recovery after browser refresh
      if (name && name.trim()) player.name = cleanName;
      if (avatar) player.avatar = avatar;
      if (color) player.color = color;
      player.connected = true;
      player.socketId = socketId;
      if (isBot) player.isBot = true;
    } else {
      // Check if name is already taken by another playerId
      let finalName = cleanName;
      const existingNames = new Set(
        Array.from(this.players.values()).map(p => p.name.toLowerCase())
      );
      if (existingNames.has(finalName.toLowerCase())) {
        let suffix = 2;
        while (existingNames.has(`${finalName} #${suffix}`.toLowerCase())) {
          suffix++;
        }
        finalName = `${finalName} #${suffix}`;
      }

      const initialRank = this.players.size + 1;
      player = {
        id: cleanId,
        name: finalName,
        avatar: avatar || '🎉',
        color: color || '#00A4E8',
        score: 0,
        position: initialRank,
        previousPosition: initialRank,
        rankDelta: 0,
        lastAnswerIndex: null,
        lastAnswerCorrect: false,
        lastPointsEarned: 0,
        lastAnswerTimeSec: null,
        streak: 0,
        connected: true,
        isBot: Boolean(isBot),
        socketId
      };
      this.players.set(cleanId, player);
    }

    if (socketId) {
      this.socketToPlayer.set(socketId, cleanId);
    }

    this._recalculatePositions(false);
    this._broadcastState();
    return player;
  }

  handleDisconnect(socketId) {
    const playerId = this.socketToPlayer.get(socketId);
    if (playerId) {
      const player = this.players.get(playerId);
      this.socketToPlayer.delete(socketId);
      if (player && player.socketId === socketId) {
        const replacement = Array.from(this.socketToPlayer).find(([, id]) => id === playerId);
        player.socketId = replacement ? replacement[0] : null;
        player.connected = Boolean(replacement);
      }
      this._broadcastState();
    }
  }

  removePlayer(playerId) {
    return this.removePlayers([playerId]) > 0;
  }

  removePlayers(playerIds) {
    let removed = 0;
    for (const playerId of playerIds) {
      const player = this.players.get(playerId);
      if (!player) continue;
      for (const [socketId, id] of this.socketToPlayer) {
        if (id === playerId) this.socketToPlayer.delete(socketId);
      }
      this.players.delete(playerId);
      if (this.fastestCorrectPlayerId === playerId) this.fastestCorrectPlayerId = null;
      removed++;
    }
    if (removed) {
      this._recalculatePositions(false);
      this._broadcastState();
    }
    return removed;
  }

  /**
   * Starts a quiz from Question 1 (or puts in lobby if startImmediately=false)
   */
  startQuiz(quiz, startImmediately = true) {
    if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      throw new Error('Quiz bevat geen vragen.');
    }

    this.selectQuizForLobby(quiz);

    // Fire Flow trigger: quiz_started
    this._triggerFlow('quiz_started', {
      quiz_naam: this.activeQuiz.title
    });

    if (startImmediately) {
      this.nextStep();
    }
    return this.getPublicState();
  }

  /**
   * Advances the quiz state machine:
   * - From 'lobby' -> starts Question 0
   * - From 'question' -> ends question early and goes to 'reveal' (podium/leaderboard)
   * - From 'reveal' -> starts next question, or goes to 'finished' if at last question
   * - From 'finished' -> resets to 'lobby'
   */
  nextStep() {
    if (!this.activeQuiz) {
      throw new Error('Geen actieve quiz geselecteerd.');
    }

    if (this.phase === 'lobby') {
      return this._startQuestion(0);
    }

    if (this.phase === 'question') {
      return this._finalizeQuestionRound('manual_advance');
    }

    if (this.phase === 'reveal') {
      const nextIdx = this.currentQuestionIndex + 1;
      if (nextIdx < this.activeQuiz.questions.length) {
        return this._startQuestion(nextIdx);
      }
      return this._finishQuiz();
    }

    if (this.phase === 'finished') {
      this.selectQuizForLobby(this.activeQuiz);
      return this.getPublicState();
    }

    return this.getPublicState();
  }

  _startQuestion(index) {
    this._clearTimers();
    const question = this.activeQuiz.questions[index];
    if (!question) {
      return this._finishQuiz();
    }

    // Snapshot each player's position BEFORE this question starts
    this._recalculatePositions(false);
    for (const player of this.players.values()) {
      player.previousPosition = player.position;
      player.lastAnswerIndex = null;
      player.lastAnswerCorrect = false;
      player.lastPointsEarned = 0;
      player.lastAnswerTimeSec = null;
    }

    this.currentQuestionIndex = index;
    this.fastestCorrectPlayerId = null;
    this.roundId = randomUUID();
    this.phase = 'question';
    this.questionTimeLimit = Math.min(90, Math.max(5, Number(question.timeLimit) || 20));
    this.questionMaxPoints = Math.max(100, Number(question.points) || 1000);
    this.questionStartedAt = Date.now();
    this.remainingSeconds = this.questionTimeLimit;
    this.currentAvailablePoints = this.questionMaxPoints;

    // Fire Flow trigger: question_asked
    this._triggerFlow('question_asked', {
      vraag_tekst: question.question,
      vraag_nummer: index + 1,
      quiz_naam: this.activeQuiz.title
    });

    // High-frequency timer (200ms) for smooth countdown & live 1000->0 score ticker
    this.tickInterval = setInterval(() => {
      const elapsedSec = (Date.now() - this.questionStartedAt) / 1000;
      const remaining = Math.max(0, this.questionTimeLimit - elapsedSec);
      this.remainingSeconds = Number(remaining.toFixed(1));
      this.currentAvailablePoints = QuizEngine.calculateTimeScore(
        elapsedSec,
        this.questionTimeLimit,
        this.questionMaxPoints
      );

      this.emit('timer_tick', {
        remainingSeconds: Math.ceil(remaining),
        exactRemainingSeconds: this.remainingSeconds,
        currentAvailablePoints: this.currentAvailablePoints,
        elapsedSeconds: Number(elapsedSec.toFixed(2))
      });

      if (elapsedSec >= this.questionTimeLimit) {
        this._finalizeQuestionRound('timeout');
      }
    }, 200);

    this._broadcastState();
    return this.getPublicState();
  }

  /**
   * Processes a player's submitted answer (0..3)
   */
  submitAnswer(playerId, answerIndex) {
    if (this.phase !== 'question' || !this.activeQuiz) {
      return { accepted: false, reason: 'Geen actieve vraag.' };
    }

    const player = this.players.get(playerId);
    if (!player) {
      return { accepted: false, reason: 'Speler niet gevonden.' };
    }

    if (player.lastAnswerIndex !== null) {
      return { accepted: false, reason: 'Je hebt deze vraag al beantwoord.' };
    }

    const question = this.activeQuiz.questions[this.currentQuestionIndex];
    const cleanIndex = Number(answerIndex);
    if (
      (typeof answerIndex !== 'number' && typeof answerIndex !== 'string') ||
      (typeof answerIndex === 'string' && !answerIndex.trim()) ||
      !Number.isInteger(cleanIndex) || cleanIndex < 0 || cleanIndex > 3
    ) {
      return { accepted: false, reason: 'Ongeldige antwoordoptie.' };
    }

    const elapsedSeconds = Math.max(0, (Date.now() - this.questionStartedAt) / 1000);
    if (elapsedSeconds >= this.questionTimeLimit) {
      this._finalizeQuestionRound('timeout');
      return { accepted: false, reason: 'De tijd voor deze vraag is voorbij.' };
    }
    const isCorrect = cleanIndex === Number(question.correctIndex);
    if (isCorrect && !this.fastestCorrectPlayerId) {
      this.fastestCorrectPlayerId = player.id;
    }

    const pointsEarned = isCorrect
      ? QuizEngine.calculateTimeScore(elapsedSeconds, this.questionTimeLimit, this.questionMaxPoints)
      : 0;

    player.lastAnswerIndex = cleanIndex;
    player.lastAnswerCorrect = isCorrect;
    player.lastPointsEarned = pointsEarned;
    player.lastAnswerTimeSec = Number(elapsedSeconds.toFixed(2));
    player.score += pointsEarned;
    player.streak = isCorrect ? (player.streak || 0) + 1 : 0;

    // Update live positions so Flow tokens have current score & rank
    this._recalculatePositions(false);

    const flowTokens = this._buildPlayerTokens(player);
    const flowState = { playerId: player.id, playerName: player.name };

    if (isCorrect) {
      this._triggerFlow('player_answered_correct', flowTokens, flowState);
    } else {
      this._triggerFlow('player_answered_wrong', flowTokens, flowState);
    }

    this._broadcastState();

    // Check if all connected players have answered
    const activePlayers = Array.from(this.players.values()).filter(p => p.connected);
    const allAnswered =
      activePlayers.length > 0 && activePlayers.every(p => p.lastAnswerIndex !== null);

    if (allAnswered && !this.allAnsweredTimeout) {
      this.allAnsweredTimeout = setTimeout(() => {
        this.allAnsweredTimeout = null;
        const connectedPlayers = Array.from(this.players.values()).filter(p => p.connected);
        if (this.phase === 'question' && connectedPlayers.length > 0 &&
            connectedPlayers.every(p => p.lastAnswerIndex !== null)) {
          this._finalizeQuestionRound('all_answered');
        }
      }, 600);
    }

    return {
      accepted: true,
      answerIndex: cleanIndex,
      elapsedSeconds: player.lastAnswerTimeSec
    };
  }

  /**
   * Ends the current question round, calculates rank deltas, fires rank Flow triggers,
   * and dispatches Web Push notifications to all players.
   */
  _finalizeQuestionRound(reason = 'timeout') {
    if (this.phase !== 'question') return this.getPublicState();
    this._clearTimers();

    this.phase = 'reveal';
    this.remainingSeconds = 0;
    this.currentAvailablePoints = 0;

    const question = this.activeQuiz.questions[this.currentQuestionIndex];
    const questionNum = this.currentQuestionIndex + 1;
    const totalQuestions = this.activeQuiz.questions.length;

    // Recalculate final positions for this round and compute rankDelta vs previousPosition
    const sortedPlayers = this._recalculatePositions(true);

    // 1. Trigger question_time_up
    this._triggerFlow('question_time_up', {
      vraag_tekst: question ? question.question : '',
      vraag_nummer: questionNum,
      quiz_naam: this.activeQuiz ? this.activeQuiz.title : ''
    });

    // 2. Evaluate per-player rank & top-3 triggers
    for (const player of sortedPlayers) {
      const tokens = this._buildPlayerTokens(player);
      const state = { playerId: player.id, playerName: player.name };

      // player_rank_up: Als een speler is gestegen in positie (bijv. van 3 naar 1)
      if (player.position < player.previousPosition) {
        this._triggerFlow('player_rank_up', tokens, state);
      }

      // player_entered_top3: Als een speler in de top 3 zit (binnenkomt of erin staat na een ronde)
      if (player.position <= 3) {
        this._triggerFlow('player_entered_top3', tokens, state);
      }

      // player_left_top3: Als een speler buiten de top 3 valt (was <= 3, nu > 3)
      if (player.previousPosition <= 3 && player.position > 3) {
        this._triggerFlow('player_left_top3', tokens, state);
      }

      // player_is_first: Als een speler op de 1e plek staat
      if (player.position === 1) {
        this._triggerFlow('player_is_first', tokens, state);
      }
    }

    // 3. Send automatic Web Push notification to every logged-in player
    if (this.pushManager && sortedPlayers.length > 0) {
      this.pushManager
        .sendRoundResultsToPlayers(sortedPlayers, questionNum, totalQuestions)
        .catch(err => this.log(`[QuizEngine] Push round error: ${err.message}`));
    }

    this._broadcastState({ roundEndReason: reason });
    if (this.fastestCorrectPlayerId) {
      this.emit('fastest_correct', {
        playerId: this.fastestCorrectPlayerId,
        roundId: this.roundId
      });
    }
    return this.getPublicState();
  }

  /**
   * Ends the quiz and triggers `player_won` for the #1 player
   */
  _finishQuiz() {
    this._clearTimers();
    this.phase = 'finished';
    const sortedPlayers = this._recalculatePositions(false);

    if (sortedPlayers.length > 0) {
      const winner = sortedPlayers[0];
      const tokens = this._buildPlayerTokens(winner);
      const state = { playerId: winner.id, playerName: winner.name };
      this._triggerFlow('player_won', tokens, state);

      if (this.pushManager) {
        this.pushManager
          .sendToAll(
            {
              title: `🏆 ${winner.name} heeft gewonnen!`,
              body: `Eindstand ${this.activeQuiz.title}: 1. ${winner.name} (${winner.score} pt)!`,
              tag: 'quiz-winner'
            },
            sortedPlayers.map(p => p.id)
          )
          .catch(() => {});
      }
    }

    this._broadcastState();
    return this.getPublicState();
  }

  /**
   * Flow Action: Give bonus points to a specific player
   */
  giveBonusPoints(playerIdentifier, pointsAmount) {
    const player = this.findPlayer(playerIdentifier);
    if (!player) {
      throw new Error(`Speler "${playerIdentifier}" niet gevonden.`);
    }
    const bonus = Number(pointsAmount) || 0;
    player.previousPosition = player.position;
    player.score = Math.max(0, player.score + bonus);
    player.lastPointsEarned = (player.lastPointsEarned || 0) + bonus;

    this._recalculatePositions(true);

    const tokens = this._buildPlayerTokens(player);
    const state = { playerId: player.id, playerName: player.name };

    if (player.position < player.previousPosition) {
      this._triggerFlow('player_rank_up', tokens, state);
    }
    if (player.position <= 3 && player.previousPosition > 3) {
      this._triggerFlow('player_entered_top3', tokens, state);
    }
    if (player.position === 1 && player.previousPosition !== 1) {
      this._triggerFlow('player_is_first', tokens, state);
    }

    this._broadcastState({
      bonusEvent: {
        playerId: player.id,
        playerName: player.name,
        bonusPoints: bonus,
        newScore: player.score
      }
    });

    return player;
  }

  findPlayer(identifier) {
    if (!identifier) return null;
    if (typeof identifier === 'object') {
      identifier = identifier.id || identifier.name;
    }
    const clean = String(identifier).trim();
    if (this.players.has(clean)) {
      return this.players.get(clean);
    }
    const lower = clean.toLowerCase();
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === lower || p.id.toLowerCase() === lower) {
        return p;
      }
    }
    return null;
  }

  /**
   * Evaluates Flow Conditions (EN-kaarten)
   */
  evaluateCondition(conditionId, args = {}, state = {}) {
    let targetId = null;
    if (args.player && args.player.id && args.player.id !== '__trigger__') {
      targetId = args.player.id;
    } else if (state && (state.playerId || state.playerName)) {
      targetId = state.playerId || state.playerName;
    }

    const sorted = this.getLeaderboard();
    const player = targetId ? this.findPlayer(targetId) : sorted[0];
    if (!player) return false;

    switch (conditionId) {
      case 'is_player_winner':
        return this.phase === 'finished' && player.position === 1;
      case 'is_last_answer_correct':
        return Boolean(player.lastAnswerCorrect);
      case 'is_last_answer_wrong':
        return player.lastAnswerIndex !== null && !player.lastAnswerCorrect;
      case 'did_player_rank_up':
        return player.position < player.previousPosition;
      case 'is_player_in_top3':
        return player.position >= 1 && player.position <= 3;
      case 'is_player_outside_top3':
        return player.position > 3;
      case 'is_player_first':
        return player.position === 1;
      default:
        return false;
    }
  }

  _recalculatePositions(updateRankDelta = false) {
    const list = Array.from(this.players.values());
    list.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tie-breaker: faster last answer
      const timeA = a.lastAnswerTimeSec ?? 999;
      const timeB = b.lastAnswerTimeSec ?? 999;
      return timeA - timeB;
    });

    list.forEach((player, idx) => {
      const newPos = idx + 1;
      player.position = newPos;
      if (updateRankDelta) {
        player.rankDelta = (player.previousPosition || newPos) - newPos;
      }
    });

    return list;
  }

  getLeaderboard() {
    return this._recalculatePositions(false).map(p => ({ ...p }));
  }

  _buildPlayerTokens(player) {
    return {
      speler_naam: String(player.name || 'Speler'),
      score: Number(player.score || 0),
      positie: Number(player.position || 1),
      vorige_positie: Number(player.previousPosition || player.position || 1),
      quiz_naam: String(this.activeQuiz ? this.activeQuiz.title : 'Party Quiz')
    };
  }

  _triggerFlow(triggerId, tokens = {}, state = {}) {
    const entry = {
      id: `flow_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      triggerId,
      tokens,
      state
    };
    this.flowHistory.unshift(entry);
    if (this.flowHistory.length > 50) {
      this.flowHistory.length = 50;
    }

    this.onFlowTrigger(triggerId, tokens, state, entry);
    this.emit('flow_triggered', entry);
  }

  _clearTimers() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (this.allAnsweredTimeout) {
      clearTimeout(this.allAnsweredTimeout);
      this.allAnsweredTimeout = null;
    }
  }

  _broadcastState(extra = {}) {
    const state = this.getPublicState(extra);
    this.onStateChange(state);
    this.emit('state_change', state);
  }

  getPublicState(extra = {}) {
    const leaderboard = this.getLeaderboard();
    const top1Score = leaderboard.length > 0 ? leaderboard[0].score : 0;

    const currentQ =
      this.activeQuiz &&
      this.currentQuestionIndex >= 0 &&
      this.activeQuiz.questions[this.currentQuestionIndex]
        ? this.activeQuiz.questions[this.currentQuestionIndex]
        : null;

    // Count answers per option (only reveal counts per option in 'reveal' or 'finished', or live total count during question)
    const answerCounts = [0, 0, 0, 0];
    let answeredCount = 0;
    for (const p of this.players.values()) {
      if (p.lastAnswerIndex !== null && p.lastAnswerIndex >= 0 && p.lastAnswerIndex <= 3) {
        answerCounts[p.lastAnswerIndex]++;
        answeredCount++;
      }
    }

    return {
      phase: this.phase,
      quizId: this.activeQuiz ? this.activeQuiz.id : null,
      quizTitle: this.activeQuiz ? this.activeQuiz.title : 'Geen quiz geselecteerd',
      quizDescription: this.activeQuiz ? this.activeQuiz.description : '',
      currentQuestionIndex: this.currentQuestionIndex,
      totalQuestions: this.activeQuiz && this.activeQuiz.questions ? this.activeQuiz.questions.length : 0,
      remainingSeconds: Math.ceil(this.remainingSeconds),
      exactRemainingSeconds: this.remainingSeconds,
      currentAvailablePoints: this.currentAvailablePoints,
      questionTimeLimit: this.questionTimeLimit,
      question: currentQ
        ? {
            id: currentQ.id,
            question: currentQ.question,
            options: currentQ.options,
            timeLimit: currentQ.timeLimit || 20,
            points: currentQ.points || 1000,
            // Only expose correctIndex during reveal or finished phases
            correctIndex:
              this.phase === 'reveal' || this.phase === 'finished'
                ? Number(currentQ.correctIndex)
                : null
          }
        : null,
      answeredCount,
      totalPlayers: leaderboard.length,
      connectedPlayers: leaderboard.filter(p => p.connected).length,
      answerCounts:
        this.phase === 'reveal' || this.phase === 'finished' ? answerCounts : null,
      leaderboard: leaderboard.map(p => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        color: p.color,
        score: p.score,
        position: p.position,
        previousPosition: p.previousPosition,
        rankDelta: p.rankDelta,
        hasAnswered: p.lastAnswerIndex !== null,
        lastAnswerIndex:
          this.phase === 'reveal' || this.phase === 'finished' ? p.lastAnswerIndex : null,
        lastAnswerCorrect:
          this.phase === 'reveal' || this.phase === 'finished' ? p.lastAnswerCorrect : null,
        lastPointsEarned:
          this.phase === 'reveal' || this.phase === 'finished' ? p.lastPointsEarned : 0,
        lastAnswerTimeSec: p.lastAnswerTimeSec,
        streak: p.streak || 0,
        gapToFirst: Math.max(0, top1Score - p.score),
        connected: p.connected
      })),
      top3: leaderboard.slice(0, 3).map(p => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        color: p.color,
        score: p.score,
        position: p.position,
        previousPosition: p.previousPosition,
        rankDelta: p.rankDelta
      })),
      ...extra
    };
  }
}

module.exports = QuizEngine;
