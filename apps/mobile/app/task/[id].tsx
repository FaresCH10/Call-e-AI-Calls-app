import { useCallback, useEffect, useState } from 'react';
import {
  ScrollView,
  View,
  Text,
  TextInput,
  Pressable,
  Linking,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { TaskDetail } from '@dial/schemas';
import { api, ApiError } from '../../lib/api';
import { colors, spacing, text, toneFor, LIVE_STATES } from '../../lib/theme';
import { Card, Pill, Button, SectionLabel, Notice } from '../../components/ui';

/**
 * The task detail screen, deep-linkable as dial://task/<id> so a completion
 * notification can open straight to the result.
 *
 * Progress is polled rather than streamed: a phone suspends sockets when it
 * locks, and adaptive polling is both simpler and more reliable there. The
 * interval backs off once the task is no longer moving.
 */
export default function TaskScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [intake, setIntake] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setTask(await api.getTask(id));
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this task.');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!task || !LIVE_STATES.has(task.state)) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [task, load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  if (!task) {
    return (
      <View style={styles.centre}>
        {error ? <Notice tone="danger">{error}</Notice> : <ActivityIndicator />}
      </View>
    );
  }

  const tone = toneFor(task.state);
  const live = LIVE_STATES.has(task.state);
  const best = task.result?.best ?? null;

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
      <Pill label={task.stateLabel} bg={tone.bg} fg={tone.fg} />
      <Text style={styles.instruction}>{task.instruction}</Text>
      {task.headline ? <Text style={styles.headline}>{task.headline}</Text> : null}

      {task.clarifyingQuestions.length > 0 ? (
        <Card>
          <SectionLabel>A few quick questions</SectionLabel>
          <Text style={{ color: colors.textSecondary, marginBottom: spacing.md }}>
            These let Dial call the right places and ask the right things.
          </Text>

          {task.clarifyingQuestions.map((question) => (
            <View key={question.id} style={{ marginBottom: spacing.md }}>
              <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>
                {question.question}
              </Text>
              {question.why ? (
                <Text style={{ color: colors.textMuted, fontSize: text.sm, marginBottom: 6 }}>
                  {question.why}
                </Text>
              ) : null}

              {question.options.length > 0 ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: 6 }}>
                  {question.options.map((option) => {
                    const selected = intake[question.id] === option;
                    return (
                      <Pressable
                        key={option}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        onPress={() =>
                          setIntake((prev) => ({
                            ...prev,
                            [question.id]: selected ? '' : option,
                          }))
                        }
                        style={{
                          paddingHorizontal: spacing.md,
                          minHeight: 44,
                          justifyContent: 'center',
                          borderRadius: 999,
                          borderWidth: 1,
                          borderColor: selected ? colors.primary : colors.border,
                          backgroundColor: selected ? colors.primary : colors.surface,
                        }}
                      >
                        <Text style={{ color: selected ? colors.primaryText : colors.textPrimary }}>
                          {option}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}

              <TextInput
                value={intake[question.id] ?? ''}
                onChangeText={(value) => setIntake((prev) => ({ ...prev, [question.id]: value }))}
                placeholder={question.options.length ? 'Or type your own' : 'Your answer'}
                placeholderTextColor={colors.textPlaceholder}
                maxLength={500}
                accessibilityLabel={question.question}
                style={{
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: 10,
                  paddingHorizontal: spacing.md,
                  minHeight: 46,
                  color: colors.textPrimary,
                }}
              />
            </View>
          ))}

          <View style={{ gap: spacing.sm }}>
            <Button
              label="Start calling"
              variant="primary"
              loading={busy}
              onPress={() =>
                void act(() =>
                  api.answerQuestions(
                    task.id,
                    Object.entries(intake).map(([id, answer]) => ({ id, answer })),
                  ),
                )
              }
            />
            <Button
              label="Skip and go"
              loading={busy}
              onPress={() => void act(() => api.answerQuestions(task.id, [], true))}
            />
          </View>
        </Card>
      ) : null}

      {task.state === 'needs_user_input' && task.clarificationQuestion ? (
        <Notice tone="warning">{task.clarificationQuestion}</Notice>
      ) : null}

      {task.pendingAuthorization ? (
        <Card>
          <SectionLabel>Needs your approval</SectionLabel>
          <Text style={{ color: colors.textPrimary, marginBottom: spacing.sm }}>
            {task.pendingAuthorization.prompt}
          </Text>
          <Text style={{ color: colors.textSecondary, marginBottom: spacing.md, fontSize: text.sm }}>
            Dial has not called anyone yet and will not until you approve.
          </Text>
          <View style={{ gap: spacing.sm }}>
            <Button
              label="Approve"
              variant="primary"
              loading={busy}
              onPress={() => void act(() => api.decideAuthorization(task.id, true))}
            />
            <Button
              label="Not now"
              loading={busy}
              onPress={() => void act(() => api.decideAuthorization(task.id, false))}
            />
          </View>
        </Card>
      ) : null}

      {best ? (
        <Card>
          <SectionLabel>Best verified option</SectionLabel>
          <Text style={styles.resultName}>{best.candidate.name}</Text>
          {best.normalizedPrice !== null ? (
            <Text style={styles.resultPrice}>
              {best.normalizedCurrency ?? ''} {best.normalizedPrice.toFixed(2)}
            </Text>
          ) : null}
          {best.rankReasons.map((reason) => (
            <Text key={reason} style={styles.reason}>
              ✓ {reason}
            </Text>
          ))}
          {task.result ? (
            <Text style={styles.tally}>
              {task.result.tally.discovered} found · {task.result.tally.contacted} contacted ·{' '}
              {task.result.tally.answered} answered · {task.result.tally.comparable} comparable
            </Text>
          ) : null}
          {best.candidate.phoneE164 ? (
            <View style={{ marginTop: spacing.md }}>
              <Button
                label="Call them myself"
                onPress={() => void Linking.openURL(`tel:${best.candidate.phoneE164}`)}
              />
            </View>
          ) : null}
        </Card>
      ) : null}

      {task.result && task.result.caveats.length > 0 ? (
        <Notice tone="warning">{task.result.caveats.join('\n')}</Notice>
      ) : null}

      {task.events.length > 0 ? (
        <Card>
          <SectionLabel>Progress</SectionLabel>
          {task.events.map((event, index) => {
            const isLast = index === task.events.length - 1;
            return (
              <Text
                key={event.id}
                style={[styles.event, isLast && live ? styles.eventLive : null]}
              >
                {isLast && live ? '● ' : '✓ '}
                {event.message}
              </Text>
            );
          })}
        </Card>
      ) : null}

      {task.calls.length > 0 ? (
        <Card>
          <SectionLabel>Calls Dial made</SectionLabel>
          {task.calls.map((call) => (
            <View key={call.id} style={styles.callRow}>
              <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>
                {call.businessName}
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: text.sm }}>
                {call.phoneMasked} · {call.disposition.replace(/_/g, ' ')}
              </Text>
              {call.structuredResult?.['evidence_summary'] ? (
                <Text style={{ color: colors.textSecondary, marginTop: 4 }}>
                  {String(call.structuredResult['evidence_summary'])}
                </Text>
              ) : call.failureMessage ? (
                <Text style={{ color: colors.textMuted, marginTop: 4 }}>{call.failureMessage}</Text>
              ) : null}
            </View>
          ))}
        </Card>
      ) : null}

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
        {live ? (
          <Button
            label="Stop this task"
            variant="danger"
            loading={busy}
            onPress={() => void act(() => api.cancelTask(task.id))}
          />
        ) : null}
        <Button
          label="Delete"
          loading={busy}
          onPress={() =>
            void act(async () => {
              await api.deleteTask(task.id);
              router.replace('/(tabs)/history');
            })
          }
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  instruction: { fontSize: text.xl, fontWeight: '600', color: colors.textPrimary },
  headline: { fontSize: text.base, color: colors.textSecondary },
  resultName: { fontSize: text.xl, fontWeight: '600', color: colors.textPrimary },
  resultPrice: { fontSize: text.xxl, fontWeight: '600', color: colors.textPrimary },
  reason: { color: colors.textSecondary, marginTop: 4 },
  tally: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    color: colors.textSecondary,
    fontSize: text.sm,
  },
  event: { color: colors.textSecondary, paddingVertical: 3 },
  eventLive: { color: colors.textPrimary, fontWeight: '600' },
  callRow: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
});
