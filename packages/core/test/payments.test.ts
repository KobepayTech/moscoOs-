import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { defaultCircleConfig } from '../src/config.js';
import { formatMoney } from '../src/money.js';
import {
  assessApplicationFee,
  describeFeeSplit,
  PaymentError,
  splitPlatformFee,
  subscriptionAllows,
  subscriptionStatus,
} from '../src/payments.js';

const config = defaultCircleConfig();

describe('the 50,000 application fee split', () => {
  it('keeps 5% for the rail and remits the rest to the circle', () => {
    const split = splitPlatformFee(50_000, 0.05);

    assert.equal(split.gross, 50_000);
    assert.equal(split.processingFee, 2_500);
    assert.equal(split.net, 47_500);
  });

  it('is what the founding configuration asks for', () => {
    assert.equal(config.applicationFee.amount, 50_000);
    assert.equal(config.applicationFee.processingFeeRate, 0.05);

    const split = splitPlatformFee(config.applicationFee.amount, config.applicationFee.processingFeeRate);
    assert.equal(split.net, 47_500);
  });

  it('always reconciles: gross is the fee plus the net, exactly', () => {
    // Amounts chosen to land awkwardly on the rounding.
    for (const gross of [1, 7, 33, 999, 1_001, 12_345, 50_000, 999_999, 1_234_567]) {
      for (const rate of [0, 0.005, 0.015, 0.05, 0.075, 0.1, 0.333]) {
        const split = splitPlatformFee(gross, rate);
        assert.equal(
          split.processingFee + split.net,
          gross,
          `${gross} at ${rate} split to ${split.processingFee} + ${split.net}`,
        );
        assert.ok(split.net >= 0);
        assert.ok(split.processingFee >= 0);
      }
    }
  });

  it('passes the whole amount through when the rail charges nothing', () => {
    const split = splitPlatformFee(50_000, 0);
    assert.equal(split.processingFee, 0);
    assert.equal(split.net, 50_000);
  });

  it('refuses a rate that would leave the circle with nothing', () => {
    assert.throws(() => splitPlatformFee(50_000, 1), PaymentError);
    assert.throws(() => splitPlatformFee(50_000, 1.5), PaymentError);
    assert.throws(() => splitPlatformFee(50_000, -0.1), PaymentError);
  });

  it('tells the member exactly what happens to their money', () => {
    const split = splitPlatformFee(50_000, 0.05);
    const text = describeFeeSplit(split, (amount) => formatMoney(amount, 'TZS'));

    assert.match(text, /TSh 50,000/);
    assert.match(text, /TSh 2,500/);
    assert.match(text, /TSh 47,500/);
    // The member must be told the charge is not recoverable before they pay.
    assert.match(text, /not recoverable/);
  });
});

describe('the fee gates the sponsor request, not the application', () => {
  const assess = (state: Parameters<typeof assessApplicationFee>[0]['state']) =>
    assessApplicationFee({
      feeAmount: config.applicationFee.amount,
      processingFeeRate: config.applicationFee.processingFeeRate,
      state,
    });

  it('will not circulate an unpaid application', () => {
    const result = assess('unpaid');
    assert.equal(result.mayCirculate, false);
    assert.equal(result.outstanding, 50_000);
    assert.match(result.reason, /must be paid before/);
  });

  it('will not circulate while the payment is still unconfirmed', () => {
    const result = assess('awaiting_confirmation');
    assert.equal(result.mayCirculate, false);
    assert.equal(result.outstanding, 50_000);
    assert.match(result.reason, /handset/);
  });

  it('circulates once the fee is held', () => {
    const result = assess('held');
    assert.equal(result.mayCirculate, true);
    assert.equal(result.outstanding, 0);
    assert.match(result.reason, /refunded if the loan is not approved/);
  });

  it('still counts as paid once earned', () => {
    const result = assess('earned');
    assert.equal(result.mayCirculate, true);
    assert.equal(result.outstanding, 0);
  });

  it('reports a refunded fee as settled, not owing', () => {
    const result = assess('refunded');
    assert.equal(result.mayCirculate, false);
    assert.equal(result.outstanding, 0);
  });
});

describe('the monthly platform subscription', () => {
  const base = {
    monthlyAmount: config.platform.memberSubscription,
    graceDays: config.platform.subscriptionGraceDays,
  };

  it('counts every month from joining to now', () => {
    const status = subscriptionStatus({
      ...base,
      joinedOn: '2026-01-10',
      paidPeriods: [],
      asOf: '2026-04-20',
    });

    // January, February, March, April.
    assert.equal(status.monthsDue, 4);
    assert.equal(status.monthsPaid, 0);
    assert.equal(status.arrears, 4 * config.platform.memberSubscription);
  });

  it('is current when every month is paid', () => {
    const status = subscriptionStatus({
      ...base,
      joinedOn: '2026-01-10',
      paidPeriods: ['2026-01', '2026-02', '2026-03', '2026-04'],
      asOf: '2026-04-20',
    });

    assert.equal(status.standing, 'current');
    assert.equal(status.monthsMissed, 0);
    assert.equal(status.arrears, 0);
    assert.deepEqual(status.withheld, []);
  });

  it('is current, not lapsed, while only the present month is unpaid', () => {
    const status = subscriptionStatus({
      ...base,
      joinedOn: '2026-01-10',
      paidPeriods: ['2026-01', '2026-02', '2026-03'],
      asOf: '2026-04-20',
    });

    // April is outstanding but is not yet overdue — it is the month in progress.
    assert.equal(status.standing, 'current');
    assert.equal(status.monthsMissed, 1);
  });

  it('gives a grace period before a missed month becomes a lapse', () => {
    const status = subscriptionStatus({
      ...base,
      joinedOn: '2026-01-10',
      paidPeriods: ['2026-01', '2026-02'],
      asOf: '2026-04-03',
    });

    // March was missed, but we are only three days into April.
    assert.equal(status.standing, 'grace');
    assert.ok(status.graceDaysRemaining > 0);
    assert.deepEqual(status.withheld, []);
  });

  it('lapses once the grace period has run out', () => {
    const status = subscriptionStatus({
      ...base,
      joinedOn: '2026-01-10',
      paidPeriods: ['2026-01', '2026-02'],
      asOf: '2026-04-20',
    });

    assert.equal(status.standing, 'lapsed');
    assert.equal(status.graceDaysRemaining, 0);
  });

  /**
   * The line the platform must not cross: a software bill may withhold the
   * features it pays for, but never a member's access to their own money or
   * their standing in their own circle.
   */
  it('withholds borrowing and sponsoring when lapsed — and nothing else', () => {
    const lapsed = subscriptionStatus({
      ...base,
      joinedOn: '2026-01-10',
      paidPeriods: [],
      asOf: '2026-06-20',
    });

    assert.equal(lapsed.standing, 'lapsed');

    assert.equal(subscriptionAllows(lapsed, 'borrow'), false);
    assert.equal(subscriptionAllows(lapsed, 'sponsor'), false);

    // Never withheld, whatever the operator is owed.
    assert.equal(subscriptionAllows(lapsed, 'read'), true, 'a member must always see their own money');
    assert.equal(subscriptionAllows(lapsed, 'repay'), true, 'a member must always be able to repay');
    assert.equal(subscriptionAllows(lapsed, 'vote'), true, 'billing must not disenfranchise a member');
  });

  it('allows everything while current', () => {
    const current = subscriptionStatus({
      ...base,
      joinedOn: '2026-01-10',
      paidPeriods: ['2026-01', '2026-02', '2026-03', '2026-04'],
      asOf: '2026-04-20',
    });

    for (const action of ['borrow', 'sponsor', 'vote', 'repay', 'read'] as const) {
      assert.equal(subscriptionAllows(current, action), true);
    }
  });

  it('owes nothing on the day a member joins', () => {
    const status = subscriptionStatus({
      ...base,
      joinedOn: '2026-04-20',
      paidPeriods: ['2026-04'],
      asOf: '2026-04-20',
    });

    assert.equal(status.monthsDue, 1);
    assert.equal(status.standing, 'current');
    assert.equal(status.arrears, 0);
  });
});
