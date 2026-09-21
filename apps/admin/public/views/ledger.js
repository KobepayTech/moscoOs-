/**
 * The books.
 *
 * Append-only and open to every member. Reversals sit next to the entries
 * they correct; nothing is ever removed.
 */

import { date, esc, html, money } from '../lib/format.js';
import { api } from '../lib/api.js';
import { head, page, stat } from '../lib/ui.js';

export function renderLedger(target) {
  return page(target, async () => {
    const data = await api('/ledger');
    const entries = data.entries.slice().reverse().slice(0, 200);

    return (
      head(
        'Ledger',
        'Every movement of money, open to every member. Nothing here is ever deleted — a mistake is corrected by posting a reversal, and the original stays visible.',
      ) +
      html`
        <div class="grid" style="margin-bottom:16px">
          ${stat('Total assets', money(data.position.totalAssets, { compact: true }), '')}
          ${stat('Liabilities', money(data.position.totalLiabilities, { compact: true }), 'Owed to investors and savers')}
          ${stat('Members’ equity', money(data.position.totalEquity, { compact: true }), 'Share capital plus retained surplus')}
          ${stat(
            'Balance check',
            data.trialBalance.balanced ? '<span class="pill pill-positive">balanced</span>' : '<span class="pill pill-danger">out</span>',
            data.trialBalance.balanced ? 'Debits equal credits' : `Out by ${money(data.trialBalance.difference)}`,
          )}
        </div>

        <div class="card">
          <div class="card-title">Recent entries</div>
          <p class="card-note">Showing the most recent ${entries.length} of ${data.entries.length}.</p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Entry</th>
                  <th class="num">Amount</th>
                  <th>Reference</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${entries
                  .map(
                    (entry) => html`
                      <tr style="${entry.voided ? 'opacity:0.62' : ''}">
                        <td class="muted">${date(entry.date)}</td>
                        <td>
                          ${esc(entry.narration)}
                          <div class="mono">${esc(entry.id)}</div>
                        </td>
                        <td class="num">${money(entry.amount)}</td>
                        <td class="mono">${esc(entry.reference ?? '—')}</td>
                        <td>
                          ${entry.voided ? '<span class="pill pill-danger">voided</span>' : ''}
                          ${entry.reversalOf ? '<span class="pill pill-info">reversal</span>' : ''}
                        </td>
                      </tr>
                    `,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      `
    );
  });
}
