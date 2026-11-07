package graph

func agentToolsSupervisorPresent(supervisor PiAdapterSupervisor) bool {
	return supervisor.Propose != nil || supervisor.WithdrawDraft != nil || supervisor.ConfirmDraft != nil ||
		supervisor.GraphState != nil || supervisor.TaskStatus != nil || supervisor.ValidateProposal != nil ||
		supervisor.ListProjects != nil || supervisor.BindProject != nil || supervisor.ListProblems != nil ||
		supervisor.ResolveProblem != nil
}

type agentToolsArtifacts struct {
	present bool
	access  AgentArtifactAccess
	list    func(query ArtifactQuery) ArtifactPage
	get     func(artifactId string, version *int) ArtifactRecord
	read    func(artifactId string, version int, maxBytes int) ArtifactRead
	publish func(input PublishArtifactInput) ArtifactRecord
	retire  func(artifactId string, version int, reason string, requestId string) ArtifactRecord
	promote func(input ArtifactPromoteInput) ArtifactRecord
}

func agentToolsArtifactsOf(value any) agentToolsArtifacts {
	switch service := value.(type) {
	case *PiAdapterArtifactService:
		access := AgentArtifactAccess{}
		if granted, ok := service.Access.(AgentArtifactAccess); ok {
			access = granted
		}
		return agentToolsArtifacts{
			present: true, access: access,
			list:    service.List,
			get:     service.Get,
			read:    service.Read,
			publish: service.Publish,
			retire:  service.Retire,
			promote: service.Promote,
		}
	case *AgentToolsArtifactService:
		return agentToolsArtifacts{
			present: true,
			access:  AgentArtifactAccess{AllowedNamespaces: service.AllowedNamespaces, CanPromote: service.CanPromote},
			list:    service.List,
			get:     service.Get,
			read:    service.Read,
			publish: service.Publish,
			retire:  service.Retire,
			promote: service.Promote,
		}
	}
	return agentToolsArtifacts{}
}

type agentToolsPeers struct {
	list func() []PiAdapterPeerNode
	send func(request PiAdapterPeerRequest) any
}

func agentToolsPeersOf(value any) *agentToolsPeers {
	switch service := value.(type) {
	case PiAdapterPeerTools:
		return &agentToolsPeers{list: service.List, send: service.Send}
	case *PiAdapterPeerTools:
		return &agentToolsPeers{list: service.List, send: service.Send}
	}
	return nil
}
