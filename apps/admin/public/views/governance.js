/**
 * Votes and announcements.
 *
 * Weight follows shares. Financial records are reversed rather than deleted,
 * and the page says so where it matters.
 */

import { state } from '../lib/state.js';
import { date, esc, html, pct } from '../lib/format.js';
import { api } from '../lib/api.js';
import { flash, head, page, row } from '../lib/ui.js';

export function renderGovernance(target) {
  return page(target, async () => {
    const [{ proposals }, { announcements }] = await Promise.all([
      api('/proposals'),
      api('/announcements'),
    ]);

    state.notifications.openProposals = proposals.filter((proposal) => proposal.status === 'open').length;

    return (
      head(
        'Votes',
        'Any member can propose that a record be removed, but nobody removes one alone. Financial records are never deleted — a vote against a ledger entry reverses it and leaves the original visible.',
      ) +
      html`
        <div class="card">
          <div class="card-title">Proposals</div>
          <p class="card-note">
            A proposal carries when enough of the circle turns out (${pct(state.config?.governance.quorumRatio ?? 0.5, 0)}
            of voting weight) and enough of those who voted are in favour
            (${pct(state.config?.governance.passThresholdRatio ?? 2 / 3, 0)}). Weight follows shares.
          </p>

          ${proposals.length === 0 ? '<div class="empty">No proposals.</div>' : ''}

          ${proposals
            .map((proposal) => {
              const tally = proposal.tally;
              const total = Math.max(1, tally.eligibleWeight);
              const canVote = proposal.status === 'open';

              return html`
                <div style="padding:14px 0;border-top:1px solid var(--border)">
                  <div class="page-head" style="margin-bottom:6px">
                    <div>
                      <strong>Remove ${esc(proposal.entityType.replace(/_/g, ' '))}</strong>
                      <span class="mono">${esc(proposal.entityId)}</span>
                      ${proposal.kind === 'void_financial_record'
                        ? '<span class="pill pill-info">reverses, does not delete</span>'
                        : ''}
                      <div class="muted" style="font-size:13px;margin-top:3px">${esc(proposal.reason)}</div>
                      <div class="faint" style="font-size:12px;margin-top:2px">
                        Proposed by ${esc(proposal.proposedByName)} on ${date(proposal.openedOn)} ·
                        closes ${date(proposal.closesOn)}
                      </div>
                    </div>
                    <span
                      class="pill pill-${proposal.status === 'executed'
                        ? 'positive'
                        : proposal.status === 'open'
                          ? 'warning'
                          : 'neutral'}"
                      >${esc(proposal.status)}</span
                    >
                  </div>

                  <div class="vote-bar">
                    <div class="vote-for" style="width:${(tally.forWeight / total) * 100}%"></div>
                    <div class="vote-against" style="width:${(tally.againstWeight / total) * 100}%"></div>
                    <div class="vote-abstain" style="width:${(tally.abstainWeight / total) * 100}%"></div>
                  </div>

                  <div class="faint" style="font-size:12.5px">${esc(proposal.headline)}</div>
                  <div class="muted" style="font-size:12.5px;margin-top:2px">
                    ${tally.forWeight.toLocaleString()} for ·
                    ${tally.againstWeight.toLocaleString()} against ·
                    ${tally.abstainWeight.toLocaleString()} abstaining ·
                    turnout ${pct(tally.turnout, 0)} of ${tally.eligibleWeight.toLocaleString()} shares
                  </div>

                  ${canVote
                    ? html`
                        <div class="btn-row" style="margin-top:10px">
                          <button class="btn btn-sm btn-primary" data-vote="for" data-proposal="${esc(proposal.id)}">
                            In favour
                          </button>
                          <button class="btn btn-sm btn-danger" data-vote="against" data-proposal="${esc(proposal.id)}">
                            Against
                          </button>
                          <button class="btn btn-sm" data-vote="abstain" data-proposal="${esc(proposal.id)}">
                            Abstain
                          </button>
                        </div>
                      `
                    : ''}
                </div>
              `;
            })
            .join('')}
        </div>

        <div class="card">
          <div class="card-title">Announcements</div>
          <p class="card-note">
            Notices to the circle. These are ordinary records, so a vote can remove one outright.
          </p>
          ${announcements.length === 0 ? '<div class="empty">Nothing posted.</div>' : ''}
          ${announcements
            .map(
              (announcement) => html`
                <div style="padding:12px 0;border-top:1px solid var(--border)">
                  <div class="page-head" style="margin-bottom:4px">
                    <div>
                      <strong>${esc(announcement.title)}</strong>
                      <div class="muted" style="font-size:13px">${esc(announcement.body)}</div>
                      <div class="faint" style="font-size:12px;margin-top:3px">
                        ${esc(announcement.postedByName)} · ${date(announcement.postedOn)}
                      </div>
                    </div>
                    <button class="btn btn-sm btn-danger" data-propose="${esc(announcement.id)}">
                      Propose removal
                    </button>
                  </div>
                </div>
              `,
            )
            .join('')}
        </div>
      `
    );
  }).then(() => {
    target.querySelectorAll('[data-vote]').forEach((element) => {
      element.addEventListener('click', async () => {
        try {
          const result = await api(`/proposals/${encodeURIComponent(element.dataset.proposal)}/votes`, {
            method: 'POST',
            body: { choice: element.dataset.vote },
          });
          flash(
            result.outcome === 'delete'
              ? 'Your vote carried the proposal — the record has been removed.'
              : result.outcome === 'void'
                ? 'Your vote carried the proposal — the entry has been reversed and marked void.'
                : `Vote recorded (${result.vote.weight.toLocaleString()} shares).`,
          );
          renderGovernance(target);
        } catch (error) {
          flash(error.message, 'error');
        }
      });
    });

    target.querySelectorAll('[data-propose]').forEach((element) => {
      element.addEventListener('click', async () => {
        const reason = prompt('Why should this be removed? (at least 10 characters)', '');
        if (!reason) return;
        try {
          await api('/proposals', {
            method: 'POST',
            body: { entityType: 'announcement', entityId: element.dataset.propose, reason },
          });
          flash('Proposal opened. The circle has been notified and can now vote.');
          renderGovernance(target);
        } catch (error) {
          flash(error.message, 'error');
        }
      });
    });
  });
}
