package graph

func piAdapterRetrievalReach(network *PiAdapterNetwork, role string, gate SendGate) *RetrievalBroker {
	systemDomains := []string{}
	if role == "master" {
		systemDomains = []string{"github.com", "raw.githubusercontent.com", "api.github.com"}
	}
	domains := []string{}
	if network != nil {
		domains = append(domains, network.RetrievalDomains...)
	}
	domains = piAdapterUnique(append(domains, systemDomains...))
	unrestricted := true
	if len(domains) == 0 && !unrestricted {
		return nil
	}
	return CreateRetrievalBroker(domains, gate, unrestricted, 0, 0)
}

func piAdapterRunToolCommand(commands *WorkspaceCommandRunner, interrupt *AbortSignal, command string, args []string, signal *AbortSignal, timeoutMs int) CommandResult {
	merged, release := MergeAbortSignals(interrupt, signal)
	defer release()
	if timeoutMs > 0 {
		return commands.RunWithTimeout(command, args, merged, timeoutMs)
	}
	return commands.Run(command, args, merged)
}

func piAdapterFetchDocument(retrieval *RetrievalBroker, interrupt *AbortSignal, url string, signal *AbortSignal) RetrievalResult {
	merged, release := MergeAbortSignals(interrupt, signal)
	defer release()
	return retrieval.Fetch(url, merged)
}
