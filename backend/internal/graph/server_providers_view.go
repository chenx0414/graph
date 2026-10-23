package graph

import (
	"strings"
)

// ProviderCredentialView is one credential as the browser may see it.
type ProviderCredentialView struct {
	SecretRef          string  `json:"secretRef"`
	Resolved           bool    `json:"resolved"`
	DisplayName        *string `json:"displayName,omitempty"`
	SharedLimitGroupID *string `json:"sharedLimitGroupId,omitempty"`
}

// ProviderView is the credential view of the whole configuration.
type ProviderView struct {
	Credentials map[string]ProviderCredentialView `json:"credentials"`
}

// SanitizeProviderView is the credential view safe for the browser/API: names
// and resolved flags only, never a secret value. `secretValues` is read inside
// the daemon and dropped.
func SanitizeProviderView(config GraphConfig, secretValues map[string]string) ProviderView {
	credentials := map[string]ProviderCredentialView{}
	for id, credential := range config.Credentials {
		view := ProviderCredentialView{SecretRef: credential.SecretRef}
		if value, ok := secretValues[credential.SecretRef]; ok && strings.TrimSpace(value) != "" {
			view.Resolved = true
		}
		if credential.DisplayName != "" {
			name := credential.DisplayName
			view.DisplayName = &name
		}
		if credential.SharedLimitGroupId != "" {
			group := credential.SharedLimitGroupId
			view.SharedLimitGroupID = &group
		}
		credentials[id] = view
	}
	return ProviderView{Credentials: credentials}
}

// PlatformView is one platform in the settings wizard directory.
type PlatformView struct {
	OAuthProvider        string                 `json:"oauthProvider,omitempty"`
	ID                   string                 `json:"id"`
	Label                string                 `json:"label"`
	API                  ModelApi               `json:"api"`
	BaseURL              string                 `json:"baseUrl"`
	CredentialRef        string                 `json:"credentialRef"`
	CredentialKind       ProviderCredentialKind `json:"credentialKind"`
	ModelsListSupported  bool                   `json:"modelsListSupported"`
	Headers              map[string]string      `json:"headers,omitempty"`
	DocsURL              *string                `json:"docsUrl,omitempty"`
	Notes                []string               `json:"notes"`
	Custom               bool                   `json:"custom"`
	CredentialConfigured bool                   `json:"credentialConfigured"`
}

// PlatformCatalog is the platform directory for the settings wizard.
type PlatformCatalog struct {
	Platforms []PlatformView `json:"platforms"`
}

// PlatformCatalogView is the platform directory for the settings wizard, with
// per-platform credential resolution status derived from the daemon's merged
// secret view.
func PlatformCatalogView(secretValues map[string]string) PlatformCatalog {
	platforms := make([]PlatformView, 0, len(PLATFORM_PRESETS))
	for _, preset := range PLATFORM_PRESETS {
		view := PlatformView{
			ID: preset.ID, Label: preset.Label, API: preset.API, BaseURL: preset.BaseURL, OAuthProvider: preset.OAuthProvider,
			CredentialRef: preset.CredentialRef, CredentialKind: preset.CredentialKind,
			ModelsListSupported: preset.ModelsListSupported, Headers: preset.Headers,
			DocsURL: preset.DocsURL, Notes: preset.Notes, Custom: preset.ID == CUSTOM_PLATFORM_ID,
		}
		if value, ok := secretValues[preset.CredentialRef]; ok && strings.TrimSpace(value) != "" {
			view.CredentialConfigured = true
		}
		platforms = append(platforms, view)
	}
	return PlatformCatalog{Platforms: platforms}
}

// ProviderRegistration is one provider endpoint the runtime may dispatch to.
// The credential value never leaves the daemon.
type ProviderRegistration struct {
	BaseURL string
	API     ModelApi
	APIKey  string
	Models  []ConfiguredModel
	Headers map[string]string
}

// providerStringPointer returns a pointer to the value.
func providerStringPointer(value string) *string { return &value }
