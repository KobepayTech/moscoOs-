/**
 * Rendering values for people: money, percentages, dates, and safe HTML.
 */

import { state } from './state.js';

export function money(amount, { compact = false } = {}) {
  if (amount === null || amount === undefined) return '—';
  const symbol = state.config?.currency === 'TZS' ? 'TSh' : (state.config?.currency ?? '');
  const sign = amount < 0 ? '-' : '';
  const value = Math.abs(amount);

  if (compact && value >= 1_000_000) {
    return `${sign}${symbol} ${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  return `${sign}${symbol} ${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function pct(ratio, decimals = 1) {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return `${(ratio * 100).toFixed(decimals)}%`;
}

export function date(value) {
  if (!value) return '—';
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Escape anything that came from the server before it reaches innerHTML. */
export function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

export function html(strings, ...values) {
  return strings.reduce((out, chunk, index) => out + chunk + (values[index] ?? ''), '');
}
