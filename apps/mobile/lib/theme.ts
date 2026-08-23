/**
 * The same tokens the web app uses (packages/ui), expressed for React Native.
 * Kept as a local module because Metro should not have to resolve a TS package
 * at runtime for something this small — but the values are identical, and a
 * change to the palette belongs in both places.
 */
export const colors = {
  background: '#f4f7fb',
  surface: '#ffffff',
  surfaceMuted: '#fafbfd',
  border: '#e4e9f2',
  borderStrong: '#d3dae6',
  textPrimary: '#14181f',
  textSecondary: '#59636f',
  textMuted: '#8b95a3',
  textPlaceholder: '#9aa3b0',
  primary: '#17191d',
  primaryText: '#ffffff',
  send: '#4b5563',
  success: '#0f9d76',
  successSoft: '#e6f6f1',
  warning: '#b45309',
  warningSoft: '#fdf3e7',
  danger: '#c0392f',
  dangerSoft: '#fdeceb',
  info: '#2563eb',
  infoSoft: '#eaf0fe',
  active: '#14b8a6',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = { sm: 6, md: 10, lg: 12, xl: 16, pill: 999 };
export const text = {
  xs: 12,
  sm: 13,
  base: 15,
  md: 16,
  lg: 18,
  xl: 22,
  xxl: 28,
};

export const STATE_TONE: Record<string, { bg: string; fg: string }> = {
  completed: { bg: colors.successSoft, fg: colors.success },
  partially_completed: { bg: colors.warningSoft, fg: colors.warning },
  failed: { bg: colors.dangerSoft, fg: colors.danger },
  canceled: { bg: colors.surfaceMuted, fg: colors.textSecondary },
  needs_user_input: { bg: colors.warningSoft, fg: colors.warning },
  awaiting_confirmation: { bg: colors.warningSoft, fg: colors.warning },
};

export function toneFor(state: string) {
  return STATE_TONE[state] ?? { bg: colors.infoSoft, fg: colors.info };
}

export const LIVE_STATES = new Set([
  'created',
  'interpreting',
  'researching',
  'candidates_ready',
  'planning_calls',
  'calling',
  'collecting_results',
  'comparing',
  'executing_action',
]);
