'use strict';

(function () {
  const socket = io();
  const STORAGE_KEY = 'homey_party_quiz_player_v1';
  const AVATARS = ['🎉', '🦊', '🚀', '⚡', '🦄', '🔥', '👑', '🤖'];
  const COLORS = ['#00A4E8', '#6366F1', '#10B981', '#F59E0B', '#F43F5E', '#8B5CF6'];
  const SHAPES = ['▲', '◆', '●', '■'];

  let profile = loadStoredProfile();
  let hasJoinedSession = false;
  let isJoining = false;
  let isReconnecting = false;
  let isResetting = false;
  let resetEventReceived = false;
  let joinAttempt = 0;
  let pendingPushPermission = null;
  let lastGameState = null;
  let currentQuestionId = null;
  let mySelectedAnswer = null;
  let swRegistration = null;
  let audioContext = null;
  let lastCelebratedRound = null;

  function enablePlayerAudio() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      if (!audioContext) audioContext = new AudioContextClass();
      if (audioContext.state !== 'running' && audioContext.state !== 'closed') {
        audioContext.resume().catch(err => console.warn('Geluid inschakelen mislukt:', err));
      }
    } catch (err) {
      console.warn('Geluid inschakelen mislukt:', err);
    }
  }

  function playFastestSound() {
    if (!audioContext || audioContext.state !== 'running') return false;
    try {
      const now = audioContext.currentTime;
      [660, 880, 1100].forEach((frequency, index) => {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const start = now + index * 0.12;
        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.07, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.2);
      });
      return true;
    } catch (err) {
      console.warn('Geluid afspelen mislukt:', err);
      return false;
    }
  }

  function loadStoredProfile() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && saved.playerId) return saved;
    } catch (e) {}
    return {
      playerId: '',
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
    renderPickers();
  }

  function renderPickers() {
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
        renderPickers();
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
        renderPickers();
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

  function requestPushPermission() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      return Promise.resolve(null);
    }
    try {
      return Promise.resolve(Notification.requestPermission()).catch(err => {
        console.warn('Push-toestemming aanvragen mislukt:', err);
        return 'error';
      });
    } catch (err) {
      console.warn('Push-toestemming aanvragen mislukt:', err);
      return Promise.resolve('error');
    }
  }

  async function setupWebPushSubscription(permissionRequest) {
    const statusEl = document.getElementById('headerPushStatus');
    const playerId = profile.playerId;
    const playerSecret = profile.playerSecret;
    const permission = await permissionRequest;
    if (permission === null) {
      statusEl.textContent = '🔔 Web Push niet beschikbaar; gebruik HTTPS en een ondersteunde browser';
      return false;
    }

    try {
      if (!hasJoinedSession || profile.playerId !== playerId) throw new Error('Meld je opnieuw aan om push te activeren.');
      if (permission !== 'granted') {
        statusEl.textContent = permission === 'denied'
          ? '🔕 Push geweigerd; wijzig de toestemming in je browser'
          : '🔕 Push niet toegestaan';
        return false;
      }

      swRegistration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      let readyTimeout;
      try {
        await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((resolve, reject) => {
            readyTimeout = setTimeout(() => reject(new Error('Service worker niet op tijd actief.')), 10000);
          })
        ]);
      } finally {
        clearTimeout(readyTimeout);
      }
      const keyRes = await fetch('/api/vapid-public-key');
      if (!keyRes.ok) throw new Error('Publieke push-sleutel kon niet worden opgehaald.');
      const { publicKey } = await keyRes.json();
      if (!publicKey) throw new Error('Publieke push-sleutel ontbreekt.');

      const applicationServerKey = urlBase64ToUint8Array(publicKey);
      let subscription = await swRegistration.pushManager.getSubscription();
      if (subscription && subscription.options && subscription.options.applicationServerKey) {
        const existingKey = new Uint8Array(subscription.options.applicationServerKey);
        if (existingKey.length !== applicationServerKey.length ||
            !existingKey.every((value, index) => value === applicationServerKey[index])) {
          if (!await subscription.unsubscribe()) throw new Error('Oud push-abonnement kon niet worden verwijderd.');
          subscription = null;
        }
      }
      if (!subscription) {
        subscription = await swRegistration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey
        });
      }

      if (!hasJoinedSession || profile.playerId !== playerId) throw new Error('Meld je opnieuw aan om push te activeren.');
      const subscribeRes = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId,
          playerSecret,
          subscription
        })
      });
      if (!subscribeRes.ok) {
        const data = await subscribeRes.json();
        throw new Error(data.error || 'Push-abonnement kon niet worden opgeslagen.');
      }

      if (!hasJoinedSession || profile.playerId !== playerId) return false;
      statusEl.textContent = '🔔 Web Push geactiveerd';
      return true;
    } catch (err) {
      console.warn('Web Push niet beschikbaar:', err);
      statusEl.textContent = `🔔 Web Push mislukt: ${err.message}`;
      return false;
    }
  }

  function showInAppPushBanner(title, body) {
    const banner = document.getElementById('pushBanner');
    document.getElementById('pushBannerTitle').textContent = title || 'Party Quiz';
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
    if (isJoining || isResetting) return;
    const nameVal = document.getElementById('inputPlayerName').value.trim() || profile.name;
    if (!nameVal) {
      document.getElementById('inputPlayerName').focus();
      return;
    }
    profile.name = nameVal;
    saveStoredProfile();
    if (requestPush && document.getElementById('chkEnablePush').checked) {
      pendingPushPermission = requestPushPermission();
    }
    if (!socket.connected) {
      isReconnecting = true;
      showScreen('screenReconnect');
      return;
    }
    const permissionRequest = pendingPushPermission;
    pendingPushPermission = null;
    isJoining = true;
    const attempt = ++joinAttempt;

    socket.emit(
      'player_join',
      {
        playerId: profile.playerId,
        playerSecret: profile.playerSecret,
        name: profile.name,
        avatar: profile.avatar,
        color: profile.color
      },
      async response => {
        if (attempt !== joinAttempt) return;
        isJoining = false;
        isReconnecting = false;
        if (response && response.success) {
          hasJoinedSession = true;
          profile.playerId = response.player.id;
          profile.playerSecret = response.playerSecret;
          profile.name = response.player.name;
          saveStoredProfile();
          updateHeaderBar(response.player);

          if (response.state) {
            renderGameState(response.state);
          }
          if (permissionRequest) await setupWebPushSubscription(permissionRequest);
        } else {
          if (response && response.code === 'player_removed') {
            const storageCleared = clearPlayerSession();
            if (!storageCleared) {
              showInAppPushBanner('Profiel niet gewist', 'Wis het spelersprofiel via de resetknop.');
              return;
            }
          }
          showScreen('screenJoin');
          showInAppPushBanner('Aanmelden mislukt', (response && response.error) || 'Probeer het opnieuw.');
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
    lastGameState = state;

    const me = (state.leaderboard || []).find(p => p.id === profile.playerId);
    if (me) {
      updateHeaderBar(me);
    }

    if (!hasJoinedSession) {
      showScreen(isReconnecting ? 'screenReconnect' : 'screenJoin');
      return;
    }

    if (state.phase === 'lobby') {
      document.getElementById('lobbyQuizNameText').textContent =
        state.quizTitle || 'Party Quiz';
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
          <span style="line-height: 1.25;">${escapeHtml(opt)}</span>
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
    if (!socket.connected || !hasJoinedSession) {
      showInAppPushBanner('Verbinding herstellen', 'Je wordt opnieuw aangemeld. Probeer daarna opnieuw.');
      return;
    }
    enablePlayerAudio();
    mySelectedAnswer = answerIndex;
    const submittedQuestionId = currentQuestionId;
    socket.emit(
      'submit_answer',
      {
        playerId: profile.playerId,
        answerIndex
      },
      res => {
        if (currentQuestionId !== submittedQuestionId) return;
        if (res && res.accepted) {
          document.getElementById('lockedTitle').textContent = `Antwoord ingedrukt op ${res.elapsedSeconds}s!`;
          document.getElementById('lockedSub').textContent =
            res.elapsedSeconds <= 1.0
              ? '⚡ Binnen de eerste seconde! Als het goed is pak je de volle 1000 punten!'
              : 'Wachten tot de vraag sluit voor het resultaat...';
        } else {
          mySelectedAnswer = null;
          showInAppPushBanner('Antwoord niet verzonden', (res && res.reason) || 'Probeer het opnieuw.');
          if (lastGameState) renderGameState(lastGameState);
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
    document.getElementById('resultTop3Title').textContent =
      state.phase === 'finished' ? '🏆 Eindstand Top 3' : '🏆 Huidige Top 3';
    document.getElementById('resultLeaderboardTitle').textContent =
      state.phase === 'finished' ? 'Volledige eindranglijst' : 'Volledige ranglijst';
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
    document.getElementById('resultLeaderboardList').innerHTML = (state.leaderboard || [])
      .map(p => `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 0;">
          <span style="min-width:0;overflow-wrap:anywhere;font-weight:${p.id === profile.playerId ? '900' : '600'}">
            #${p.position} ${escapeHtml(p.avatar || '🎉')} ${escapeHtml(p.name)} ${p.id === profile.playerId ? '(Jij)' : ''}
          </span>
          <span style="flex-shrink:0;font-weight:800;color:var(--homey-blue);">${p.score} pt</span>
        </div>
      `)
      .join('');
  }

  function showScreen(screenId) {
    document.body.classList.toggle('gameplay-active', screenId === 'screenGameplay');
    ['screenJoin', 'screenLobbyWait', 'screenReconnect', 'screenGameplay', 'screenRoundResult'].forEach(id => {
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
      if (profile.playerId) isReconnecting = true;
      joinQuizNow(false);
    }
  });

  socket.on('disconnect', () => {
    if (!hasJoinedSession && !isJoining) return;
    hasJoinedSession = false;
    isJoining = false;
    isReconnecting = true;
    joinAttempt++;
    showScreen('screenReconnect');
    showInAppPushBanner('Verbinding herstellen', 'Je wordt opnieuw aangemeld bij de quiz.');
  });

  socket.on('quiz_state', state => {
    renderGameState(state);
  });

  function clearPlayerSession() {
    hasJoinedSession = false;
    isJoining = false;
    isReconnecting = false;
    joinAttempt++;
    pendingPushPermission = null;
    lastGameState = null;
    document.getElementById('resetConfirm').hidden = true;
    currentQuestionId = null;
    mySelectedAnswer = null;
    lastCelebratedRound = null;
    profile = { playerId: '', name: '', avatar: '🎉', color: '#00A4E8' };
    let storageCleared = true;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      console.error('Spelersprofiel verwijderen mislukt:', err);
      storageCleared = false;
    }
    document.getElementById('headerPlayerName').textContent = 'Welkom bij Party Quiz';
    document.getElementById('headerAvatar').textContent = profile.avatar;
    document.getElementById('headerAvatar').style.background = profile.color;
    document.getElementById('headerPushStatus').textContent = 'Kies je naam om mee te doen';
    document.getElementById('headerRankBadge').style.display = 'none';
    document.getElementById('headerScoreBadge').style.display = 'none';
    initJoinForm();
    showScreen('screenJoin');
    return storageCleared;
  }

  socket.on('player_removed', () => {
    const storageCleared = clearPlayerSession();
    showInAppPushBanner('Uit de quiz verwijderd', storageCleared
      ? 'De host heeft je uit de quiz verwijderd.'
      : 'De host heeft je verwijderd. Wis ook je spelersprofiel via de resetknop.');
  });

  function showResetScreen() {
    const storageCleared = clearPlayerSession();
    showInAppPushBanner(storageCleared ? 'Sessie beëindigd' : 'Profiel niet gewist', storageCleared
      ? 'Vul je naam in en maak een nieuw profiel om opnieuw mee te doen.'
      : 'Wis je spelersprofiel in de browserinstellingen voordat je opnieuw begint.');
    return storageCleared;
  }

  socket.on('player_session_ended', () => {
    if (isResetting) resetEventReceived = true;
    showResetScreen();
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

  socket.on('fastest_correct', payload => {
    if (!hasJoinedSession || !payload || !payload.roundId || payload.roundId === lastCelebratedRound) return;
    lastCelebratedRound = payload.roundId;
    const played = playFastestSound();
    showInAppPushBanner('⚡ Jij was het snelst!', played
      ? 'Je gaf als eerste het juiste antwoord.'
      : 'Je gaf als eerste het juiste antwoord. Controleer het geluid van je telefoon.');
  });

  document.getElementById('btnJoinGame').addEventListener('click', () => {
    enablePlayerAudio();
    joinQuizNow(true);
  });

  document.getElementById('inputPlayerName').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      enablePlayerAudio();
      joinQuizNow(true);
    }
  });

  document.getElementById('btnRequestPushAgain').addEventListener('click', async () => {
    if (!await setupWebPushSubscription(requestPushPermission())) {
      showInAppPushBanner('Web Push niet actief', document.getElementById('headerPushStatus').textContent);
      return;
    }
    try {
      const response = await fetch('/api/push/player-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: profile.playerId, playerSecret: profile.playerSecret })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Testmelding mislukt.');
      showInAppPushBanner('Testmelding verzonden', 'Controleer de melding op je telefoon.');
    } catch (err) {
      console.warn('Testmelding mislukt:', err);
      showInAppPushBanner('Testmelding mislukt', err.message);
    }
  });

  document.getElementById('btnEditProfile').addEventListener('click', () => {
    hasJoinedSession = false;
    showScreen('screenJoin');
  });

  document.getElementById('btnResetPlayer').addEventListener('click', () => {
    if (!isResetting) {
      document.getElementById('resetError').hidden = true;
      document.getElementById('resetConfirm').hidden = false;
    }
  });

  document.getElementById('btnCancelReset').addEventListener('click', () => {
    if (!isResetting) document.getElementById('resetConfirm').hidden = true;
  });

  document.getElementById('btnConfirmReset').addEventListener('click', async () => {
    if (isResetting) return;
    isResetting = true;
    resetEventReceived = false;
    document.getElementById('resetError').hidden = true;
    document.getElementById('btnResetPlayer').disabled = true;
    document.getElementById('btnConfirmReset').disabled = true;
    document.getElementById('btnCancelReset').disabled = true;
    document.getElementById('btnJoinGame').disabled = true;
    try {
      const credentials = { playerId: profile.playerId, playerSecret: profile.playerSecret };
      if (socket.connected) {
        await new Promise((resolve, reject) => {
          socket.timeout(10000).emit('player_reset', credentials, (err, response) => {
            if (err) reject(new Error('De server reageert niet. Probeer het opnieuw.'));
            else if (!response || !response.success) reject(new Error((response && response.error) || 'De sessie kon niet worden beëindigd.'));
            else resolve(response);
          });
        });
      } else if (credentials.playerId) {
        const response = await fetch('/api/player/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(credentials)
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || 'De sessie kon niet worden beëindigd.');
      }
      if (!resetEventReceived) showResetScreen();
      document.getElementById('resetConfirm').hidden = true;
    } catch (err) {
      if (resetEventReceived) {
        console.warn('Bevestiging van sessiebeëindiging ontbreekt:', err);
      } else {
        console.error('Spelerssessie beëindigen mislukt:', err);
        const message = err instanceof TypeError
          ? 'Geen verbinding met de quizserver. Start de app en probeer opnieuw.'
          : err.message;
        const resetError = document.getElementById('resetError');
        resetError.textContent = message;
        resetError.hidden = false;
        showInAppPushBanner('Reset mislukt', message);
      }
    } finally {
      isResetting = false;
      document.getElementById('btnResetPlayer').disabled = false;
      document.getElementById('btnConfirmReset').disabled = false;
      document.getElementById('btnCancelReset').disabled = false;
      document.getElementById('btnJoinGame').disabled = false;
      if (isReconnecting && socket.connected && profile.name) joinQuizNow(false);
    }
  });

  initJoinForm();
})();
