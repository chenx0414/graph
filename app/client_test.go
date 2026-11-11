package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAPIClientGetSendsTheSessionCookieAndReturnsTheBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method %s", r.Method)
		}
		if got := r.Header.Get("Cookie"); got != "graph_session=tok" {
			t.Errorf("cookie %q", got)
		}
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	payload, err := newAPIClient(server.URL, "tok").get("/api/conversations")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if string(payload) != `{"ok":true}` {
		t.Fatalf("body %q", payload)
	}
}

func TestAPIClientPostSendsJSONOriginAndCookie(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method %s", r.Method)
		}
		if got := r.Header.Get("content-type"); got != "application/json" {
			t.Errorf("content-type %q", got)
		}
		if got := r.Header.Get("Origin"); got != server.URL {
			t.Errorf("origin %q want %q", got, server.URL)
		}
		if got := r.Header.Get("Cookie"); got != "graph_session=tok" {
			t.Errorf("cookie %q", got)
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"text":"你好"}` {
			t.Errorf("body %q", body)
		}
		w.Write([]byte(`{}`))
	}))
	defer server.Close()

	if _, err := newAPIClient(server.URL, "tok").post("/api/conversations", map[string]string{"text": "你好"}); err != nil {
		t.Fatalf("post: %v", err)
	}
}

func TestAPIClientPostWithNoBodySendsAnEmptyObject(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{}` {
			t.Errorf("body %q", body)
		}
	}))
	defer server.Close()

	if _, err := newAPIClient(server.URL, "").post("/api/config", nil); err != nil {
		t.Fatalf("post: %v", err)
	}
}

func TestAPIClientReportsARejectedPost(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()

	_, err := newAPIClient(server.URL, "tok").post("/api/conversations", map[string]string{})
	if err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("a rejected post must say the status, err %v", err)
	}
}

func TestAPIClientReportsThePathOfAFailedGet(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	_, err := newAPIClient(server.URL+"/", "tok").get("/api/conversations")
	if err == nil || !strings.Contains(err.Error(), "/api/conversations") || !strings.Contains(err.Error(), "500") {
		t.Fatalf("err %v", err)
	}
}
