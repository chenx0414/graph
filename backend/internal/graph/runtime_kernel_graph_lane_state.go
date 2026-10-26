package graph

import "sync/atomic"

// kernelGraphLaneState is the state one lane keeps between its nodes.
//
// The lane used to hold it in the closures of one very large function: the
// node lookups, the session assembly, the lane's own options and the
// resident host all closed over the same maps, so one file carried four
// responsibilities and none of them could be read on its own.
type kernelGraphLaneState struct {
	options                  KernelGraphLaneOptions
	closing                  atomic.Bool
	restoring                laneTable[*FrozenExecutionRecovery]
	hosts                    laneTable[*PigNodeHost]
	sessions                 laneTable[NodeSession]
	sessionRevisions         laneTable[string]
	hostConfigs              laneTable[string]
	boundModels              laneTable[ModelEntry]
	preparedReviewExecutions laneTable[string]
}

// newKernelGraphLaneState opens the state of one lane.
func newKernelGraphLaneState(options KernelGraphLaneOptions) *kernelGraphLaneState {
	return &kernelGraphLaneState{
		options:                  options,
		restoring:                laneTable[*FrozenExecutionRecovery]{},
		hosts:                    laneTable[*PigNodeHost]{},
		sessions:                 laneTable[NodeSession]{},
		sessionRevisions:         laneTable[string]{},
		hostConfigs:              laneTable[string]{},
		boundModels:              laneTable[ModelEntry]{},
		preparedReviewExecutions: laneTable[string]{},
	}
}
