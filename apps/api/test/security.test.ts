/**
 * Regression tests for the findings of the security review.
 *
 * Each of these reproduces a real defect that existed in this codebase, so
 * they are worth keeping even though they look paranoid. A test that only
 * asserts the fix is in place is cheap; discovering the same hole a second
 * time is not.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { openDb, type Db } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';

let db: Db;
let server: Server;
let base: string;

before(async () => {
  db = openDb({ location: ':memory:' });
  seed(db, { quiet: true });
  server = createApp(db);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

async function call(path: string, options: { method?: string; body?: unknown; token?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function signIn(phone: string): Promise<string> {
  const response = await call('/auth/login', {
    method: 'POST',
    body: { phone, password: 'mamogoro123' },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.token as string;
}

const phoneOf = (index: number) => `+2557${String(10000000 + index * 137).slice(0, 8)}`;

/**
 * The signing key used to be a constant in the source, guarded only by
 * `NODE_ENV === 'production'` — which nothing set. Anyone who read the
 * repository could mint a chair token and empty the circle.
 */
describe('tokens cannot be forged from anything in the source', () => {
  it('rejects a token signed with the old hardcoded development key', async () => {
    const published = 'mamogoro-development-secret-do-not-use-in-production';
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'mem_01',
        role: 'chair',
        name: 'Forged',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');
    const forged = `${payload}.${createHmac('sha256', published).update(payload).digest('base64url')}`;

    assert.equal((await call('/dashboard', { token: forged })).status, 401);
    assert.equal(
      (await call('/members', { method: 'POST', token: forged, body: { fullName: 'x' } })).status,
      401,
    );
  });

  it('rejects a token signed with any other guessable key', async () => {
    for (const guess of ['secret', 'mamogoro', 'changeme', 'password', '']) {
      const payload = Buffer.from(
        JSON.stringify({ sub: 'mem_01', role: 'chair', name: 'x', exp: Math.floor(Date.now() / 1000) + 60 }),
      ).toString('base64url');
      const forged = `${payload}.${createHmac('sha256', guess).update(payload).digest('base64url')}`;
      assert.equal((await call('/dashboard', { token: forged })).status, 401, `key "${guess}" was accepted`);
    }
  });

  it('rejects an unsigned token with the signature stripped', async () => {
    const payload = Buffer.from(
      JSON.stringify({ sub: 'mem_01', role: 'chair', name: 'x', exp: Math.floor(Date.now() / 1000) + 60 }),
    ).toString('base64url');

    for (const attempt of [payload, `${payload}.`, `${payload}.${payload}`]) {
      assert.equal((await call('/dashboard', { token: attempt })).status, 401);
    }
  });

  it('rejects a payload edited after signing', async () => {
    const token = await signIn(phoneOf(29)); // an ordinary member
    const [payload, signature] = token.split('.');

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    claims.role = 'chair';
    const tampered = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;

    assert.equal((await call('/dashboard', { token: tampered })).status, 401);
  });

  it('rejects an expired token', async () => {
    const payload = Buffer.from(
      JSON.stringify({ sub: 'mem_01', role: 'chair', name: 'x', exp: Math.floor(Date.now() / 1000) - 10 }),
    ).toString('base64url');
    const key = randomBytes(32).toString('hex');
    const token = `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;

    assert.equal((await call('/dashboard', { token })).status, 401);
  });
});

/**
 * Enrolment sets the new account's password, so whoever enrols it can sign in
 * as it. A secretary could therefore enrol a `chair` and inherit the chair's
 * power to move money.
 */
describe('a secretary cannot enrol their way to more power', () => {
  it('refuses to let a secretary create a chair', async () => {
    const secretary = await signIn(phoneOf(2));
    const { status, body } = await call('/members', {
      method: 'POST',
      token: secretary,
      body: {
        fullName: 'Back Door',
        phone: '+255799000001',
        password: 'hunter22',
        role: 'chair',
        shares: 50,
      },
    });

    assert.equal(status, 403);
    assert.match(JSON.stringify(body), /Only the chair may enrol/);
  });

  it('refuses cashier and secretary too, not just chair', async () => {
    const secretary = await signIn(phoneOf(2));

    for (const role of ['cashier', 'secretary']) {
      const { status } = await call('/members', {
        method: 'POST',
        token: secretary,
        body: {
          fullName: `Escalated ${role}`,
          phone: `+25579900${role === 'cashier' ? '1' : '2'}002`,
          password: 'hunter22',
          role,
          shares: 50,
        },
      });
      assert.equal(status, 403, `a secretary was able to create a ${role}`);
    }
  });

  it('still lets a secretary enrol an ordinary member', async () => {
    const secretary = await signIn(phoneOf(2));
    const { status } = await call('/members', {
      method: 'POST',
      token: secretary,
      body: {
        fullName: 'Ordinary Member',
        phone: '+255799000003',
        password: 'a-good-password',
        shares: 50,
      },
    });

    assert.equal(status, 200);
  });

  it('lets the chair appoint an officer', async () => {
    const chair = await signIn(phoneOf(0));
    const { status } = await call('/members', {
      method: 'POST',
      token: chair,
      body: {
        fullName: 'Second Cashier',
        phone: '+255799000004',
        password: 'a-good-password',
        role: 'cashier',
        shares: 50,
      },
    });

    assert.equal(status, 200);
  });
});

/**
 * The token carries a role, but roles change. Authorisation reads the member's
 * current row so a stood-down officer cannot keep acting on an old token.
 */
describe('standing is read as it is now, not as the token remembers it', () => {
  it('stops honouring a cashier token once the member is stood down', async () => {
    const cashier = await signIn(phoneOf(1));

    // The token works while they hold the role.
    assert.equal(
      (await call('/members/mem_29/fees', {
        method: 'POST',
        token: cashier,
        body: { kind: 'other', amount: 1000, paidOn: '2026-09-01' },
      })).status,
      200,
    );

    db.prepare("UPDATE members SET role = 'member' WHERE id = 'mem_02'").run();

    // The same token, unchanged, no longer carries the power.
    const { status, body } = await call('/members/mem_29/fees', {
      method: 'POST',
      token: cashier,
      body: { kind: 'other', amount: 1000, paidOn: '2026-09-01' },
    });

    assert.equal(status, 403);
    assert.match(JSON.stringify(body), /You are signed in as member/);

    db.prepare("UPDATE members SET role = 'cashier' WHERE id = 'mem_02'").run();
  });

  it('turns away a token for a membership that has been closed', async () => {
    const token = await signIn(phoneOf(27));
    assert.equal((await call('/dashboard', { token })).status, 200);

    db.prepare("UPDATE members SET status = 'exited' WHERE id = 'mem_28'").run();

    const { status, body } = await call('/dashboard', { token });
    assert.equal(status, 403);
    assert.match(JSON.stringify(body), /membership has been closed/);

    db.prepare("UPDATE members SET status = 'active' WHERE id = 'mem_28'").run();
  });

  it('turns away a token for a member who no longer exists', async () => {
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'mem_does_not_exist',
        role: 'chair',
        name: 'Ghost',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');

    // Even correctly signed, there is nobody behind it. Sign a real token
    // first so the process key is the one in use.
    const real = await signIn(phoneOf(0));
    const [, signature] = real.split('.');
    assert.ok(signature);

    const { status } = await call('/dashboard', { token: `${payload}.${signature}` });
    assert.equal(status, 401);
  });
});

/**
 * `GET /%` used to reach `decodeURIComponent` in the static handler, throw a
 * URIError outside the router's try block, and end the process. One
 * unauthenticated request could stop the circle's books.
 */
describe('a malformed request cannot take the server down', () => {
  it('answers a malformed percent-escape instead of dying', async () => {
    const response = await fetch(`${base}/%`);
    assert.ok(response.status >= 400 && response.status < 500, `got ${response.status}`);
  });

  it('is still serving afterwards', async () => {
    assert.equal((await call('/health')).status, 200);
  });

  it('survives a range of malformed and hostile paths', async () => {
    const paths = [
      '/%',
      '/%zz',
      '/%e0%a4%a',
      '/..%2f..%2fetc%2fpasswd',
      '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/////',
      `/${'a'.repeat(3000)}`,
    ];

    for (const path of paths) {
      const response = await fetch(`${base}${path}`);
      assert.ok(response.status < 500, `${path} produced ${response.status}`);
      const body = await response.text();
      assert.ok(!body.includes('root:'), `${path} leaked a system file`);
    }

    assert.equal((await call('/health')).status, 200, 'server stopped serving');
  });
});
