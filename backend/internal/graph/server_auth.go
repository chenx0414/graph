package graph

import (
	"crypto/rand"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

const sessionCookieName = "graph_session"

func CreateSession() string {
	return graphUUID()
}

func LocalOrigin(origin string) string {
	if origin == "" {
		return ""
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return ""
	}
	host := parsed.Hostname()
	if host == "127.0.0.1" || host == "localhost" {
		return origin
	}
	return ""
}

func SetSessionCookie(header http.Header, token string) {
	header.Set("Set-Cookie", sessionCookieName+"="+token+"; HttpOnly; SameSite=Strict; Path=/")
}

func ReadCookie(header, name string) string {
	if header == "" {
		return ""
	}
	for _, part := range strings.Split(header, ";") {
		part = strings.TrimSpace(part)
		key, value, ok := strings.Cut(part, "=")
		if ok && key == name {
			return value
		}
	}
	return ""
}

func Guard(token string, request *http.Request) {
	if ReadCookie(request.Header.Get("Cookie"), sessionCookieName) != token {
		RaiseStatus(http.StatusUnauthorized, "unauthorized", "Authentication required")
	}
	if request.Method != http.MethodGet && request.Method != http.MethodHead && LocalOrigin(request.Header.Get("Origin")) == "" {
		RaiseStatus(http.StatusForbidden, "forbidden_origin", "Local origin required")
	}
}

func graphUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
