package graph

import (
	"net/url"
	"strconv"
	"time"

	"net"
)

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

func PortIsFree(port int) bool {
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}
