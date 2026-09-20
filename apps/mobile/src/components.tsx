/**
 * Shared building blocks for the member app.
 */

import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { radius, spacing, usePalette, type Palette } from './theme';

/**
 * The standard screen body: scrollable, padded, pull-to-refresh.
 *
 * Every tab reloads by pulling down, because a member checking whether their
 * repayment has landed will try that before they look for a button.
 */
export function Screen({
  children,
  refreshing,
  onRefresh,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const palette = usePalette();
  return (
    <ScrollView
      style={{ backgroundColor: palette.bg }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl * 2, gap: spacing.md }}
      refreshControl={
        onRefresh ? (
          <RefreshControl refreshing={refreshing ?? false} onRefresh={onRefresh} tintColor={palette.accent} />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const palette = usePalette();
  return (
    <View
      style={[
        {
          backgroundColor: palette.surface,
          borderColor: palette.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: radius.lg,
          padding: spacing.lg,
          gap: spacing.sm,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const palette = usePalette();
  return <Text style={{ color: palette.text, fontSize: 20, fontWeight: '700' }}>{children}</Text>;
}

export function CardTitle({ children }: { children: ReactNode }) {
  const palette = usePalette();
  return <Text style={{ color: palette.text, fontSize: 15, fontWeight: '700' }}>{children}</Text>;
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const palette = usePalette();
  return (
    <Text style={{ color: muted ? palette.textMuted : palette.text, fontSize: 14, lineHeight: 21 }}>
      {children}
    </Text>
  );
}

export function Caption({ children }: { children: ReactNode }) {
  const palette = usePalette();
  return <Text style={{ color: palette.textFaint, fontSize: 12.5, lineHeight: 18 }}>{children}</Text>;
}

/** A headline figure with a label above and a note beneath. */
export function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  const palette = usePalette();
  return (
    <View style={{ gap: 2 }}>
      <Text
        style={{
          color: palette.textMuted,
          fontSize: 11.5,
          fontWeight: '700',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        {label}
      </Text>
      <Text style={{ color: palette.text, fontSize: 24, fontWeight: '700' }}>{value}</Text>
      {note ? <Caption>{note}</Caption> : null}
    </View>
  );
}

/** A label/value line, used throughout for schedules and summaries. */
export function Row({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: Tone;
  strong?: boolean;
}) {
  const palette = usePalette();
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 7,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: palette.border,
        gap: spacing.md,
      }}
    >
      <Text style={{ color: palette.textMuted, fontSize: 14, flexShrink: 1 }}>{label}</Text>
      {tone ? (
        <Pill tone={tone}>{value}</Pill>
      ) : (
        <Text
          style={{
            color: palette.text,
            fontSize: 14,
            fontWeight: strong ? '700' : '500',
            fontVariant: ['tabular-nums'],
          }}
        >
          {value}
        </Text>
      )}
    </View>
  );
}

export type Tone = 'neutral' | 'positive' | 'warning' | 'danger' | 'info' | 'accent';

function toneColours(palette: Palette, tone: Tone): { bg: string; fg: string } {
  switch (tone) {
    case 'positive':
      return { bg: palette.positiveSoft, fg: palette.positive };
    case 'warning':
      return { bg: palette.warningSoft, fg: palette.warning };
    case 'danger':
      return { bg: palette.dangerSoft, fg: palette.danger };
    case 'info':
      return { bg: palette.infoSoft, fg: palette.info };
    case 'accent':
      return { bg: palette.accentSoft, fg: palette.accent };
    default:
      return { bg: palette.surfaceSunken, fg: palette.textMuted };
  }
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  const palette = usePalette();
  const { bg, fg } = toneColours(palette, tone);
  return (
    <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 }}>
      <Text style={{ color: fg, fontSize: 11.5, fontWeight: '700' }}>{children}</Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = 'secondary',
  disabled,
  loading,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  loading?: boolean;
}) {
  const palette = usePalette();

  const background =
    variant === 'primary' ? palette.accent : variant === 'danger' ? palette.dangerSoft : palette.surface;
  const foreground =
    variant === 'primary' ? palette.accentText : variant === 'danger' ? palette.danger : palette.text;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => ({
        backgroundColor: background,
        borderColor: variant === 'primary' ? palette.accent : palette.border,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radius.md,
        paddingVertical: 13,
        paddingHorizontal: spacing.lg,
        alignItems: 'center',
        opacity: disabled || loading ? 0.5 : pressed ? 0.82 : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator color={foreground} />
      ) : (
        <Text style={{ color: foreground, fontSize: 15, fontWeight: '600' }}>{label}</Text>
      )}
    </Pressable>
  );
}

/** A bar showing how far along something is — sponsor cover, a vote, a term. */
export function Meter({ ratio, complete }: { ratio: number; complete?: boolean }) {
  const palette = usePalette();
  const width = `${Math.max(0, Math.min(100, ratio * 100))}%` as const;

  return (
    <View
      style={{
        height: 8,
        borderRadius: 999,
        backgroundColor: palette.surfaceSunken,
        overflow: 'hidden',
        marginTop: 6,
      }}
    >
      <View
        style={{ width, height: '100%', backgroundColor: complete ? palette.positive : palette.accent }}
      />
    </View>
  );
}

export function Alert({ children, tone = 'info' }: { children: ReactNode; tone?: Tone }) {
  const palette = usePalette();
  const { bg, fg } = toneColours(palette, tone);
  return (
    <View style={{ backgroundColor: bg, borderRadius: radius.md, padding: spacing.md }}>
      <Text style={{ color: fg, fontSize: 13.5, lineHeight: 20 }}>{children}</Text>
    </View>
  );
}

export function Loading({ note }: { note?: string }) {
  const palette = usePalette();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl, gap: spacing.md }}>
      <ActivityIndicator color={palette.accent} />
      {note ? <Caption>{note}</Caption> : null}
    </View>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  const palette = usePalette();
  return (
    <View style={{ padding: spacing.xl, alignItems: 'center' }}>
      <Text style={{ color: palette.textFaint, fontSize: 13.5, textAlign: 'center' }}>{children}</Text>
    </View>
  );
}

/** An explanatory aside — used wherever a number needs a sentence. */
export function Explain({ children }: { children: ReactNode }) {
  const palette = usePalette();
  return (
    <View
      style={{
        backgroundColor: palette.surfaceSunken,
        borderLeftWidth: 3,
        borderLeftColor: palette.accent,
        borderRadius: radius.sm,
        padding: spacing.md,
      }}
    >
      <Text style={{ color: palette.textMuted, fontSize: 13.5, lineHeight: 20 }}>{children}</Text>
    </View>
  );
}
