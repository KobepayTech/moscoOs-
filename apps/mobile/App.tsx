/**
 * Mamogoro Circles — the member app.
 *
 * Five tabs, in the order a member actually uses them: where I stand, what I
 * owe, who is asking me to back them, what the circle is doing, and what we
 * are voting on.
 */

import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import {
  api,
  clearToken,
  loadToken,
  saveToken,
  SessionContext,
  type CircleConfig,
  type Member,
  type Session,
} from './src/api';
import { Loading } from './src/components';
import { BorrowScreen } from './src/screens/Borrow';
import { CircleScreen } from './src/screens/Circle';
import { HomeScreen } from './src/screens/Home';
import { MyLoansScreen } from './src/screens/MyLoans';
import { SignInScreen } from './src/screens/SignIn';
import { SponsorshipsScreen } from './src/screens/Sponsorships';
import { VotesScreen } from './src/screens/Votes';
import { usePalette } from './src/theme';

const Tab = createBottomTabNavigator();

export default function App() {
  const scheme = useColorScheme();
  const palette = usePalette();

  const [member, setMember] = useState<Member | null>(null);
  const [config, setConfig] = useState<CircleConfig | null>(null);
  const [starting, setStarting] = useState(true);

  const refresh = useCallback(async () => {
    const [me, circleConfig] = await Promise.all([
      api<{ member: Member }>('/auth/me'),
      api<CircleConfig>('/config'),
    ]);
    setMember(me.member);
    setConfig(circleConfig);
  }, []);

  const signIn = useCallback(
    async (phone: string, password: string) => {
      const result = await api<{ token: string; member: Member }>('/auth/login', {
        method: 'POST',
        anonymous: true,
        body: { phone, password },
      });
      await saveToken(result.token);
      await refresh();
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    await clearToken();
    setMember(null);
    setConfig(null);
  }, []);

  // Resume the previous session if the stored token is still good.
  useEffect(() => {
    void (async () => {
      const token = await loadToken();
      if (token) {
        try {
          await refresh();
        } catch {
          await clearToken();
        }
      }
      setStarting(false);
    })();
  }, [refresh]);

  const session = useMemo<Session>(
    () => ({ member, config, signIn, signOut, refresh }),
    [member, config, signIn, signOut, refresh],
  );

  const navigationTheme = useMemo(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        background: palette.bg,
        card: palette.surface,
        border: palette.border,
        text: palette.text,
        primary: palette.accent,
      },
    };
  }, [palette, scheme]);

  if (starting) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: palette.bg }}>
          <Loading note="Opening the circle…" />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SessionContext.Provider value={session}>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />

        {member ? (
          <NavigationContainer theme={navigationTheme}>
            <Tab.Navigator
              screenOptions={{
                headerShown: false,
                tabBarActiveTintColor: palette.accent,
                tabBarInactiveTintColor: palette.textFaint,
                tabBarStyle: { backgroundColor: palette.surface, borderTopColor: palette.border },
                tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
              }}
            >
              <Tab.Screen
                name="Home"
                component={HomeScreen}
                options={{ tabBarIcon: ({ color }) => <TabGlyph glyph="◉" color={color} /> }}
              />
              <Tab.Screen
                name="Borrow"
                component={BorrowScreen}
                options={{ tabBarIcon: ({ color }) => <TabGlyph glyph="↗" color={color} /> }}
              />
              <Tab.Screen
                name="My loans"
                component={MyLoansScreen}
                options={{ tabBarIcon: ({ color }) => <TabGlyph glyph="≡" color={color} /> }}
              />
              <Tab.Screen
                name="Sponsor"
                component={SponsorshipsScreen}
                options={{ tabBarIcon: ({ color }) => <TabGlyph glyph="⚭" color={color} /> }}
              />
              <Tab.Screen
                name="Circle"
                component={CircleScreen}
                options={{ tabBarIcon: ({ color }) => <TabGlyph glyph="○" color={color} /> }}
              />
              <Tab.Screen
                name="Votes"
                component={VotesScreen}
                options={{ tabBarIcon: ({ color }) => <TabGlyph glyph="✓" color={color} /> }}
              />
            </Tab.Navigator>
          </NavigationContainer>
        ) : (
          <SignInScreen />
        )}
      </SessionContext.Provider>
    </SafeAreaProvider>
  );
}

/**
 * Tab icons as glyphs.
 *
 * Avoids pulling an icon font into the bundle for six marks. Swap for
 * `@expo/vector-icons` if the set grows.
 */
function TabGlyph({ glyph, color }: { glyph: string; color: string }) {
  return <Text style={{ color, fontSize: 17, lineHeight: 20 }}>{glyph}</Text>;
}
