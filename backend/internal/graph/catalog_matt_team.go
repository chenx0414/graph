package graph

import (
	"strings"

	"regexp"
)

type MattTeamRole string

var mattTeamRoles = []MattTeamRole{"planner", "worker", "standards", "spec"}

type MattTeamOptions struct {
	Name    string
	Task    string
	Spec    string
	Ticket  int
	BaseRef string
	Check   struct {
		Command   string
		Args      []string
		TimeoutMs *int
	}
	RecipePrefix string
	Models       map[MattTeamRole]string
	Instructions map[MattTeamRole]string
}

type MattTeamCatalog interface {
	Capability(id string, version string) *CapabilityRecord
	SaveAgentCombination(combination AgentCombination) SavedAgentCombination
}

func mattTeamSkill(name string) string {
	return "mattpocock-skills-skills-engineering-" + name
}

var mattTeamPrefix = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// AssembleMattTeam builds published role recipes and returns an ordinary v2 definition.
func AssembleMattTeam(catalog MattTeamCatalog, options MattTeamOptions) GraphDefinition {
	fields := []struct {
		key   string
		value string
	}{{"name", options.Name}, {"task", options.Task}, {"spec", options.Spec}, {"baseRef", options.BaseRef}}
	for _, field := range fields {
		if strings.TrimSpace(field.value) == "" {
			Raise("invalid_input", "Matt team "+field.key+" must be nonempty")
		}
	}
	if !isSafeInteger(options.Ticket) || options.Ticket < 1 {
		Raise("invalid_input", "Matt team ticket must be a positive integer")
	}
	prefix := options.RecipePrefix
	if prefix == "" {
		prefix = "matt-team"
	}
	if !mattTeamPrefix.MatchString(prefix) {
		Raise("invalid_input", "Matt recipePrefix must be a lowercase slug")
	}
	bindings := map[MattTeamRole][]string{
		"planner":   {mattTeamSkill("codebase-design")},
		"worker":    {mattTeamSkill("tdd")},
		"standards": {mattTeamSkill("code-review")},
		"spec":      {mattTeamSkill("code-review")},
	}
	versions := map[string]string{}
	missing := []string{}
	for _, role := range mattTeamRoles {
		for _, id := range bindings[role] {
			resource := catalog.Capability(id, "")
			if resource == nil || resource.Kind != "skill" || resource.Status != "available" {
				missing = append(missing, string(role)+": "+id)
				continue
			}
			versions[id] = resource.Version
		}
	}
	if len(missing) > 0 {
		Raise("missing_capability", "Matt team requires available skills before assembly:\n"+strings.Join(missing, "\n"))
	}
	context := "Task: " + options.Task + "\nApproved specification: " + options.Spec + "\nTicket: #" + itoa(options.Ticket) + "\nFixed review base: " + options.BaseRef
	instructions := map[MattTeamRole]string{
		"planner":   context + "\nRead the project AGENTS.md, CODING_STANDARDS.md, CONTEXT.md and relevant ADRs. Read the bound /codebase-design skill when choosing implementation seams. Preserve the approved specification and ticket; do not interview again or invent new scope. Where the project uses Matt's mechanical flow, run its tickets stage before first implementation, never implement as an opening gate. Publish a plan artifact containing the ordered implementation slices, approved acceptance and checks, affected seams and skill requirements. Submit result with the exact plan {artifactId,version,digest}, specification, ticket and fixed base. Done means the immutable plan has been published and submitted.",
		"worker":    context + "\nRead the delivered exact plan with artifact_read; check its digest and implement only that plan in this original worker worktree. Read the bound /tdd skill and project testing instructions before tests, driving each agreed slice red then green. On rework read both exact report references, retain the original plan, and fix the reported failures in this same node/session. Run project checks before workspace_commit; reference the ticket in the commit message. Publish committed implementation files or a manifest of exact code artifacts using metadata.kind=code. Submit result with plan, subject {artifactId,version,digest}, source commit and evidence. Review is performed by the existing Standards and Spec graph peers; do not spawn nested agents or create graphs. Done means committed implementation and immutable references are submitted, not final delivery.",
		"standards": context + "\nRead the bound /code-review skill. You are its independent Standards axis, already dispatched by main alongside the Spec peer; do not call spawn or create a graph. Read the exact delivered plan and subject with artifact_read, check digests, and inspect the actual current integration worktree and its HEAD against the fixed base. Apply all project standards and the skill's smell baseline, skipping mechanically enforced rules. Never change code. Publish a graph.review@1 JSON report containing current integration commit, passed, reason, plan, subject, axis and file/line or reproducible evidence. The delivered private source commit is provenance, not the final integration SHA. Submit result containing the same plan/subject, report {artifactId,version,digest}, commit, passed and reason. Done means this exact version has a published independent report; do not declare graph completion.",
		"spec":      context + "\nRead the bound /code-review skill. You are its independent Spec axis, already dispatched by main alongside the Standards peer; do not call spawn or create a graph. Read the exact delivered plan and subject with artifact_read, check digests, and inspect the actual current integration worktree and its HEAD against the fixed base. Compare every approved acceptance with the actual diff: missing/partial requirements, wrong behavior and scope creep; cite specification and reproducible evidence. Never change code. Publish a graph.review@1 JSON report containing current integration commit, passed, reason, plan, subject, axis and evidence. The private source commit is provenance, not the final integration SHA. Submit result containing the same plan/subject, report {artifactId,version,digest}, commit, passed and reason. Done means this exact version has a published independent report; do not declare graph completion.",
	}
	identity := map[MattTeamRole]string{
		"planner":   "Plan an approved ticket into explicit, verifiable implementation slices. Publish immutable plans; do not implement or approve delivery.",
		"worker":    "Implement the delivered immutable plan and process review feedback in this same worktree and session. Never substitute self-review for the independent graph review peers.",
		"standards": "Independent, read-only Standards reviewer. Follow the Standards axis of code-review using the graph peers already arranged by main. Do not spawn agents.",
		"spec":      "Independent, read-only Spec reviewer. Follow the Spec axis of code-review using the graph peers already arranged by main. Do not spawn agents.",
	}
	reference := map[string]any{
		"type": "object", "required": []any{"artifactId", "version", "digest"},
		"properties": map[string]any{
			"artifactId": map[string]any{"type": "string", "minLength": 1},
			"version":    map[string]any{"type": "integer", "minimum": 1},
			"digest":     map[string]any{"type": "string", "minLength": 1},
		},
	}
	data := map[string]any{"protocol": "data"}
	handoff := map[string]any{"protocol": "handoff"}
	review := map[string]any{"protocol": "review"}
	candidate := map[string]any{"protocol": "candidate"}
	definitions := map[MattTeamRole]string{}
	for _, role := range mattTeamRoles {
		definitions[role] = prefix + "-" + string(role) + "@1"
	}
	create := func() GraphDefinition {
		nodes := map[string]any{}
		for _, role := range mattTeamRoles {
			inputs := data
			if role == "worker" {
				inputs = handoff
			}
			if role == "standards" || role == "spec" {
				inputs = candidate
			}
			outputs := handoff
			if role == "worker" {
				outputs = candidate
			}
			if role == "standards" || role == "spec" {
				outputs = review
			}
			node := map[string]any{
				"recipe": definitions[role], "task": string(role) + ": " + options.Task,
				"instructions": instructions[role],
				"inputs":       map[string]any{"job": inputs},
				"outputs":      map[string]any{"result": outputs},
				"submission":   map[string]any{"required": []any{"result"}},
			}
			if options.Instructions != nil && options.Instructions[role] != "" {
				node["instructions"] = options.Instructions[role]
			}
			if options.Models != nil && options.Models[role] != "" {
				node["model"] = options.Models[role]
			}
			nodes[string(role)] = node
		}
		timeout := 300000
		if options.Check.TimeoutMs != nil {
			timeout = *options.Check.TimeoutMs
		}
		args := make([]any, len(options.Check.Args))
		for i, arg := range options.Check.Args {
			args[i] = arg
		}
		falseWhen := "standards.subject.artifactId == spec.subject.artifactId && standards.subject.version == spec.subject.version && standards.subject.digest == spec.subject.digest && standards.plan.artifactId == spec.plan.artifactId && standards.plan.version == spec.plan.version && standards.plan.digest == spec.plan.digest && standards.commit == spec.commit && (standards.passed == false || spec.passed == false)"
		trueWhen := "standards.subject.artifactId == spec.subject.artifactId && standards.subject.version == spec.subject.version && standards.subject.digest == spec.subject.digest && standards.plan.artifactId == spec.plan.artifactId && standards.plan.version == spec.plan.version && standards.plan.digest == spec.plan.digest && standards.commit == spec.commit && standards.passed == true && spec.passed == true"
		emit := func(passed bool) map[string]any {
			body := map[string]any{
				"plan": "standards.plan", "subject": "standards.subject", "commit": "standards.commit",
				"standards": "$standards", "spec": "$spec", "passed": passed,
			}
			name := "approved"
			if !passed {
				name = "rework"
			}
			return map[string]any{name: body}
		}
		return ParseGraphDefinition(map[string]any{
			"schemaVersion": 2, "name": options.Name,
			"protocols": map[string]any{
				"data":      map[string]any{"type": "object"},
				"handoff":   map[string]any{"type": "object", "required": []any{"plan"}, "properties": map[string]any{"plan": reference, "subject": reference}},
				"candidate": map[string]any{"type": "object", "required": []any{"plan", "subject"}, "properties": map[string]any{"plan": reference, "subject": reference}},
				"review": map[string]any{"type": "object", "required": []any{"plan", "subject", "report", "commit", "passed", "reason"}, "properties": map[string]any{
					"plan": reference, "subject": reference, "report": reference,
					"commit": map[string]any{"type": []any{"string", "null"}}, "passed": map[string]any{"type": "boolean"},
					"reason": map[string]any{"type": "string", "minLength": 1},
				}},
			},
			"nodes": nodes,
			"modules": map[string]any{
				"decision": map[string]any{
					"type": "router", "trigger": "each", "requiredInputs": []any{"standards", "spec"},
					"inputs": map[string]any{"standards": review, "spec": review}, "outputs": map[string]any{"rework": handoff, "approved": data},
					"rules": []any{
						map[string]any{"when": falseWhen, "emit": emit(false)},
						map[string]any{"when": trueWhen, "emit": emit(true)},
					},
				},
				"check": map[string]any{
					"type": "operation", "trigger": "each", "inputs": map[string]any{"job": data}, "outputs": map[string]any{"result": data},
					"operation": map[string]any{
						"action": "workspace.command", "version": 1, "command": options.Check.Command, "args": args, "output": "result", "timeoutMs": timeout,
					},
				},
			},
			"edges": map[string]any{
				"planned":          map[string]any{"from": "planner.result", "to": "worker.job", "enabled": true},
				"standards":        map[string]any{"from": "worker.result", "to": "standards.job", "enabled": true},
				"spec":             map[string]any{"from": "worker.result", "to": "spec.job", "enabled": true},
				"standards-report": map[string]any{"from": "standards.result", "to": "decision.standards", "enabled": true},
				"spec-report":      map[string]any{"from": "spec.result", "to": "decision.spec", "enabled": true},
				"rework":           map[string]any{"from": "decision.rework", "to": "worker.job", "enabled": true},
			},
			"inputs": map[string]any{
				"job":   map[string]any{"to": "planner.job", "protocol": "data"},
				"check": map[string]any{"to": "check.job", "protocol": "data"},
			},
			"outputs": map[string]any{
				"result": map[string]any{"from": "decision.approved", "protocol": "data"},
			},
			"acceptance": []any{
				map[string]any{"id": "check", "description": "Project checks pass on the current clean integration commit", "kind": "check", "module": "check"},
				map[string]any{"id": "standards", "description": "Independent standards review of the current integration commit", "kind": "review", "node": "standards"},
				map[string]any{"id": "spec", "description": "Independent spec review of the current integration commit", "kind": "review", "node": "spec"},
			},
		})
	}
	create()
	for _, role := range mattTeamRoles {
		resources := []AgentCombinationResource{}
		for _, resourceId := range bindings[role] {
			resources = append(resources, AgentCombinationResource{ResourceId: resourceId, Version: versions[resourceId], Role: "skill", Required: true})
		}
		combination := AgentCombination{
			Id: prefix + "-" + string(role), Name: "Matt " + string(role), Description: identity[role],
			RecommendedGrade: "medium", Review: role == "standards" || role == "spec",
			Tags: []string{"matt-team", string(role)}, SystemPrompt: identity[role], Resources: resources,
		}
		result := catalog.SaveAgentCombination(combination)
		if result.Definition == nil {
			message := "Matt " + string(role) + " did not compile"
			if result.CompileError != nil {
				message = *result.CompileError
			}
			Raise("invalid_agent_combination", message)
		}
		definitions[role] = result.Definition.DefinitionVersion
	}
	return create()
}
