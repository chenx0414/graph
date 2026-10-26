package graph

// Which models the sediment review asks.
//
// The candidates are the models the review may pick between, and the
// choice is the one the review says wins.
func ShouldSediment(gate SedimentGate) bool {
	role := ""
	if gate.Role != nil {
		role = *gate.Role
	}
	return gate.Enabled && role == "master" && !gate.Paused && !gate.AlreadyReviewed && gate.Threshold > 0 && gate.ToolCalls >= gate.Threshold
}

// SEDIMENT_ATTEMPT_LIMIT is how many models one review may ask.
const SEDIMENT_ATTEMPT_LIMIT = 2

func SedimentCandidates(main ModelEntry, directory []ModelEntry, preferred *string) []ModelEntry {
	var ordered []ModelEntry
	add := func(candidate *ModelEntry) {
		if candidate == nil {
			return
		}
		for _, existing := range ordered {
			if existing.Id == candidate.Id {
				return
			}
		}
		ordered = append(ordered, *candidate)
	}
	mainIdentity := ModelIdentity(main)
	var eligible []ModelEntry
	for _, model := range directory {
		if model.Id != main.Id && ModelIdentity(model) != mainIdentity {
			eligible = append(eligible, model)
		}
	}
	if preferred != nil && *preferred != "" {
		for i := range eligible {
			if eligible[i].Id == *preferred {
				add(&eligible[i])
				break
			}
		}
	}
	for _, grade := range MODEL_GRADE_ORDER {
		for i := range eligible {
			if eligible[i].Grade == grade {
				add(&eligible[i])
			}
		}
	}
	if len(ordered) > SEDIMENT_ATTEMPT_LIMIT {
		ordered = ordered[:SEDIMENT_ATTEMPT_LIMIT]
	}
	return ordered
}

func SelectSedimentModel(main ModelEntry, directory []ModelEntry, preferred *string) *ModelEntry {
	if preferred != nil && *preferred != "" {
		for i := range directory {
			if directory[i].Id == *preferred {
				return &directory[i]
			}
		}
	}
	mainIdentity := ModelIdentity(main)
	var candidates []ModelEntry
	for _, model := range directory {
		if model.Id != main.Id && ModelIdentity(model) != mainIdentity {
			candidates = append(candidates, model)
		}
	}
	for _, grade := range MODEL_GRADE_ORDER {
		for i := range candidates {
			if candidates[i].Grade == grade {
				found := candidates[i]
				return &found
			}
		}
	}
	return nil
}
