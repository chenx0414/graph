package main

import (
	"encoding/json"
	"strings"
)

type platformPreset struct {
	ID             string   `json:"id"`
	Label          string   `json:"label"`
	API            string   `json:"api"`
	BaseURL        string   `json:"baseUrl"`
	CredentialRef  string   `json:"credentialRef"`
	CredentialKind string   `json:"credentialKind"`
	Custom         bool     `json:"custom"`
	Notes          []string `json:"notes"`
}

type nativeProviderRow struct {
	ID         string
	Label      string
	Platform   string
	BaseURL    string
	Models     []string
	Configured bool
}

type providerDraft struct {
	Platform string
	Name     string
	BaseURL  string
	APIKey   string
	Models   string
}

type platformCatalogPayload struct {
	Platforms []platformPreset `json:"platforms"`
}

func parseNativeProviders(payload []byte) ([]nativeProviderRow, map[string]any, int, error) {
	var envelope struct {
		Revision int            `json:"revision"`
		Config   map[string]any `json:"config"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return nil, nil, 0, err
	}
	document := envelope.Config
	credentials, _ := document["credentials"].(map[string]any)
	models, _ := document["models"].(map[string]any)
	entries, _ := models["entries"].([]any)
	byProvider := map[string]*nativeProviderRow{}
	order := []string{}
	for _, raw := range entries {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		provider := strings.TrimSpace(stringValue(entry["provider"]))
		credentialID := strings.TrimSpace(stringValue(entry["credentialId"]))
		key := credentialID
		if key == "" {
			key = provider
		}
		if key == "" {
			continue
		}
		row, known := byProvider[key]
		if !known {
			row = &nativeProviderRow{ID: key, Label: key, Platform: provider, BaseURL: strings.TrimSpace(stringValue(entry["baseUrl"]))}
			byProvider[key] = row
			order = append(order, key)
		}
		if id := strings.TrimSpace(stringValue(entry["id"])); id != "" {
			row.Models = append(row.Models, id)
		}
		if row.BaseURL == "" {
			row.BaseURL = strings.TrimSpace(stringValue(entry["baseUrl"]))
		}
	}
	rows := make([]nativeProviderRow, 0, len(order))
	for _, key := range order {
		row := *byProvider[key]
		if credential, ok := credentials[key].(map[string]any); ok {
			row.Configured, _ = credential["configured"].(bool)
			if platform := strings.TrimSpace(stringValue(credential["platform"])); platform != "" {
				row.Platform = platform
			}
			if name := strings.TrimSpace(stringValue(credential["displayName"])); name != "" {
				row.Label = name
			}
		}
		if len(row.Models) == 0 {
			continue
		}
		rows = append(rows, row)
	}
	return rows, document, envelope.Revision, nil
}

func stringValue(raw any) string {
	text, _ := raw.(string)
	return text
}

func (s *shellState) platformLabel(id string) string {
	for _, preset := range s.providers.platforms {
		if preset.ID == id {
			return preset.Label
		}
	}
	return id
}

func (s *shellState) ensureProviders() {
	if s.providers.loading || s.providers.attempted {
		return
	}
	s.loadProviders()
}

func (s *shellState) loadProviders() {
	// The flag, the token paths and the fetch all belong to the shell's writer:
	// this runs from a render as often as from a click, and a render must not
	// write the state it is reading.
	var start bool
	var api apiClient
	onUI(s.window, func() {
		if s.providers.loading {
			return
		}
		s.providers.loading = true
		if s.providers.appToken == "" {
			s.providers.appToken = appToken(s.stateDir)
		}
		if s.providers.secretsFile == "" {
			s.providers.secretsFile = secretsPath(s.stateDir)
		}
		api = s.api
		start = true
	})
	if !start {
		return
	}
	go func() {
		nativeRows, document, revision, platforms, nativeErr := s.fetchNativeProviders(api)
		payload, magpieErr := api.get("/api/providers/magpie")
		var entries []providerEntry
		var enabled map[string]bool
		var source magpieProvidersPayload
		if magpieErr == nil {
			entries, enabled, source, magpieErr = parseMagpieProviders(payload)
			if magpieErr == nil && !source.Available && source.Error != "" {
				magpieErr = errStatus(source.Error)
			}
		}
		onUI(s.window, func() {
			s.providers.loading = false
			s.providers.attempted = true
			s.providers.native = nativeRows
			if len(platforms) > 0 {
				s.providers.platforms = platforms
			}
			if nativeErr == nil {
				s.providers.document = document
				s.providers.revision = revision
				s.providers.nativeFailed = ""
			} else {
				s.providers.nativeFailed = nativeErr.Error()
			}
			if magpieErr != nil {
				s.providers.failed = magpieErr.Error()
				s.providers.source = source
			} else {
				s.providers.failed = ""
				s.providers.entries = entries
				s.providers.enabled = enabled
				s.providers.source = source
			}
			s.frame()
		})
	}()
}

func (s *shellState) fetchNativeProviders(api apiClient) ([]nativeProviderRow, map[string]any, int, []platformPreset, error) {
	configPayload, err := api.get("/api/config")
	if err != nil {
		if isNotFound(err) {
			return nil, nil, 0, nil, nil
		}
		return nil, nil, 0, nil, err
	}
	rows, document, revision, err := parseNativeProviders(configPayload)
	if err != nil {
		return nil, nil, 0, nil, err
	}
	// The platforms belong on the shell's writer, so this read returns them
	// instead of storing them from the worker goroutine.
	var platforms []platformPreset
	if catalogPayload, catalogErr := api.get("/api/providers"); catalogErr == nil {
		var catalog platformCatalogPayload
		if json.Unmarshal(catalogPayload, &catalog) == nil {
			platforms = catalog.Platforms
		}
	}
	return rows, document, revision, platforms, nil
}

func (s *shellState) nativeProviderModel(id string) *nativeProviderRow {
	for index := range s.providers.native {
		if s.providers.native[index].ID == id {
			return &s.providers.native[index]
		}
	}
	return nil
}

func (s *shellState) openProviderPicker(id string) {
	active := s.active()
	if active == nil {
		return
	}
	active.modelPicker.provider = id
	active.modelPicker.open = true
	active.modelPicker.active = 0
	active.modelPicker.showAll = false
	active.modelPicker.focus = true
	s.frame()
}

func (s *shellState) addProviderDraft() {
	platform := "openai"
	baseURL := ""
	for _, preset := range s.providers.platforms {
		if preset.ID == platform {
			baseURL = preset.BaseURL
		}
	}
	s.providers.draft = providerDraft{Platform: platform, BaseURL: baseURL}
	s.providers.addOpen = true
	s.providers.editing = ""
	s.providers.saveFailed = ""
	s.frame()
}

func (s *shellState) editProvider(id string) {
	row := s.nativeProviderModel(id)
	if row == nil {
		return
	}
	s.providers.draft = providerDraft{
		Platform: row.Platform,
		Name:     row.Label,
		BaseURL:  row.BaseURL,
		Models:   strings.Join(row.Models, ", "),
	}
	s.providers.editing = id
	s.providers.addOpen = false
	s.providers.removeArmed = false
	s.providers.saveFailed = ""
	s.frame()
}

func (s *shellState) closeProviderEditor() {
	s.providers.editing = ""
	s.providers.addOpen = false
	s.providers.removeArmed = false
	s.providers.draft = providerDraft{}
	s.providers.saveFailed = ""
	s.frame()
}

func (s *shellState) providerEntryModels(entries []any, credentialID string) []any {
	kept := make([]any, 0, len(entries))
	for _, raw := range entries {
		entry, ok := raw.(map[string]any)
		if !ok {
			kept = append(kept, raw)
			continue
		}
		if strings.TrimSpace(stringValue(entry["credentialId"])) == credentialID {
			continue
		}
		kept = append(kept, raw)
	}
	return kept
}

func (s *shellState) removeProvider(id string) {
	document := cloneDocument(s.providers.document)
	if document == nil || id == "" {
		return
	}
	credentials, _ := document["credentials"].(map[string]any)
	if credentials != nil {
		delete(credentials, id)
	}
	modelsDoc, _ := document["models"].(map[string]any)
	if modelsDoc != nil {
		entries, _ := modelsDoc["entries"].([]any)
		modelsDoc["entries"] = s.providerEntryModels(entries, id)
	}
	s.providers.saving = true
	s.providers.saveFailed = ""
	apiClient := s.api
	revision := s.providers.revision
	go func() {
		_, err := apiClient.post("/api/config", map[string]any{"expectedRevision": revision, "document": document})
		onUI(s.window, func() {
			s.providers.saving = false
			if err != nil {
				s.providers.saveFailed = "移除失败：" + err.Error()
				s.frame()
				return
			}
			s.providers.editing = ""
			s.providers.removeArmed = false
			s.providers.draft = providerDraft{}
			s.refreshProviders()
			s.dropCachedModels()
			s.frame()
		})
	}()
}

func (s *shellState) saveProvider() {
	if s.providers.saving {
		return
	}
	name := strings.TrimSpace(s.providers.draft.Name)
	baseURL := strings.TrimSpace(s.providers.draft.BaseURL)
	key := strings.TrimSpace(s.providers.draft.APIKey)
	models := splitModelList(s.providers.draft.Models)
	if name == "" || baseURL == "" || len(models) == 0 {
		s.providers.saveFailed = "名称、接口地址和模型列表都要填"
		s.frame()
		return
	}
	document := cloneDocument(s.providers.document)
	if document == nil {
		s.providers.saveFailed = "读不到配置，暂时加不了供应商"
		s.frame()
		return
	}
	platform := s.providers.draft.Platform
	if platform == "" {
		platform = "custom"
	}
	preset := platformPreset{ID: platform, API: "openai-completions"}
	for _, candidate := range s.providers.platforms {
		if candidate.ID == platform {
			preset = candidate
			break
		}
	}
	api := preset.API
	if api == "" {
		api = "openai-completions"
	}
	editing := s.providers.editing
	credentialID := editing
	secretRef := ""
	credentials, _ := document["credentials"].(map[string]any)
	if credentials == nil {
		credentials = map[string]any{}
		document["credentials"] = credentials
	}
	if editing != "" {
		if existing, ok := credentials[editing].(map[string]any); ok {
			secretRef = strings.TrimSpace(stringValue(existing["secretRef"]))
		}
	} else {
		credentialID = slugProviderID(name)
		secretRef = "GRAPH_PROVIDER_" + strings.ToUpper(strings.ReplaceAll(credentialID, "-", "_")) + "_API_KEY"
	}
	if secretRef == "" {
		s.providers.saveFailed = "这个供应商没有可用的密钥引用"
		s.frame()
		return
	}
	credentials[credentialID] = map[string]any{"secretRef": secretRef, "platform": platform, "displayName": name}
	modelsDoc, _ := document["models"].(map[string]any)
	if modelsDoc == nil {
		modelsDoc = map[string]any{"entries": []any{}}
		document["models"] = modelsDoc
	}
	entries, _ := modelsDoc["entries"].([]any)
	entries = s.providerEntryModels(entries, credentialID)
	for _, modelID := range models {
		entries = append(entries, map[string]any{
			"id": modelID, "provider": credentialID, "api": api, "baseUrl": baseURL,
			"contextWindow": 128000, "maxTokens": 8192, "credentialId": credentialID,
		})
	}
	modelsDoc["entries"] = entries
	s.providers.saving = true
	s.providers.saveFailed = ""
	apiClient, appToken := s.api, s.providers.appToken
	revision, secretsFile := s.providers.revision, s.providers.secretsFile
	go func() {
		body := map[string]any{"expectedRevision": revision, "document": document}
		_, err := apiClient.post("/api/config", body)
		if err == nil && key != "" {
			_, err = apiClient.postApp("/api/app/secret", appToken, map[string]any{"ref": secretRef, "value": key, "persisted": true})
			if err == nil && secretsFile != "" {
				err = saveSecret(secretsFile, secretRef, &key)
			}
		}
		onUI(s.window, func() {
			s.providers.saving = false
			if err != nil {
				s.providers.saveFailed = "保存失败：" + err.Error()
				s.frame()
				return
			}
			s.providers.addOpen = false
			s.providers.editing = ""
			s.providers.removeArmed = false
			s.providers.draft = providerDraft{}
			s.refreshProviders()
			s.dropCachedModels()
			s.frame()
		})
	}()
}

func splitModelList(value string) []string {
	fields := strings.FieldsFunc(value, func(r rune) bool {
		return r == ',' || r == '\n' || r == '，' || r == ' ' || r == '\t'
	})
	models := make([]string, 0, len(fields))
	seen := map[string]bool{}
	for _, field := range fields {
		model := strings.TrimSpace(field)
		if model == "" || seen[model] {
			continue
		}
		seen[model] = true
		models = append(models, model)
	}
	return models
}

func slugProviderID(name string) string {
	var builder strings.Builder
	previousDash := false
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			builder.WriteRune(r)
			previousDash = false
		case r == '-' || r == '_' || r == ' ':
			if !previousDash && builder.Len() > 0 {
				builder.WriteRune('-')
				previousDash = true
			}
		}
	}
	id := strings.Trim(builder.String(), "-")
	if id == "" {
		return "provider"
	}
	return id
}

func cloneDocument(document map[string]any) map[string]any {
	if document == nil {
		return nil
	}
	payload, err := json.Marshal(document)
	if err != nil {
		return nil
	}
	var clone map[string]any
	if err := json.Unmarshal(payload, &clone); err != nil {
		return nil
	}
	return clone
}
