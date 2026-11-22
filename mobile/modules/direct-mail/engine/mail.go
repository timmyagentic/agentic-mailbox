// Package directmail implements the on-device QQ and 163 IMAP/SMTP transport.
package directmail

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/mail"
	"net/smtp"
	"strings"
	"time"

	"github.com/emersion/go-imap"
	id "github.com/emersion/go-imap-id"
	"github.com/emersion/go-imap/client"
	_ "github.com/emersion/go-message/charset"
	mime "github.com/emersion/go-message/mail"
	"golang.org/x/net/html"
)

func domain(address string) (string, error) {
	parsed, err := mail.ParseAddress(address)
	if err != nil || parsed.Address != address {
		return "", errors.New("请输入完整的邮箱地址")
	}
	_, d, _ := strings.Cut(address, "@")
	switch strings.ToLower(d) {
	case "qq.com", "foxmail.com":
		return "qq.com", nil
	case "163.com":
		return "163.com", nil
	}
	return "", errors.New("请选择 QQ、Foxmail 或 163 邮箱")
}

type dialMail func(host, port string) (net.Conn, error)

func connection(host, port string) (net.Conn, error) {
	c, e := tls.DialWithDialer(&net.Dialer{Timeout: 12 * time.Second}, "tcp", net.JoinHostPort(host, port), &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
	if e != nil {
		return nil, errors.New("无法建立安全连接，请检查网络")
	}
	if e = c.SetDeadline(time.Now().Add(40 * time.Second)); e != nil {
		c.Close()
		return nil, e
	}
	return c, nil
}

func selectInbox(conn net.Conn, address, pass, d string) (*client.Client, *imap.MailboxStatus, error) {
	c, e := client.New(conn)
	if e != nil {
		return nil, nil, e
	}
	c.Timeout = 30 * time.Second
	if e = c.Login(address, pass); e != nil {
		return nil, nil, errors.New("邮箱登录失败，请检查 IMAP/SMTP 开关和客户端授权码")
	}
	if d == "163.com" {
		ext := id.NewClient(c)
		supported, err := ext.SupportID()
		if err != nil {
			return nil, nil, err
		}
		if supported {
			if _, err = ext.ID(id.ID{id.FieldName: "Agentic Mailbox", id.FieldVersion: "1"}); err != nil {
				return nil, nil, err
			}
		}
	}
	box, e := c.Select("INBOX", d != "163.com")
	return c, box, e
}

type entry struct {
	UID     uint32 `json:"uid"`
	Subject string `json:"subject"`
	From    string `json:"from"`
	Date    int64  `json:"date"`
}
type inboxResult struct {
	Validity uint32  `json:"validity"`
	Messages []entry `json:"messages"`
}

func list(c *client.Client, box *imap.MailboxStatus) (string, error) {
	result := inboxResult{box.UidValidity, []entry{}}
	if box.Messages > 0 {
		first := uint32(1)
		if box.Messages > 40 {
			first = box.Messages - 39
		}
		seq := new(imap.SeqSet)
		seq.AddRange(first, box.Messages)
		msgs := make(chan *imap.Message, 40)
		done := make(chan error, 1)
		go func() { done <- c.Fetch(seq, []imap.FetchItem{imap.FetchUid, imap.FetchEnvelope}, msgs) }()
		for m := range msgs {
			if m.Envelope == nil {
				continue
			}
			e := m.Envelope
			from := ""
			if len(e.From) > 0 {
				from = e.From[0].Address()
			}
			result.Messages = append(result.Messages, entry{m.Uid, e.Subject, from, e.Date.UnixMilli()})
		}
		if err := <-done; err != nil {
			return "", err
		}
	}
	b, e := json.Marshal(result)
	return string(b), e
}

// Inbox fetches a bounded window of recent envelopes without changing read flags.
func Inbox(address, password string) (string, error) {
	return dialMail(connection).inbox(address, password)
}

func (dial dialMail) inbox(address, password string) (string, error) {
	d, e := domain(address)
	if e != nil {
		return "", e
	}
	conn, e := dial("imap."+d, "993")
	if e != nil {
		return "", e
	}
	defer conn.Close()
	c, box, e := selectInbox(conn, address, password, d)
	if e != nil {
		return "", e
	}
	defer c.Logout()
	return list(c, box)
}

func htmlText(s string) string {
	z := html.NewTokenizer(strings.NewReader(s))
	var text strings.Builder
	ignore := ""
	for {
		switch z.Next() {
		case html.ErrorToken:
			return strings.TrimSpace(text.String())
		case html.StartTagToken, html.EndTagToken:
			name, _ := z.TagName()
			tag := string(name)
			if tag == "script" || tag == "style" {
				if ignore == tag {
					ignore = ""
				} else {
					ignore = tag
				}
			}
			if tag == "p" || tag == "br" || tag == "div" {
				text.WriteByte('\n')
			}
		case html.TextToken:
			if ignore == "" {
				text.Write(z.Text())
			}
		}
	}
}

func readBody(r io.Reader) (string, error) {
	mr, e := mime.CreateReader(r)
	if e != nil {
		return "", e
	}
	defer mr.Close()
	var fallback string
	for {
		p, e := mr.NextPart()
		if e == io.EOF {
			break
		}
		if e != nil {
			return "", errors.New("邮件正文解码失败")
		}
		h, ok := p.Header.(*mime.InlineHeader)
		if !ok {
			continue
		}
		kind, _, _ := h.ContentType()
		if kind != "text/plain" && kind != "text/html" {
			continue
		}
		b, e := io.ReadAll(io.LimitReader(p.Body, 512<<10))
		if e != nil {
			return "", e
		}
		if kind == "text/plain" {
			return string(b), nil
		}
		if fallback == "" {
			fallback = htmlText(string(b))
		}
	}
	return fallback, nil
}

// Read resolves a UID only in its original UIDVALIDITY epoch.
func Read(address, password string, validity, uid int64) (string, error) {
	return dialMail(connection).read(address, password, validity, uid)
}

func (dial dialMail) read(address, password string, validity, uid int64) (string, error) {
	d, e := domain(address)
	if e != nil {
		return "", e
	}
	conn, e := dial("imap."+d, "993")
	if e != nil {
		return "", e
	}
	defer conn.Close()
	c, box, e := selectInbox(conn, address, password, d)
	if e != nil {
		return "", e
	}
	defer c.Logout()
	if int64(box.UidValidity) != validity || uid < 1 || uid > 1<<32-1 {
		return "", errors.New("邮箱已变化，请重新刷新")
	}
	seq := new(imap.SeqSet)
	seq.AddNum(uint32(uid))
	part := &imap.BodySectionName{Peek: true, Partial: []int{0, 4 << 20}}
	msgs := make(chan *imap.Message, 1)
	e = c.UidFetch(seq, []imap.FetchItem{part.FetchItem()}, msgs)
	if e != nil {
		return "", e
	}
	m := <-msgs
	if m == nil || m.GetBody(part) == nil {
		return "", errors.New("邮件已移走，请刷新收件箱")
	}
	return readBody(m.GetBody(part))
}

func compose(address, to, subject, body string) ([]byte, string, error) {
	if strings.ContainsAny(to+subject, "\r\n") || len(body) > 2<<20 {
		return nil, "", errors.New("无效的收件人、主题或正文")
	}
	dest, e := mail.ParseAddress(to)
	if e != nil {
		return nil, "", errors.New("请填写一个有效的收件地址")
	}
	var h mime.Header
	h.SetAddressList("From", []*mime.Address{{Address: address}})
	h.SetAddressList("To", []*mime.Address{dest})
	h.SetDate(time.Now())
	if e = h.GenerateMessageIDWithHostname(strings.Split(address, "@")[1]); e != nil {
		return nil, "", e
	}
	h.SetSubject(subject)
	h.SetContentType("text/plain", map[string]string{"charset": "utf-8"})
	var buf bytes.Buffer
	w, e := mime.CreateSingleInlineWriter(&buf, h)
	if e != nil {
		return nil, "", e
	}
	if _, e = io.WriteString(w, body); e != nil {
		return nil, "", e
	}
	if e = w.Close(); e != nil {
		return nil, "", e
	}
	return buf.Bytes(), dest.Address, nil
}

// Send returns success only after the server accepts the complete DATA command.
func Send(address, password, to, subject, body string) error {
	return dialMail(connection).send(address, password, to, subject, body)
}

func (dial dialMail) send(address, password, to, subject, body string) error {
	d, e := domain(address)
	if e != nil {
		return e
	}
	raw, rcpt, e := compose(address, to, subject, body)
	if e != nil {
		return e
	}
	host := "smtp." + d
	conn, e := dial(host, "465")
	if e != nil {
		return e
	}
	defer conn.Close()
	c, e := smtp.NewClient(conn, host)
	if e != nil {
		return e
	}
	defer c.Close()
	if e = c.Auth(smtp.PlainAuth("", address, password, host)); e != nil {
		return errors.New("SMTP 授权失败，请检查授权码和发信权限")
	}
	if e = c.Mail(address); e != nil {
		return errors.New("服务商拒绝发件地址")
	}
	if e = c.Rcpt(rcpt); e != nil {
		return errors.New("服务商拒绝收件地址")
	}
	w, e := c.Data()
	if e != nil {
		return errors.New("服务商暂时无法接收邮件")
	}
	if _, e = w.Write(raw); e != nil {
		return errors.New("发送结果未知，请核对后再试")
	}
	if e = w.Close(); e != nil {
		return errors.New("未收到投递确认，请核对后再试")
	}
	return nil
}
