package graph

// PiAdapterStreamOptions are the provider transport's own switches.
type PiAdapterStreamOptions struct {
	// EstimateMissing reports a missing usage report as an estimate instead of a failure.
	EstimateMissing bool
	// OnRequest records the request profile of one provider call.
	OnRequest func(callId string, profile map[string]any)
	// OnSend observes what the transport is about to send.
	OnSend func(sent PiAdapterSentRequest)
	// OnTransport observes what the provider attempt looked like from the outside.
	OnTransport func(observation ProviderTransportObservation)
}

// PiAdapterSentRequest is what the transport is about to send.
type PiAdapterSentRequest struct {
	SystemPrompt     *string
	ToolDeclarations any
}

// PiAdapterToolCall is one executed tool call, as the session reports it.
type PiAdapterToolCall struct {
	Tool    string
	Ms      float64
	IsError bool
	Target  *string
}

// PiAdapterContextSession is the context session a node records.
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

// PiAdapterConversationDelta is one live text delta of a conversation.
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

// PiAdapterPeerNode is one peer of the same graph.
type PiAdapterPeerNode struct {
	Id     string  `json:"id"`
	Role   *string `json:"role"`
	Status string  `json:"status"`
}

// PiAdapterPeerRequest is one message a node sends to a peer.
type PiAdapterPeerRequest struct {
	To        string `json:"to"`
	Text      string `json:"text"`
	RequestId string `json:"requestId"`
}

// PiAdapterPeerTools is the peer surface one node may use.
type PiAdapterPeerTools struct {
	List func() []PiAdapterPeerNode
	Send func(request PiAdapterPeerRequest) any
}

// piAdapterCatalogSkills adapts the catalog to the skill lookup BoundSkills needs.
type piAdapterCatalogSkills struct {
	catalog *Catalog
}

func (skills piAdapterCatalogSkills) Capability(id string, version string) *CapabilityRecord {
	if skills.catalog == nil {
		return nil
	}
	return skills.catalog.Capability(id, version)
}

// piAdapterBoundSkills are the skills a resolved capability bundle actually bound.
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
