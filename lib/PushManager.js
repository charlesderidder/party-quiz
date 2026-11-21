'use strict';

const webPush = require('web-push');

class PushManager {
  /**
   * @param {object} options
   * @param {object} options.homey - Homey instance
   * @param {function} options.log - Logger function
   * @param {function} options.onRealtimePush - Optional socket fallback broadcaster
   */
  constructor({ homey, log, onRealtimePush }) {
    this.homey = homey;
    this.log = log || console.log;
    this.onRealtimePush = onRealtimePush || (() => {});
    this.subscriptions = new Map(); // playerId -> PushSubscription object
    this.vapidKeys = null;
    this.vapidSubject = 'mailto:partyquiz@homey.local';
  }

  /**
   * Initializes VAPID keys from Homey.settings or generates a fresh pair on first start
   */
  init() {
    let storedKeys = this.homey.settings.get('vapidKeys');
    if (!storedKeys || !storedKeys.publicKey || !storedKeys.privateKey) {
      this.log('[PushManager] Geen VAPID-keys gevonden. Nieuwe VAPID-keys genereren...');
      storedKeys = webPush.generateVAPIDKeys();
      this.homey.settings.set('vapidKeys', storedKeys);
      this.log('[PushManager] Nieuwe VAPID-keys opgeslagen in Homey.settings.');
    } else {
      this.log('[PushManager] Bestaande VAPID-keys geladen uit Homey.settings.');
    }

    this.vapidKeys = storedKeys;

    const customSubject = this.homey.settings.get('vapidSubject');
    if (customSubject && (customSubject.startsWith('mailto:') || customSubject.startsWith('https:'))) {
      this.vapidSubject = customSubject;
    }

    webPush.setVapidDetails(
      this.vapidSubject,
      this.vapidKeys.publicKey,
      this.vapidKeys.privateKey
    );

    // Load persisted subscriptions if available
    const savedSubs = this.homey.settings.get('pushSubscriptions') || {};
    for (const [playerId, sub] of Object.entries(savedSubs)) {
      if (sub && sub.endpoint) {
        this.subscriptions.set(playerId, sub);
      }
    }
  }

  getPublicKey() {
    return this.vapidKeys ? this.vapidKeys.publicKey : null;
  }

  regenerateVapidKeys() {
    this.vapidKeys = webPush.generateVAPIDKeys();
    this.homey.settings.set('vapidKeys', this.vapidKeys);
    this.subscriptions.clear();
    this.homey.settings.set('pushSubscriptions', {});
    webPush.setVapidDetails(
      this.vapidSubject,
      this.vapidKeys.publicKey,
      this.vapidKeys.privateKey
    );
    this.log('[PushManager] VAPID-keys opnieuw gegenereerd.');
    return this.vapidKeys.publicKey;
  }

  saveSubscription(playerId, subscription) {
    if (!playerId || !subscription || !subscription.endpoint) return false;
    this.subscriptions.set(playerId, subscription);
    this._persistSubscriptions();
    this.log(`[PushManager] Web Push abonnement geregistreerd voor speler ${playerId}`);
    return true;
  }

  removeSubscription(playerId) {
    this.subscriptions.delete(playerId);
    this._persistSubscriptions();
  }

  _persistSubscriptions() {
    const obj = {};
    for (const [id, sub] of this.subscriptions.entries()) {
      obj[id] = sub;
    }
    this.homey.settings.set('pushSubscriptions', obj);
  }

  /**
   * Sends a Web Push notification to a specific player
   */
  async sendToPlayer(playerId, payloadObj) {
    // Also emit over Socket.io so players on non-HTTPS LAN still get an in-app push banner
    this.onRealtimePush(playerId, payloadObj);

    const sub = this.subscriptions.get(playerId);
    if (!sub) return { sent: false, reason: 'no_subscription' };

    const payload = JSON.stringify({
      title: payloadObj.title || 'Homey Party Quiz',
      body: payloadObj.body || '',
      icon: payloadObj.icon || '/assets/icon.svg',
      badge: '/assets/icon.svg',
      tag: payloadObj.tag || 'homey-quiz-update',
      data: {
        url: payloadObj.url || '/play',
        ...payloadObj.data
      }
    });

    try {
      await webPush.sendNotification(sub, payload, { TTL: 60 });
      return { sent: true };
    } catch (err) {
      this.log(`[PushManager] Fout bij versturen Web Push naar ${playerId}: ${err.message}`);
      if (err.statusCode === 404 || err.statusCode === 410) {
        this.removeSubscription(playerId);
      }
      return { sent: false, reason: err.message };
    }
  }

  /**
   * Broadcasts a Web Push notification to all subscribed players
   */
  async sendToAll(payloadObj, activePlayerIds = null) {
    const targetIds = activePlayerIds || Array.from(this.subscriptions.keys());
    // Broadcast realtime fallback to everyone if no specific list
    if (!activePlayerIds) {
      this.onRealtimePush('ALL', payloadObj);
    }

    const results = await Promise.allSettled(
      targetIds.map(playerId => this.sendToPlayer(playerId, payloadObj))
    );
    const sentCount = results.filter(r => r.status === 'fulfilled' && r.value.sent).length;
    return { total: targetIds.length, sent: sentCount };
  }

  /**
   * Sends personalized round summary Web Push notifications after each question
   */
  async sendRoundResultsToPlayers(playersList, questionNumber, totalQuestions) {
    const top3 = playersList.slice(0, 3);
    const medals = ['🥇', '🥈', '🥉'];
    const top3Text = top3
      .map((p, idx) => `${medals[idx]} ${p.name} (${p.score})`)
      .join(' • ');

    const promises = playersList.map(player => {
      let statusHeader = '⏰ Geen antwoord';
      if (player.lastAnswerIndex !== null && player.lastAnswerIndex !== undefined) {
        statusHeader = player.lastAnswerCorrect
          ? `✅ Goed! (+${player.lastPointsEarned} pt)`
          : '❌ Helaas, fout antwoord (0 pt)';
      }

      const rankDeltaText =
        player.rankDelta > 0
          ? `🔼 +${player.rankDelta}`
          : player.rankDelta < 0
          ? `🔽 ${player.rankDelta}`
          : '➖';

      const title = `Vraag ${questionNumber}/${totalQuestions}: ${statusHeader}`;
      const body = `Jij staat op plek #${player.position} (${rankDeltaText}) met ${player.score} pt.\nTop 3: ${top3Text}`;

      return this.sendToPlayer(player.id, {
        title,
        body,
        tag: `quiz-round-${questionNumber}`,
        data: {
          questionNumber,
          correct: player.lastAnswerCorrect,
          pointsEarned: player.lastPointsEarned,
          score: player.score,
          position: player.position,
          top3: top3.map(t => ({ name: t.name, score: t.score, position: t.position }))
        }
      });
    });

    await Promise.allSettled(promises);
  }
}

module.exports = PushManager;
