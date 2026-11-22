import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, FlatList, Pressable, ScrollView, Text, View } from 'react-native';
import type { BootstrapPayload, Conversation, ConversationSummary, DraftInput, DraftMode, EmailDetail, MailDraft } from '../../src/shared/types';
import Accounts from './Accounts';
import { message, mobileApi, type MobileApi } from './api';
import Compose from './Compose';
import { mailText, makeDraft } from './mail';
import { Action, Field, Header, Loading, Notice, palette, styles } from './ui';

const folders = [
  ['inbox', '收件箱'], ['sent', '已发送'], ['drafts', '草稿'], ['archive', '归档'], ['trash', '废纸篓'],
] as const;
type Folder = typeof folders[number][0];
type Screen = { name: 'inbox' | 'accounts' } | { name: 'reader'; id: string; starred: boolean }
  | { name: 'compose'; draft: DraftInput | MailDraft; previous?: { name: 'reader'; id: string; starred: boolean } };

function Reader({ api, id, starred, folder, back, compose }: {
  api: MobileApi; id: string; starred: boolean; folder: Folder; back: () => void;
  compose: (mode: DraftMode, mail: EmailDetail) => void;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [flag, setFlag] = useState(starred);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setNotice('');
    try {
      const data = await api.conversation(id, signal);
      if (signal?.aborted) return;
      setConversation(data);
      if (data.messages.some(mail => !mail.readAt && !mail.outgoing)) {
        await api.markConversation(id, true);
      }
    } catch (error) { if (!signal?.aborted) setNotice(message(error)); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [api, id]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setNotice('');
    setBusy(true);
    try { await action(); } catch (error) { setNotice(message(error)); }
    finally { lock.current = false; setBusy(false); }
  }

  const latest = conversation?.messages.find(mail => mail.id === id) || conversation?.messages.at(-1);
  function move(target: 'archive' | 'trash' | 'restore') {
    void run(async () => { await api.placeEmail(id, { folder: target }); back(); });
  }

  return <View style={styles.screen}>
    <Header title={latest?.subject || '邮件会话'} subtitle={latest?.aliasAddress} back={back} />
    <ScrollView contentContainerStyle={styles.content}>
      {loading && <Loading />}
      <Notice text={notice} error />
      {!conversation && !loading && <Action label="重新加载" onPress={() => void load()} />}
      {latest && <View style={styles.row}>
        <Action label={flag ? '取消星标' : '星标'} disabled={busy} onPress={() => void run(async () => {
          await api.placeEmail(id, { starred: !flag }); setFlag(!flag);
        })} />
        <Action label="标为未读" disabled={busy} onPress={() => void run(async () => { await api.markConversation(id, false); back(); })} />
        {(folder === 'trash' || folder === 'archive') && <Action label="移回收件箱" disabled={busy} onPress={() => move('restore')} />}
        {folder === 'inbox' && <Action label="归档" disabled={busy} onPress={() => move('archive')} />}
        {folder !== 'trash' && <Action label="移到废纸篓" disabled={busy} onPress={() => move('trash')} />}
      </View>}
      {conversation?.messages.map(mail => <View key={mail.id} style={styles.card}>
        <Text style={styles.heading} selectable>{mail.fromName || mail.fromAddress}</Text>
        <Text style={styles.muted} selectable>{mail.fromAddress} → {mail.toAddress}</Text>
        <Text style={styles.muted}>{new Date(mail.sentAt || mail.receivedAt).toLocaleString()}</Text>
        <Text selectable style={styles.text}>{mailText(mail) || '（无正文）'}</Text>
        {mail.attachments.map(attachment => <Action key={attachment.id} label={'打开附件 · ' + attachment.filename}
          disabled={busy} onPress={() => void run(() => api.shareAttachment(attachment))} />)}
        <View style={styles.row}>
          <Action label="回复" disabled={busy} onPress={() => compose('reply', mail)} />
          <Action label="转发" disabled={busy} onPress={() => compose('forward', mail)} />
        </View>
      </View>)}
    </ScrollView>
  </View>;
}

export default function Mailbox({ token, user, onLogout }: { token: string; user: string; onLogout: () => void }) {
  const api = useMemo(() => mobileApi(token, onLogout), [token, onLogout]);
  const [screen, setScreen] = useState<Screen>({ name: 'inbox' });
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [folder, setFolder] = useState<Folder>('inbox');
  const [source, setSource] = useState('');
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [threads, setThreads] = useState<ConversationSummary[]>([]);
  const [drafts, setDrafts] = useState<MailDraft[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshLock = useRef(false);
  const revision = useRef(0);
  const mailAccounts = bootstrap?.mailAccounts ?? [];
  const aliases = bootstrap?.recentAliases ?? [];
  const senders = [...mailAccounts, ...aliases.filter(alias => alias.status === 'active')];
  const sources = [...mailAccounts, ...aliases];

  const loadBootstrap = useCallback(async () => {
    const [value, { aliases }] = await Promise.all([api.bootstrap(), api.aliases()]);
    const data = { ...value, recentAliases: aliases };
    setBootstrap(data);
    return data;
  }, [api]);

  const load = useCallback(async (next = 1) => {
    const current = ++revision.current;
    setLoading(true);
    setError('');
    try {
      if (folder === 'drafts') {
        const result = await api.drafts();
        if (current === revision.current) setDrafts(result.drafts);
      } else {
        const result = await api.conversations({ folder, aliasId: source, query: appliedQuery, page: next });
        if (current !== revision.current) return;
        setThreads(previous => next === 1 ? result.conversations : [
          ...previous, ...result.conversations.filter(item => !previous.some(row => row.id === item.id)),
        ]);
        setTotal(result.total);
        setPage(next);
      }
    } catch (error) { if (current === revision.current) setError(message(error)); }
    finally { if (current === revision.current) setLoading(false); }
  }, [api, folder, source, appliedQuery]);

  useEffect(() => { void loadBootstrap().catch(error => setError(message(error))); }, [loadBootstrap]);
  useEffect(() => {
    setThreads([]);
    setDrafts([]);
    setTotal(0);
    void load();
    return () => { revision.current++; };
  }, [load]);

  const back = useCallback(() => {
    setScreen({ name: 'inbox' });
    void load();
  }, [load]);

  useEffect(() => {
    if (screen.name === 'inbox' || screen.name === 'compose') return;
    const listener = BackHandler.addEventListener('hardwareBackPress', () => { back(); return true; });
    return () => listener.remove();
  }, [screen.name, back]);

  async function refresh() {
    if (refreshLock.current) return;
    refreshLock.current = true;
    setRefreshing(true);
    setError('');
    setNotice('');
    try {
      const data = bootstrap ?? await loadBootstrap();
      let imported = 0;
      let more = 0;
      const errors: string[] = [];
      for (const account of data.mailAccounts) {
        try {
          const { result } = await api.refreshMailAccount(account.id);
          imported += result.imported;
          if (result.hasMore) more++;
          if (result.error) errors.push(account.address + '：' + result.error);
        } catch (error) { errors.push(account.address + '：' + message(error)); }
      }
      await Promise.all([loadBootstrap(), load()]);
      if (errors.length) setError(errors.join('\n'));
      if (data.mailAccounts.length) setNotice('导入 ' + imported + ' 封邮件。' + (more ? '还有邮件可继续刷新。' : ''));
    } catch (error) { setError(message(error)); }
    finally { refreshLock.current = false; setRefreshing(false); }
  }

  function compose(mode: DraftMode, sourceEmail?: EmailDetail) {
    const preferred = sourceEmail?.aliasId || source;
    const alias = mode === 'reply' && sourceEmail ? sourceEmail.aliasId :
      senders.find(item => item.id === preferred)?.id || senders[0]?.id || '';
    setScreen({ name: 'compose', draft: makeDraft(alias, mode, sourceEmail), previous: screen.name === 'reader' ? screen : undefined });
  }

  if (screen.name === 'accounts') return <Accounts api={api} data={bootstrap} back={back}
    changed={async () => { await Promise.all([loadBootstrap(), load()]); }}
    logout={() => { onLogout(); }} />;
  if (screen.name === 'reader') return <Reader key={screen.id} api={api} id={screen.id} starred={screen.starred} folder={folder}
    back={back} compose={compose} />;
  if (screen.name === 'compose') return <Compose key={'id' in screen.draft ? screen.draft.id : 'new'} api={api}
    initial={screen.draft} senders={senders} aiEnabled={bootstrap?.local !== true}
    close={(text) => {
      setNotice(text ?? '');
      if (screen.previous && !text) setScreen(screen.previous);
      else back();
    }} />;

  const header = <View style={{ gap: 10 }}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {folders.map(([key, label]) => <Action key={key} label={label} primary={folder === key} onPress={() => setFolder(key)} />)}
    </ScrollView>
    {folder !== 'drafts' && <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        <Action label="全部邮箱" primary={!source} onPress={() => setSource('')} />
        {sources.map(alias => <Action key={alias.id} label={alias.address} primary={source === alias.id} onPress={() => setSource(alias.id)} />)}
      </ScrollView>
      <View style={[styles.row, { alignItems: 'flex-end' }]}>
        <View style={{ flex: 1 }}>
          <Field label="搜索邮件" placeholder="发件人、主题或正文" value={query} onChangeText={setQuery} onSubmitEditing={() => setAppliedQuery(query.trim())} />
        </View>
        <Action label="搜索" onPress={() => setAppliedQuery(query.trim())} />
        {!!appliedQuery && <Action label="清除" onPress={() => { setQuery(''); setAppliedQuery(''); }} />}
      </View>
    </>}
    <Notice text={notice} />
    <Notice text={error} error />
    {!bootstrap && !loading && <Action label="重新载入邮箱" onPress={() => void refresh()} />}
  </View>;
  const empty = loading ? <Loading /> : <View style={styles.card}>
    <Text style={styles.heading}>{folder === 'drafts' ? '没有草稿' : appliedQuery ? '没有搜索结果' : '这里还没有邮件'}</Text>
    {!bootstrap?.mailAccounts.length && folder === 'inbox' && <Action label="接入邮箱" onPress={() => setScreen({ name: 'accounts' })} />}
  </View>;

  return <View style={styles.screen}>
    <Header title={folders.find(([key]) => key === folder)?.[1] || '收件箱'} subtitle={user}>
      <Action label="设置" onPress={() => setScreen({ name: 'accounts' })} />
      <Action label="写信" primary onPress={() => compose('new')} />
    </Header>
    <View style={{ paddingHorizontal: 16 }}>
      <Action label={refreshing ? '正在刷新…' : '一键刷新'} disabled={refreshing} onPress={() => void refresh()} />
    </View>
    {folder === 'drafts' ? <FlatList data={drafts} keyExtractor={item => item.id} contentContainerStyle={styles.content}
      ListHeaderComponent={header} ListEmptyComponent={empty} keyboardShouldPersistTaps="handled"
      renderItem={({ item }) => <Pressable accessibilityRole="button" style={styles.card} onPress={() => setScreen({ name: 'compose', draft: item })}>
        <Text style={styles.heading}>{item.subject || '（无主题）'}</Text>
        <Text style={styles.muted}>{item.to || '未填收件人'} · {item.status === 'uncertain' ? '发送结果不确定' : new Date(item.updatedAt).toLocaleString()}</Text>
      </Pressable>} />
    : <FlatList data={threads} keyExtractor={item => item.id} contentContainerStyle={styles.content} ListHeaderComponent={header}
      ListEmptyComponent={empty} keyboardShouldPersistTaps="handled" refreshing={refreshing} onRefresh={() => void refresh()}
      ListFooterComponent={threads.length < total ? <Action label={loading ? '正在载入…' : '加载更多'} disabled={loading} onPress={() => void load(page + 1)} /> : undefined}
      renderItem={({ item }) => <Pressable accessibilityRole="button" style={[styles.card, item.unreadCount > 0 && { borderLeftWidth: 4, borderLeftColor: palette.accent }]}
        onPress={() => setScreen({ name: 'reader', id: item.id, starred: item.starred })}>
        <Text style={styles.muted} numberOfLines={1}>{item.outgoing ? item.toAddress : item.fromName || item.fromAddress} · {new Date(item.receivedAt).toLocaleDateString()}</Text>
        <Text style={styles.heading} numberOfLines={1}>{item.starred ? '★ ' : ''}{item.subject || '（无主题）'}{item.threadCount > 1 ? ' · ' + item.threadCount : ''}</Text>
        <Text style={styles.text} numberOfLines={2}>{item.preview}</Text>
        <Text style={styles.muted} numberOfLines={1}>{item.aliasAddress}{item.attachmentCount ? ' · ' + item.attachmentCount + ' 个附件' : ''}</Text>
      </Pressable>} />}
  </View>;
}
