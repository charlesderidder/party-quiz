'use strict';

module.exports = {
  async getStatus({ homey }) {
    return homey.app.getWidgetStatus();
  },

  async nextQuestion({ homey }) {
    return homey.app.advanceQuizFromWidget();
  },

  async startDefaultQuiz({ homey, body }) {
    const quizId = body && body.quizId ? body.quizId : null;
    return homey.app.startQuizFromWidget(quizId);
  }
};
