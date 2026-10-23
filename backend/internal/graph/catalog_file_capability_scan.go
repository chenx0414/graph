package graph

import (
	"os"
	"path/filepath"
)

// ScanCapabilities walks a capability root up to four directories deep.
func ScanCapabilities(root string) []CapabilityRecord {
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		panic(err)
	}
	records := []CapabilityRecord{}
	fileCapabilitiesWalk(resolved, resolved, 0, &records)
	seen := map[string]CapabilityRecord{}
	for i := range records {
		if records[i].Status == "invalid" {
			continue
		}
		key := records[i].Id + "@" + records[i].Version
		if previous, ok := seen[key]; ok {
			records[i].Status = "invalid"
			records[i].Error = "Duplicate capability " + key + "; also found at " + previous.Source
			records[i].Snapshot = map[string]any{"path": records[i].Source, "error": records[i].Error}
			continue
		}
		seen[key] = records[i]
	}
	return records
}
