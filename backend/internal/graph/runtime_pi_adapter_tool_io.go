package graph

// The I/O one operation's tools can start on the daemon's side.
//
// A tool call is not the kernel's: the kernel marks the tool task aborted, but
// the process and the socket belong to the daemon. Whatever the daemon starts
// for one operation therefore runs with that operation's interrupt signal, so
// an interruption reaches the work itself instead of only the bookkeeping about
// it.

// piAdapterRetrievalReach builds the fetch broker of one operation: the granted
// domains plus the system reach a master always has.
func piAdapterRetrievalReach(network *PiAdapterNetwork, access *ResolvedAccessPolicy, role string, gate SendGate) *RetrievalBroker {
	systemDomains := []string{}
	if role == "master" {
		systemDomains = []string{"github.com", "raw.githubusercontent.com", "api.github.com"}
	}
	domains := []string{}
	if network != nil {
		domains = append(domains, network.RetrievalDomains...)
	}
	domains = piAdapterUnique(append(domains, systemDomains...))
	unrestricted := access != nil && access.Network == "unrestricted"
	if len(domains) == 0 && !unrestricted {
		return nil
	}
	return CreateRetrievalBroker(domains, gate, unrestricted, 0, 0)
}

// piAdapterRunToolCommand runs one command a tool of this operation started,
// merging the operation's interrupt signal with the caller's own reason to
// stop. A non-positive timeout keeps the runner's own limit.
func piAdapterRunToolCommand(commands *WorkspaceCommandRunner, interrupt *AbortSignal, command string, args []string, signal *AbortSignal, timeoutMs int) CommandResult {
	merged, release := MergeAbortSignals(interrupt, signal)
	defer release()
	if timeoutMs > 0 {
		return commands.RunWithTimeout(command, args, merged, timeoutMs)
	}
	return commands.Run(command, args, merged)
}

// piAdapterFetchDocument reads one granted document. A fetch can outlive the
// turn, so an interrupted operation stops waiting on the network for a document
// it no longer wants.
func piAdapterFetchDocument(retrieval *RetrievalBroker, interrupt *AbortSignal, url string, signal *AbortSignal) RetrievalResult {
	merged, release := MergeAbortSignals(interrupt, signal)
	defer release()
	return retrieval.Fetch(url, merged)
}
