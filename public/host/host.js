'use strict';

(function () {
  const socket = io();
  let currentState = null;
  let lastPhase = null;
  let soundEnabled = true;
  let audioCtx = null;

  const SHAPES = ['▲', '◆', '●', '■'];

  // =========================================================================
  // SUBTLE SYNTHESIZED SOUND EFFECTS (Web Audio API)
  // =========================================================================
  function ensureAudio() {
    if (!soundEnabled) return null;
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) audioCtx = new AudioContextClass();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function playTone(freq, duration = 0.12, type = 'sine', gainVal = 0.08, delay = 0) {
    const ctx = ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration);
  }

  function sfxQuestionStart() {
    playTone(523.25, 0.12, 'triangle', 0.1, 0);
    playTone(659.25, 0.12, 'triangle', 0.1, 0.1);
    playTone(783.99, 0.22, 'triangle', 0.12, 0.2);
  }

  function sfxTick(urgent = false) {
    playTone(urgent ? 880 : 620, 0.05, 'sine', urgent ? 0.07 : 0.035, 0);
  }

  function sfxRevealPodium() {
    playTone(440, 0.14, 'triangle', 0.1, 0);
    playTone(554.37, 0.14, 'triangle', 0.1, 0.12);
    playTone(659.25, 0.28, 'triangle', 0.12, 0.24);
  }

  function sfxWinnerFanfare() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((n, i) => playTone(n, 0.22, 'triangle', 0.13, i * 0.14));
  }

  // =========================================================================
  // INITIALIZATION & QR CODE
  // =========================================================================
  async function loadInitialData() {
    try {
      const res = await fetch('/api/state');
      const data = await res.json();
      populateQuizDropdown(data.quizzes || [], data.quizId);
      if (!currentState) renderState(data);
      await refreshQrCode(data.playUrl);
    } catch (err) {
      console.error('Failed to load initial state:', err);
    }
  }

  async function refreshQrCode(preferredUrl) {
    try {
      const urlParam = preferredUrl ? `?url=${encodeURIComponent(preferredUrl)}` : '';
      const res = await fetch(`/api/qr${urlParam}`);
      const data = await res.json();
      if (data.qrDataUrl) {
        document.getElementById('qrCodeImage').src = data.qrDataUrl;
      }
      if (data.playUrl) {
        const link = document.getElementById('playUrlLink');
        link.href = data.playUrl;
        link.textContent = data.playUrl;
      }
    } catch (err) {
      console.error('QR error:', err);
    }
  }

  function populateQuizDropdown(quizzes, activeQuizId) {
    const select = document.getElementById('quizSelectDropdown');
    select.innerHTML = quizzes
      .map(
        q =>
          `<option value="${escapeHtml(q.id)}" ${
            q.id === activeQuizId ? 'selected' : ''
          }>📚 ${escapeHtml(q.title)} (${q.questionCount} vragen)</option>`
      )
      .join('');
  }

  // =========================================================================
  // RENDER GAME VIEWS
  // =========================================================================
  function renderState(state) {
    if (!state) return;
    currentState = state;
    document.body.classList.toggle('lobby-active', state.phase === 'lobby');

    // Trigger subtle audio cues on phase change
    if (state.phase !== lastPhase) {
      if (state.phase === 'question') sfxQuestionStart();
      else if (state.phase === 'reveal') sfxRevealPodium();
      else if (state.phase === 'finished') sfxWinnerFanfare();
      lastPhase = state.phase;
    }

    document.getElementById('viewLobby').style.display =
      state.phase === 'lobby' ? 'grid' : 'none';
    document.getElementById('viewQuestion').style.display =
      state.phase === 'question' ? 'flex' : 'none';
    document.getElementById('viewReveal').style.display =
      state.phase === 'reveal' ? 'flex' : 'none';
    document.getElementById('viewFinished').style.display =
      state.phase === 'finished' ? 'block' : 'none';

    if (state.phase === 'lobby') {
      renderLobby(state);
    } else if (state.phase === 'question') {
      renderQuestion(state);
    } else if (state.phase === 'reveal') {
      renderReveal(state);
    } else if (state.phase === 'finished') {
      renderFinished(state);
    }
  }

  function renderLobby(state) {
    document.getElementById('lobbyQuizTitle').textContent = state.quizTitle || 'Party Quiz';
    document.getElementById('lobbyQuizDesc').textContent =
      state.quizDescription || `${state.totalQuestions} vragen klaar om te starten.`;
    document.getElementById('lobbyPlayerCount').textContent = state.totalPlayers || 0;

    const grid = document.getElementById('lobbyPlayersGrid');
    const players = state.leaderboard || [];
    if (players.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 36px; text-align: center; color: var(--text-muted); border: 1px dashed var(--border-subtle); border-radius: 20px;">
          Nog geen spelers in de lobby. Scan de QR-code links of klik op <strong>"🤖 +4 Demo Spelers"</strong> bovenaan!
        </div>
      `;
    } else {
      grid.innerHTML = players
        .map(
          p => `
        <div class="player-chip">
          <div class="player-chip-left">
            <span class="player-avatar-dot" style="background: ${escapeHtml(p.color || '#00A4E8')}">
              ${escapeHtml(p.avatar || '🎉')}
            </span>
            <span class="player-name">${escapeHtml(p.name)}</span>
          </div>
          <button class="btn-homey btn-sm" style="padding: 4px 8px; font-size: 11px;" onclick="window.__kickPlayer('${escapeHtml(p.id)}')" title="Verwijder speler">✕</button>
        </div>
      `
        )
        .join('');
    }
  }

  function renderQuestion(state) {
    const q = state.question;
    if (!q) return;

    document.getElementById('qCounterLabel').textContent = `VRAAG ${
      state.currentQuestionIndex + 1
    } VAN ${state.totalQuestions}`;
    document.getElementById('qTimerValue').textContent = state.remainingSeconds;
    document.getElementById('qPointsTicker').textContent = state.currentAvailablePoints;
    document.getElementById('qAnsweredCount').textContent = state.answeredCount;
    document.getElementById('qTotalPlayers').textContent = state.totalPlayers;
    document.getElementById('qTextBanner').textContent = q.question;

    const pct = Math.max(
      0,
      Math.min(100, ((state.exactRemainingSeconds || state.remainingSeconds) / (state.questionTimeLimit || 20)) * 100)
    );
    document.getElementById('qTimerBar').style.width = `${pct}%`;

    const optionsGrid = document.getElementById('qOptionsGrid');
    optionsGrid.innerHTML = (q.options || [])
      .map(
        (opt, idx) => `
      <div class="answer-tile answer-tile-${idx}" style="cursor: default;">
        <span class="answer-shape">${SHAPES[idx]}</span>
        <span>${escapeHtml(opt)}</span>
      </div>
    `
      )
      .join('');
  }

  function renderReveal(state) {
    const q = state.question;
    if (!q) return;

    document.getElementById('revealQuestionTitle').textContent = `Vraag ${
      state.currentQuestionIndex + 1
    }: ${q.question}`;

    const isLastQuestion = state.currentQuestionIndex + 1 >= state.totalQuestions;
    document.getElementById('btnNextQuestion').innerHTML = isLastQuestion
      ? '🏆 Bekijk Eindstand &amp; Winnaar'
      : '➡️ Volgende Vraag';

    const counts = state.answerCounts || [0, 0, 0, 0];
    const revealOptionsGrid = document.getElementById('revealOptionsGrid');
    revealOptionsGrid.innerHTML = (q.options || [])
      .map((opt, idx) => {
        const isCorrect = idx === Number(q.correctIndex);
        const count = counts[idx] || 0;
        return `
        <div class="answer-tile answer-tile-${idx} ${
          isCorrect ? 'correct-highlight' : 'dimmed'
        }" style="cursor: default; justify-content: space-between;">
          <div style="display:flex;align-items:center;gap:14px;">
            <span class="answer-shape">${SHAPES[idx]}</span>
            <span>${escapeHtml(opt)}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;font-size:16px;background:rgba(0,0,0,0.25);padding:6px 12px;border-radius:12px;">
            <span>${isCorrect ? '✅' : ''}</span>
            <span>${count}×</span>
          </div>
        </div>
      `;
      })
      .join('');

    renderPodium('revealPodiumStage', state.top3 || []);
    renderLeaderboard('revealLeaderboardList', state.leaderboard || []);
  }

  function renderFinished(state) {
    const lb = state.leaderboard || [];
    const winner = lb[0];
    if (winner) {
      document.getElementById('winnerHeadline').textContent = `🏆 ${winner.name} heeft gewonnen!`;
      document.getElementById('winnerSubline').textContent = `Eindscore: ${winner.score} punten in "${state.quizTitle}" — Homey Flow 'player_won' geactiveerd!`;
    } else {
      document.getElementById('winnerHeadline').textContent = 'Quiz Voltooid!';
      document.getElementById('winnerSubline').textContent = state.quizTitle || '';
    }

    renderPodium('finalPodiumStage', state.top3 || []);
    renderLeaderboard('finalLeaderboardList', lb);
  }

  function renderPodium(containerId, top3) {
    const stage = document.getElementById(containerId);
    if (!top3 || top3.length === 0) {
      stage.innerHTML =
        '<div style="color:var(--text-muted);padding:30px;">Nog geen scores om te tonen.</div>';
      return;
    }

    // Order visually on podium: 2nd place (left), 1st place (center), 3rd place (right)
    const visualOrder = [];
    if (top3[1]) visualOrder.push({ player: top3[1], rank: 2, medal: '🥈' });
    if (top3[0]) visualOrder.push({ player: top3[0], rank: 1, medal: '🥇' });
    if (top3[2]) visualOrder.push({ player: top3[2], rank: 3, medal: '🥉' });

    stage.innerHTML = visualOrder
      .map(({ player, rank, medal }) => {
        const deltaHtml = formatRankDelta(player.rankDelta);
        return `
        <div class="podium-column">
          <div class="podium-avatar" style="border-color: ${escapeHtml(player.color || '#00A4E8')}">
            ${escapeHtml(player.avatar || '🎉')}
          </div>
          <div class="podium-name">${escapeHtml(player.name)}</div>
          <div style="margin-bottom: 6px;">${deltaHtml}</div>
          <div class="podium-pillar pillar-${rank}">
            <div style="font-size: 24px;">${medal}</div>
            <div style="font-size: 16px; margin-top: 4px;">${player.score} pt</div>
          </div>
        </div>
      `;
      })
      .join('');
  }

  function renderLeaderboard(containerId, leaderboard) {
    const container = document.getElementById(containerId);
    if (!leaderboard || leaderboard.length === 0) {
      container.innerHTML =
        '<div style="color:var(--text-muted);text-align:center;padding:20px;">Geen spelers.</div>';
      return;
    }

    container.innerHTML = leaderboard
      .map(p => {
        const deltaBadge = formatRankDelta(p.rankDelta);
        const roundPts =
          p.lastPointsEarned > 0
            ? `<span style="color:var(--homey-green);font-weight:800;font-size:13px;">+${p.lastPointsEarned} pt</span>`
            : `<span style="color:var(--text-muted);font-size:12px;">+0 pt</span>`;

        return `
        <div class="lb-row">
          <div class="lb-left">
            <span class="lb-pos">#${p.position}</span>
            <span style="font-size: 20px;">${escapeHtml(p.avatar || '🎉')}</span>
            <div>
              <div style="font-weight: 800; font-size: 15px;">${escapeHtml(p.name)}</div>
              <div style="font-size: 11.5px; color: var(--text-muted);">
                Vorige plek: #${p.previousPosition || p.position}
              </div>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            ${roundPts}
            ${deltaBadge}
            <div style="font-weight: 900; font-size: 16px; min-width: 72px; text-align: right; color: var(--homey-blue);">
              ${p.score} pt
            </div>
          </div>
        </div>
      `;
      })
      .join('');
  }

  function formatRankDelta(delta) {
    if (delta > 0) {
      return `<span class="rank-badge rank-up">▲ +${delta}</span>`;
    }
    if (delta < 0) {
      return `<span class="rank-badge rank-down">▼ ${delta}</span>`;
    }
    return `<span class="rank-badge rank-same">• gelijk</span>`;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, s => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[s]));
  }

  // =========================================================================
  // SOCKET EVENTS & CONTROLS
  // =========================================================================
  socket.on('quiz_state', state => {
    renderState(state);
  });

  let lastWholeSecond = null;
  socket.on('timer_tick', tick => {
    if (!currentState || currentState.phase !== 'question') return;
    document.getElementById('qTimerValue').textContent = tick.remainingSeconds;
    document.getElementById('qPointsTicker').textContent = tick.currentAvailablePoints;

    const hint = document.getElementById('pointsRuleHint');
    if (tick.elapsedSeconds <= 1.0) {
      hint.textContent = '⚡ EERSTE SECONDE: 1000 PT GARANTIE!';
      hint.style.color = '#10B981';
    } else {
      hint.textContent = '⏱️ Score loopt nu af van 1000 naar 0 (sec 2-20)';
      hint.style.color = '#F59E0B';
    }

    const pct = Math.max(
      0,
      Math.min(100, (tick.exactRemainingSeconds / (currentState.questionTimeLimit || 20)) * 100)
    );
    document.getElementById('qTimerBar').style.width = `${pct}%`;

    if (tick.remainingSeconds !== lastWholeSecond) {
      lastWholeSecond = tick.remainingSeconds;
      if (tick.remainingSeconds > 0 && tick.remainingSeconds <= 5) {
        sfxTick(true);
      }
    }
  });

  socket.on('flow_event', entry => {
    if (!entry) return;
    const tokenPairs = Object.entries(entry.tokens || {})
      .map(([k, v]) => `[${k}: ${v}]`)
      .join(' ');
    document.getElementById('flowTickerText').textContent = `Trigger "${entry.triggerId}" afgevuurd ${tokenPairs}`;
  });

  window.__kickPlayer = playerId => {
    adminAction('host_kick_player', { playerId });
  };

  function adminAction(event, payload) {
    const status = document.getElementById('hostStatus');
    status.hidden = false;
    if (!socket.connected) {
      status.textContent = 'Geen verbinding met de quizserver. Start de app en laad de pagina opnieuw.';
      return;
    }
    status.textContent = 'Bezig...';
    socket.timeout(10000).emit(event, payload, (err, result) => {
      if (err || !result || result.success === false) {
        status.textContent = (result && result.error) || 'Beheeractie mislukt. Controleer de verbinding en probeer opnieuw.';
      } else if (event === 'host_clear_players') {
        status.textContent = `${result.removed} spelers verwijderd.`;
      } else {
        status.hidden = true;
      }
    });
  }

  document.getElementById('quizSelectDropdown').addEventListener('change', e => {
    const quizId = e.target.value;
    adminAction('host_select_quiz', { quizId });
  });

  document.getElementById('btnStartQuiz').addEventListener('click', () => {
    ensureAudio();
    const quizId = document.getElementById('quizSelectDropdown').value;
    adminAction('host_start_quiz', { quizId });
  });

  document.getElementById('btnSkipQuestion').addEventListener('click', () => {
    adminAction('host_next_step', {});
  });

  document.getElementById('btnNextQuestion').addEventListener('click', () => {
    adminAction('host_next_step', {});
  });

  document.getElementById('btnRestartLobby').addEventListener('click', () => {
    adminAction('host_next_step', {});
  });

  document.getElementById('btnAddBots').addEventListener('click', async () => {
    const res = await fetch('/api/demo/add-bots', { method: 'POST' });
    if (!res.ok) alert((await res.json()).error || 'Beheeractie mislukt.');
  });

  document.getElementById('btnClearPlayers').addEventListener('click', () => {
    document.getElementById('clearPlayersConfirm').hidden = false;
  });

  document.getElementById('btnCancelClearPlayers').addEventListener('click', () => {
    document.getElementById('clearPlayersConfirm').hidden = true;
  });

  document.getElementById('btnConfirmClearPlayers').addEventListener('click', () => {
    document.getElementById('clearPlayersConfirm').hidden = true;
    adminAction('host_clear_players', {});
  });

  document.getElementById('btnBotAnswers').addEventListener('click', async () => {
    const res = await fetch('/api/demo/bot-answers', { method: 'POST' });
    if (!res.ok) alert((await res.json()).error || 'Beheeractie mislukt.');
  });

  document.getElementById('btnToggleSound').addEventListener('click', e => {
    soundEnabled = !soundEnabled;
    if (soundEnabled) ensureAudio();
    e.currentTarget.textContent = soundEnabled ? '🔊 Geluid Aan' : '🔇 Geluid Uit';
  });

  document.getElementById('btnToggleTheme').addEventListener('click', () => {
    document.body.classList.toggle('theme-dark');
  });

  loadInitialData();
})();
