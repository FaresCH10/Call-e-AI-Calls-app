import { Text, View, Pressable, ActivityIndicator, StyleSheet, type ViewStyle } from 'react-native';
import { colors, elevation, radius, spacing, text } from '../lib/theme';

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Pill({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: text.sm, fontWeight: '500' }}>{label}</Text>
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
  const isPrimary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled || loading) }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        isPrimary && { backgroundColor: colors.primary, borderColor: colors.primary },
        variant === 'danger' && { borderColor: colors.danger },
        (disabled || loading) && { opacity: 0.5 },
        pressed && { opacity: 0.8 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={isPrimary ? colors.primaryText : colors.textPrimary} />
      ) : (
        <Text
          style={{
            color: isPrimary
              ? colors.primaryText
              : variant === 'danger'
                ? colors.danger
                : colors.textPrimary,
            fontWeight: '600',
            fontSize: text.base,
          }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Notice({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'warning' | 'danger';
}) {
  const palette =
    tone === 'danger'
      ? { bg: colors.dangerSoft, fg: colors.danger }
      : tone === 'warning'
        ? { bg: colors.warningSoft, fg: colors.warning }
        : { bg: colors.surfaceMuted, fg: colors.textSecondary };
  return (
    <View style={[styles.notice, { backgroundColor: palette.bg }]}>
      <Text style={{ color: palette.fg }}>{children}</Text>
    </View>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    // The web gives cards a soft lift off the canvas; a flat bordered box read
    // as a different product next to it.
    ...elevation.card,
  },
  pill: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  button: {
    // 44pt minimum touch target (section 37).
    minHeight: 46,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  notice: {
    padding: spacing.lg,
    borderRadius: radius.md,
  },
  sectionLabel: {
    fontSize: text.xs,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginBottom: spacing.md,
  },
});
