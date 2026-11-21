'use strict';

module.exports = {
  async getState({ homey }) {
    return homey.app.quizEngine.getPublicState();
  },

  async getQuizzes({ homey }) {
    return homey.app.quizzes;
  },

  async saveQuiz({ homey, body }) {
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

  async deleteQuiz({ homey, params }) {
    const id = params.id;
    homey.app.quizzes = homey.app.quizzes.filter(q => q.id !== id);
    homey.app._saveQuizzes(homey.app.quizzes);
    return { deleted: id };
  },

  async nextQuestion({ homey }) {
    return homey.app.quizEngine.nextStep();
  },

  async startQuiz({ homey, body }) {
    const quizId = body && body.quizId;
    const quiz =
      (quizId && homey.app.quizzes.find(q => q.id === quizId)) ||
      homey.app.quizEngine.activeQuiz ||
      homey.app.quizzes[0];
    return homey.app.quizEngine.startQuiz(quiz, true);
  }
};
