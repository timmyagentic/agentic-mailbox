module si.timmyagentic/mailbox/directmail

go 1.26.4

require (
	github.com/emersion/go-imap v1.2.1
	github.com/emersion/go-imap-id v0.0.0-20190926060100-f94a56b9ecde
	github.com/emersion/go-message v0.18.2
	golang.org/x/net v0.63.0
)

require (
	github.com/emersion/go-sasl v0.0.0-20200509203442-7bfe0ed36a21 // indirect
	golang.org/x/mobile v0.0.0-20261117202452-47699113848a // indirect
	golang.org/x/mod v0.43.0 // indirect
	golang.org/x/sync v0.25.0 // indirect
	golang.org/x/text v0.44.0 // indirect
	golang.org/x/tools v0.53.0 // indirect
)

tool (
	golang.org/x/mobile/cmd/gobind
	golang.org/x/mobile/cmd/gomobile
)
