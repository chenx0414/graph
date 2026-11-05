package graph

// rsiAdmitSource refuses a workspace.command that would read code the integration tree does not hold.
func rsiAdmitSource(kernel *KernelStore, graphID, deliveryID, workspace string, operation *ModuleOperation, integratesSource func(string) bool) {
	if operation == nil || operation.Action != "workspace.command" {
		return
	}
	task := kernel.Store.Task(graphID)
	if task.IntegrationBranch == nil || *task.IntegrationBranch == "" {
		return
	}
	integration := kernelRow(kernel.Db, "SELECT path FROM worktrees WHERE instance_id=?", "integration:"+graphID)
	if integration == nil {
		return
	}
	if deployResolve("", graphDBString(integration, "path")) != deployResolve("", workspace) {
		return
	}
	executionID, sourceState, found := kernel.DeliverySource(deliveryID)
	if !found {
		return
	}
	// Main-delivered and module-to-module input has no causal producer to wait for.
	if executionID == nil {
		return
	}
	// Whether this source owes the integration branch a commit is a production fact (its frozen recipe,
	// its admitted work location), not the absence of a commit row - a node may submit first and be
	// committed automatically at settle. The host answers it; a commit row cannot.
	integrates := false
	if integratesSource != nil {
		integrates = integratesSource(*executionID)
	} else {
		integrates = kernelRow(kernel.Db, "SELECT sha FROM git_commits WHERE task_id=? AND operation_id=? AND kind='instance'", graphID, *executionID) != nil
	}
	if !integrates {
		return
	}
	merged := kernelRow(kernel.Db, "SELECT sha FROM git_commits WHERE task_id=? AND operation_id=? AND kind='integration'", graphID, *executionID)
	if merged == nil {
		// A short wait, not a repair: the delivery stays pending and the same one is
		// retried. It cannot block here instead: this operation runs under the
		// graph's Git lock (Git.Exclusive), and the source execution's own
		// integration needs that same lock (SettleWorkspace). Waiting for the
		// commit while holding the lock would wait for a commit that cannot be
		// made, so the operation gives the attempt back and the delivery is
		// retried after the source integrated.
		if sourceState == "running" {
			Raise("paused", "Delivery source "+*executionID+" has not been integrated yet")
		}
		Raise("integration_blocked", "Delivery source "+*executionID+" did not reach the integration branch")
	}
	produced := kernelRow(kernel.Db, "SELECT sha FROM git_commits WHERE task_id=? AND operation_id=? AND kind='instance'", graphID, *executionID)
	if produced != nil {
		sha := graphDBString(produced, "sha")
		if Git(workspace, []string{"merge-base", "--is-ancestor", sha, "HEAD"}, nil, nil).Code != 0 {
			Raise("integration_blocked", "Delivery source "+*executionID+" produced "+sha+", which the integration worktree does not contain")
		}
	}
}
