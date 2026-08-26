import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { api, ApiError } from '../../lib/api';
import { colors, elevation, radius, spacing, text } from '../../lib/theme';
import { Button, Notice } from '../../components/ui';
import { MapPinIcon } from '../../components/icons';

/**
 * The mobile command screen. Same promise as the web composer, laid out for a
 * phone: a keyboard-safe composer, tappable suggestions, and location asked for
 * only at the moment it is actually needed.
 */

const SUGGESTIONS = [
  'Find the cheapest iPhone repair near me',
  'Get three quotes for a plumber',
  'Book a dentist appointment this week',
  'Check if my prescription is ready',
];

export default function HomeScreen() {
  const router = useRouter();
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locationLabel, setLocationLabel] = useState<string | null>(null);

  async function useMyLocation() {
    setError(null);
    // Permission is requested here, at the point of use, and never in advance.
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      setError(
        'Dial does not have location access. You can still say where to look — for example "in Dublin 2".',
      );
      return;
    }
    try {
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const next = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };
      setCoords(next);
      try {
        const resolved = await api.resolveLocation(next);
        setLocationLabel(resolved.label);
      } catch {
        setLocationLabel('your current location');
      }
    } catch {
      setError('Dial could not read your location just now.');
    }
  }

  async function submit() {
    const value = instruction.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const task = await api.createTask({
        instruction: value,
        location: coords ? { ...coords, text: null } : null,
        idempotencyKey: `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      });
      setInstruction('');
      router.push(`/task/${task.id}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <Text style={styles.hero}>Let Dial make the call for you</Text>

        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={instruction}
            onChangeText={setInstruction}
            placeholder="Tell Dial what you need done and where"
            placeholderTextColor={colors.textPlaceholder}
            multiline
            maxLength={2000}
            accessibilityLabel="What do you want Dial to handle?"
          />
          <View style={styles.composerActions}>
            <Pressable
              onPress={() => void useMyLocation()}
              accessibilityRole="button"
              accessibilityLabel="Use my current location"
              style={styles.locationButton}
            >
              {/*
                An SVG pin rather than the 📍 emoji this used to draw: the
                emoji renders in the system's own colour and shape, which is
                neither the web's icon nor the same on two phones.
              */}
              <MapPinIcon size={16} color={colors.textSecondary} />
              <Text style={{ color: colors.textSecondary, fontSize: text.sm }}>
                {locationLabel ?? 'Use my location'}
              </Text>
            </Pressable>
            <Button
              label="Start"
              variant="primary"
              onPress={() => void submit()}
              disabled={!instruction.trim()}
              loading={busy}
            />
          </View>
        </View>

        {error ? <Notice tone="danger">{error}</Notice> : null}

        <Text style={styles.suggestionsLabel}>Try</Text>
        {SUGGESTIONS.map((suggestion) => (
          <Pressable
            key={suggestion}
            onPress={() => setInstruction(suggestion)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.suggestion, pressed && { opacity: 0.7 }]}
          >
            <Text style={{ color: colors.textSecondary, fontSize: text.base }}>{suggestion}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
  },
  hero: {
    fontSize: text.xxl,
    fontWeight: '500',
    color: colors.textPrimary,
    letterSpacing: -0.5,
    marginTop: spacing.lg,
    marginBottom: spacing.lg,
    lineHeight: 34,
  },
  composer: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
    ...elevation.card,
  },
  input: {
    minHeight: 96,
    fontSize: text.md,
    color: colors.textPrimary,
    textAlignVertical: 'top',
  },
  composerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  locationButton: {
    flexShrink: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  suggestionsLabel: {
    fontSize: text.xs,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginTop: spacing.lg,
  },
  suggestion: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    minHeight: 52,
    justifyContent: 'center',
  },
});
