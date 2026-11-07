package graph

import "github.com/chenx0414/graph/backend/internal/pigkernel"

type pigTurnFact int

const (
	pigTurnKernelDone pigTurnFact = iota
	pigTurnReachedModel
	pigTurnAcceptedUnsent
)

func classifyPigTurn(receipt pigkernel.ExecutionReceipt, reachedModel bool) pigTurnFact {
	if receipt.Completed {
		return pigTurnKernelDone
	}
	if reachedModel {
		return pigTurnReachedModel
	}
	return pigTurnAcceptedUnsent
}

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
