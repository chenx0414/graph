package graph

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"encoding/json"
)

// PiPackageHit is one official Pi package from the npm keyword channel.
type PiPackageHit struct {
	Name            string   `json:"name"`
	Version         string   `json:"version"`
	Description     string   `json:"description"`
	Publisher       *string  `json:"publisher"`
	WeeklyDownloads *float64 `json:"weeklyDownloads"`
	Url             *string  `json:"url"`
}

const piPackageKeyword = "pi-package"

const piPackageCacheMS = 5 * 60_000

var (
	piPackageCacheMu sync.Mutex
	piPackageCache   = map[string]struct {
		At   int64
		Hits []PiPackageHit
	}{}
)

// ParseRegistrySearch keeps only packages that carry the official pi-package keyword.
func ParseRegistrySearch(payload any) []PiPackageHit {
	root, _ := payload.(map[string]any)
	objects, _ := root["objects"].([]any)
	if objects == nil {
		return []PiPackageHit{}
	}
	hits := []PiPackageHit{}
	for _, entry := range objects {
		item, _ := entry.(map[string]any)
		pkg, _ := item["package"].(map[string]any)
		name, _ := pkg["name"].(string)
		if pkg == nil || name == "" {
			continue
		}
		keywords, _ := pkg["keywords"].([]any)
		marked := false
		for _, keyword := range keywords {
			if text, ok := keyword.(string); ok && text == piPackageKeyword {
				marked = true
			}
		}
		if !marked {
			continue
		}
		publisher := piPackageText(nested(pkg, "publisher", "username"))
		npmLink := piPackageText(nested(pkg, "links", "npm"))
		var weekly *float64
		if downloads, ok := item["downloads"].(map[string]any); ok {
			if number, ok := downloads["weekly"].(float64); ok {
				weekly = &number
			}
		}
		version, _ := pkg["version"].(string)
		description, _ := pkg["description"].(string)
		hits = append(hits, PiPackageHit{
			Name:            name,
			Version:         version,
			Description:     description,
			Publisher:       publisher,
			WeeklyDownloads: weekly,
			Url:             npmLink,
		})
	}
	return hits
}

func piPackageText(value any) *string {
	text, ok := value.(string)
	if !ok || text == "" {
		return nil
	}
	return &text
}

func nested(root map[string]any, keys ...string) any {
	var current any = root
	for _, key := range keys {
		item, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = item[key]
	}
	return current
}

// SearchPiPackages reads the official npm channel. Repeated browsing reuses a five-minute cache.
func SearchPiPackages(input struct {
	Query string
	Limit int
}) []PiPackageHit {
	limit := input.Limit
	if limit == 0 {
		limit = 20
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 50 {
		limit = 50
	}
	terms := strings.Join(strings.Fields(input.Query), " ")
	text := "keywords:" + piPackageKeyword
	if terms != "" {
		text += " " + terms
	}
	key := fmt.Sprintf("%s|%d", text, limit)
	piPackageCacheMu.Lock()
	if cached, ok := piPackageCache[key]; ok && NowMillis()-cached.At < piPackageCacheMS {
		hits := cached.Hits
		piPackageCacheMu.Unlock()
		return hits
	}
	piPackageCacheMu.Unlock()
	endpoint := "https://registry.npmjs.org/-/v1/search?text=" + url.QueryEscape(text) + "&size=" + fmt.Sprint(limit)
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		panic(err)
	}
	req.Header.Set("accept", "application/json")
	response, err := HTTPClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		Raise("capability_unavailable", fmt.Sprintf("npm registry search failed: HTTP %d", response.StatusCode))
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		panic(err)
	}
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		panic(err)
	}
	hits := ParseRegistrySearch(payload)
	piPackageCacheMu.Lock()
	piPackageCache[key] = struct {
		At   int64
		Hits []PiPackageHit
	}{At: NowMillis(), Hits: hits}
	piPackageCacheMu.Unlock()
	return hits
}
