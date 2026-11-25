package graph

import (
	"fmt"
	"sync"
)

type ModuleEvaluation struct {
	TransitionId string
	Emitted      bool
	Waiting      bool
	Triggered    bool
	Outputs      map[string]any
	Reasons      []string
}

type moduleEvalEnv struct {
	Inputs  map[string]any
	State   any
	Trigger string
	Limits  *ModuleLimits
	Entry   string
}

type moduleEvalFn func(moduleEvalEnv) ModuleEvaluationResult

type ModuleRuntime struct {
	kernel          *KernelStore
	taskId          string
	RevisionVersion int
	compiled        *compiledModule
}

// scoped rebinds the runtime onto a transaction's store, so a module transition recorded inside a
// transaction joins it instead of opening a second one on the pool.
func (runtime *ModuleRuntime) scoped(tx *TaskStore) *ModuleRuntime {
	scoped := *runtime
	if runtime.kernel != nil {
		scoped.kernel = runtime.kernel.scoped(tx)
	}
	return &scoped
}

type compiledModule struct {
	trigger        string
	requiredInputs []string
	rules          []RuleDeclaration
	inputNames     []string
	updatedAt      string
}

var moduleSerialize = struct {
	mu    sync.Mutex
	tails map[string]*sync.Mutex
}{tails: map[string]*sync.Mutex{}}

func moduleLock(kernel *KernelStore, taskId, moduleId string) *sync.Mutex {
	key := fmt.Sprintf("%p\x00%s\x00%s", kernel.Store, taskId, moduleId)
	moduleSerialize.mu.Lock()
	defer moduleSerialize.mu.Unlock()
	lock := moduleSerialize.tails[key]
	if lock == nil {
		lock = &sync.Mutex{}
		moduleSerialize.tails[key] = lock
	}
	return lock
}
