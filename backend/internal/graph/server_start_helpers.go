package graph

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

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
	return verifyPricePage(snapshot.SourceUrl, snapshot.ModelId)
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

func cliCwd() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}
