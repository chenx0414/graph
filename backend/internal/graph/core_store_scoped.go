package graph

// A transaction owns one connection. Code that runs inside its body must reach the database
// through that connection, so every type that carries a store can be rebound onto the store the
// transaction owns. A holder that only forwards statements (a kernel, an artifact workspace) is
// rebound field by field so its own store is the transaction's; a holder that also keeps live
// state (an execution's counters, a git integration's mutex and caches) is not copied at all,
// because the copy's updates would be lost and a copied mutex is not a lock.

func (k *KernelStore) scoped(tx *TaskStore) *KernelStore {
	scoped := *k
	scoped.Store = tx
	scoped.Db = tx.Db
	scoped.DB = tx.DB
	return &scoped
}

func (w *ArtifactWorkspace) scoped(tx *TaskStore) *ArtifactWorkspace {
	scoped := *w
	scoped.store = tx
	return &scoped
}

func (l *WriteLedger) scoped(tx *TaskStore) *WriteLedger {
	scoped := *l
	scoped.store = tx
	return &scoped
}

func (c *RsiApplyContext) scoped(tx *TaskStore) *RsiApplyContext {
	scoped := *c
	scoped.Store = tx
	return &scoped
}

func (g *TaskSendGate) scoped(tx *TaskStore) *TaskSendGate {
	scoped := *g
	scoped.store = tx
	return &scoped
}

// GitIntegration keeps a mutex and two caches, so it is never copied: a scoped view carries only
// the store, and the code that needs the caches goes on using the original.
func (g *GitIntegration) scoped(tx *TaskStore) *GitIntegration {
	return &GitIntegration{store: tx, stateDir: g.stateDir}
}

func (l *OperationLifecycle) scoped(tx *TaskStore) *OperationLifecycle {
	scoped := *l
	scoped.store = tx
	return &scoped
}

// TaskRuntime carries a mutex and a dozen pointers, so it is rebuilt field by field: the store and
// the holders that only forward statements move onto the transaction, while everything that owns
// live state (an execution's counters, git's locks, the scheduler) stays the same object.
func (r *TaskRuntime) scoped(tx *TaskStore) *TaskRuntime {
	scoped := &TaskRuntime{
		options:         r.options,
		store:           tx,
		catalog:         r.catalog,
		execution:       r.execution,
		scheduler:       r.scheduler,
		closed:          r.closed,
		stateDir:        r.stateDir,
		projects:        r.projects,
		live:            r.live,
		models:          r.models,
		magpie:          r.magpie,
		master:          r.master,
		catalogOpt:      r.catalogOpt,
		limits:          r.limits,
		agentCtx:        r.agentCtx,
		systemCtx:       r.systemCtx,
		rsi:             r.rsi,
		autoWake:        r.autoWake,
		taskSetups:      r.taskSetups,
		Host:            r.Host,
		graphLane:       r.graphLane,
		laneTokenBudget: r.laneTokenBudget,
	}
	if r.kernel != nil {
		scoped.kernel = r.kernel.scoped(tx)
	}
	if r.artifacts != nil {
		scoped.artifacts = r.artifacts.scoped(tx)
	}
	if r.git != nil {
		scoped.git = r.git.scoped(tx)
	}
	return scoped
}
