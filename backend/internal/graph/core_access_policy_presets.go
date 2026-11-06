package graph

type AccessMode string

type AccessRead string

type AccessWrite string

type AccessNetwork string

type AccessCommands string

type ExtensionRuntime string

type UnixSocketAccess string

type ProtectedStoreAccess string

type GitMetadataAccess string

type AccessAutoApprove struct {
	Permission   bool `json:"permission"`
	SystemChange bool `json:"systemChange"`
}

type AccessFilesystem struct {
	Read             AccessRead           `json:"read"`
	Write            AccessWrite          `json:"write"`
	GitMetadata      GitMetadataAccess    `json:"gitMetadata"`
	CredentialStores ProtectedStoreAccess `json:"credentialStores"`
}

type AccessPiExtensions struct {
	Runtime      ExtensionRuntime `json:"runtime"`
	LocalBinding bool             `json:"localBinding"`
	UnixSockets  UnixSocketAccess `json:"unixSockets"`
	AppleEvents  bool             `json:"appleEvents"`
}

type AccessPolicy struct {
	Mode         AccessMode         `json:"mode"`
	AutoApprove  AccessAutoApprove  `json:"autoApprove"`
	Filesystem   AccessFilesystem   `json:"filesystem"`
	Network      AccessNetwork      `json:"network"`
	Commands     AccessCommands     `json:"commands"`
	PiExtensions AccessPiExtensions `json:"piExtensions"`
}
func FullAccessPolicy() AccessPolicy {
	return AccessPolicy{
		Mode:        "full",
		AutoApprove: AccessAutoApprove{Permission: true, SystemChange: true},
		Filesystem: AccessFilesystem{
			Read:             "host",
			Write:            "host",
			GitMetadata:      "writable",
			CredentialStores: "readable",
		},
		Network:  "unrestricted",
		Commands: "host",
		PiExtensions: AccessPiExtensions{
			Runtime:      "host",
			LocalBinding: true,
			UnixSockets:  "all",
			AppleEvents:  true,
		},
	}
}
