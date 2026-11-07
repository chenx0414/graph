package graph

import "sync"

var conversationInjectors = struct {
	mutex sync.Mutex
	by    map[string]func(string) bool
}{by: map[string]func(string) bool{}}

func RegisterConversationInjector(conversationId string, inject func(string) bool) func() {
	if conversationId == "" || inject == nil {
		return func() {}
	}
	conversationInjectors.mutex.Lock()
	conversationInjectors.by[conversationId] = inject
	conversationInjectors.mutex.Unlock()
	return func() {
		conversationInjectors.mutex.Lock()
		delete(conversationInjectors.by, conversationId)
		conversationInjectors.mutex.Unlock()
	}
}

func conversationInjectorOf(conversationId string) func(string) bool {
	conversationInjectors.mutex.Lock()
	defer conversationInjectors.mutex.Unlock()
	return conversationInjectors.by[conversationId]
}
