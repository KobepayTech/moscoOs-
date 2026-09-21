/**
 * The register.
 *
 * Every member, their shares, and what they have pledged on behalf of others.
 */

import { esc, html, money, pct } from '../lib/format.js';
import { api } from '../lib/api.js';
import { go } from '../lib/router.js';
import { head, page, stat } from '../lib/ui.js';

export function renderMembers(target) {
  return page(target, async () => {
    const data = await api('/members');
    const { register, members } = data;

    return (
      head(
        'Members',
        `${register.memberCount} members holding ${register.issued.toLocaleString()} of ${register.authorized.toLocaleString()} authorised shares. Open anyone to read their statement.`,
      ) +
      html`
        <div class="grid" style="margin-bottom:16px">
          ${stat('Issued shares', register.issued.toLocaleString(), `${money(register.parValue)} each`)}
          ${stat('Share capital', money(register.issuedCapital, { compact: true }), 'Paid up by members')}
          ${stat('Unissued', register.unissued.toLocaleString(), 'Room for new members')}
          ${stat('Largest holding', pct(register.largestHoldingRatio), 'Concentration check')}
        </div>

        <div class="card">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  <th class="num">Shares</th>
                  <th class="num">Value</th>
                  <th class="num">Stake</th>
                  <th>Standing</th>
                </tr>
              </thead>
              <tbody>
                ${members
                  .map(
                    (member) => html`
                      <tr class="clickable" data-member="${esc(member.id)}">
                        <td>
                          <div>${esc(member.fullName)}</div>
                          <div class="mono">${esc(member.phone)}</div>
                        </td>
                        <td>
                          ${member.role === 'member'
                            ? '<span class="muted">member</span>'
                            : `<span class="pill pill-accent">${esc(member.role)}</span>`}
                        </td>
                        <td class="num">${member.shares.toLocaleString()}</td>
                        <td class="num">${money(member.shareValue)}</td>
                        <td class="num">${pct(member.ownershipRatio, 2)}</td>
                        <td>
                          ${member.fullyPaid
                            ? '<span class="pill pill-positive">fully paid</span>'
                            : '<span class="pill pill-warning">subscription incomplete</span>'}
                          ${member.status !== 'active'
                            ? `<span class="pill pill-danger">${esc(member.status)}</span>`
                            : ''}
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
  }).then(() => {
    target.querySelectorAll('[data-member]').forEach((element) => {
      element.addEventListener('click', () => go('member', element.dataset.member));
    });
  });
}
