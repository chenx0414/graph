package graph

import (
	"strings"
)

type ProviderCredentialView struct {
	SecretRef          string  `json:"secretRef"`
	Resolved           bool    `json:"resolved"`
	DisplayName        *string `json:"displayName,omitempty"`
	SharedLimitGroupID *string `json:"sharedLimitGroupId,omitempty"`
	NeedsRelogin       bool    `json:"needsRelogin,omitempty"`
	CredentialNote     string  `json:"credentialNote,omitempty"`
}

type ProviderView struct {
	Credentials map[string]ProviderCredentialView `json:"credentials"`
}

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
	Unsupported          bool                   `json:"unsupported,omitempty"`
	UnsupportedReason    string                 `json:"unsupportedReason,omitempty"`
}

type PlatformCatalog struct {
	Platforms []PlatformView `json:"platforms"`
}

func PlatformCatalogView(secretValues map[string]string) PlatformCatalog {
	platforms := make([]PlatformView, 0, len(PLATFORM_PRESETS))
	for _, preset := range PLATFORM_PRESETS {
		view := PlatformView{
			ID: preset.ID, Label: preset.Label, API: preset.API, BaseURL: preset.BaseURL, OAuthProvider: preset.OAuthProvider,
			CredentialRef: preset.CredentialRef, CredentialKind: preset.CredentialKind,
			ModelsListSupported: preset.ModelsListSupported, Headers: preset.Headers,
			DocsURL: preset.DocsURL, Notes: preset.Notes, Custom: preset.ID == CUSTOM_PLATFORM_ID,
		}
		if preset.Unsupported {
			view.Unsupported = true
			view.UnsupportedReason = UnsupportedPlatformReason(preset.ID)
		}
		if value, ok := secretValues[preset.CredentialRef]; ok && strings.TrimSpace(value) != "" {
			view.CredentialConfigured = true
		}
		platforms = append(platforms, view)
	}
	return PlatformCatalog{Platforms: platforms}
}

type ProviderRegistration struct {
	BaseURL string
	API     ModelApi
	APIKey  string
	Models  []ConfiguredModel
	Headers map[string]string
}

func providerStringPointer(value string) *string { return &value }
