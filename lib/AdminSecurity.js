'use strict';

const crypto = require('crypto');

class AdminSecurity {
  constructor(settings) {
    this.settings = settings;
    this.sessions = new Map();
    this.attempts = new Map();
  }

  isConfigured() {
    return Boolean(this.settings.get('adminPasswordHash'));
  }

  setPassword(password) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
      throw new Error('Het beheerderswachtwoord moet 12 tot 256 tekens bevatten.');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    this.settings.set('adminPasswordHash', { salt, hash });
    this.sessions.clear();
  }

  verify(password) {
    const record = this.settings.get('adminPasswordHash');
    if (!record || typeof password !== 'string' || password.length > 256 ||
        typeof record.salt !== 'string' || !/^[0-9a-f]{128}$/.test(record.hash || '')) {
      return false;
    }
    const expected = Buffer.from(record.hash, 'hex');
    const actual = crypto.scryptSync(password, record.salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  }

  authenticate(password, address) {
    const now = Date.now();
    for (const [key, value] of this.attempts) {
      if (value.until <= now) this.attempts.delete(key);
    }
    const attempt = this.attempts.get(address);
    if (attempt && attempt.count >= 5) return false;
    if (!this.verify(password)) {
      this.attempts.set(address, { count: attempt ? attempt.count + 1 : 1, until: attempt ? attempt.until : now + 15 * 60 * 1000 });
      return false;
    }
    this.attempts.delete(address);
    return true;
  }

  createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
    return token;
  }

  sessionFromRequest(req) {
    const match = /(?:^|;\s*)party_quiz_admin=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
    if (!match) return false;
    const expiry = this.sessions.get(match[1]);
    if (!expiry || expiry <= Date.now()) {
      this.sessions.delete(match[1]);
      return false;
    }
    return true;
  }
}

module.exports = AdminSecurity;
