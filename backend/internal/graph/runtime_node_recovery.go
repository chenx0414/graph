package graph

import "sync"

// The node's recovery handover.
//
// A node's turn may be interrupted by a crash. The recovery restores the
// configuration the turn was admitted with into the lane, so the node's
// re-run is the turn it was admitted as, and it marks the turns the kernel
// finished so the executor may start them again.
//
// The kernel is the PiG one and it runs in this process: the restored
// configuration is what the lane needs, and there is no second process to
// admit anything.

var nodeRecoveryResolvers = struct {
	sync.Mutex
	values map[string]func(*FrozenExecutionRecovery) (*NodeRecoveryBinding, error)
}{values: map[string]func(*FrozenExecutionRecovery) (*NodeRecoveryBinding, error){}}

// NodeRecoveryBinding is what the lane learned about one restored node.
type NodeRecoveryBinding struct {
	// Config is the configuration the node was admitted with.
	Config map[string]any
	// Callback is the node's own channel, when the node still has one.
	Callback func(string, map[string]any) (any, error)
	// Close ends the node's channel.
	Close func()
}

// registerNodeRecoveryResolver records how a restored node is handed back.
func registerNodeRecoveryResolver(database string, resolver func(*FrozenExecutionRecovery) (*NodeRecoveryBinding, error)) {
	nodeRecoveryResolvers.Lock()
	defer nodeRecoveryResolvers.Unlock()
	nodeRecoveryResolvers.values[database] = resolver
}

// PrepareNodeRecovery restores one node into the lane.
func PrepareNodeRecovery(database string, wrapper *FrozenExecutionRecovery) (*NodeRecoveryBinding, error) {
	nodeRecoveryResolvers.Lock()
	resolver := nodeRecoveryResolvers.values[database]
	nodeRecoveryResolvers.Unlock()
	if resolver == nil {
		return nil, nil
	}
	return resolver(wrapper)
}

var nodeCompletions = struct {
	sync.Mutex
	values map[string]bool
}{values: map[string]bool{}}

// hasNodeCompletion reports whether the kernel finished that node's turn.
//
// An execution that carries a submission may not be started again without
// proof that the turn is still there. The kernel's own receipt is that proof,
// and this is where the proof is kept.
func hasNodeCompletion(database, id string) bool {
	nodeCompletions.Lock()
	defer nodeCompletions.Unlock()
	return nodeCompletions.values[database+":"+id]
}

// markNodeCompletion records that the kernel finished that node's turn.
func markNodeCompletion(database, id string) {
	nodeCompletions.Lock()
	defer nodeCompletions.Unlock()
	nodeCompletions.values[database+":"+id] = true
}
