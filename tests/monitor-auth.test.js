'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('crypto');
const { AccessJwtVerifier, BrowserAuth } = require('../monitor-web/auth');

function accessFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  Object.assign(jwk, { kid: 'key-1', alg: 'RS256', use: 'sig' });
  const now = Date.parse('2026-08-29T16:00:00.000Z');
  const token = overrides => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key-1' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: 'https://team.cloudflareaccess.com', aud: ['human-aud'],
      email: 'operator@example.com', exp: Math.floor(now / 1000) + 300,
      ...overrides
    })).toString('base64url');
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    return `${header}.${payload}.${signature}`;
  };
  const verifier = new AccessJwtVerifier({
    teamDomain: 'https://team.cloudflareaccess.com', audience: 'human-aud', now: () => now,
    fetch: async () => ({ ok: true, json: async () => ({ keys: [jwk] }) })
  });
  return { now, token, verifier };
}

test('Cloudflare Access verifier checks signature, issuer, audience, and expiry', async () => {
  const fixture = accessFixture();
  const auth = await fixture.verifier.verify(fixture.token());
  assert.equal(auth.identity, 'operator@example.com');
  await assert.rejects(fixture.verifier.verify(fixture.token({ aud: ['wrong'] })), /audience/);
  await assert.rejects(fixture.verifier.verify(fixture.token({ iss: 'https://attacker.invalid' })), /issuer/);
  await assert.rejects(fixture.verifier.verify(fixture.token({ exp: Math.floor(fixture.now / 1000) - 1 })), /expired/);
  const parts = fixture.token().split('.');
  parts[2] = Buffer.alloc(256).toString('base64url');
  await assert.rejects(fixture.verifier.verify(parts.join('.')), /signature/);
});

test('fallback browser login requires high entropy and rate-limits failures', () => {
  assert.throws(() => new BrowserAuth({ password: 'short', secureCookies: false }), /at least 32/);
  const auth = new BrowserAuth({ password: 'this-is-a-high-entropy-test-password', secureCookies: false });
  for (let index = 0; index < 5; index += 1) assert.throws(() => auth.login('wrong', '127.0.0.1'), /Invalid/);
  assert.throws(() => auth.login('wrong', '127.0.0.1'), /Too many/);
  const session = auth.login('this-is-a-high-entropy-test-password', '127.0.0.2');
  assert.match(session.cookie, /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(session.cookie, /Secure/);
});
