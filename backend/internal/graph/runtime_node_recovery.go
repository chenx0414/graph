package graph

import "sync"

var nodeRecoveryResolvers = struct {
	sync.Mutex
	values map[string]func(*FrozenExecutionRecovery) (*NodeRecoveryBinding, error)
}{values: map[string]func(*FrozenExecutionRecovery) (*NodeRecoveryBinding, error){}}

type NodeRecoveryBinding struct {
	Config map[string]any
	Callback func(string, map[string]any) (any, error)
	Close func()
}

func registerNodeRecoveryResolver(database string, resolver func(*FrozenExecutionRecovery) (*NodeRecoveryBinding, error)) {
	nodeRecoveryResolvers.Lock()
	defer nodeRecoveryResolvers.Unlock()
	nodeRecoveryResolvers.values[database] = resolver
}

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

func hasNodeCompletion(database, id string) bool {
	nodeCompletions.Lock()
	defer nodeCompletions.Unlock()
	return nodeCompletions.values[database+":"+id]
}

func markNodeCompletion(database, id string) {
	nodeCompletions.Lock()
	defer nodeCompletions.Unlock()
	nodeCompletions.values[database+":"+id] = true
}
