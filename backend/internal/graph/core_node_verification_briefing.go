package graph

import "strings"

func (driver *NodeTurnDriver) verificationBriefing(taskID string, definition GraphDefinition) string {
	kernel := driver.options.Kernel
	lines := []string{}
	for _, criterion := range definition.Acceptance {
		spec := criterion.Verification
		if spec == nil || !interfaceSpecContains(spec.ImplementationNodes, driver.options.NodeId) {
			continue
		}
		task := kernel.Store.Task(taskID)
		project, _ := g5One(kernel.Db, "SELECT root FROM projects WHERE id=?", task.ProjectID)
		repo := g5Str(project["root"])
		module := definition.Modules[criterion.Module]
		attempts := graphAcceptanceCheckAttempts(kernel, taskID, criterion.Module)
		baseline, _ := findVerificationBaseline(kernel, repo, spec, module.Operation, attempts, "")
		if baseline != nil {
			lines = append(lines, "Acceptance "+criterion.Id+" failed as expected at Git commit "+*baseline.Commit+" in host operation "+baseline.Id+". Preserve verification files "+strings.Join(spec.Paths, ", ")+" and implement the behavior those files assert.")
		}
	}
	return strings.Join(lines, "\n")
}
