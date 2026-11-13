package main

import (
	"encoding/json"
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
	if meta, ok := s.modelMeta[model]; ok {
		return meta, true
	}
	short := shortModel(model)
	for id, meta := range s.modelMeta {
		if meta.modelID == model || meta.modelID == short || shortModel(id) == short {
			return meta, true
		}
	}
	for id, meta := range s.modelMeta {
		if modelPrefixMatches(shortModel(id), short) || modelPrefixMatches(meta.modelID, short) {
			return meta, true
		}
	}
	return modelMeta{}, false
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
