import { useEffect, useState } from 'react';
import { ScrollView, View, Text, Switch, StyleSheet, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import type { UserSettings } from '@dial/schemas';
import { api, API_URL } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { colors, spacing, text } from '../../lib/theme';
import { Card, Button, SectionLabel, Notice } from '../../components/ui';

/**
 * The authorization policy, editable on the phone and stored on the server, so
 * changing it here changes what Dial may do everywhere.
 */

const CYCLE = ['automatic', 'ask', 'never'] as const;
const LABEL: Record<string, string> = {
  automatic: 'Automatically',
  ask: 'Ask me first',
  never: 'Never',
  allow: 'Share it',
};

export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const router = useRouter();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api
      .getSettings()
      .then(setSettings)
      .catch(() => setError('Could not load your settings.'));
  }, []);

  async function patch(next: Partial<UserSettings>) {
    if (!settings) return;
    setSaving(true);
    try {
      const updated = await api.updateSettings({ ...settings, ...next });
      setSettings(updated);
      setError(null);
    } catch {
      setError('Could not save that change.');
    } finally {
      setSaving(false);
    }
  }

  function cyclePolicy(key: keyof UserSettings['policy']) {
    if (!settings) return;
    const current = settings.policy[key] as string;
    const index = CYCLE.indexOf(current as never);
    const next = CYCLE[(index + 1) % CYCLE.length];
    void patch({ policy: { ...settings.policy, [key]: next } as UserSettings['policy'] });
  }

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Card>
        <SectionLabel>What Dial may do</SectionLabel>
        {settings ? (
          <>
            <Row
              label="Making phone calls"
              value={LABEL[settings.policy.phoneInquiries] ?? settings.policy.phoneInquiries}
              onPress={() => cyclePolicy('phoneInquiries')}
            />
            <Row
              label="Reservations"
              value={
                LABEL[settings.policy.reservationsWithoutPayment] ??
                settings.policy.reservationsWithoutPayment
              }
              onPress={() => cyclePolicy('reservationsWithoutPayment')}
            />
            <Row
              label="Appointments"
              value={LABEL[settings.policy.appointments] ?? settings.policy.appointments}
              onPress={() => cyclePolicy('appointments')}
            />
            {/* Deliberately not editable: purchases always require approval. */}
            <Row label="Purchases" value="Always ask" />
          </>
        ) : (
          <Text style={{ color: colors.textSecondary }}>Loading...</Text>
        )}
      </Card>

      <Card>
        <SectionLabel>Notifications</SectionLabel>
        <View style={styles.row}>
          <Text style={{ color: colors.textPrimary, fontSize: text.base, flex: 1 }}>
            Tell me when a task finishes
          </Text>
          <Switch
            value={settings?.notificationsEnabled ?? true}
            onValueChange={(value) => void patch({ notificationsEnabled: value })}
            disabled={!settings || saving}
          />
        </View>
      </Card>

      <Card>
        <SectionLabel>Account</SectionLabel>
        <Text style={{ color: colors.textSecondary, marginBottom: spacing.sm }}>{user?.email}</Text>
        <Text style={{ color: colors.textMuted, fontSize: text.xs, marginBottom: spacing.md }}>
          Connected to {API_URL}
        </Text>
        <Button
          label="Sign out"
          onPress={() => {
            void signOut().then(() => router.replace('/sign-in'));
          }}
        />
      </Card>

      <Card>
        <SectionLabel>Delete account</SectionLabel>
        <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
          Removes your account, every task and every transcript. This cannot be undone.
        </Text>
        <Button
          label="Delete my account"
          variant="danger"
          onPress={() =>
            Alert.alert('Delete your account?', 'Everything will be permanently removed.', [
              { text: 'Keep it', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: () => {
                  void api
                    .deleteAccount()
                    .then(() => signOut())
                    .then(() => router.replace('/sign-in'));
                },
              },
            ])
          }
        />
      </Card>
    </ScrollView>
  );
}

function Row({ label, value, onPress }: { label: string; value: string; onPress?: () => void }) {
  return (
    <View style={styles.row}>
      <Text style={{ color: colors.textPrimary, fontSize: text.base, flex: 1 }}>{label}</Text>
      {onPress ? (
        <Button label={value} onPress={onPress} />
      ) : (
        <Text style={{ color: colors.textMuted }}>{value}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 52,
  },
});
