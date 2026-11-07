package graph

import (
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"crypto/x509"
)

var ApplicationRoot string

var HTTPClient = &http.Client{Timeout: 0, Transport: envAwareTransport()}

func envAwareTransport() http.RoundTripper {
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return &http.Transport{Proxy: http.ProxyFromEnvironment}
	}
	transport := base.Clone()
	transport.Proxy = http.ProxyFromEnvironment
	if pool := extraCertPool(); pool != nil {
		transport.TLSClientConfig = transport.TLSClientConfig.Clone()
		transport.TLSClientConfig.RootCAs = pool
	}
	return transport
}

func extraCertPool() *x509.CertPool {
	files := extraCertFiles()
	if len(files) == 0 {
		return nil
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	for _, file := range files {
		pem, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		pool.AppendCertsFromPEM(pem)
	}
	return pool
}

func extraCertFiles() []string {
	raw := strings.TrimSpace(os.Getenv("NODE_EXTRA_CA_CERTS"))
	if raw == "" {
		return nil
	}
	var files []string
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			files = append(files, part)
		}
	}
	return files
}

func ReadBody(body io.ReadCloser) ([]byte, error) {
	defer body.Close()
	return io.ReadAll(body)
}

func NowMillis() int64 { return time.Now().UnixMilli() }
