package graph

func harnessToolDeclarations(set agentToolContext) []AgentToolDeclaration {
	main := set.main
	features := set.features
	return []AgentToolDeclaration{
		{Name: "compare_harness_candidates", Label: "Compare harness candidates", Description: "Compare harness candidates using the same declared domain and evidence. Record the decision and its justification before adoption.", Parameters: tbObject([]tbField{
			{"graphId", tbString(map[string]any{"description": "Graph the candidates belong to."})},
			{"nodeIds", tbArray(tbString(nil))},
			{"baselineNodeId", tbOptional(tbString(map[string]any{"description": "Candidate the others are compared against. Defaults to the first candidate by id."}))},
			{"domain", tbOptional(tbString(map[string]any{"description": "Domain the task belongs to; its adopted lessons come back with the comparison."}))},
		}, []string{"graphId", "nodeIds"}), Available: main && features.Harness},
		{Name: "record_harness_decision", Label: "Record harness decision", Description: "Record or update a harness decision with its cue, evidence, status and fixing reference. Only adopted lessons enter future prompts.", Parameters: tbObject([]tbField{
			{"graphId", tbOptional(tbString(map[string]any{"description": "Graph the compared candidates belong to, when the lesson came from a comparison."}))},
			{"domain", tbString(map[string]any{"description": "Domain the lesson belongs to; later tasks in this domain find it."})},
			{"axis", tbOptional(tbString(map[string]any{"description": "general (the lesson holds for every kind of work, and every domain finds it) or specific (it holds for this domain only). Claims the general axis only when the evidence shows it."}))},
			{"chosen", tbString(map[string]any{"description": "The candidate that was adopted, as compare_harness_candidates reported it. The anonymous id is fine: the host resolves it to the candidate that actually ran, so the lesson still names it later."})},
			{"cue", tbString(map[string]any{"description": "What the situation looked like when this lesson applies."})},
			{"lesson", tbString(map[string]any{"description": "What to do about it."})},
			{"evidence", tbString(map[string]any{"description": "What shows the lesson worked."})},
			{"harness", tbOptional(tbString(map[string]any{"description": "The harness change that produced the adopted behavior."}))},
			{"requestId", tbOptional(tbString(nil))},
		}, []string{"domain", "chosen", "cue", "lesson", "evidence"}), Available: main && features.Harness},
		{Name: "record_harness_friction", Label: "Record harness friction", Description: "Record a harness friction cue before solving it. The same cue updates one record; only adopted lessons enter later prompts. Mark fixed with its reference.", Parameters: tbObject([]tbField{
			{"domain", tbString(map[string]any{"description": "Domain the friction belongs to; later tasks in this domain find it."})},
			{"cue", tbString(map[string]any{"description": "The situation in which the friction showed up."})},
			{"why", tbString(map[string]any{"description": "Why it matters - what it cost or what it led to."})},
			{"axis", tbOptional(tbString(map[string]any{"description": "general (it is not about one kind of work) or specific (it is about this domain only)."}))},
			{"status", tbOptional(tbString(map[string]any{"description": "open, fixed or rejected. Record the same cue again to move it."}))},
			{"ref", tbOptional(tbString(map[string]any{"description": "What fixed it, for example the commit that did."}))},
			{"requestId", tbOptional(tbString(nil))},
		}, []string{"domain", "cue", "why"}), Available: main && features.Harness},
		{Name: "declare_harness_domain", Label: "Declare the harness domain", Description: "Declare the harness domain and constraints a candidate changes before comparing or adopting it.", Parameters: tbObject([]tbField{
			{"domain", tbString(map[string]any{"description": "The name of the kind of work this project does."})},
			{"requestId", tbOptional(tbString(nil))},
		}, []string{"domain"}), Available: main && features.Harness},
		{Name: "read_harness_experience", Label: "Read harness experience", Description: "Read recorded harness friction and decisions. Narrow it with status and limit, and check truncated before assuming you have seen everything.", Parameters: tbObject([]tbField{
			{"domain", tbOptional(tbString(map[string]any{"description": "Domain to read. Omit it to list the domains that hold lessons."}))},
			{"status", tbOptional(tbString(map[string]any{"description": "Only records in this state: open, adopted, fixed or rejected."}))},
			{"limit", tbOptional(tbNumber())},
		}, nil), Available: main && features.Harness},
		{Name: "read_harness_evidence", Label: "Read harness evidence", Description: "Read evidence for a harness change or candidate. Use evidence to distinguish an observed failure from a hypothesis.", Parameters: tbObject([]tbField{
			{"graphId", tbOptional(tbString(map[string]any{"description": "Graph to read. Omit it to read this conversation's own run."}))},
			{"nodeId", tbOptional(tbString(map[string]any{"description": "Read one node only."}))},
			{"kind", tbOptional(tbString(map[string]any{"description": "summary (the digest) or trajectory (the ordered steps of a node)."}))},
			{"limit", tbOptional(tbNumber())},
		}, nil), Available: main && features.Harness},
		{Name: "probe_harness", Label: "Probe harness variants", Description: "Run a bounded probe of a harness candidate against its declared domain. Inspect the resulting evidence before adoption.", Parameters: tbObject([]tbField{
			{"task", tbString(map[string]any{"description": "The task every candidate answers."})},
			{"variants", tbArray(tbObject([]tbField{
				{"label", tbString(map[string]any{"description": "Name of this candidate, so you can tell the variants apart."})},
				{"axis", tbOptional(tbString(map[string]any{"description": "general (a change that should hold for every kind of work) or specific (a change that holds for this domain only). Propose one of each when you can: the comparison then shows which kind of change actually pays off."}))},
				{"harness", tbOptional(tbObject(nil, nil))},
				{"recipe", tbOptional(tbString(map[string]any{"description": "Agent definition this candidate runs under; defaults to the probe's recipe."}))},
				{"model", tbOptional(tbString(map[string]any{"description": "Model this candidate runs on; defaults to the probe's model."}))},
			}, []string{"label"}))},
			{"recipe", tbOptional(tbString(map[string]any{"description": "Agent definition every candidate runs under unless its variant names one. read_system_capabilities lists them."}))},
			{"baseHarness", tbOptional(tbString(map[string]any{"description": "adopted to start every candidate from the harness this project already adopted, so the round tests a change on top of the last winner instead of beside it."}))},
			{"model", tbOptional(tbString(map[string]any{"description": "Model every candidate runs on unless its variant names one."}))},
			{"domain", tbOptional(tbString(map[string]any{"description": "Domain the task belongs to; its adopted lessons come back with the contrast."}))},
			{"timeoutMs", tbOptional(tbNumber())},
		}, []string{"task", "variants"}), Available: main && features.Harness},
	}
}
