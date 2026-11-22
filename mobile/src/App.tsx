import { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { message, mobileApi, origin, sessionKey } from './api';
import { Action, Field, Loading, Notice, styles } from './ui';
import Mailbox from './Mailbox';

type Identity = { token: string; user: string };
type Mode = 'login' | 'register' | 'admin';

function SignIn({ onLogin }: { onLogin: (identity: Identity) => Promise<void> }) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const invalid = busy || !password || (mode !== 'admin' && !username.trim());

  async function submit() {
    if (invalid) return;
    setBusy(true);
    setError('');
    try {
      const api = mobileApi();
      const result = mode === 'admin' ? await api.login(password) : await api.memberLogin(username.trim(), password, mode === 'register');
      if (!result.authenticated || !result.sessionToken || !result.user) throw new Error('此服务器需要更新后才能登录手机端。');
      await onLogin({ token: result.sessionToken, user: result.user.email });
      setPassword('');
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  return <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingTop: 42 }]}>
      <Text style={styles.title}>Agentic Mailbox</Text>
      <Text style={styles.muted}>{new URL(origin).host}</Text>
      <View style={styles.card}>
        <Text style={styles.heading}>{mode === 'register' ? '创建个人邮箱空间' : mode === 'admin' ? '管理员登录' : '登录个人邮箱空间'}</Text>
        {mode !== 'admin' && <Field label="用户名" autoCapitalize="none" autoCorrect={false}
          value={username} onChangeText={setUsername} autoComplete="username" />}
        <Field label="密码" secureTextEntry autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          value={password} onChangeText={setPassword} onSubmitEditing={() => void submit()} />
        <Notice text={error} error />
        <Action label={busy ? '正在验证…' : mode === 'register' ? '注册' : '登录'} onPress={() => void submit()}
          disabled={!!invalid} primary />
      </View>
      <View style={styles.row}>
        {([['login', '个人登录'], ['register', '注册账号'], ['admin', '管理员登录']] as const).filter(([key]) => key !== mode).map(([key, label]) =>
          <Action key={key} label={label} disabled={busy} onPress={() => { setMode(key); setError(''); }} />)}
      </View>
    </ScrollView>
  </KeyboardAvoidingView>;
}

export default function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState('');

  const forget = useCallback(() => {
    setIdentity(null);
    void SecureStore.deleteItemAsync(sessionKey).catch((error) => setError(message(error)));
  }, []);

  useEffect(() => {
    let active = true;
    async function restore() {
      try {
        const token = await SecureStore.getItemAsync(sessionKey);
        if (!token) return;
        const result = await mobileApi(token).session();
        if (!active) return;
        if (result.authenticated && result.user) setIdentity({ token, user: result.user.email });
        else await SecureStore.deleteItemAsync(sessionKey);
      } catch (error) { if (active) setError(message(error)); }
      finally { if (active) setStarting(false); }
    }
    void restore();
    return () => { active = false; };
  }, []);

  return <SafeAreaProvider>
    <SafeAreaView style={styles.screen}>
      {starting ? <Loading /> : identity ? <Mailbox token={identity.token} user={identity.user} onLogout={forget} /> :
        <><Notice text={error} error /><SignIn onLogin={async (next) => {
          await SecureStore.setItemAsync(sessionKey, next.token);
          setError('');
          setIdentity(next);
        }} /></>}
    </SafeAreaView>
  </SafeAreaProvider>;
}
