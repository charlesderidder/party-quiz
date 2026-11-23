'use strict';

(function () {
  const socket = io();
  const SHAPES = ['▲', '◆', '●', '■'];
  const OPTION_COLORS = ['#F43F5E', '#00A4E8', '#F59E0B', '#10B981'];

  let quizzes = [];
  let activeQuizId = null;
  let draftQuiz = null; // working copy currently edited
  let latestState = null;

  // =========================================================================
  // HELPERS
  // =========================================================================
  function escapeHtml(str) {
    return String(str === undefined || str === null ? '' : str).replace(/[&<>"']/g, s => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[s]));
  }

  function showAlert(message, isError = false) {
    const el = document.getElementById('adminStatusAlert');
    el.textContent = message;
    el.style.display = 'block';
    el.style.color = isError ? 'var(--homey-rose)' : 'var(--homey-green)';
    clearTimeout(window.__alertTimer);
    window.__alertTimer = setTimeout(() => {
      el.style.display = 'none';
    }, 4500);
  }

  function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function api(path, options) {
    return fetch(path, options).then(async res => {
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        data = null;
      }
      if (!res.ok) {
        throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
      }
      return data;
    });
  }

  // =========================================================================
  // TABS
  // =========================================================================
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.tab;
      ['tabEditor', 'tabImport', 'tabSettings', 'tabFlows'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = id === target ? (id === 'tabEditor' ? 'grid' : 'flex') : 'none';
      });
      if (target === 'tabSettings') loadSettings();
    });
  });

  // =========================================================================
  // QUIZ CRUD EDITOR
  // =========================================================================
  async function loadQuizzes(selectId) {
    const data = await api('/api/quizzes');
    quizzes = data.quizzes || [];
    if (quizzes.length === 0) {
      activeQuizId = null;
      draftQuiz = null;
    } else {
      const targetId =
        selectId || activeQuizId || (latestState && latestState.quizId) || quizzes[0].id;
      activeQuizId = quizzes.some(q => q.id === targetId) ? targetId : quizzes[0].id;
      draftQuiz = JSON.parse(JSON.stringify(quizzes.find(q => q.id === activeQuizId)));
    }
    renderSidebar();
    renderEditor();
  }

  function renderSidebar() {
    const list = document.getElementById('quizSidebarList');
    if (quizzes.length === 0) {
      list.innerHTML =
        '<div style="font-size:13px;color:var(--text-muted);padding:12px;">Nog geen quizzen. Maak er een aan of importeer een bestand.</div>';
      return;
    }
    list.innerHTML = quizzes
      .map(
        q => `
      <div class="quiz-list-item ${q.id === activeQuizId ? 'active' : ''}" data-id="${escapeHtml(q.id)}">
        <div style="font-weight:800;font-size:14px;">${escapeHtml(q.title)}</div>
        <div style="font-size:11.5px;color:var(--text-muted);">${(q.questions || []).length} vragen${
          latestState && latestState.quizId === q.id && latestState.phase !== 'lobby'
            ? ' • 🟢 Live'
            : ''
        }</div>
      </div>
    `
      )
      .join('');

    list.querySelectorAll('.quiz-list-item').forEach(item => {
      item.addEventListener('click', () => {
        if (!draftQuiz || confirmDiscard()) {
          loadQuizzes(item.dataset.id);
        }
      });
    });
  }

  function confirmDiscard() {
    return true; // Autosave model through explicit "Opslaan" button; switching reloads saved version
  }

  function renderEditor() {
    const container = document.getElementById('questionsEditorContainer');
    const titleInput = document.getElementById('editQuizTitle');
    const descInput = document.getElementById('editQuizDesc');

    if (!draftQuiz) {
      titleInput.value = '';
      descInput.value = '';
      document.getElementById('editQuestionCount').textContent = '0';
      container.innerHTML = `
        <div style="padding:34px;text-align:center;color:var(--text-muted);border:1px dashed var(--border-subtle);border-radius:18px;">
          Selecteer een quiz links of maak een nieuwe quiz aan.
        </div>`;
      return;
    }

    titleInput.value = draftQuiz.title || '';
    descInput.value = draftQuiz.description || '';
    draftQuiz.questions = draftQuiz.questions || [];
    document.getElementById('editQuestionCount').textContent = draftQuiz.questions.length;

    container.innerHTML = draftQuiz.questions
      .map((q, qIndex) => renderQuestionCard(q, qIndex))
      .join('');

    // Bind question field events
    container.querySelectorAll('[data-qfield]').forEach(input => {
      input.addEventListener('input', e => {
        const qIndex = Number(e.target.dataset.qindex);
        const field = e.target.dataset.qfield;
        const val = e.target.value;
        const question = draftQuiz.questions[qIndex];
        if (!question) return;
        if (field.startsWith('option')) {
          const optIndex = Number(field.replace('option', ''));
          question.options[optIndex] = val;
        } else if (field === 'timeLimit' || field === 'points') {
          question[field] = Math.max(1, Number(val) || 1);
        } else {
          question[field] = val;
        }
      });
    });

    container.querySelectorAll('[data-correct]').forEach(btn => {
      btn.addEventListener('click', () => {
        const qIndex = Number(btn.dataset.qindex);
        draftQuiz.questions[qIndex].correctIndex = Number(btn.dataset.correct);
        renderEditor();
      });
    });

    container.querySelectorAll('[data-remove-question]').forEach(btn => {
      btn.addEventListener('click', () => {
        const qIndex = Number(btn.dataset.removeQuestion);
        draftQuiz.questions.splice(qIndex, 1);
        renderEditor();
      });
    });

    container.querySelectorAll('[data-move]').forEach(btn => {
      btn.addEventListener('click', () => {
        const qIndex = Number(btn.dataset.qindex);
        const dir = btn.dataset.move === 'up' ? -1 : 1;
        const target = qIndex + dir;
        if (target < 0 || target >= draftQuiz.questions.length) return;
        const [item] = draftQuiz.questions.splice(qIndex, 1);
        draftQuiz.questions.splice(target, 0, item);
        renderEditor();
      });
    });
  }

  function renderQuestionCard(q, qIndex) {
    const options = q.options || ['', '', '', ''];
    const correctIdx = Number(q.correctIndex) || 0;

    return `
      <div class="question-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="option-badge" style="background:var(--homey-blue);">${qIndex + 1}</span>
            <strong style="font-size:14px;">Vraag ${qIndex + 1}</strong>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn-homey btn-sm" data-move="up" data-qindex="${qIndex}">↑</button>
            <button class="btn-homey btn-sm" data-move="down" data-qindex="${qIndex}">↓</button>
            <button class="btn-homey btn-danger btn-sm" data-remove-question="${qIndex}">🗑️</button>
          </div>
        </div>

        <input data-qfield="question" data-qindex="${qIndex}" class="input-homey"
          placeholder="Typ hier de vraagtekst..." value="${escapeHtml(q.question || '')}" />

        <div class="options-editor-grid">
          ${options
            .map(
              (opt, oIndex) => `
            <div class="option-input-row" style="${
              oIndex === correctIdx ? 'border-color:#10B981;background:rgba(16,185,129,0.1);' : ''
            }">
              <span class="option-badge" style="background:${OPTION_COLORS[oIndex]};">${
                SHAPES[oIndex]
              }</span>
              <input data-qfield="option${oIndex}" data-qindex="${qIndex}" class="input-homey"
                style="border:none;background:transparent;padding:4px;"
                placeholder="Antwoordoptie ${oIndex + 1}" value="${escapeHtml(opt)}" />
              <button class="btn-homey btn-sm" data-correct="${oIndex}" data-qindex="${qIndex}"
                title="Markeer als juiste antwoord"
                style="${
                  oIndex === correctIdx
                    ? 'background:#10B981;color:#fff;border-color:#10B981;'
                    : ''
                }">${oIndex === correctIdx ? '✅ Juist' : 'Kies'}</button>
            </div>
          `
            )
            .join('')}
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div>
            <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px;">Tijdslimiet (seconden)</label>
            <input type="number" min="5" max="90" data-qfield="timeLimit" data-qindex="${qIndex}"
              class="input-homey" value="${Number(q.timeLimit) || 20}" />
          </div>
          <div>
            <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px;">
              Max. punten (snelheidsbonus: 1000 in sec 1 → 0 in sec 20)
            </label>
            <input type="number" min="100" max="2000" step="50" data-qfield="points" data-qindex="${qIndex}"
              class="input-homey" value="${Number(q.points) || 1000}" />
          </div>
        </div>
      </div>
    `;
  }

  document.getElementById('btnNewQuiz').addEventListener('click', () => {
    const newQuiz = {
      id: makeId('quiz'),
      title: 'Nieuwe Quiz',
      description: 'Beschrijving van je nieuwe quiz',
      createdAt: new Date().toISOString(),
      questions: [
        {
          id: makeId('q'),
          question: 'Wat is de hoofdstad van Nederland?',
          options: ['Rotterdam', 'Amsterdam', 'Utrecht', 'Den Haag'],
          correctIndex: 1,
          timeLimit: 20,
          points: 1000
        }
      ]
    };
    quizzes.push(newQuiz);
    activeQuizId = newQuiz.id;
    draftQuiz = JSON.parse(JSON.stringify(newQuiz));
    renderSidebar();
    renderEditor();
    showAlert('Nieuwe quiz aangemaakt. Vergeet niet op "💾 Quiz Opslaan" te klikken.');
  });

  document.getElementById('btnAddQuestion').addEventListener('click', () => {
    if (!draftQuiz) return;
    draftQuiz.questions.push({
      id: makeId('q'),
      question: '',
      options: ['', '', '', ''],
      correctIndex: 0,
      timeLimit: 20,
      points: 1000
    });
    renderEditor();
  });

  document.getElementById('editQuizTitle').addEventListener('input', e => {
    if (draftQuiz) draftQuiz.title = e.target.value;
  });

  document.getElementById('editQuizDesc').addEventListener('input', e => {
    if (draftQuiz) draftQuiz.description = e.target.value;
  });

  document.getElementById('btnSaveQuiz').addEventListener('click', async () => {
    if (!draftQuiz) return;
    try {
      draftQuiz.title = document.getElementById('editQuizTitle').value.trim() || 'Naamloze Quiz';
      draftQuiz.description = document.getElementById('editQuizDesc').value.trim();
      draftQuiz.questions = (draftQuiz.questions || []).map(q => ({
        ...q,
        options: (q.options || []).map(o => String(o || '').trim())
      }));

      const { quiz: saved } = await api('/api/quizzes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftQuiz)
      });
      activeQuizId = saved.id;
      await loadQuizzes(saved.id);
      showAlert(`✅ Quiz "${saved.title}" is opgeslagen (${(saved.questions || []).length} vragen).`);
    } catch (err) {
      showAlert(`❌ Opslaan mislukt: ${err.message}`, true);
    }
  });

  document.getElementById('btnDeleteQuiz').addEventListener('click', async () => {
    if (!draftQuiz) return;
    if (!confirm(`Weet je zeker dat je "${draftQuiz.title}" wilt verwijderen?`)) return;
    try {
      await api(`/api/quizzes/${encodeURIComponent(draftQuiz.id)}`, { method: 'DELETE' });
      activeQuizId = null;
      draftQuiz = null;
      await loadQuizzes();
      showAlert('🗑️ Quiz verwijderd.');
    } catch (err) {
      showAlert(`❌ Verwijderen mislukt: ${err.message}`, true);
    }
  });

  document.getElementById('btnActivateInLobby').addEventListener('click', async () => {
    if (!draftQuiz) return;
    try {
      await api('/api/control/select-quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quizId: draftQuiz.id })
      });
      showAlert('📺 Quiz is klaargezet in de lobby. Open /host om te starten!');
    } catch (err) {
      showAlert(`❌ ${err.message}`, true);
    }
  });

  // =========================================================================
  // IMPORT (.xlsx / .csv / .json)
  // =========================================================================
  document.getElementById('importForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fileInput = document.getElementById('importFileInput');
    const customTitle = document.getElementById('importCustomTitle').value.trim();
    if (!fileInput.files || !fileInput.files[0]) {
      showAlert('❌ Selecteer eerst een bestand.', true);
      return;
    }
    const formData = new FormData();
    formData.append('file', fileInput.files[0]);
    if (customTitle) formData.append('title', customTitle);

    try {
      const result = await api('/api/import', { method: 'POST', body: formData });
      showAlert(
        `📥 "${result.quiz.title}" geïmporteerd met ${(result.quiz.questions || []).length} vragen!`
      );
      document.getElementById('importForm').reset();
      await loadQuizzes(result.quiz.id);
      document.querySelector('.tab-btn[data-tab="tabEditor"]').click();
    } catch (err) {
      showAlert(`❌ Import mislukt: ${err.message}`, true);
    }
  });

  // =========================================================================
  // SETTINGS, HTTPS & VAPID
  // =========================================================================
  async function loadSettings() {
    try {
      const data = await api('/api/settings');
      const cfg = data.serverConfig || {};
      document.getElementById('settingPublicUrl').value = cfg.publicBaseUrl || '';
      document.getElementById('settingVapidSubject').value =
        cfg.vapidSubject || 'mailto:partyquiz@homey.local';
      document.getElementById('detectedLanIpText').textContent =
        data.detectedLanIp || 'onbekend';
      document.getElementById('vapidPublicKeyInput').value = data.vapidPublicKey || '—';
      document.getElementById('subCountText').textContent = data.subscriptionCount || 0;
    } catch (err) {
      showAlert(`❌ Instellingen laden mislukt: ${err.message}`, true);
    }
  }

  document.getElementById('btnSaveSettings').addEventListener('click', async () => {
    try {
      const payload = {
        publicBaseUrl: document.getElementById('settingPublicUrl').value.trim(),
        vapidSubject: document.getElementById('settingVapidSubject').value.trim()
      };
      await api('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      showAlert('✅ Server-URL & HTTPS-instellingen opgeslagen.');
      await loadSettings();
    } catch (err) {
      showAlert(`❌ Opslaan mislukt: ${err.message}`, true);
    }
  });

  document.getElementById('btnRegenVapid').addEventListener('click', async () => {
    if (!confirm('Nieuwe VAPID-keys genereren? Bestaande push-abonnementen komen te vervallen.')) return;
    try {
      const res = await api('/api/push/regenerate-vapid', { method: 'POST' });
      document.getElementById('vapidPublicKeyInput').value = res.publicKey;
      showAlert('🔄 Nieuwe VAPID-keys gegenereerd en opgeslagen in Homey.settings.');
    } catch (err) {
      showAlert(`❌ ${err.message}`, true);
    }
  });

  document.getElementById('btnTestPushAll').addEventListener('click', async () => {
    try {
      await api('/api/push/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Test vanaf het Party Quiz beheerpaneel — Top 3 wordt live bijgewerkt! 🏆'
        })
      });
      showAlert('🔔 Test Web Push verzonden naar alle geregistreerde spelers.');
    } catch (err) {
      showAlert(`❌ ${err.message}`, true);
    }
  });

  // =========================================================================
  // FLOW STUDIO TESTER
  // =========================================================================
  function findPlayerIdByName(name) {
    const q = String(name || '').toLowerCase().trim();
    if (!q || !latestState) return null;
    const found = (latestState.leaderboard || []).find(
      p => p.name.toLowerCase() === q || p.name.toLowerCase().includes(q)
    );
    return found ? found.id : null;
  }

  document.getElementById('btnRunBonusFlow').addEventListener('click', async () => {
    const name = document.getElementById('flowBonusPlayer').value;
    const points = Number(document.getElementById('flowBonusPoints').value) || 0;
    const playerId = findPlayerIdByName(name);
    if (!playerId) {
      showAlert('❌ Speler niet gevonden. Voeg eerst spelers toe via /host.', true);
      return;
    }
    try {
      await api('/api/control/bonus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId, points })
      });
      showAlert(`🎁 ${points} bonuspunten aan ${name} gegeven.`);
    } catch (err) {
      showAlert(`❌ ${err.message}`, true);
    }
  });

  document.getElementById('btnRunPushAllFlow').addEventListener('click', async () => {
    const text = document.getElementById('flowPushAllText').value.trim();
    try {
      await api('/api/push/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text })
      });
      showAlert('🔔 DAN-actie send_push_all uitgevoerd.');
    } catch (err) {
      showAlert(`❌ ${err.message}`, true);
    }
  });

  document.getElementById('btnEvalCondition').addEventListener('click', async () => {
    const conditionId = document.getElementById('flowConditionSelect').value;
    const name = document.getElementById('flowConditionPlayer').value;
    const playerId = findPlayerIdByName(name);
    const resultEl = document.getElementById('flowConditionResult');
    if (!playerId) {
      resultEl.textContent = '❌ Speler niet gevonden in de actieve quiz.';
      resultEl.style.color = 'var(--homey-rose)';
      return;
    }
    try {
      const res = await api('/api/flow/evaluate-condition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conditionId, playerId })
      });
      resultEl.textContent = res.result
        ? `✅ EN-kaart "${conditionId}" is WAAR voor ${name}`
        : `❌ EN-kaart "${conditionId}" is ONWAAR voor ${name}`;
      resultEl.style.color = res.result ? 'var(--homey-green)' : 'var(--homey-rose)';
    } catch (err) {
      resultEl.textContent = `❌ ${err.message}`;
      resultEl.style.color = 'var(--homey-rose)';
    }
  });

  // =========================================================================
  // LIVE TRIGGER LOG
  // =========================================================================
  const TRIGGER_LABELS = {
    quiz_started: '🚀 quiz_started',
    question_asked: '❓ question_asked',
    question_time_up: '⏰ question_time_up',
    player_answered_correct: '✅ player_answered_correct',
    player_answered_wrong: '❌ player_answered_wrong',
    player_rank_up: '📈 player_rank_up',
    player_entered_top3: '🏆 player_entered_top3',
    player_left_top3: '📉 player_left_top3',
    player_is_first: '🥇 player_is_first',
    player_won: '👑 player_won'
  };

  function renderFlowEvent(entry) {
    if (!entry) return;
    const list = document.getElementById('flowEventsList');
    const tokensHtml = Object.entries(entry.tokens || {})
      .map(
        ([k, v]) =>
          `<span class="glass-pill" style="font-size:11px;padding:3px 9px;">[${escapeHtml(
            k
          )}: ${escapeHtml(v)}]</span>`
      )
      .join(' ');

    const item = document.createElement('div');
    item.className = 'flow-log-item';
    item.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:4px;">
        <strong>${escapeHtml(TRIGGER_LABELS[entry.triggerId] || entry.triggerId)}</strong>
        <div style="display:flex;flex-wrap:wrap;gap:4px;">${tokensHtml}</div>
      </div>
      <span style="font-size:11px;color:var(--text-muted);">${new Date(
        entry.timestamp || Date.now()
      ).toLocaleTimeString('nl-NL')}</span>
    `;
    list.prepend(item);
    while (list.children.length > 40) list.removeChild(list.lastChild);
  }

  socket.on('flow_event', renderFlowEvent);

  socket.on('quiz_state', state => {
    latestState = state;
    if (state) {
      // Keep sidebar in sync with "Live" indicator
      renderSidebar();
    }
  });

  // =========================================================================
  // INIT
  // =========================================================================
  (async function init() {
    try {
      latestState = await api('/api/state');
    } catch (e) {
      latestState = null;
    }
    await loadQuizzes();
    await loadSettings();
    try {
      const { flowHistory } = await api('/api/flow/history');
      flowHistory.reverse().forEach(renderFlowEvent);
    } catch (err) {
      showAlert(`❌ Flow-logboek laden mislukt: ${err.message}`, true);
    }
  })();
})();
