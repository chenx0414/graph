package graph

import "strings"

// Host-owned policy: editable identities and role rules cannot relax it.
const AGENT_TESTING_POLICY = "Testing policy (all Graph Agents, including main, workers, reviewers and auxiliary Agents):\n" +
	"Unit, integration and end-to-end tests are all allowed. One condition applies to every one of them: write the test before the code.\n" +
	"For a regression, demonstrate the failure at the intended behavior before the fix and the success afterward, and leave a reproducible artifact (command, report file, rerunnable script or screenshot) from the run.\n" +
	"A test asserts outward behaviour: never private variables, internal functions or implementation details, and do not weaken an existing check to obtain a pass.\n" +
	"Reviewers must flag a test written after the code it tests, and any check that only reproduces the implementation. This host policy takes precedence over conflicting recipe, skill, project or editable prompt testing guidance."

func WithAgentTestingPolicy(prompt, fallback string) string {
	body := strings.TrimSpace(prompt)
	if body == "" {
		body = fallback
	}
	return body + "\n\n" + AGENT_TESTING_POLICY
}
