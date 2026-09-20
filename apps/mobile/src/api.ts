/**
 * API client and session.
 *
 * The token lives in the device keychain via expo-secure-store rather than in
 * AsyncStorage: it is a bearer credential for someone's savings, and a phone
 * that is shared or resold should not leave it lying in plain storage.
 */

import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { createContext, useContext } from 'react';

const TOKEN_KEY = 'mamogoro.token';

function baseUrl(): string {
  const configured = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  return configured ?? 'http://localhost:4000';
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Problems the member can act on, rendered as a list under the message. */
  get problems(): string[] {
    if (!Array.isArray(this.detail)) return [];
    return this.detail.map((entry) =>
      typeof entry === 'string' ? entry : ((entry as { message?: string }).message ?? String(entry)),
    );
  }
}

let cachedToken: string | null = null;

export async function loadToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  try {
    cachedToken = await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

export async function saveToken(token: string): Promise<void> {
  cachedToken = token;
  try {
    await SecureStore.setItemAsync(TOKEN_KEY, token);
  } catch {
    // An unavailable keychain should not stop the member using the app for
    // this session; they will simply have to sign in again next time.
  }
}

export async function clearToken(): Promise<void> {
  cachedToken = null;
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Skip the Authorization header (sign-in only). */
  anonymous?: boolean;
}

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = options.anonymous ? null : await loadToken();

  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    // Distinguish "no network" from "server said no": a member on a weak
    // connection needs to know it is worth trying again.
    throw new ApiError(0, 'Could not reach the circle. Check your connection and try again.');
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(response.status, error.message ?? 'Something went wrong', error.code, error.detail);
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// Session context
// ---------------------------------------------------------------------------

export interface Member {
  id: string;
  fullName: string;
  phone: string;
  role: string;
  joinedOn: string;
  status: string;
}

export interface CircleConfig {
  circleName: string;
  currency: string;
  shares: { parValue: number; minimumMembershipShares: number };
  membership: { monthlyContribution: number; annualFee: number };
  termLoan: { monthlyInterestRate: number; defaultTermMonths: number; minimumMonthlyPrincipalRate: number };
  shortTermLoan: { flatRate: number; maxDays: number };
  sponsorship: { coverageRatio: number; responseWindowHours: number };
  governance: { quorumRatio: number; passThresholdRatio: number };
}

export interface Session {
  member: Member | null;
  config: CircleConfig | null;
  signIn(phone: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside a SessionProvider');
  return session;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const SYMBOLS: Record<string, string> = { TZS: 'TSh', KES: 'KSh', UGX: 'USh', RWF: 'FRw', USD: '$' };

export function money(amount: number | null | undefined, currency = 'TZS'): string {
  if (amount === null || amount === undefined) return '—';
  const symbol = SYMBOLS[currency] ?? currency;
  const sign = amount < 0 ? '-' : '';
  return `${sign}${symbol} ${Math.abs(amount).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function compactMoney(amount: number | null | undefined, currency = 'TZS'): string {
  if (amount === null || amount === undefined) return '—';
  const symbol = SYMBOLS[currency] ?? currency;
  const value = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (value >= 1_000_000) return `${sign}${symbol} ${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${sign}${symbol} ${(value / 1_000).toFixed(0)}k`;
  return money(amount, currency);
}

export function percent(ratio: number | null | undefined, decimals = 1): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return `${(ratio * 100).toFixed(decimals)}%`;
}

export function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function longDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
