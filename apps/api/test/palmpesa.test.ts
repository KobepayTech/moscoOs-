/**
 * The PalmPesa adapter, against the contract KobeOS runs in production.
 *
 * The rail itself is stood up as a local HTTP server speaking exactly what
 * `server/src/creators/palmpesa.service.ts` in KobeOS expects and returns, so
 * these tests fail if the request shape drifts — which is the only way to know
 * an integration still matches, short of charging somebody real money.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';

import {
  PalmPesaProvider,
  ProviderCannotError,
  ProviderNotConfiguredError,
  normalisePhone,
} from '../src/providers.js';

const SECRET = 'test-webhook-secret-0123456789';

/** Every request the fake rail received, so the shape can be asserted. */
let received: { path: string; auth: string | undefined; body: Record<string, any> }[] = [];
let rail: Server;
let railBase: string;

/** What the fake rail should answer with next. */
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

before(async () => {
  rail = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({
        path: req.url ?? '',
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : {},
      });
      res.writeHead(nextResponse.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(nextResponse.body));
    });
  });

  await new Promise<void>((resolve) => rail.listen(0, resolve));
  railBase = `http://127.0.0.1:${(rail.address() as AddressInfo).port}`;

  process.env.PALMPESA_BASE_URL = railBase;
  process.env.PALMPESA_API_TOKEN = 'test-token';
  process.env.MOSCOOS_WEBHOOK_SECRET = SECRET;
  process.env.MOSCOOS_PUBLIC_URL = 'https://circles.example.org';
});

after(async () => {
  await new Promise<void>((resolve) => rail.close(() => resolve()));
  delete process.env.PALMPESA_BASE_URL;
  delete process.env.PALMPESA_API_TOKEN;
  delete process.env.MOSCOOS_WEBHOOK_SECRET;
  delete process.env.MOSCOOS_PUBLIC_URL;
});

function provider() {
  return new PalmPesaProvider();
}

function sign(body: string): string {
  return createHmac('sha256', `${SECRET}:palmpesa`).update(body).digest('hex');
}

describe('initiating a USSD push', () => {
  it('sends exactly what the rail expects', async () => {
    received = [];
    nextResponse = { status: 200, body: { message: 'Request accepted', order_id: 'ORD-9911' } };

    const result = await provider().initiate({
      intentId: 'pay_abc123',
      reference: 'pay_abc123',
      grossAmount: 50_000,
      currency: 'TZS',
      payerPhone: '0712345678',
      payerName: 'Elia Swai',
      payerEmail: 'elia@example.org',
      narrative: 'Loan application fee',
    });

    assert.equal(result.providerRef, 'ORD-9911');
    assert.equal(result.status, 'initiated');

    const sent = received[0];
    assert.equal(sent.path, '/api/palmpesa/initiate');
    assert.equal(sent.auth, 'Bearer test-token', 'the token goes in the Authorization header');

    assert.deepEqual(sent.body, {
      name: 'Elia Swai',
      email: 'elia@example.org',
      phone: '255712345678',
      amount: 50_000,
      transaction_id: 'pay_abc123',
      address: 'Tanzania',
      postcode: '00000',
      callback_url: 'https://circles.example.org/webhooks/palmpesa',
    });
  });

  it('sends the intent id as the transaction id, so the callback needs no lookup', async () => {
    received = [];
    nextResponse = { status: 200, body: { message: 'ok', order_id: 'ORD-2' } };

    await provider().initiate({
      intentId: 'pay_xyz',
      reference: 'pay_xyz',
      grossAmount: 5_000,
      currency: 'TZS',
      payerPhone: '+255712345678',
      narrative: 'Subscription',
    });

    assert.equal(received[0].body.transaction_id, 'pay_xyz');
  });

  it('surfaces a rail error rather than pretending the push went out', async () => {
    received = [];
    nextResponse = { status: 502, body: { message: 'upstream down' } };

    await assert.rejects(
      () =>
        provider().initiate({
          intentId: 'pay_1',
          reference: 'pay_1',
          grossAmount: 1_000,
          currency: 'TZS',
          payerPhone: '0712345678',
          narrative: 'x',
        }),
      /returned 502/,
    );
  });

  it('refuses to call the rail with no token', async () => {
    const token = process.env.PALMPESA_API_TOKEN;
    delete process.env.PALMPESA_API_TOKEN;

    try {
      await assert.rejects(
        () =>
          provider().initiate({
            intentId: 'pay_1',
            reference: 'pay_1',
            grossAmount: 1_000,
            currency: 'TZS',
            payerPhone: '0712345678',
            narrative: 'x',
          }),
        ProviderNotConfiguredError,
      );
    } finally {
      process.env.PALMPESA_API_TOKEN = token;
    }
  });
});

describe('phone numbers, however members write them', () => {
  it('normalises every form to the 255 the rail wants', () => {
    assert.equal(normalisePhone('0712345678'), '255712345678');
    assert.equal(normalisePhone('+255712345678'), '255712345678');
    assert.equal(normalisePhone('255712345678'), '255712345678');
    assert.equal(normalisePhone('712345678'), '255712345678');
    assert.equal(normalisePhone('655 123 456'), '255655123456');
    assert.equal(normalisePhone('+255 712-345-678'), '255712345678');
  });
});

describe('order status', () => {
  it('reads the first row the way the rail returns it', async () => {
    received = [];
    nextResponse = {
      status: 200,
      body: {
        reference: 'pay_abc123',
        resultcode: '000',
        result: 'SUCCESS',
        message: 'Order found',
        data: [
          {
            order_id: 'ORD-9911',
            creation_date: '2026-09-22 10:14:02',
            amount: '50000',
            payment_status: 'COMPLETED',
            transid: 'MPESA-XYZ-1',
            channel: 'MPESA',
            reference: 'pay_abc123',
            msisdn: '255712345678',
          },
        ],
      },
    };

    const result = await provider().orderStatus('ORD-9911');

    assert.equal(received[0].path, '/api/order-status');
    assert.deepEqual(received[0].body, { order_id: 'ORD-9911' });

    assert.equal(result!.status, 'confirmed');
    assert.equal(result!.grossAmount, 50_000, 'the rail sends amounts as strings');
    assert.equal(result!.railReceipt, 'MPESA-XYZ-1');
    assert.equal(result!.channel, 'MPESA');
  });

  it('returns nothing for an order the rail does not know', async () => {
    nextResponse = { status: 200, body: { reference: '', resultcode: '404', result: '', message: 'none', data: [] } };
    assert.equal(await provider().orderStatus('ORD-nope'), null);
  });
});

describe('callback signatures', () => {
  const body = JSON.stringify({ order_id: 'ORD-1', payment_status: 'COMPLETED', reference: 'pay_1' });

  it('accepts a correctly signed body', () => {
    assert.equal(provider().verifyCallback(body, sign(body)), true);
  });

  it('accepts the sha256= prefix some senders add', () => {
    assert.equal(provider().verifyCallback(body, `sha256=${sign(body)}`), true);
  });

  it('refuses a body that was altered after signing', () => {
    const tampered = JSON.stringify({ order_id: 'ORD-1', payment_status: 'COMPLETED', reference: 'pay_2' });
    assert.equal(provider().verifyCallback(tampered, sign(body)), false);
  });

  it('refuses a signature made with another provider’s key', () => {
    // The key is `${secret}:${provider}`, so a valid mpesa signature must not
    // pass as a palmpesa one.
    const wrongScope = createHmac('sha256', `${SECRET}:mpesa`).update(body).digest('hex');
    assert.equal(provider().verifyCallback(body, wrongScope), false);
  });

  it('refuses an unsigned callback', () => {
    assert.equal(provider().verifyCallback(body, undefined), false);
    assert.equal(provider().verifyCallback(body, ''), false);
  });

  it('refuses everything when no secret is configured', () => {
    const secret = process.env.MOSCOOS_WEBHOOK_SECRET;
    const shared = process.env.WEBHOOK_SECRET;
    delete process.env.MOSCOOS_WEBHOOK_SECRET;
    delete process.env.WEBHOOK_SECRET;

    try {
      // KobeOS falls back to a literal 'default-secret' here, which makes an
      // unconfigured deployment forgeable by anyone who has read the source.
      const forged = createHmac('sha256', 'default-secret:palmpesa').update(body).digest('hex');
      assert.equal(provider().verifyCallback(body, forged), false);
      assert.equal(provider().configured, false);
    } finally {
      if (secret) process.env.MOSCOOS_WEBHOOK_SECRET = secret;
      if (shared) process.env.WEBHOOK_SECRET = shared;
    }
  });
});

describe('reading a callback', () => {
  it('takes the reference as the correlation key', () => {
    const result = provider().parseCallback({
      order_id: 'ORD-9911',
      payment_status: 'COMPLETED',
      reference: 'pay_abc123',
    });

    assert.equal(result.providerRef, 'pay_abc123', 'ours, not the rail’s');
    assert.equal(result.status, 'confirmed');
  });

  it('falls back to the order id when the callback carries only that', () => {
    const result = provider().parseCallback({ order_id: 'ORD-9911', payment_status: 'COMPLETED' });
    assert.equal(result.providerRef, 'ORD-9911');
  });

  it('enriches from the data row when one is present', () => {
    const result = provider().parseCallback({
      order_id: 'ORD-9911',
      payment_status: 'COMPLETED',
      reference: 'pay_abc123',
      data: [
        {
          order_id: 'ORD-9911',
          creation_date: '2026-09-22 10:14:02',
          amount: '50000',
          payment_status: 'COMPLETED',
          transid: 'MPESA-XYZ-1',
          channel: 'MPESA',
          reference: 'pay_abc123',
          msisdn: '255712345678',
        },
      ],
    });

    assert.equal(result.grossAmount, 50_000);
    assert.equal(result.railReceipt, 'MPESA-XYZ-1');
    assert.equal(result.channel, 'MPESA');
  });

  it('treats PENDING as pending, never as paid', () => {
    // The member has been sent the prompt and has not answered it. Reading
    // that as payment would credit a fee nobody has paid.
    assert.equal(provider().parseCallback({ reference: 'pay_1', payment_status: 'PENDING' }).status, 'pending');
  });

  it('treats FAILED as failed, and anything unrecognised likewise', () => {
    assert.equal(provider().parseCallback({ reference: 'pay_1', payment_status: 'FAILED' }).status, 'failed');
    assert.equal(provider().parseCallback({ reference: 'pay_1', payment_status: 'WHAT' }).status, 'failed');
    assert.equal(provider().parseCallback({ reference: 'pay_1' }).status, 'failed');
  });

  it('refuses a callback it cannot identify rather than guessing', () => {
    // One PalmPesa account serves several products; acting on somebody else's
    // callback would credit the wrong book.
    assert.throws(() => provider().parseCallback({ payment_status: 'COMPLETED' }), /neither a reference nor an order id/);
  });
});

describe('what the rail cannot do', () => {
  it('says plainly that it cannot reverse a collection', async () => {
    await assert.rejects(
      () => provider().refund({ intentId: 'pay_1', providerRef: 'ORD-1', amount: 47_500, reason: 'loan withdrawn' }),
      (error: Error) => {
        assert.ok(error instanceof ProviderCannotError);
        // Distinct from "not configured": one means wait, the other means act.
        assert.ok(!(error instanceof ProviderNotConfiguredError));
        assert.match(error.message, /record it as a manual refund/);
        return true;
      },
    );
  });

  it('declares it up front rather than at the moment of need', () => {
    assert.equal(provider().supportsRefund, false);
  });
});
