/**
 * Visual language, shared with the admin panel.
 *
 * Warm earth rather than fintech blue: this is a savings circle, and members
 * should feel they are looking at their own group's book, not a bank's.
 */

import { useColorScheme } from 'react-native';

export interface Palette {
  bg: string;
  surface: string;
  surfaceSunken: string;
  border: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentSoft: string;
  accentText: string;
  positive: string;
  positiveSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  info: string;
  infoSoft: string;
}

const light: Palette = {
  bg: '#f7f4ef',
  surface: '#ffffff',
  surfaceSunken: '#f1ece4',
  border: '#e2d9cc',
  text: '#23201c',
  textMuted: '#6b625a',
  textFaint: '#958a7e',
  accent: '#b45f1f',
  accentSoft: '#f6e6d8',
  accentText: '#ffffff',
  positive: '#2f6f4e',
  positiveSoft: '#e2f0e7',
  warning: '#9a6a10',
  warningSoft: '#faeed4',
  danger: '#a33327',
  dangerSoft: '#f8e3e0',
  info: '#2c5d86',
  infoSoft: '#e0ecf6',
};

const dark: Palette = {
  bg: '#171513',
  surface: '#211e1b',
  surfaceSunken: '#1a1815',
  border: '#322d28',
  text: '#f0ebe4',
  textMuted: '#a89d91',
  textFaint: '#7d736a',
  accent: '#d98842',
  accentSoft: '#3a2a1c',
  accentText: '#1a1310',
  positive: '#6cc395',
  positiveSoft: '#1e3229',
  warning: '#d9ad52',
  warningSoft: '#332914',
  danger: '#e08376',
  dangerSoft: '#38211e',
  info: '#7db2dd',
  infoSoft: '#1c2a36',
};

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 22, xxl: 30 };
export const radius = { sm: 8, md: 12, lg: 16 };
