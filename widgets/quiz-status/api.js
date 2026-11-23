'use strict';

module.exports = {
  async getStatus({ homey }) {
    return homey.app.getWidgetStatus();
  },

  async nextQuestion() {
    throw new Error('Open het hostscherm en meld je aan als beheerder.');
  },

  async startDefaultQuiz() {
    throw new Error('Open het hostscherm en meld je aan als beheerder.');
  }
};
