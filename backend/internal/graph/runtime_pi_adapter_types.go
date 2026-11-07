package graph

type PiAdapterStreamOptions struct {
	EstimateMissing bool
	OnRequest func(callId string, profile map[string]any)
	OnSend func(sent PiAdapterSentRequest)
	OnTransport func(observation ProviderTransportObservation)
	HasFallback bool
}

type PiAdapterSentRequest struct {
	SystemPrompt     *string
	ToolDeclarations any
}

type PiAdapterToolCall struct {
	Tool    string
	Ms      float64
	IsError bool
	Target  *string
}

type PiAdapterContextSession struct {
	TaskId              string
	NodeId              string
	OperationId         string
	BindingId           string
	SessionId           string
	CapabilityDigest    string
	ModelPolicyDigest   string
	ToolPolicyDigest    string
	SourceLeafId        *string
	SourceContextDigest *string
	ChildContextDigest  *string
}

type PiAdapterConversationDelta struct {
	TaskId         string
	ConversationId string
	OperationId    string
	EntryId        string
	PartId         string
	Ordinal        int
	Delta          string
	Text           string
	Length         int
}

type PiAdapterPeerNode struct {
	Id     string  `json:"id"`
	Role   *string `json:"role"`
	Status string  `json:"status"`
}

type PiAdapterPeerRequest struct {
	To        string `json:"to"`
	Text      string `json:"text"`
	RequestId string `json:"requestId"`
}

type PiAdapterPeerTools struct {
	List func() []PiAdapterPeerNode
	Send func(request PiAdapterPeerRequest) any
}

type piAdapterCatalogSkills struct {
	catalog *Catalog
}

func (skills piAdapterCatalogSkills) Capability(id string, version string) *CapabilityRecord {
	if skills.catalog == nil {
		return nil
	}
	return skills.catalog.Capability(id, version)
}

func piAdapterBoundSkills(facts []ResolvedCapabilityFact, catalog *Catalog) []BoundSkill {
	plain := []struct {
		Id      string
		Version string
		Kind    string
		Path    string
	}{}
	for _, fact := range facts {
		plain = append(plain, struct {
			Id      string
			Version string
			Kind    string
			Path    string
		}{Id: fact.Id, Version: fact.Version, Kind: fact.Kind, Path: fact.Path})
	}
	return BoundSkills(plain, piAdapterCatalogSkills{catalog})
}
