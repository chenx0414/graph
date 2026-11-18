package main

import (
	"encoding/json"
	"sort"
	"strings"
)

type modelMeta struct {
	id            string
	modelID       string
	contextWindow int64
	maxTokens     int64
}

func parseModelMeta(payload []byte) map[string]modelMeta {
	var listed struct {
		Models []struct {
			ID            string `json:"id"`
			ModelID       string `json:"modelId"`
			ContextWindow int64  `json:"contextWindow"`
			MaxTokens     int64  `json:"maxTokens"`
		} `json:"models"`
	}
	if json.Unmarshal(payload, &listed) != nil {
		return nil
	}
	meta := make(map[string]modelMeta, len(listed.Models))
	for _, model := range listed.Models {
		if model.ID == "" {
			continue
		}
		meta[model.ID] = modelMeta{id: model.ID, modelID: model.ModelID, contextWindow: model.ContextWindow, maxTokens: model.MaxTokens}
	}
	return meta
}

func (s *shellState) ensureModelMeta() {
	if s.modelMeta != nil || s.modelMetaLoading {
		return
	}
	s.modelMetaLoading = true
	go func() {
		payload, err := s.api.get("/api/settings")
		if err == nil {
			s.modelMeta = parseModelMeta(payload)
			s.modelMetaResolved = nil
			s.modelMetaMiss = nil
		}
		s.modelMetaError = ""
		if err != nil {
			s.modelMetaError = err.Error()
		}
		s.modelMetaLoading = false
		s.frame()
	}()
}

func (s *shellState) modelMetaFor(model string) (modelMeta, bool) {
	if model == "" || len(s.modelMeta) == 0 {
		return modelMeta{}, false
	}
	if meta, ok := s.modelMetaResolved[model]; ok {
		return meta, true
	}
	if s.modelMetaMiss != nil && s.modelMetaMiss[model] {
		return modelMeta{}, false
	}
	if meta, ok := s.modelMeta[model]; ok {
		s.rememberModelMeta(model, meta)
		return meta, true
	}
	short := shortModel(model)
	best, bestScore, found := modelMeta{}, 0, false
	for _, id := range s.modelMetaKeys() {
		meta := s.modelMeta[id]
		score := modelMetaMatchScore(id, meta, model, short)
		if score == 0 {
			continue
		}
		if !found || score > bestScore || (score == bestScore && id < best.id) {
			best, bestScore, found = meta, score, true
		}
	}
	if found {
		s.rememberModelMeta(model, best)
	} else if s.modelMetaMiss == nil {
		s.modelMetaMiss = map[string]bool{model: true}
	} else {
		s.modelMetaMiss[model] = true
	}
	return best, found
}

func (s *shellState) rememberModelMeta(model string, meta modelMeta) {
	if s.modelMetaResolved == nil {
		s.modelMetaResolved = map[string]modelMeta{}
	}
	s.modelMetaResolved[model] = meta
}

func (s *shellState) modelMetaKeys() []string {
	keys := make([]string, 0, len(s.modelMeta))
	for id := range s.modelMeta {
		keys = append(keys, id)
	}
	sort.Strings(keys)
	return keys
}

func modelMetaMatchScore(id string, meta modelMeta, model, short string) int {
	switch {
	case meta.modelID == model:
		return 4
	case shortModel(id) == short && meta.modelID == short:
		return 3
	case shortModel(id) == short:
		return 2
	case modelPrefixMatches(shortModel(id), short), modelPrefixMatches(meta.modelID, short):
		return 1
	}
	return 0
}

func modelPrefixMatches(candidate, model string) bool {
	if candidate == "" || model == "" {
		return false
	}
	if strings.HasPrefix(candidate, model) || strings.HasPrefix(model, candidate) {
		return true
	}
	if index := strings.LastIndex(candidate, "/"); index >= 0 {
		leaf := candidate[index+1:]
		if strings.HasPrefix(leaf, model) || strings.HasPrefix(model, leaf) {
			return true
		}
	}
	return false
}
