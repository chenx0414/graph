package graph

import (
	"crypto/x509"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

// ApplicationRoot is the checkout the daemon was loaded from. The CLI sets it
// once at startup. Source identity and on-disk presets resolve from here.
var ApplicationRoot string

// VendorOriginRewrites mirrors the e2e fetch substitution in
// src/server/vendor-transport.mjs when that fixture file is present. It is not
// a Fastify proxy. Production checkouts do not have the file.
func VendorOriginRewrites() [][2]string {
	if ApplicationRoot == "" {
		return nil
	}
	raw, err := os.ReadFile(ApplicationRoot + "/src/server/vendor-transport.mjs")
	if err != nil {
		return nil
	}
	re := regexp.MustCompile(`replace\('([^']+)',\s*['"]([^'"]+)['"]\)`)
	found := re.FindAllStringSubmatch(string(raw), -1)
	out := make([][2]string, 0, len(found))
	for _, match := range found {
		out = append(out, [2]string{match[1], match[2]})
	}
	return out
}

func rewriteURL(raw string) string {
	for _, pair := range VendorOriginRewrites() {
		if strings.HasPrefix(raw, pair[0]) {
			return pair[1] + strings.TrimPrefix(raw, pair[0])
		}
	}
	return raw
}

// HTTPClient is the process-wide client for provider calls. Timeouts are the
// caller's; this client does not impose a short default that TypeScript fetch lacked.
var HTTPClient = &http.Client{Timeout: 0, Transport: &rewriteTransport{base: envAwareTransport()}}

// envAwareTransport is the Go counterpart of the `--use-env-proxy` launch flag
// the TypeScript daemon was started with. Node reads HTTPS_PROXY, HTTP_PROXY and
// NO_PROXY for its global fetch, and trusts the extra authorities named by
// NODE_EXTRA_CA_CERTS. The Go daemon replaces that process, so it has to honor
// the same environment on its own transport.
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

// extraCertPool appends the NODE_EXTRA_CA_CERTS authorities to the system
// roots. Node takes one file; a comma separated list is accepted here so an
// operator can trust several bundles at once.
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

type rewriteTransport struct{ base http.RoundTripper }

func (t *rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	next := rewriteURL(req.URL.String())
	if next != req.URL.String() {
		clone := req.Clone(req.Context())
		parsed, err := url.Parse(next)
		if err != nil {
			return nil, err
		}
		clone.URL = parsed
		clone.Host = parsed.Host
		req = clone
	}
	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	return base.RoundTrip(req)
}

// ReadBody reads and closes an HTTP body.
func ReadBody(body io.ReadCloser) ([]byte, error) {
	defer body.Close()
	return io.ReadAll(body)
}

// NowMillis is Date.now().
func NowMillis() int64 { return time.Now().UnixMilli() }
