package directmail

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap"
	id "github.com/emersion/go-imap-id"
	"github.com/emersion/go-imap/backend"
	"github.com/emersion/go-imap/backend/memory"
	"github.com/emersion/go-imap/server"
)

type fixtureBackend struct {
	*memory.Backend
	address string
}

func (b fixtureBackend) Login(info *imap.ConnInfo, address, password string) (backend.User, error) {
	if address != b.address || password != "fixture-code" {
		return nil, backend.ErrInvalidCredentials
	}
	return b.Backend.Login(info, "username", "password")
}

// SMTP accepts exactly one message, then delivers its MIME bytes into the same
// IMAP mailbox so a successful send alone cannot satisfy the test.
func smtpFixture(conn net.Conn, inbox backend.Mailbox) error {
	defer conn.Close()
	reader := textproto.NewReader(bufio.NewReader(conn))
	fmt.Fprint(conn, "220 fixture ESMTP\r\n")
	for {
		line, e := reader.ReadLine()
		if e != nil {
			return e
		}
		switch {
		case strings.HasPrefix(line, "EHLO "):
			fmt.Fprint(conn, "250-fixture\r\n250 AUTH PLAIN\r\n")
		case strings.HasPrefix(line, "AUTH PLAIN "):
			fmt.Fprint(conn, "235 accepted\r\n")
		case strings.HasPrefix(line, "MAIL FROM:"), strings.HasPrefix(line, "RCPT TO:"):
			fmt.Fprint(conn, "250 OK\r\n")
		case line == "DATA":
			fmt.Fprint(conn, "354 Go ahead\r\n")
			data, e := reader.ReadDotBytes()
			if e != nil {
				return e
			}
			if e = inbox.CreateMessage(nil, time.Now(), bytes.NewReader(data)); e != nil {
				return e
			}
			_, e = fmt.Fprint(conn, "250 queued\r\n")
			return e
		default:
			return fmt.Errorf("unexpected SMTP command")
		}
	}
}

func TestSendThenReceive(t *testing.T) {
	for _, provider := range []string{"qq.com", "163.com"} {
		t.Run(provider, func(t *testing.T) {
			addr := "fixture@" + provider
			be := fixtureBackend{memory.New(), addr}
			user, _ := be.Login(nil, addr, "fixture-code")
			box, _ := user.GetMailbox("INBOX")
			cert := httptest.NewTLSServer(nil)
			defer cert.Close()
			listen := func() net.Listener {
				l, e := tls.Listen("tcp", "127.0.0.1:0", cert.TLS.Clone())
				if e != nil {
					t.Fatal(e)
				}
				return l
			}
			imapPort, smtpPort := listen(), listen()
			defer smtpPort.Close()
			s := server.New(be)
			s.Enable(id.NewExtension(id.ID{id.FieldName: "fixture"}))
			go s.Serve(imapPort)
			defer s.Close()
			sent := make(chan error, 1)
			go func() {
				c, e := smtpPort.Accept()
				if e == nil {
					e = smtpFixture(c, box)
				}
				sent <- e
			}()
			dial := dialMail(func(host, port string) (net.Conn, error) {
				target := imapPort
				if host == "smtp."+provider && port == "465" {
					target = smtpPort
				} else if host != "imap."+provider || port != "993" {
					return nil, fmt.Errorf("unexpected endpoint")
				}
				conn, e := tls.Dial("tcp", target.Addr().String(), &tls.Config{RootCAs: cert.Client().Transport.(*http.Transport).TLSClientConfig.RootCAs, ServerName: "example.com", MinVersion: tls.VersionTLS12})
				if e == nil {
					conn.SetDeadline(time.Now().Add(5 * time.Second))
				}
				return conn, e
			})
			if e := dial.send(addr, "fixture-code", addr, "中文测试", "来自手机的测试邮件"); e != nil {
				t.Fatal(e)
			}
			if e := <-sent; e != nil {
				t.Fatal(e)
			}
			result, e := dial.inbox(addr, "fixture-code")
			if e != nil {
				t.Fatal(e)
			}
			var data inboxResult
			if e = json.Unmarshal([]byte(result), &data); e != nil {
				t.Fatal(e)
			}
			for _, m := range data.Messages {
				if m.Subject == "中文测试" && m.From == addr {
					body, e := dial.read(addr, "fixture-code", int64(data.Validity), int64(m.UID))
					if e != nil || strings.TrimSpace(body) != "来自手机的测试邮件" {
						t.Fatalf("MIME round trip: %v %q", e, body)
					}
					if _, e = dial.read(addr, "fixture-code", int64(data.Validity)+1, int64(m.UID)); e == nil {
						t.Fatal("accepted stale UID")
					}
					return
				}
			}
			t.Fatalf("new message missing: %s", result)
		})
	}
}

func TestTransferInput(t *testing.T) {
	if _, _, e := compose("me@qq.com", "a@example.org", "subject\r\nBcc: spam@example.org", "hi"); e == nil {
		t.Fatal("accepted invalid header")
	}
	if _, e := domain("other@example.com"); e == nil {
		t.Fatal("accepted unsupported provider")
	}
	if body, e := readBody(strings.NewReader("Content-Type: text/html\r\n\r\n<p>正文</p><script>hidden</script>")); e != nil || body != "正文" {
		t.Fatalf("HTML body: %q %v", body, e)
	}
}
