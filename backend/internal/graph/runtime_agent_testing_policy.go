package graph

import "strings"

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

func agentVddObligation(role string) string {
	switch role {
	case "main":
		return "VDD obligation: restate the outcome and observable acceptance in your own words, and wait for confirmation before proposing work. Convert the confirmed intent into a check that fails on the current behaviour, and say which part only a human can confirm."
	case "reviewer":
		return "VDD obligation: judge whether the check could have failed. A check never seen fail proves nothing, so report it as unproven rather than passed, and flag a test written after the code it tests. Name the exact commit and files for every finding, and do not weaken a check to obtain a pass."
	}
	return "VDD obligation: run the check that must fail before your change and show it failing, then implement until the same check passes. An edit you have not executed is not evidence, and a check that cannot fail is not a check."
}
