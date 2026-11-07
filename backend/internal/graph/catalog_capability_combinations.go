package graph

import (
	"strings"
)

func (library *CapabilityLibrary) Search(input CapabilitySearchInput) CapabilitySearchResult {
	query := strings.ToLower(strings.TrimSpace(input.Query))
	terms := []string{}
	for _, term := range strings.Fields(query) {
		if term != "" {
			terms = append(terms, term)
		}
	}
	limit := 20
	if input.Limit > 0 {
		limit = min(input.Limit, 50)
	}
	offset := 0
	if input.Offset > 0 {
		offset = input.Offset
	}
	matches := []CapabilityRecord{}
	for _, record := range library.capabilitiesCache {
		if input.Kind != "" && record.Kind != input.Kind {
			continue
		}
		if input.Role != "" && record.Role != input.Role {
			continue
		}
		if len(terms) > 0 {
			parts := []string{}
			for _, part := range []string{record.Id, record.Kind, record.Version, record.Name, record.Description, record.Source, record.Role} {
				if part != "" {
					parts = append(parts, part)
				}
			}
			haystack := strings.ToLower(strings.Join(parts, "\n"))
			matched := true
			for _, term := range terms {
				if !strings.Contains(haystack, term) {
					matched = false
					break
				}
			}
			if !matched {
				continue
			}
		}
		matches = append(matches, record)
	}
	items := []CapabilityRecord{}
	if offset < len(matches) {
		end := offset + limit
		if end > len(matches) {
			end = len(matches)
		}
		items = matches[offset:end]
	}
	return CapabilitySearchResult{
		Total:   len(matches),
		Offset:  offset,
		Limit:   limit,
		HasMore: offset+limit < len(matches),
		Items:   items,
	}
}
