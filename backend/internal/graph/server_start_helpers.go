package graph

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

// failedDefinitionsSuffix describes the bootstrap entries that did not install.
func failedDefinitionsSuffix(failed []PresetFailure) string {
	if len(failed) == 0 {
		return ""
	}
	return fmt.Sprintf(", %d failed", len(failed))
}

func writeRevocations(path string, refs []string) error {
	seen := map[string]bool{}
	unique := []string{}
	for _, ref := range refs {
		if !seen[ref] {
			seen[ref] = true
			unique = append(unique, ref)
		}
	}
	sort.Strings(unique)
	body, err := json.MarshalIndent(unique, "", "  ")
	if err != nil {
		return err
	}
	temporary := fmt.Sprintf("%s.%d.%s.tmp", path, os.Getpid(), graphUUID())
	if err := os.WriteFile(temporary, append(body, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

func defaultPriceVerify(snapshot PriceSnapshot) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, snapshot.SourceUrl, nil)
	if err != nil {
		return false
	}
	request.Header.Set("user-agent", "graph-price-refresh/1")
	response, err := HTTPClient.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return false
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return false
	}
	return strings.Contains(string(body), snapshot.ModelId)
}

func sameStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	seen := map[string]int{}
	for _, item := range left {
		seen[item]++
	}
	for _, item := range right {
		seen[item]--
		if seen[item] < 0 {
			return false
		}
	}
	return true
}

func envPointers(values map[string]string) map[string]*string {
	out := map[string]*string{}
	for key, value := range values {
		copied := value
		out[key] = &copied
	}
	return out
}

func mergeEnv(base, extra map[string]string) map[string]string {
	out := map[string]string{}
	for key, value := range base {
		out[key] = value
	}
	for key, value := range extra {
		out[key] = value
	}
	return out
}

func sameSecret(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func stringIn(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

// cliCwd is the working directory this process runs in. The RSI root falls back to it
// when no explicit root is configured.
func cliCwd() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}
