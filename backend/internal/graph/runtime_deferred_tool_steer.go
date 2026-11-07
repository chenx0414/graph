package graph

import "sync"

var deferredDeliveryHook = struct {
	mutex sync.Mutex
	hook  func(conversationId string, requestId string) bool
}{}

func SetDeferredDeliveryHook(hook func(conversationId string, requestId string) bool) func() {
	deferredDeliveryHook.mutex.Lock()
	previous := deferredDeliveryHook.hook
	deferredDeliveryHook.hook = hook
	deferredDeliveryHook.mutex.Unlock()
	return func() {
		deferredDeliveryHook.mutex.Lock()
		deferredDeliveryHook.hook = previous
		deferredDeliveryHook.mutex.Unlock()
	}
}

func deliverDeferredResultToRunningTurn(conversationId, requestId string) bool {
	deferredDeliveryHook.mutex.Lock()
	hook := deferredDeliveryHook.hook
	deferredDeliveryHook.mutex.Unlock()
	if hook == nil {
		return false
	}
	return hook(conversationId, requestId)
}
