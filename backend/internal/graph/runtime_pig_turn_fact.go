package graph

import "github.com/chenx0414/graph/backend/internal/pigkernel"

// One interrupted turn has one of three facts.
//
// The kernel finished it, the model was already asked, or the admission was
// accepted and never sent. The main operation and a node execution both read
// this classification. They settle differently. They do not decide differently.
type pigTurnFact int

const (
	// pigTurnKernelDone is a turn the kernel finished and the Graph did not.
	pigTurnKernelDone pigTurnFact = iota
	// pigTurnReachedModel is a turn whose credential was already spent.
	pigTurnReachedModel
	// pigTurnAcceptedUnsent is a turn the kernel accepted and never sent.
	pigTurnAcceptedUnsent
)

// classifyPigTurn reads the three facts of one frozen turn.
//
// A finished receipt wins. Otherwise a provider call that was not already
// named before the admission means the model was asked. Anything else was
// accepted and never sent.
func classifyPigTurn(receipt pigkernel.ExecutionReceipt, reachedModel bool) pigTurnFact {
	if receipt.Completed {
		return pigTurnKernelDone
	}
	if reachedModel {
		return pigTurnReachedModel
	}
	return pigTurnAcceptedUnsent
}

// pigCallsBeyond reports whether a turn made a provider call of its own.
//
// prior names the calls that existed before the admission. A call that is not
// among them belongs to this turn, and the turn must not be sent again.
func pigCallsBeyond(prior []string, seen []string) bool {
	known := map[string]bool{}
	for _, id := range prior {
		known[id] = true
	}
	for _, id := range seen {
		if !known[id] {
			return true
		}
	}
	return false
}
