package graph

import (
	"fmt"
	"sync"
)

type RestrictedGate = SendGate

type McpRunResult struct {
	Code   *int
	Stdout string
	Stderr string
}

type McpProcessControl struct {
	Kill func(signal string) bool
	End  func()
}

type RestrictedProcessControl struct {
	Pid *int
	Write func(message any) bool
	End func()
	Kill func(signal string) bool
}

type RestrictedCommand struct {
	Broker RestrictedGate
	Cwd string
	ScratchDir string
	Executable string
	Args []string
	Input string
	ReadPaths []string
	WritePaths []string
	TimeoutMs int
	OnRequest func(request any) (any, error)
	OnWorkerMessage func(message any)
	Env map[string]string
	KeepStdinOpen bool
	Signal *AbortSignal
	OnSpawn func(control McpProcessControl)
	OnProcess func(control RestrictedProcessControl)
	OnStdout func(chunk string)
	OnCancel func(request any)
	Preflight func()
}

type RestrictedExecutor interface {
	Run(command RestrictedCommand) CommandResult
	Close()
}

type restrictedLease struct {
	Executor interface {
		Run(RestrictedCommand) CommandResult
	}
	Release func()
}

type RestrictedMcpExecutor struct {
	Executor interface {
		Run(RestrictedCommand) CommandResult
	}
}

func (adapter RestrictedMcpExecutor) Run(command RestrictedCommand) McpRunResult {
	result := adapter.Executor.Run(command)
	return McpRunResult{Code: result.Code, Stdout: result.Stdout, Stderr: result.Stderr}
}

var (
	restrictedExecutorMutex  sync.Mutex
	sharedRestrictedExecutor *sandboxExecutor
	sharedRestrictedRefs     int
)

func AcquireRestrictedExecutor() restrictedLease {
	restrictedExecutorMutex.Lock()
	defer restrictedExecutorMutex.Unlock()
	if sharedRestrictedExecutor == nil {
		sharedRestrictedExecutor = newSandboxExecutor()
	}
	sharedRestrictedRefs++
	acquired := sharedRestrictedExecutor
	return restrictedLease{
		Executor: acquired,
		Release: func() {
			restrictedExecutorMutex.Lock()
			defer restrictedExecutorMutex.Unlock()
			sharedRestrictedRefs--
			if sharedRestrictedRefs == 0 && sharedRestrictedExecutor == acquired {
				sharedRestrictedExecutor = nil
				acquired.Close()
			}
		},
	}
}

func OpenRestrictedExecutor() RestrictedExecutor {
	return newSandboxExecutor()
}

func EncodeWorkerReply(reply any, maxBytes int) string {
	if maxBytes <= 0 {
		maxBytes = maxWorkerReplyBytes
	}
	if reply == nil {
		return workerRefusal("Worker reply could not be serialized")
	}
	encoded, err := marshalJSON(reply)
	if err != nil {
		return workerRefusal("Worker reply could not be serialized: " + err.Error())
	}
	if len(encoded) > maxBytes {
		return workerRefusal(fmt.Sprintf("Worker reply exceeded %d bytes and was refused", maxBytes))
	}
	return encoded
}

type workerOkReply struct {
	Ok    bool `json:"ok"`
	Value any  `json:"value"`
}

type workerErrorReply struct {
	Ok    bool   `json:"ok"`
	Error string `json:"error"`
}

func workerRefusal(message string) string {
	return `{"ok":false,"error":` + jsonString(message) + `}`
}
