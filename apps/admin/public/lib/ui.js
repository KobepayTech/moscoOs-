/**
 * Shared presentation pieces.
 *
 * Everything that appears on more than one page: the page frame, stat tiles,
 * label/value rows, the capital waterfall bar, and the flash message.
 */

import { esc, html, money, pct } from './format.js';
import { requestRender, state } from './state.js';

/** The circles mark, used in the sidebar and on the sign-in card. */
export const MARK = html`
  <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
    <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.35" />
    <circle cx="16" cy="16" r="8.5" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.6" />
    <circle cx="16" cy="16" r="4" fill="currentColor" />
  </svg>
`;

export function flash(message, kind = 'ok') {
  state.flash = { message, kind };
  requestRender();
  setTimeout(() => {
    if (state.flash?.message === message) {
      state.flash = null;
      requestRender();
    }
  }, 5000);
}

/** Render a page, turning any failure into a message rather than a blank screen. */
export async function page(target, build) {
  try {
    target.innerHTML = await build();
  } catch (error) {
    target.innerHTML = html`
      <div class="alert alert-error">
        ${esc(error.message)}
        ${Array.isArray(error.detail)
          ? `<ul>${error.detail.map((problem) => `<li>${esc(problem.message ?? problem)}</li>`).join('')}</ul>`
          : ''}
      </div>
    `;
  }
}

export function head(title, subtitle, actions = '') {
  return html`
    <div class="page-head">
      <div>
        <h1 class="page-title">${esc(title)}</h1>
        ${subtitle ? `<p class="page-sub">${esc(subtitle)}</p>` : ''}
      </div>
      <div class="btn-row">${actions}</div>
    </div>
  `;
}

export function stat(label, value, foot) {
  return html`
    <div class="stat">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${value}</div>
      ${foot ? `<div class="stat-foot">${esc(foot)}</div>` : ''}
    </div>
  `;
}

export function row(label, value, tone) {
  const rendered = tone ? `<span class="pill pill-${tone}">${value}</span>` : value;
  return `<tr><td class="muted">${esc(label)}</td><td class="num">${rendered}</td></tr>`;
}

/**
 * The utilisation bar.
 *
 * This is the single most important picture in the system: it shows which
 * money is working and whose it is. The investor is paid on the blue-solid
 * segment alone, and the pale blue is capital sitting idle earning nobody
 * anything.
 */
export function waterfallCard(capital) {
  const total = Math.max(1, capital.totalCapital);
  const equityFree = Math.max(0, capital.equityPool - capital.equityUtilised);

  // Segments carry only the amount; the key below names what each one is.
  // A label long enough to be clipped is worse than no label at all.
  const segment = (value, className, label) => {
    if (value <= 0) return '';
    const share = (value / total) * 100;
    const text = share > 8 ? money(value, { compact: true }) : '';
    return `<div class="waterfall-seg ${className}" style="flex: 0 0 ${share}%" title="${esc(label)}">${text}</div>`;
  };

  return html`
    <div class="card" style="margin-top:16px">
      <div class="card-title">Whose money is at work</div>
      <p class="card-note">
        Lending draws the members' own capital first. External capital only starts earning once lending goes
        beyond that line — so the pale blue below is committed but idle, and earns its investor nothing.
      </p>

      <div class="waterfall">
        <div class="waterfall-track">
          ${segment(capital.equityUtilised, 'seg-equity-used', `Members' capital lent: ${money(capital.equityUtilised)}`)}
          ${segment(equityFree, 'seg-equity-free', `Members' capital free: ${money(equityFree)}`)}
          ${segment(capital.facilityUtilised, 'seg-facility-used', `External capital lent: ${money(capital.facilityUtilised)}`)}
          ${segment(capital.facilityIdle, 'seg-facility-idle', `External capital idle: ${money(capital.facilityIdle)}`)}
        </div>

        <div class="waterfall-key">
          <span class="key-item"
            ><span class="key-swatch" style="background: var(--accent)"></span>Members' capital lent
            ${money(capital.equityUtilised, { compact: true })}</span
          >
          <span class="key-item"
            ><span class="key-swatch" style="background: var(--accent-soft)"></span>Members' capital free
            ${money(equityFree, { compact: true })}</span
          >
          <span class="key-item"
            ><span class="key-swatch" style="background: var(--info)"></span>External capital lent
            ${money(capital.facilityUtilised, { compact: true })}</span
          >
          <span class="key-item"
            ><span class="key-swatch" style="background: var(--info-soft)"></span>External capital idle
            ${money(capital.facilityIdle, { compact: true })}</span
          >
        </div>
      </div>

      <div class="grid" style="margin-top:18px">
        ${stat('Free to lend', money(capital.available, { compact: true }), 'Available right now')}
        ${stat('Largest single loan', money(capital.maxSingleLoan, { compact: true }), 'Under current policy')}
        ${stat('Utilisation', pct(capital.utilisationRatio), 'Of the whole capital base')}
      </div>
    </div>
  `;
}
