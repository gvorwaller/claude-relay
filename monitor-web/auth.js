'use strict';

const { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } = require('crypto');

function decodeJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

class AccessJwtVerifier {
  constructor(options = {}) {
    this.teamDomain = String(options.teamDomain || '').replace(/\/$/, '');
    this.audience = options.audience || '';
    this.fetch = options.fetch || globalThis.fetch;
    this.now = options.now || (() => Date.now());
    this.keys = null;
    this.keysExpiresAt = 0;
  }

  configured() {
    return Boolean(this.teamDomain && this.audience);
  }

  async signingKeys() {
    if (this.keys && this.now() < this.keysExpiresAt) return this.keys;
    const response = await this.fetch(`${this.teamDomain}/cdn-cgi/access/certs`, {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error('Cloudflare Access signing keys are unavailable');
    const body = await response.json();
    if (!Array.isArray(body.keys)) throw new Error('Cloudflare Access signing keys are invalid');
    this.keys = new Map(body.keys.map(key => [key.kid, createPublicKey({ key, format: 'jwk' })]));
    this.keysExpiresAt = this.now() + 60 * 60 * 1000;
    return this.keys;
  }

  async verify(token) {
    if (!this.configured() || typeof token !== 'string') throw new Error('Cloudflare Access token is required');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Cloudflare Access token is malformed');
    let header;
    let payload;
    try {
      header = decodeJson(parts[0]);
      payload = decodeJson(parts[1]);
    } catch {
      throw new Error('Cloudflare Access token is malformed');
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Cloudflare Access token algorithm is invalid');
    const keys = await this.signingKeys();
    const key = keys.get(header.kid);
    if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) {
      throw new Error('Cloudflare Access token signature is invalid');
    }
    const now = Math.floor(this.now() / 1000);
    if (!Number.isFinite(payload.exp) || payload.exp <= now) throw new Error('Cloudflare Access token is expired');
    if (Number.isFinite(payload.nbf) && payload.nbf > now + 30) throw new Error('Cloudflare Access token is not active');
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(this.audience)) throw new Error('Cloudflare Access token audience is invalid');
    if (payload.iss !== this.teamDomain) throw new Error('Cloudflare Access token issuer is invalid');
    return {
      kind: 'cloudflare',
      identity: String(payload.email || payload.common_name || payload.sub || 'operator'),
      claims: payload
    };
  }
}

function parseCookies(header) {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function equalText(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

class BrowserAuth {
  constructor(options = {}) {
    this.password = options.password || '';
    this.secureCookies = options.secureCookies !== false;
    this.now = options.now || (() => Date.now());
    this.sessions = new Map();
    this.attempts = new Map();
    this.sessionTtlMs = options.sessionTtlMs || 12 * 60 * 60 * 1000;
    this.access = options.accessVerifier || new AccessJwtVerifier(options);
    this.csrfSecret = options.csrfSecret || randomBytes(32);
    if (!this.access.configured() && this.password.length < 32) {
      throw new Error('Configure Cloudflare Access or a monitor password of at least 32 characters');
    }
  }

  async authenticate(req) {
    if (this.access.configured()) {
      return this.access.verify(req.headers['cf-access-jwt-assertion']);
    }
    const id = parseCookies(req.headers.cookie).relay_monitor_session;
    const session = id && this.sessions.get(id);
    if (!session || session.expiresAt <= this.now()) {
      if (id) this.sessions.delete(id);
      throw new Error('Authentication required');
    }
    return { kind: 'session', identity: 'operator', sessionId: id, csrf: session.csrf };
  }

  login(password, remoteAddress) {
    if (this.access.configured()) throw new Error('Password login is disabled');
    const key = String(remoteAddress || 'unknown');
    const cutoff = this.now() - 10 * 60 * 1000;
    const attempts = (this.attempts.get(key) || []).filter(at => at >= cutoff);
    if (attempts.length >= 5) throw new Error('Too many login attempts');
    if (!equalText(password, this.password)) {
      attempts.push(this.now());
      this.attempts.set(key, attempts);
      throw new Error('Invalid credential');
    }
    this.attempts.delete(key);
    const id = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    this.sessions.set(id, { csrf, expiresAt: this.now() + this.sessionTtlMs });
    return {
      id,
      csrf,
      cookie: `relay_monitor_session=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Strict${this.secureCookies ? '; Secure' : ''}; Max-Age=${Math.floor(this.sessionTtlMs / 1000)}`
    };
  }

  csrf(auth) {
    if (auth.kind === 'session') return auth.csrf;
    return createHmac('sha256', this.csrfSecret).update(auth.identity).digest('base64url');
  }

  verifyCsrf(auth, value) {
    return equalText(this.csrf(auth), value);
  }

  logout(auth) {
    if (auth.kind === 'session') this.sessions.delete(auth.sessionId);
    return `relay_monitor_session=; Path=/; HttpOnly; SameSite=Strict${this.secureCookies ? '; Secure' : ''}; Max-Age=0`;
  }
}

module.exports = { AccessJwtVerifier, BrowserAuth, equalText, parseCookies };
