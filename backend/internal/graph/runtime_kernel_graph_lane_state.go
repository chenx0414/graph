package graph

// kernelGraphLaneState is the state one lane keeps between its nodes.
//
// The lane used to hold it in the closures of one very large function: the
// node lookups, the session assembly, the lane's own options and the
// resident host all closed over the same maps, so one file carried four
// responsibilities and none of them could be read on its own.
type kernelGraphLaneState struct {
	options                  KernelGraphLaneOptions
	closing                  bool
	restoring                map[string]*FrozenExecutionRecovery
	hosts                    map[string]*PigNodeHost
	sessions                 map[string]NodeSession
	sessionRevisions         map[string]string
	hostConfigs              map[string]string
	boundModels              map[string]ModelEntry
	preparedReviewExecutions map[string]string
}

// newKernelGraphLaneState opens the state of one lane.
func newKernelGraphLaneState(options KernelGraphLaneOptions) *kernelGraphLaneState {
	return &kernelGraphLaneState{
		options:                  options,
		restoring:                map[string]*FrozenExecutionRecovery{},
		hosts:                    map[string]*PigNodeHost{},
		sessions:                 map[string]NodeSession{},
		sessionRevisions:         map[string]string{},
		hostConfigs:              map[string]string{},
		boundModels:              map[string]ModelEntry{},
		preparedReviewExecutions: map[string]string{},
	}
}
