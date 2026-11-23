'use strict';

function requireAdmin(homey, body) {
  if (!homey.app.adminSecurity.authenticate(body && body.adminPassword, 'homey-api')) {
    throw new Error('Ongeldig beheerderswachtwoord of te veel pogingen.');
  }
}

module.exports = {
  async getState({ homey }) {
    return homey.app.quizEngine.getPublicState();
  },

  async getQuizzes() {
    throw new Error('Gebruik de beveiligde beheer-API.');
  },

  async getSettings() {
    throw new Error('Gebruik de beveiligde beheer-API.');
  },

  async getAdminData({ homey, body }) {
    requireAdmin(homey, body);
    return { settings: homey.app.getAppSettings(), quizzes: homey.app.quizzes };
  },

  async setAdminPassword({ homey, body }) {
    if (homey.app.adminSecurity.isConfigured()) requireAdmin(homey, body);
    homey.app.adminSecurity.setPassword(body && body.newPassword);
    return { success: true };
  },

  async saveSettings({ homey, body }) {
    requireAdmin(homey, body);
    return { success: true, serverConfig: homey.app._saveServerConfig(body || {}) };
  },

  async testPush({ homey, body }) {
    requireAdmin(homey, body);
    return homey.app.sendTestPush(body || {});
  },

  async regenerateVapid({ homey, body }) {
    requireAdmin(homey, body);
    return { success: true, publicKey: homey.app.pushManager.regenerateVapidKeys() };
  },

  async saveQuiz({ homey, body }) {
    requireAdmin(homey, body);
    const FileImporter = require('./lib/FileImporter');
    const normalized = FileImporter.normalizeJsonQuiz(body, body.title);
    const idx = homey.app.quizzes.findIndex(q => q.id === normalized.id);
    if (idx >= 0) {
      homey.app.quizzes[idx] = normalized;
    } else {
      homey.app.quizzes.push(normalized);
    }
    homey.app._saveQuizzes(homey.app.quizzes);
    return normalized;
  },

  async deleteQuiz({ homey, params, body }) {
    requireAdmin(homey, body);
    const id = params.id;
    homey.app.quizzes = homey.app.quizzes.filter(q => q.id !== id);
    homey.app._saveQuizzes(homey.app.quizzes);
    return { deleted: id };
  },

  async nextQuestion({ homey, body }) {
    requireAdmin(homey, body);
    return homey.app.quizEngine.nextStep();
  },

  async startQuiz({ homey, body }) {
    requireAdmin(homey, body);
    const quizId = body && body.quizId;
    const quiz =
      (quizId && homey.app.quizzes.find(q => q.id === quizId)) ||
      homey.app.quizEngine.activeQuiz ||
      homey.app.quizzes[0];
    return homey.app.quizEngine.startQuiz(quiz, true);
  }
};
