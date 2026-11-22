import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Action, Field, Header, Notice, styles } from './ui';
import * as mail from './direct-mail';

export default function DirectInbox({ hosted }: { hosted: () => void }) {
  const [accounts, setAccounts] = useState<string[]>([]);
  const [letters, setLetters] = useState<mail.Letter[]>([]);
  const [view, setView] = useState<'inbox'|'add'|'import'|'read'|'write'>('inbox');
  const [selected, setSelected] = useState<mail.Letter>();
  const [text, setText] = useState('');
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [pair, setPair] = useState('');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [permission, askCamera] = useCameraPermissions();

  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setNotice('');
    try { await action(); }
    catch (err) { setNotice(err instanceof Error ? err.message : '操作失败，请检查网络。'); }
    finally { lock.current = false; setBusy(false); }
  }
  function update(account: string, items: mail.Letter[]) {
    setLetters(old => [...old.filter(item => item.address !== account), ...items].sort((a,b) => b.date-a.date));
  }
  async function refresh(list: string[]) {
    const failed: string[] = [];
    await Promise.all(list.map(async account => {
      try { update(account, await mail.inbox(account)); }
      catch (e) { failed.push(account+' · '+(e instanceof Error ? e.message : '刷新失败')); }
    }));
    setNotice(failed.join('\n') || (list.length ? '收件箱已刷新。' : ''));
  }
  useEffect(() => { void run(async () => {
    const saved = await mail.addresses(); setAccounts(saved); await refresh(saved);
  }); }, []);
  function back() { if (lock.current) return; setCode(''); setPair(''); setNotice(''); setView('inbox'); }
  async function add(email: string, password: string) {
    const normalized = mail.normalize(email);
    const rows = await mail.connect(normalized, password);
    setAccounts(await mail.addresses()); update(normalized, rows); setAddress(''); setCode(''); setPair('');
    setView('inbox'); setNotice(normalized+' 已连接。');
  }
  function scan(value: string) {
    if (lock.current || !pair) return;
    try {
      const data = mail.unpack(value, pair);
      setPair(''); setAddress(data.address); setCode(data.password); setView('add'); setNotice('已解密，请确认要连接的邮箱。');
    } catch (e) { setNotice(e instanceof Error ? e.message : '无法导入。'); }
  }
  function compose(sender: string) { setAddress(sender); setTo(''); setSubject(''); setBody(''); setNotice(''); setView('write'); }
  function confirmSend() {
    Alert.alert('发送邮件', address+' → '+to+'\n'+subject, [{text:'取消',style:'cancel'}, {text:'确认发送',onPress:() => void run(async () => {
      await mail.send(address,to,subject,body); setBody(''); setView('inbox'); setNotice('发件服务器已接收邮件。');
    })}]);
  }
  const titles = { inbox:'手机收件箱', add:'添加邮箱', import:'从 Mac 导入', read:'阅读邮件', write:'写信' };
  return <View style={styles.screen}><Header title={titles[view]} back={view==='inbox' ? undefined : back}/>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Notice text={busy ? '正在连接…' : notice}/>
      {view==='inbox' && <>
        <View style={styles.row}><Action label="添加邮箱" disabled={busy} onPress={()=>{setAddress('');setCode('');setNotice('');setView('add');}}/>
          <Action label="从 Mac 导入" disabled={busy} onPress={()=>{setPair(mail.pairingCode());setNotice('');setView('import');}}/>
          {!!accounts.length && <><Action label="刷新全部" disabled={busy} onPress={()=>void run(()=>refresh(accounts))}/>
            <Action label="写信" disabled={busy} primary onPress={()=>compose(accounts[0])}/></>}</View>
        {accounts.length ? <Text style={styles.muted}>{accounts.join(' · ')}</Text> :
          <Text style={styles.text}>添加 QQ 或 163 邮箱后，手机可以直接收发邮件。</Text>}
        {letters.map(item=><Pressable key={item.address+'/'+item.validity+'/'+item.uid} style={styles.card} disabled={busy}
          onPress={()=>void run(async()=>{const value=await mail.read(item);setText(value);setSelected(item);setView('read');})}>
          <Text style={styles.heading}>{item.subject || '无主题'}</Text><Text style={styles.text}>{item.from}</Text>
          <Text style={styles.muted}>{item.address} · {new Date(item.date).toLocaleString()}</Text></Pressable>)}
        <Action label="进入托管邮箱" disabled={busy} onPress={hosted}/>
      </>}
      {view==='import' && <>
        <Text style={styles.text}>在 Mac 应用窗口点「导入到手机」，选择邮箱并输入此配对码，再用本机扫描二维码。</Text>
        <Text selectable style={styles.heading}>{pair.match(/.{1,4}/g)?.join(' ')}</Text>
        {permission?.granted ? <CameraView style={{height:280}} barcodeScannerSettings={{barcodeTypes:['qr']}}
          onBarcodeScanned={({data})=>scan(data)}/> : <Action label="允许使用相机" onPress={()=>void askCamera()}/>}
      </>}
      {view==='add' && <><Field label="邮箱地址" value={address} onChangeText={setAddress} autoCapitalize="none" keyboardType="email-address" editable={!busy}/>
        <Field label="客户端授权码" secureTextEntry autoCapitalize="none" value={code} onChangeText={setCode} editable={!busy}/>
        <Text style={styles.muted}>在邮箱网页版启用 IMAP/SMTP，填写该邮箱生成的客户端授权码。</Text>
        <Action label="连接并收信" primary disabled={busy||!address.trim()||!code.trim()} onPress={()=>void run(()=>add(address,code.trim()))}/></>}
      {view==='read' && selected && <><Text style={styles.heading}>{selected.subject}</Text><Text>{selected.from}</Text>
        <Text selectable style={styles.text}>{text || '这封邮件没有可显示的正文。'}</Text></>}
      {view==='write' && <><Text style={styles.label}>发件邮箱</Text><View style={styles.row}>{accounts.map(account=>
        <Action key={account} label={account} primary={account===address} disabled={busy} onPress={()=>setAddress(account)}/>)}</View>
        <Field label="收件地址" value={to} onChangeText={setTo} editable={!busy} keyboardType="email-address" autoCapitalize="none"/>
        <Field label="主题" value={subject} onChangeText={setSubject} editable={!busy}/>
        <Field label="正文" value={body} multiline onChangeText={setBody} editable={!busy}/>
        <Action label="发送" primary disabled={busy||!to.trim()||!body.trim()} onPress={confirmSend}/></>}
    </ScrollView></View>;
}
