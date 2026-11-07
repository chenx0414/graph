package graph

import (
	"io"
	"net"
	"net/http"
	"sync"

	"bufio"
)

type networkProxy struct {
	listener net.Listener
	domains  []string
	mutex    sync.Mutex
	closed   bool
}

func (executor *sandboxExecutor) openNetworkProxy(command RestrictedCommand, unixSockets []string) (*networkProxy, map[string]string) {
	if command.AllowUnrestrictedNetwork {
		return nil, map[string]string{"NO_PROXY": "*", "no_proxy": "*"}
	}
	domains := command.NetworkDomains
	if command.LocalNetwork {
		domains = nil
	}
	if len(domains) == 0 && len(unixSockets) == 0 {
		return nil, map[string]string{}
	}
	proxy, err := startNetworkProxy(SandboxNetworkDomains(domains))
	if err != nil {
		panic(err)
	}
	address := "http://127.0.0.1:" + itoa(proxyPort(proxy))
	return proxy, map[string]string{
		"HTTP_PROXY":         address,
		"http_proxy":         address,
		"HTTPS_PROXY":        address,
		"https_proxy":        address,
		"ALL_PROXY":          address,
		"all_proxy":          address,
		"NO_PROXY":           "",
		"no_proxy":           "",
		"NODE_USE_ENV_PROXY": "1",
	}
}

func startNetworkProxy(domains []string) (*networkProxy, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	proxy := &networkProxy{listener: listener, domains: domains}
	go proxy.serve()
	return proxy, nil
}

func (proxy *networkProxy) Port() int {
	if proxy == nil || proxy.listener == nil {
		return 0
	}
	address, ok := proxy.listener.Addr().(*net.TCPAddr)
	if !ok {
		return 0
	}
	return address.Port
}

func (proxy *networkProxy) Close() {
	if proxy == nil {
		return
	}
	proxy.mutex.Lock()
	defer proxy.mutex.Unlock()
	if proxy.closed {
		return
	}
	proxy.closed = true
	_ = proxy.listener.Close()
}

func (proxy *networkProxy) serve() {
	for {
		connection, err := proxy.listener.Accept()
		if err != nil {
			return
		}
		go proxy.handle(connection)
	}
}

func (proxy *networkProxy) handle(connection net.Conn) {
	defer connection.Close()
	reader := bufio.NewReader(connection)
	request, err := http.ReadRequest(reader)
	if err != nil {
		return
	}
	if request.Method == http.MethodConnect {
		host, _, err := net.SplitHostPort(request.Host)
		if err != nil {
			return
		}
		if !AllowedDomain(proxy.domains, host) {
			return
		}
		upstream, err := net.Dial("tcp", request.Host)
		if err != nil {
			return
		}
		defer upstream.Close()
		if _, err := connection.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
			return
		}
		done := make(chan struct{})
		go func() {
			_, _ = io.Copy(upstream, connection)
			close(done)
		}()
		_, _ = io.Copy(connection, upstream)
		<-done
		return
	}
	if request.URL == nil || !request.URL.IsAbs() {
		return
	}
	if !AllowedDomain(proxy.domains, request.URL.Hostname()) {
		return
	}
	outgoing, err := http.NewRequest(request.Method, request.URL.String(), request.Body)
	if err != nil {
		return
	}
	outgoing.Header = request.Header
	client := &http.Client{Transport: &http.Transport{}}
	response, err := client.Do(outgoing)
	if err != nil {
		return
	}
	defer response.Body.Close()
	_ = response.Write(connection)
}

func proxyPort(proxy *networkProxy) int {
	if proxy == nil {
		return 0
	}
	return proxy.Port()
}
