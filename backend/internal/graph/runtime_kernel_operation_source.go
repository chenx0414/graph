package graph

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
	if executionID == nil {
		return
	}
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
