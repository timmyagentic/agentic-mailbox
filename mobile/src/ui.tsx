import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

export const palette = {
  background: '#f5f3ec', card: '#fffdf8', ink: '#182b27', muted: '#52635b',
  line: '#d8ddd3', accent: '#1b5346', accentSoft: '#e2eee7', error: '#972c28',
};

export function Action({ label, onPress, primary, disabled }: {
  label: string; onPress: () => void; primary?: boolean; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.action, primary && styles.primary, (pressed || disabled) && styles.dim]}>
    <Text style={[styles.actionText, primary && styles.primaryText]}>{label}</Text>
  </Pressable>;
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <TextInput {...props} accessibilityLabel={label} placeholderTextColor={palette.muted}
      style={[styles.input, props.multiline && styles.multiline, props.style]} />
  </View>;
}

export function Header({ title, subtitle, back, children }: { title: string; subtitle?: string; back?: () => void; children?: ReactNode }) {
  return <View style={styles.header}>
    {back && <Action label="返回" onPress={back} />}
    <View style={styles.headerTitle}>
      <Text accessibilityRole="header" numberOfLines={2} style={styles.title}>{title}</Text>
      {subtitle && <Text numberOfLines={1} style={styles.muted}>{subtitle}</Text>}
    </View>
    {children}
  </View>;
}

export function Notice({ text, error }: { text?: string; error?: boolean }) {
  if (!text) return null;
  return <Text accessibilityLiveRegion="polite" style={[styles.notice, error && styles.error]}>{text}</Text>;
}

export function Loading() { return <ActivityIndicator style={styles.loading} color={palette.accent} />; }

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  content: { padding: 16, gap: 14 },
  card: { backgroundColor: palette.card, borderRadius: 16, borderColor: palette.line, borderWidth: 1, padding: 14, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  headerTitle: { flex: 1, gap: 3 },
  title: { fontSize: 25, fontWeight: '700', color: palette.ink },
  heading: { fontSize: 17, fontWeight: '700', color: palette.ink },
  text: { fontSize: 16, lineHeight: 23, color: palette.ink },
  muted: { fontSize: 13, color: palette.muted },
  field: { gap: 5 },
  label: { fontSize: 13, fontWeight: '600', color: palette.ink },
  input: { minHeight: 46, backgroundColor: palette.card, borderColor: palette.line, borderWidth: 1, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 9, fontSize: 16, color: palette.ink },
  multiline: { minHeight: 180, textAlignVertical: 'top' },
  action: { minHeight: 44, justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 12,
    borderRadius: 12, backgroundColor: palette.accentSoft },
  primary: { backgroundColor: palette.accent },
  dim: { opacity: 0.58 },
  actionText: { color: palette.accent, fontWeight: '600', fontSize: 14 },
  primaryText: { color: '#ffffff' },
  notice: { padding: 10, color: palette.ink, backgroundColor: palette.accentSoft, borderRadius: 10 },
  error: { color: palette.error, backgroundColor: '#f7e6e0' },
  loading: { margin: 16 },
});
