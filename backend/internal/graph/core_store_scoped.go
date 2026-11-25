package graph

func (k *KernelStore) scoped(tx *TaskStore) *KernelStore {
	scoped := *k
	scoped.Store = tx
	scoped.Db = tx.Db
	scoped.DB = tx.DB
	return &scoped
}

func (c *Catalog) scoped(tx *TaskStore) *Catalog {
	scoped := *c
	scoped.store = tx
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

func (g *GitIntegration) scoped(tx *TaskStore) *GitIntegration {
	return &GitIntegration{store: tx, stateDir: g.stateDir}
}

func (l *OperationLifecycle) scoped(tx *TaskStore) *OperationLifecycle {
	scoped := *l
	scoped.store = tx
	return &scoped
}

func (r *TaskRuntime) scoped(tx *TaskStore) *TaskRuntime {
	scoped := &TaskRuntime{
		options:         r.options,
		store:           tx,
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
	if r.catalog != nil {
		scoped.catalog = r.catalog.scoped(tx)
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
