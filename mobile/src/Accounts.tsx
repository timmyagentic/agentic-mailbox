import { useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { BootstrapPayload, OAuthProvider } from '../../src/shared/types';
import { message, type MobileApi } from './api';
import { providers } from './mail';
import { Action, Field, Header, Notice, styles } from './ui';

type Choice = 'qq' | 'netease163' | OAuthProvider;
const choices: Choice[] = ['qq', 'netease163', 'gmail', 'outlook'];

export default function Accounts({ api, data, back, changed, logout }: {
  api: MobileApi; data: BootstrapPayload | null; back: () => void; changed: () => Promise<void>; logout: () => void;
}) {
  const [choice, setChoice] = useState<Choice>('qq');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const oauth = choice === 'gmail' || choice === 'outlook';

  async function run(action: () => Promise<string>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setFailed(false);
    setNotice('');
    try { setNotice(await action()); }
    catch (error) { setFailed(true); setNotice(message(error)); }
    finally { lock.current = false; setBusy(false); }
  }

  async function authorize(provider: OAuthProvider, id?: string) {
    const result = await api.connectOAuth(provider, id);
    if (!result) return '已取消邮箱授权。';
    await changed();
    const { result: synced } = await api.refreshMailAccount(result.accountId);
    await changed();
    if (synced.error) throw new Error(synced.error);
    return '已接入，导入 ' + synced.imported + ' 封邮件。';
  }

  async function connect() {
    if (oauth) return authorize(choice);
    const address = email.trim();
    const domain = address.split('@').pop()?.toLowerCase() || '';
    if (choice === 'qq' ? !['qq.com', 'foxmail.com'].includes(domain) : domain !== '163.com') {
      throw new Error('请输入所选服务商的邮箱地址。');
    }
    const { account } = await api.saveMailAccount({ email: address, authorizationCode: code });
    setCode('');
    await changed();
    const { result } = await api.refreshMailAccount(account.id);
    await changed();
    if (result.error) throw new Error(result.error);
    setEmail('');
    return '已接入，导入 ' + result.imported + ' 封邮件。';
  }

  return <View style={styles.screen}>
    <Header title="邮箱设置" back={back} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.heading}>接入邮箱</Text>
        <View style={styles.row}>{choices.map(key =>
          <Action key={key} label={providers[key]} primary={key === choice} disabled={busy} onPress={() => {
            setChoice(key); setEmail(''); setCode(''); setNotice('');
          }} />)}</View>
        {oauth ? <Text style={styles.muted}>
          {data?.oauthProviders?.includes(choice) ? '将在系统浏览器打开邮箱服务商授权，完成后返回 App。' : '此服务器尚未配置该服务商的 OAuth。'}
        </Text> : <>
          <Text style={styles.muted}>在邮箱网页登录并启用 IMAP/SMTP，复制邮箱客户端授权码。</Text>
          <Field label="邮箱地址" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
          <Field label="客户端授权码" autoCapitalize="none" secureTextEntry value={code} onChangeText={setCode} />
        </>}
        <Action label={busy ? '正在处理…' : oauth ? '前往授权' : '连接邮箱'} primary onPress={() => void run(connect)}
          disabled={busy || (oauth ? !data?.oauthProviders?.includes(choice) : !email.trim() || !code.trim())} />
        <Notice text={notice} error={failed} />
      </View>
      <Text style={styles.heading}>已连接邮箱</Text>
      {!data?.mailAccounts.length && <Text style={styles.muted}>还没有已连接的邮箱。</Text>}
      {data?.mailAccounts.map(account => <View key={account.id} style={styles.card}>
        <Text style={styles.heading}>{account.address}</Text>
        <Text style={styles.muted}>{providers[account.provider]} · {account.lastSyncAt ? new Date(account.lastSyncAt).toLocaleString() : '未同步'}</Text>
        <View style={styles.row}>
          <Action label="刷新" disabled={busy} onPress={() => void run(async () => {
            const { result } = await api.refreshMailAccount(account.id);
            await changed();
            if (result.error) throw new Error(result.error);
            return '导入 ' + result.imported + ' 封邮件。';
          })} />
          <Action label={account.provider === 'gmail' || account.provider === 'outlook' ? '重新授权' : '更新授权码'} disabled={busy} onPress={() => {
            const provider = account.provider;
            if (provider === 'gmail' || provider === 'outlook') void run(() => authorize(provider, account.id));
            else if (provider === 'qq' || provider === 'netease163') { setChoice(provider); setEmail(account.address); setCode(''); }
          }} />
        </View>
      </View>)}
      <Action label="退出登录" onPress={logout} disabled={busy} />
    </ScrollView>
  </View>;
}
