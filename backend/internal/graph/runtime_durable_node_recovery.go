package graph

import "sync"

var durableNodeResolvers = struct {
	sync.Mutex
	values map[string]func(map[string]any) (*DurableRecoveryBinding, error)
}{values: map[string]func(map[string]any) (*DurableRecoveryBinding, error){}}

func registerDurableNodeResolver(database string, resolver func(map[string]any) (*DurableRecoveryBinding, error)) {
	durableNodeResolvers.Lock()
	defer durableNodeResolvers.Unlock()
	durableNodeResolvers.values[database] = resolver
}
func PrepareDurableNodeRecovery(database string, wrapper map[string]any) (*DurableRecoveryBinding, error) {
	durableNodeResolvers.Lock()
	resolver := durableNodeResolvers.values[database]
	durableNodeResolvers.Unlock()
	if resolver == nil {
		return nil, nil
	}
	return resolver(wrapper)
}

type durableInput struct {
	RequestId string `json:"requestId"`
	Attempt   int    `json:"attempt"`
}

func durableRecoverableInput(database, identity, executionID string) (*durableInput, error) {
	client, err := openDurableClient(database, nil, func(string, map[string]any) (any, error) { return nil, nil })
	if err != nil {
		return nil, err
	}
	defer client.connection.Close()
	var input *durableInput
	err = client.call("recoverableInput", map[string]any{"identity": identity, "executionId": executionID}, &input)
	return input, err
}
func (host *ResidentHost) RecoveredAttempt() int {
	host.mutex.Lock()
	checked := host.recoveredAttemptChecked
	host.recoveredAttemptChecked = true
	host.mutex.Unlock()
	if checked {
		return 0
	}
	input, err := durableRecoverableInput(host.options.Config.DurableDatabase, host.options.Config.Binding.InstanceId, host.options.Config.ExecutionId)
	if err != nil {
		panic(err)
	}
	if input == nil {
		return 0
	}
	return input.Attempt
}
func (adapter *kernelGraphLaneHost) RecoveredAttempt() int { return adapter.host.RecoveredAttempt() }

var durableNodeCompletions = struct {
	sync.Mutex
	values map[string]bool
}{values: map[string]bool{}}

func hasDurableNodeCompletion(database, id string) bool {
	durableNodeCompletions.Lock()
	defer durableNodeCompletions.Unlock()
	return durableNodeCompletions.values[database+":"+id]
}
func markDurableNodeCompletion(database, id string) {
	durableNodeCompletions.Lock()
	defer durableNodeCompletions.Unlock()
	durableNodeCompletions.values[database+":"+id] = true
}
