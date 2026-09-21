/**
 * The rate model.
 *
 * Shows the derivation rather than the answer: what the rate has to cover,
 * what it would have to be at other utilisation levels, and where the circle
 * breaks even.
 */

import { esc, html, money, pct } from '../lib/format.js';
import { api } from '../lib/api.js';
import { head, page, stat } from '../lib/ui.js';

export function renderRateModel(target) {
  return page(target, async () => {
    const data = await api('/rate-model');
    const { model } = data;

    const componentRow = (label, value, note) => html`
      <tr>
        <td>
          ${esc(label)}
          <div class="faint" style="font-size:12px">${esc(note)}</div>
        </td>
        <td class="num">${pct(value, 3)}</td>
        <td class="num muted">${pct(value * 12, 2)}</td>
      </tr>
    `;

    return (
      head(
        'Rate model',
        'The lending rate is not chosen by feel. Every shilling of interest has four calls on it, and the rate is whatever makes them add up.',
      ) +
      html`
        <div class="grid" style="margin-bottom:16px">
          ${stat('Published rate', pct(data.publishedRate, 2), 'per month, on the declining balance')}
          ${stat('Break-even', pct(model.breakEvenMonthlyRate, 2), 'covers costs, funds no growth')}
          ${stat('Required', pct(model.recommendedMonthlyRate, 2), 'to also hit the members’ target')}
          ${stat('Annualised', pct(model.effectiveAnnualRate, 1), `${pct(model.nominalAnnualRate, 0)} nominal`)}
        </div>

        ${data.publishedRateIsSufficient
          ? `<div class="alert alert-ok">The published rate of ${pct(data.publishedRate, 2)} covers the investor, the running costs, expected losses and the members' target return.</div>`
          : `<div class="alert alert-error">The published rate of ${pct(data.publishedRate, 2)} is below the ${pct(model.recommendedMonthlyRate, 2)} the circle needs. At this rate the members' own capital is subsidising the lending.</div>`}

        <div class="card">
          <div class="card-title">What the rate pays for</div>
          <p class="card-note">${esc(data.explanation)}</p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Component</th>
                  <th class="num">Monthly</th>
                  <th class="num">Annualised</th>
                </tr>
              </thead>
              <tbody>
                ${componentRow(
                  'Cost of external capital',
                  model.components.costOfExternalCapital,
                  `${money(model.facilityUtilised, { compact: true })} of facility at work, at ${pct(model.inputs.investorMonthlyRate, 2)}`,
                )}
                ${componentRow('Running costs', model.components.operatingCost, `${money(model.inputs.monthlyOperatingCost)} a month`)}
                ${componentRow('Expected losses', model.components.expectedCreditLoss, `${pct(model.inputs.annualExpectedCreditLoss)} of the portfolio a year`)}
                ${componentRow('Members’ target return', model.components.equityGrowthTarget, `${pct(model.inputs.targetAnnualReturnOnEquity)} a year on share capital`)}
                <tr>
                  <td><strong>Required rate</strong></td>
                  <td class="num"><strong>${pct(model.recommendedMonthlyRate, 3)}</strong></td>
                  <td class="num muted">${pct(model.recommendedMonthlyRate * 12, 2)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-title">What happens if lending slows down</div>
          <p class="card-note">
            Idle money is the real risk, not the rate. Capital sitting in the account still has to be carried by
            the capital that is working, so the less the circle lends, the more it must charge on what it does
            lend.
            ${data.breakEven.utilisation !== null
              ? `Below ${pct(data.breakEven.utilisation, 0)} utilisation — about ${money(data.breakEven.earningAssets, { compact: true })} on loan — the current rate stops covering costs.`
              : ''}
          </p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="num">Utilisation</th>
                  <th class="num">On loan</th>
                  <th class="num">External capital at work</th>
                  <th class="num">Break-even rate</th>
                  <th class="num">Rate needed</th>
                </tr>
              </thead>
              <tbody>
                ${data.sensitivity
                  .map(
                    (sensitivityRow) => html`
                      <tr
                        style="${Math.abs(sensitivityRow.targetUtilisation - model.inputs.targetUtilisation) < 0.001
                          ? 'background: var(--accent-soft)'
                          : ''}"
                      >
                        <td class="num">${pct(sensitivityRow.targetUtilisation, 0)}</td>
                        <td class="num">${money(sensitivityRow.earningAssets, { compact: true })}</td>
                        <td class="num">${money(sensitivityRow.facilityUtilised, { compact: true })}</td>
                        <td class="num">${pct(sensitivityRow.breakEvenMonthlyRate, 2)}</td>
                        <td class="num"><strong>${pct(sensitivityRow.publishedMonthlyRate, 2)}</strong></td>
                      </tr>
                    `,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-title">What the members' capital does over a year</div>
          <p class="card-note">
            Share capital compounding at the published rate, with monthly contributions added.
          </p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="num">Month</th>
                  <th class="num">Opening</th>
                  <th class="num">Contributions</th>
                  <th class="num">Surplus</th>
                  <th class="num">Closing</th>
                </tr>
              </thead>
              <tbody>
                ${data.projection
                  .map(
                    (projectionRow) => html`
                      <tr>
                        <td class="num">${projectionRow.month}</td>
                        <td class="num muted">${money(projectionRow.openingEquity, { compact: true })}</td>
                        <td class="num muted">${money(projectionRow.contributions, { compact: true })}</td>
                        <td class="num">${money(projectionRow.surplus)}</td>
                        <td class="num"><strong>${money(projectionRow.closingEquity, { compact: true })}</strong></td>
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
