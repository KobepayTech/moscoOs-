import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { ApiError, useSession } from '../api';
import { Alert, Body, Button, Caption, Title } from '../components';
import { radius, spacing, usePalette } from '../theme';

export function SignInScreen() {
  const palette = usePalette();
  const session = useSession();

  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await session.signIn(phone.trim(), password);
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  const inputStyle = {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    color: palette.text,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 13,
    fontSize: 16,
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: palette.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: spacing.xl }}>
        <View style={{ gap: spacing.lg }}>
          <View style={{ gap: spacing.xs }}>
            <Title>Mamogoro Circles</Title>
            <Body muted>Sign in with the phone number registered with the circle.</Body>
          </View>

          {error ? <Alert tone="danger">{error}</Alert> : null}

          <View style={{ gap: spacing.sm }}>
            <Caption>Phone number</Caption>
            <TextInput
              value={phone}
              onChangeText={setPhone}
              placeholder="+255 7xx xxx xxx"
              placeholderTextColor={palette.textFaint}
              keyboardType="phone-pad"
              autoCapitalize="none"
              autoComplete="tel"
              style={inputStyle}
            />
          </View>

          <View style={{ gap: spacing.sm }}>
            <Caption>Password</Caption>
            <TextInput
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="current-password"
              onSubmitEditing={submit}
              style={inputStyle}
            />
          </View>

          <Button label="Sign in" variant="primary" onPress={submit} loading={busy} />

          <Text style={{ color: palette.textFaint, fontSize: 12.5, lineHeight: 19, textAlign: 'center' }}>
            Every member sees the same book: the ledger, the loan register, and who is standing behind whom.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
