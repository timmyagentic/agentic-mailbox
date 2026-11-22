import { useRef, useState } from 'react';
import { Alert, BackHandler, KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { useEffect } from 'react';
import { getDocumentAsync } from 'expo-document-picker';
import { File } from 'expo-file-system';
import type { DraftInput, MailAlias, MailDraft } from '../../src/shared/types';
import { message, type MobileApi } from './api';
import { Action, Field, Header, Notice, styles } from './ui';

export default function Compose({ api, initial, senders, aiEnabled, close }: {
  api: MobileApi; initial: DraftInput | MailDraft; senders: Pick<MailAlias, 'id' | 'address'>[]; aiEnabled: boolean; close: (notice?: string) => void;
}) {
  const existing = 'id' in initial ? initial : null;
  const [input, setInput] = useState<DraftInput>(initial);
  const [draft, setDraft] = useState<MailDraft | null>(existing);
  const [instruction, setInstruction] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const lock = useRef(false);
  const blocked = !!draft && draft.status !== 'draft';
  const title = input.mode === 'reply' ? '回复' : input.mode === 'forward' ? '转发' : '写信';

  function change(values: Partial<DraftInput>) {
    setInput(current => ({ ...current, ...values }));
    setDirty(true);
  }
  async function save() {
    const result = await api.saveDraft({
      aliasId: input.aliasId, to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject,
      mode: input.mode, sourceEmailId: input.sourceEmailId, bodyText: input.bodyText, bodyHtml: input.bodyHtml,
      includeOriginalFiles: input.includeOriginalFiles,
    }, draft?.id);
    setDraft(result.draft);
    setDirty(false);
    return result.draft;
  }
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(false);
    setNotice('');
    try { await action(); }
    catch (error) {
      setError(true);
      setNotice(message(error));
      if (draft?.id) {
        const current = await api.draft(draft.id).catch(() => null);
        if (current) setDraft(current.draft);
      }
    } finally { lock.current = false; setBusy(false); }
  }
  function back() {
    if (lock.current) return;
    if (!dirty || blocked) return close();
    Alert.alert('退出写信？', '可以先保存当前修改。', [
      { text: '继续编辑', style: 'cancel' },
      { text: '不保存', style: 'destructive', onPress: () => close() },
      { text: '保存并退出', onPress: () => void run(async () => { await save(); close('草稿已保存。'); }) },
    ]);
  }
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => { back(); return true; });
    return () => listener.remove();
  });

  async function attach() {
    const result = await getDocumentAsync({ copyToCacheDirectory: true });
    if (result.canceled) return;
    const selected = result.assets[0];
    if (selected.size && selected.size > 5 * 1024 * 1024) throw new Error('附件不得超过 5 MiB。');
    const file = new File(selected.uri);
    try {
      const saved = await save();
      const uploaded = await api.addDraftFile(saved.id, file as unknown as Blob & { name: string }, selected.name);
      setDraft({ ...saved, files: [...saved.files, uploaded.file] });
    } finally {
      if (file.exists) file.delete();
    }
  }
  async function send() {
    const saved = await save();
    try {
      const sent = await api.sendDraft(saved.id);
      close(sent.rejected.length ? '邮件已提交，以下地址被拒绝：' + sent.rejected.join('、') : '邮件已发送。');
    } catch (error) {
      const current = await api.draft(saved.id).catch(() => null);
      if (current) setDraft(current.draft);
      throw error;
    }
  }

  return <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <Header title={title} back={back} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Notice text={blocked ? '该草稿正在发送、已发送或结果不确定，请先检查已发送邮件。' : undefined} error />
      <Text style={styles.heading}>发件账号</Text>
      <View style={styles.row}>{senders.map(alias => <Action key={alias.id} label={alias.address}
        disabled={blocked || !!busy || input.mode === 'reply'} primary={alias.id === input.aliasId}
        onPress={() => change({ aliasId: alias.id })} />)}</View>
      {!input.aliasId && <Text style={styles.muted}>先在邮箱设置连接一个发件账号。</Text>}
      <Field label="收件人" value={input.to} onChangeText={to => change({ to })} editable={!busy && !blocked} autoCapitalize="none" keyboardType="email-address" />
      <Field label="抄送" value={input.cc} onChangeText={cc => change({ cc })} editable={!busy && !blocked} autoCapitalize="none" keyboardType="email-address" />
      <Field label="密送" value={input.bcc} onChangeText={bcc => change({ bcc })} editable={!busy && !blocked} autoCapitalize="none" keyboardType="email-address" />
      <Field label="主题" value={input.subject} onChangeText={subject => change({ subject })} editable={!busy && !blocked} />
      <Field label="正文" value={input.bodyText} onChangeText={bodyText => change({ bodyText, bodyHtml: '' })} editable={!busy && !blocked} multiline />
      <View style={styles.row}>
        <Action label="添加附件" disabled={busy || blocked || !input.aliasId} onPress={() => void run(attach)} />
        {input.mode === 'forward' && <Action label={input.includeOriginalFiles ? '包含原附件 ✓' : '包含原附件'}
          disabled={busy || blocked} onPress={() => change({ includeOriginalFiles: !input.includeOriginalFiles })} />}
      </View>
      {draft?.files.map(file => <View key={file.id} style={styles.row}>
        <Text style={styles.text}>{file.filename}</Text><Action label="移除" disabled={busy || blocked} onPress={() => void run(async () => {
          await api.removeDraftFile(draft.id, file.id);
          setDraft({ ...draft, files: draft.files.filter(item => item.id !== file.id) });
        })} />
      </View>)}
      {aiEnabled && !blocked && <View style={styles.card}>
        <Text style={styles.heading}>AI 草稿</Text>
        <Field label="起草要求" value={instruction} onChangeText={setInstruction} editable={!busy} />
        <Action label="生成草稿" disabled={busy || !input.aliasId || !instruction.trim()} onPress={() => void run(async () => {
          const saved = await save();
          const { text } = await api.suggestDraft(saved.id, instruction.trim());
          change({ bodyText: text, bodyHtml: '' });
          setNotice('已填入正文，请先检查再发送。');
        })} />
      </View>}
      <Notice text={notice} error={error} />
      <View style={styles.row}>
        <Action label="保存草稿" disabled={busy || blocked || !input.aliasId} onPress={() => void run(async () => {
          await save(); setNotice('草稿已保存。');
        })} />
        <Action label={busy ? '处理中…' : '发送'} primary disabled={busy || blocked || !input.aliasId || !input.to.trim()}
          onPress={() => Alert.alert('确认发送？', input.to, [{ text: '取消', style: 'cancel' }, { text: '发送', onPress: () => void run(send) }])} />
      </View>
      {draft && !blocked && <Action label="删除草稿" disabled={busy} onPress={() => Alert.alert('删除草稿？', '草稿及其附件将被删除。', [
        { text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: () => void run(async () => {
          await api.discardDraft(draft.id); close('草稿已删除。');
        }) },
      ])} />}
    </ScrollView>
  </KeyboardAvoidingView>;
}
