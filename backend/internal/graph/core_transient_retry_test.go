package graph

import (
	"strings"
	"testing"
)

func retryVerdict(output string) RetryDecisionRecord {
	return RetryDecision(struct {
		Output  string
		Attempt int
	}{Output: output, Attempt: 1})
}

// A failure of the machine or the transport is not a verdict on the agent's
// work. Reporting it as one tells the agent to re-think work that never reached
// the model, and leaves the user with "the turn did not finish" and no retry.
func TestTheMachineFailingIsNeverBlamedOnTheAgent(t *testing.T) {
	for _, output := range []string{
		`Post "https://api.commandcode.ai/provider/v1/chat/completions": tls: failed to verify certificate: x509: certificate signed by unknown authority`,
		`Post "https://x/v1/chat/completions": tls: failed to verify certificate: x509: certificate has expired or is not yet valid`,
		`The provider cut the arguments of the apply_rsi_change tool call`,
	} {
		decision := retryVerdict(output)
		if !decision.Retry {
			t.Fatalf("%q is the machine failing; the harness must run the turn again, got %+v", output, decision)
		}
		if strings.Contains(decision.Reason, "不是环境问题") {
			t.Fatalf("%q must not be reported as the agent's own mistake: %s", output, decision.Reason)
		}
	}
}

// A storage fault of the harness itself is neither the agent's mistake nor a
// transport problem: re-running the turn runs into the same fault again and
// spends a model call to find that out.
func TestAHarnessStorageFaultIsNamedAndNotRerun(t *testing.T) {
	for _, output := range []string{
		`Session failed after a storage error; close and reopen it`,
		`database is locked (5) (SQLITE_BUSY)`,
	} {
		decision := retryVerdict(output)
		if decision.Retry {
			t.Fatalf("%q repeats itself on the next turn; the claim that it is transient is untested, got %+v", output, decision)
		}
		if strings.Contains(decision.Reason, "不是环境问题") {
			t.Fatalf("%q is the harness's own fault, not the agent's: %s", output, decision.Reason)
		}
		if !strings.Contains(decision.Reason, "存储") {
			t.Fatalf("%q names where the fault is: %s", output, decision.Reason)
		}
	}
}

// A failure the agent can act on must not be retried: a second attempt spends a
// model call on the same conclusion.
func TestAVerdictOnTheWorkIsNotRetried(t *testing.T) {
	for _, output := range []string{
		`Provider answered HTTP 400: the request body names a model that does not exist`,
		`the patch does not apply: file changed since it was read`,
	} {
		decision := retryVerdict(output)
		if decision.Retry {
			t.Fatalf("%q is a verdict on the work and must not be retried, got %+v", output, decision)
		}
		if !strings.Contains(decision.Reason, "不是环境问题") {
			t.Fatalf("%q must say why retrying cannot help: %s", output, decision.Reason)
		}
	}
}

// A transport that already retried inside the turn is not retried again as a
// whole new turn: that doubles the requests for one failure. It is reported,
// and the report must not read as the agent's own mistake either — the user's
// "可以再发一次重试" already tells them the turn can be sent again.
func TestAnInterruptedTransportIsReportedNotRepeated(t *testing.T) {
	for _, output := range []string{
		`The durable input was not answered: unanswered: Post "https://x/v1/chat/completions": EOF (the transport retried 2 times)`,
		`Post "https://opencode.ai/zen/go/v1/chat/completions": EOF`,
		`local error: tls: bad record MAC`,
	} {
		decision := retryVerdict(output)
		if decision.Retry {
			t.Fatalf("%q already had its transport retries; a whole new turn doubles them, got %+v", output, decision)
		}
		if strings.Contains(decision.Reason, "不是环境问题") {
			t.Fatalf("%q is a transport cut, not a verdict on the work: %s", output, decision.Reason)
		}
	}
}

// The user's turn-level message must not promise a retry the harness cannot do,
// and must not read as an accusation either.
func TestAUserFacingFailureMessageNamesTheCause(t *testing.T) {
	transportCut := TurnFailureText(`Post "https://x/v1/chat/completions": EOF`)
	if !strings.Contains(transportCut, "中断") && !strings.Contains(transportCut, "重试") {
		t.Fatalf("a transport cut is described as a transport cut: %q", transportCut)
	}

	certificate := TurnFailureText(`Post "https://x/v1/chat/completions": tls: failed to verify certificate: x509: certificate signed by unknown authority`)
	if !strings.Contains(certificate, "重试") {
		t.Fatalf("a failure the harness can retry says so: %q", certificate)
	}
}
