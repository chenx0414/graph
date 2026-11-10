package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"strings"
)

type shellAPI struct {
	secrets  string
	pick     func() (string, error)
	open     func(kind string) (string, error)
	relaunch func() string
	apply    func() (bool, string)
}

type bridge struct {
	address string
	token   string
	server  *http.Server
}

const shellHeader = "x-graph-shell"

func newBridgeToken() string {
	raw := make([]byte, 24)
	_, _ = rand.Read(raw)
	return hex.EncodeToString(raw)
}

func startBridge(api *shellAPI, token string) (*bridge, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	server := &http.Server{Handler: api.handler(token)}
	go func() { _ = server.Serve(listener) }()
	return &bridge{address: "http://" + listener.Addr().String(), token: token, server: server}, nil
}

func (b *bridge) close() {
	if b != nil && b.server != nil {
		_ = b.server.Close()
	}
}

func (api *shellAPI) handler(token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/pick-directory", api.guard(token, func(body map[string]any) (any, int, string) {
		if api.pick == nil {
			return nil, http.StatusNotImplemented, "no directory picker"
		}
		path, err := api.pick()
		if err != nil {
			return nil, http.StatusInternalServerError, err.Error()
		}
		if path == "" {
			return map[string]any{"path": nil}, http.StatusOK, ""
		}
		return map[string]any{"path": path}, http.StatusOK, ""
	}))
	mux.HandleFunc("/open-resource", api.guard(token, func(body map[string]any) (any, int, string) {
		kind, _ := body["kind"].(string)
		if api.open == nil {
			return nil, http.StatusNotImplemented, "no shell open"
		}
		path, err := api.open(kind)
		if err != nil {
			return map[string]any{"opened": false, "message": err.Error()}, http.StatusOK, ""
		}
		return map[string]any{"opened": true, "path": path}, http.StatusOK, ""
	}))
	mux.HandleFunc("/save-secret", api.guard(token, func(body map[string]any) (any, int, string) {
		ref := normalizeSecretRef(stringField(body, "ref"))
		if ref == "" {
			return map[string]any{"stored": false, "message": "no ref"}, http.StatusOK, ""
		}
		var value *string
		if raw, present := body["value"]; present && raw != nil {
			text, ok := raw.(string)
			if !ok {
				return map[string]any{"stored": false, "message": "value is not a string"}, http.StatusOK, ""
			}
			value = &text
		}
		if err := saveSecret(api.secrets, ref, value); err != nil {
			return map[string]any{"stored": false, "message": err.Error()}, http.StatusOK, ""
		}
		if api.apply == nil {
			return map[string]any{"stored": true, "applied": false}, http.StatusOK, ""
		}
		applied, message := api.apply()
		return map[string]any{"stored": true, "applied": applied, "message": message}, http.StatusOK, ""
	}))
	mux.HandleFunc("/secret-status", api.guard(token, func(body map[string]any) (any, int, string) {
		refs := []string{}
		if list, ok := body["refs"].([]any); ok {
			for _, item := range list {
				if ref, ok := item.(string); ok {
					refs = append(refs, ref)
				}
			}
		}
		return secretStatus(api.secrets, refs), http.StatusOK, ""
	}))
	mux.HandleFunc("/relaunch", api.guard(token, func(map[string]any) (any, int, string) {
		if api.relaunch == nil {
			return nil, http.StatusNotImplemented, "no relaunch"
		}
		return map[string]any{"url": api.relaunch()}, http.StatusOK, ""
	}))
	return mux
}

func (api *shellAPI) guard(token string, handle func(map[string]any) (any, int, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
		w.Header().Set("Access-Control-Allow-Headers", "content-type, "+shellHeader)
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Vary", "Origin")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		if strings.TrimSpace(r.Header.Get(shellHeader)) != token {
			http.Error(w, "unknown shell caller", http.StatusForbidden)
			return
		}
		body := map[string]any{}
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		payload, status, message := handle(body)
		if status != http.StatusOK {
			http.Error(w, message, status)
			return
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(payload)
	}
}

func stringField(body map[string]any, key string) string {
	value, _ := body[key].(string)
	return value
}

func preloadScript(source, token, base string) string {
	replaced := strings.ReplaceAll(source, "__GRAPH_SHELL_TOKEN__", token)
	return strings.ReplaceAll(replaced, "__GRAPH_SHELL_BASE__", base)
}
