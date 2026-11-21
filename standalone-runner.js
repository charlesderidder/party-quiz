'use strict';

const fs = require('fs');
const path = require('path');

const settingsFile = path.join(__dirname, 'userdata', 'homey-settings.json');
let memorySettings = {};
try {
  if (fs.existsSync(settingsFile)) {
    memorySettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  }
} catch (err) {
  memorySettings = {};
}

function saveSettingsToDisk() {
  try {
    const dir = path.dirname(settingsFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(memorySettings, null, 2), 'utf8');
  } catch (err) {
    // ignore
  }
}

class MockFlowCard {
  constructor(id, type) {
    this.id = id;
    this.type = type;
    this.runListener = null;
    this.autocompleteListeners = {};
  }
  async trigger(tokens = {}, state = {}) {
    return { id: this.id, tokens, state };
  }
  registerRunListener(fn) {
    this.runListener = fn;
    return this;
  }
  registerArgumentAutocompleteListener(name, fn) {
    this.autocompleteListeners[name] = fn;
    return this;
  }
}

const homeyRuntime = {
  settings: {
    get(key) {
      return memorySettings[key];
    },
    set(key, val) {
      memorySettings[key] = val;
      saveSettingsToDisk();
    },
    unset(key) {
      delete memorySettings[key];
      saveSettingsToDisk();
    },
    getKeys() {
      return Object.keys(memorySettings);
    }
  },
  flow: {
    _triggers: {},
    _conditions: {},
    _actions: {},
    getTriggerCard(id) {
      if (!this._triggers[id]) this._triggers[id] = new MockFlowCard(id, 'trigger');
      return this._triggers[id];
    },
    getConditionCard(id) {
      if (!this._conditions[id]) this._conditions[id] = new MockFlowCard(id, 'condition');
      return this._conditions[id];
    },
    getActionCard(id) {
      if (!this._actions[id]) this._actions[id] = new MockFlowCard(id, 'action');
      return this._actions[id];
    }
  }
};

global.__HOMEY_SHIM__ = {
  App: class HomeyAppBase {
    constructor() {
      this.homey = homeyRuntime;
      this.homey.app = this;
    }
    log(...args) {
      console.log('[Homey.App]', ...args);
    }
    error(...args) {
      console.error('[Homey.App ERROR]', ...args);
    }
  }
};

const PartyQuizApp = require('./app');
const appInstance = new PartyQuizApp();
appInstance.onInit().catch(err => {
  console.error('Fatal init error:', err);
  process.exit(1);
});
