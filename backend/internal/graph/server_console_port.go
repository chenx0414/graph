package graph

import (
	"net"
	"net/url"
	"strconv"
	"time"
)

// PreferredConsolePort is the port for a request that only wants a free one.
//
// The desktop app starts the daemon with port 0, so every reload used to move the console to a new
// port - which silently invalidates the tabs, windows and probes pointing at the old one. The
// address this state directory last served on is the best guess for what should stay reachable;
// the bind itself is still the authority, so a port taken by something else falls back to a free
// one instead of failing.
//
// A nil isFree keeps the TypeScript default, which reports the port free without binding.
// A nil result is the TypeScript undefined. pollMs stays at 150 (the TypeScript default).
func PreferredConsolePort(stateDir string, isFree func(int) bool, waitMs int) *int {
	if isFree == nil {
		isFree = func(int) bool { return true }
	}
	record := callConsoleRead(stateDir)
	if record == nil || record.URL == "" {
		return nil
	}
	parsed, err := url.Parse(record.URL)
	if err != nil {
		return nil
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil
	}
	pollMs := 150
	// The daemon being replaced is usually still closing its socket, so the remembered port is
	// expected to be busy for a moment. Waiting for it is what makes a reload keep the address.
	deadline := NowMillis() + int64(waitMs)
	for {
		if callPortFree(isFree, port) {
			return &port
		}
		if NowMillis() >= deadline {
			return nil
		}
		time.Sleep(time.Duration(pollMs) * time.Millisecond)
	}
}

func callConsoleRead(stateDir string) (record *ConsoleAddress) {
	defer func() { _ = recover() }()
	return ReadConsoleAddress(stateDir)
}

func callPortFree(isFree func(int) bool, port int) (ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	return isFree(port)
}

// PortIsFree reports whether binding 127.0.0.1:port would succeed right now. A probe, not a reservation.
func PortIsFree(port int) bool {
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}
