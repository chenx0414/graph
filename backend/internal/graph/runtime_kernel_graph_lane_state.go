package graph

import "sync/atomic"

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
