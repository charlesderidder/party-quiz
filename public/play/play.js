'use strict';

(function () {
  const socket = io();
  const STORAGE_KEY = 'homey_party_quiz_player_v1';
  const AVATARS = ['🎉', '🦊', '🚀', '⚡', '🦄', '🔥', '👑', '🤖'];
  const COLORS = ['#00A4E8', '#6366F1', '#10B981', '#F59E0B', '#F43F5E', '#8B5CF6'];
  const SHAPES = ['▲', '◆', '●', '■'];

  let profile = loadStoredProfile();
  let hasJoinedSession = false;
  let currentQuestionId = null;
  let mySelectedAnswer = null;
  let swRegistration = null;

  function loadStoredProfile() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && saved.playerId) return saved;
    } catch (e) {}
    return {
      playerId: `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: '',
      avatar: '🎉',
      color: '#00A4E8'
    };
  }

  function saveStoredProfile() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    } catch (e) {}
  }

  // =========================================================================
  // RENDER PICKERS & JOIN FORM
  // =========================================================================
  function initJoinForm() {
    document.getElementById('inputPlayerName').value = profile.name || '';

    const avatarContainer = document.getElementById('avatarPicker');
    avatarContainer.innerHTML = AVATARS.map(
      av =>
        `<button type="button" class="avatar-btn ${
          av === profile.avatar ? 'selected' : ''
        }" data-avatar="${av}">${av}</button>`
    ).join('');

    avatarContainer.querySelectorAll('.avatar-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        profile.avatar = btn.dataset.avatar;
        initJoinForm();
      });
    });

    const colorContainer = document.getElementById('colorPicker');
    colorContainer.innerHTML = COLORS.map(
      c =>
        `<button type="button" class="color-btn ${
          c === profile.color ? 'selected' : ''
        }" style="background:${c}" data-color="${c}"></button>`
    ).join('');

    colorContainer.querySelectorAll('.color-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        profile.color = btn.dataset.color;
        initJoinForm();
      });
    });
  }

  // =========================================================================
  // WEB PUSH REGISTRATION (Service Worker + VAPID)
  // =========================================================================
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  async function setupWebPushSubscription() {
    const statusEl = document.getElementById('headerPushStatus');
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      statusEl.textContent = '🔔 In-App Live Push actief';
      return false;
    }

    try {
      swRegistration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        statusEl.textContent = '🔕 Push geweigerd (In-App actief)';
        return false;
      }

      const keyRes = await fetch('/api/vapid-public-key');
      const { publicKey } = await keyRes.json();
      if (!publicKey) return false;

      const subscription = await swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });

      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: profile.playerId,
          subscription
        })
      });

      statusEl.textContent = '🔔 Web Push geactiveerd';
      return true;
    } catch (err) {
      // Happens on plain HTTP non-localhost LAN without HTTPS reverse proxy
      statusEl.textContent = '🔔 Live Push actief (gebruik HTTPS voor OS-push)';
      return false;
    }
  }

  function showInAppPushBanner(title, body) {
    const banner = document.getElementById('pushBanner');
    document.getElementById('pushBannerTitle').textContent = title || 'Homey Party Quiz';
    document.getElementById('pushBannerBody').textContent = body || '';
    banner.classList.add('visible');
    clearTimeout(window.__pushBannerTimer);
    window.__pushBannerTimer = setTimeout(() => {
      banner.classList.remove('visible');
    }, 5500);
  }

  // =========================================================================
  // JOIN & RECONNECT LOGIC
  // =========================================================================
  function joinQuizNow(requestPush = false) {
    const nameVal = document.getElementById('inputPlayerName').value.trim() || profile.name;
    if (!nameVal) {
      document.getElementById('inputPlayerName').focus();
      return;
    }
    profile.name = nameVal;
    saveStoredProfile();

    socket.emit(
      'player_join',
      {
        playerId: profile.playerId,
        name: profile.name,
        avatar: profile.avatar,
        color: profile.color
      },
      async response => {
        if (response && response.success) {
          hasJoinedSession = true;
          profile.name = response.player.name;
          saveStoredProfile();
          updateHeaderBar(response.player);

          if (requestPush && document.getElementById('chkEnablePush').checked) {
            await setupWebPushSubscription();
          }

          if (response.state) {
            renderGameState(response.state);
          }
        }
      }
    );
  }

  function updateHeaderBar(me) {
    const av = document.getElementById('headerAvatar');
    av.textContent = profile.avatar || '🎉';
    av.style.background = profile.color || '#00A4E8';
    document.getElementById('headerPlayerName').textContent = profile.name || 'Speler';

    if (me) {
      const rankEl = document.getElementById('headerRankBadge');
      const scoreEl = document.getElementById('headerScoreBadge');
      rankEl.style.display = 'inline-flex';
      scoreEl.style.display = 'inline-flex';
      rankEl.textContent = `Plek #${me.position}`;
      scoreEl.textContent = `${me.score} pt`;
    }
  }

  // =========================================================================
  // RENDER PLAYER SCREENS
  // =========================================================================
  function renderGameState(state) {
    if (!state) return;

    const me = (state.leaderboard || []).find(p => p.id === profile.playerId);
    if (me) {
      updateHeaderBar(me);
    }

    if (!hasJoinedSession) {
      showScreen('screenJoin');
      return;
    }

    if (state.phase === 'lobby') {
      document.getElementById('lobbyQuizNameText').textContent =
        state.quizTitle || 'Homey Party Quiz';
      showScreen('screenLobbyWait');
      return;
    }

    if (state.phase === 'question' && state.question) {
      showScreen('screenGameplay');
      renderActiveQuestion(state, me);
      return;
    }

    if (state.phase === 'reveal' || state.phase === 'finished') {
      showScreen('screenRoundResult');
      renderRoundResult(state, me);
    }
  }

  function renderActiveQuestion(state, me) {
    const q = state.question;
    if (currentQuestionId !== q.id) {
      currentQuestionId = q.id;
      mySelectedAnswer = null;
    }

    document.getElementById('playQuestionCounter').textContent = `Vraag ${
      state.currentQuestionIndex + 1
    }/${state.totalQuestions}`;
    document.getElementById('playAvailablePoints').textContent = state.currentAvailablePoints;
    document.getElementById('playRemainingSec').textContent = state.remainingSeconds;
    document.getElementById('playQuestionText').textContent = q.question;

    const alreadyAnswered = (me && me.hasAnswered) || mySelectedAnswer !== null;
    const grid = document.getElementById('playButtonsGrid');
    const lockedCard = document.getElementById('lockedAnswerCard');

    grid.innerHTML = (q.options || [])
      .map((opt, idx) => {
        const isSelected = mySelectedAnswer === idx;
        return `
        <button
          type="button"
          class="mobile-tile answer-tile-${idx} ${isSelected ? 'selected-choice' : ''} ${
            alreadyAnswered && !isSelected ? 'dimmed' : ''
          }"
          ${alreadyAnswered ? 'disabled' : ''}
          data-idx="${idx}"
        >
          <span class="answer-shape">${SHAPES[idx]}</span>
          <span style="margin-top: 10px; line-height: 1.25;">${escapeHtml(opt)}</span>
        </button>
      `;
      })
      .join('');

    if (!alreadyAnswered) {
      lockedCard.style.display = 'none';
      grid.querySelectorAll('.mobile-tile').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.idx);
          submitPlayerAnswer(idx);
        });
      });
    } else {
      lockedCard.style.display = 'block';
    }
  }

  function submitPlayerAnswer(answerIndex) {
    mySelectedAnswer = answerIndex;
    socket.emit(
      'submit_answer',
      {
        playerId: profile.playerId,
        answerIndex
      },
      res => {
        if (res && res.accepted) {
          document.getElementById('lockedTitle').textContent = `Antwoord ingedrukt op ${res.elapsedSeconds}s!`;
          document.getElementById('lockedSub').textContent =
            res.elapsedSeconds <= 1.0
              ? '⚡ Binnen de eerste seconde! Als het goed is pak je de volle 1000 punten!'
              : 'Wachten tot de vraag sluit voor het resultaat...';
        }
      }
    );
  }

  function renderRoundResult(state, me) {
    const badge = document.getElementById('resultIconBadge');
    const headline = document.getElementById('resultHeadline');
    const ptsEl = document.getElementById('resultPointsEarned');

    if (!me) return;

    if (state.phase === 'finished') {
      badge.textContent = me.position === 1 ? '🏆' : '🎉';
      badge.style.background =
        me.position === 1 ? 'rgba(245, 158, 11, 0.2)' : 'rgba(0, 164, 232, 0.15)';
      headline.textContent =
        me.position === 1 ? 'Jij hebt de Quiz gewonnen!' : `Eindstand: Plek #${me.position}`;
      ptsEl.textContent = `Eindscore: ${me.score} punten`;
      ptsEl.style.color = 'var(--homey-blue)';
    } else if (me.lastAnswerIndex === null || me.lastAnswerIndex === undefined) {
      badge.textContent = '⏰';
      badge.style.background = 'rgba(245, 158, 11, 0.16)';
      headline.textContent = 'Te laat! Geen antwoord';
      ptsEl.textContent = '+0 punten deze ronde';
      ptsEl.style.color = 'var(--text-muted)';
    } else if (me.lastAnswerCorrect) {
      badge.textContent = '✅';
      badge.style.background = 'rgba(16, 185, 129, 0.18)';
      headline.textContent = 'Goed geantwoord!';
      ptsEl.textContent = `+${me.lastPointsEarned} punten verdiend!`;
      ptsEl.style.color = 'var(--homey-green)';
    } else {
      badge.textContent = '❌';
      badge.style.background = 'rgba(244, 63, 94, 0.18)';
      headline.textContent = 'Helaas, fout antwoord!';
      ptsEl.textContent = '+0 punten deze ronde';
      ptsEl.style.color = 'var(--homey-rose)';
    }

    document.getElementById('resultRankValue').textContent = `#${me.position}`;
    const deltaEl = document.getElementById('resultRankDelta');
    if (me.rankDelta > 0) {
      deltaEl.innerHTML = `<span class="rank-badge rank-up">▲ +${me.rankDelta} gestegen</span>`;
    } else if (me.rankDelta < 0) {
      deltaEl.innerHTML = `<span class="rank-badge rank-down">▼ ${me.rankDelta} gedaald</span>`;
    } else {
      deltaEl.innerHTML = `<span class="rank-badge rank-same">• Positie behouden</span>`;
    }

    const gapEl = document.getElementById('resultGapToFirst');
    if (me.position === 1) {
      gapEl.textContent = '🥇 Jij staat op #1!';
      gapEl.style.color = 'var(--homey-amber)';
    } else {
      gapEl.textContent = `-${me.gapToFirst} pt`;
      gapEl.style.color = 'var(--homey-blue)';
    }
    document.getElementById('resultTotalScore').textContent = `Totaal: ${me.score} pt`;

    const medals = ['🥇', '🥈', '🥉'];
    const top3El = document.getElementById('resultTop3List');
    const top3 = state.top3 || [];
    top3El.innerHTML = top3
      .map(
        (p, idx) => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;">
        <span style="font-weight:${p.id === profile.playerId ? '900' : '600'}">
          ${medals[idx] || idx + 1} ${escapeHtml(p.avatar || '🎉')} ${escapeHtml(p.name)} ${
            p.id === profile.playerId ? '(Jij)' : ''
          }
        </span>
        <span style="font-weight:800;color:var(--homey-blue);">${p.score} pt</span>
      </div>
    `
      )
      .join('');
  }

  function showScreen(screenId) {
    ['screenJoin', 'screenLobbyWait', 'screenGameplay', 'screenRoundResult'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = id === screenId ? 'flex' : 'none';
    });
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
  // SOCKET & BUTTON HANDLERS
  // =========================================================================
  socket.on('connect', () => {
    // Auto-reconnect session if player already joined before a browser refresh!
    if (profile.name && profile.name.trim()) {
      joinQuizNow(false);
    }
  });

  socket.on('quiz_state', state => {
    renderGameState(state);
  });

  socket.on('timer_tick', tick => {
    const ptsEl = document.getElementById('playAvailablePoints');
    const secEl = document.getElementById('playRemainingSec');
    if (ptsEl) ptsEl.textContent = tick.currentAvailablePoints;
    if (secEl) secEl.textContent = tick.remainingSeconds;
  });

  socket.on('push_notification', payload => {
    if (!payload) return;
    if (payload.targetPlayerId && payload.targetPlayerId !== profile.playerId) return;
    showInAppPushBanner(payload.title, payload.body);
  });

  document.getElementById('btnJoinGame').addEventListener('click', () => {
    joinQuizNow(true);
  });

  document.getElementById('inputPlayerName').addEventListener('keydown', e => {
    if (e.key === 'Enter') joinQuizNow(true);
  });

  document.getElementById('btnRequestPushAgain').addEventListener('click', async () => {
    await setupWebPushSubscription();
    await fetch('/api/push/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: profile.playerId,
        message: `Hallo ${profile.name}! Jouw Web Push notificaties zijn gekoppeld.`
      })
    });
  });

  document.getElementById('btnEditProfile').addEventListener('click', () => {
    hasJoinedSession = false;
    showScreen('screenJoin');
  });

  initJoinForm();
})();
