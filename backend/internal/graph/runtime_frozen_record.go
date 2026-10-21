package graph

import (
	"encoding/json"
	"fmt"
	"strings"
)

// The helpers that read a frozen record.
//
// A frozen execution outlives the process that wrote it, so the record names
// the credential headers it may restore and never the credential itself. The
// daemon keeps the live binding, and the record only says which headers the
// recovered turn may carry.

// durableStrings reads one list of strings out of a frozen record.
func durableStrings(value any) []string {
	body, _ := json.Marshal(value)
	var values []string
	if err := json.Unmarshal(body, &values); err != nil {
		panic(err)
	}
	return values
}

// isCredentialHeader reports whether one header carries a credential.
//
// A credential never belongs in a durable record: the record outlives the
// process that wrote it, and the daemon keeps the live binding.
func isCredentialHeader(name string) bool {
	key := strings.ToLower(name)
	return key == "authorization" || key == "proxy-authorization" || key == "cookie" || key == "set-cookie" ||
		key == "x-api-key" || key == "api-key" ||
		strings.HasSuffix(key, "token") || strings.HasSuffix(key, "secret") || strings.HasSuffix(key, "password")
}

// restoreDurableModelHeaders restores the credential headers of a recovered
// turn.
//
// The frozen record names the headers the turn was admitted with; the values
// come from the daemon's live binding. A header that is gone is a refusal:
// the turn cannot be sent again with a credential it no longer has.
func restoreDurableModelHeaders(configuration map[string]any, model *ModelEntry, directory []ModelEntry) {
	names := durableStrings(configuration["headerCredentials"])
	for _, name := range names {
		found := false
		for _, entry := range directory {
			if entry.Id != model.Id {
				continue
			}
			for key, value := range ModelRequestHeaders(entry) {
				if strings.EqualFold(key, name) {
					if model.Headers == nil {
						model.Headers = map[string]string{}
					}
					model.Headers[name] = value
					found = true
					break
				}
			}
		}
		if !found {
			panic(fmt.Errorf("Original credential header %s is unavailable for model %s", name, model.Id))
		}
	}
}
