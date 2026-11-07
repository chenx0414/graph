package graph

func SelectCapabilityRecord(records []CapabilityRecord, id string, version string) *CapabilityRecord {
	matching := make([]CapabilityRecord, 0)
	for i := range records {
		if records[i].Id == id {
			matching = append(matching, records[i])
		}
	}
	if len(matching) == 0 {
		return nil
	}
	if version == "" {
		found := matching[len(matching)-1]
		return &found
	}
	for i := range matching {
		if matching[i].Version == version {
			found := matching[i]
			return &found
		}
	}
	sourced := make([]CapabilityRecord, 0)
	for i := range matching {
		if capabilityHasPackageSource(matching[i]) {
			sourced = append(sourced, matching[i])
		}
	}
	if len(sourced) == 0 {
		return nil
	}
	found := sourced[len(sourced)-1]
	return &found
}

func capabilityHasPackageSource(record CapabilityRecord) bool {
	return record.PackageSource != nil && *record.PackageSource != ""
}
