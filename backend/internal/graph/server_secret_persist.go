package graph

// Secrets the Agent wrote through the app bridge, waiting for durable storage.
//
// The daemon applies a pushed secret immediately, but it cannot store one: the
// only durable store is the desktop app's keychain, whose codec the daemon does
// not have. So the daemon keeps the request here and the desktop — which is
// only ever a client of this daemon — asks for it on a short interval, saves it
// with the same code graph:save-secret uses, and confirms it. That keeps one
// transport (the desktop always calls in) and one writer per secret.

type SecretPersistRequest struct {
	Ref string `json:"ref"`
	// Value nil is an explicit revocation and must delete the stored entry.
	Value *string `json:"value"`
}

type SecretPersist struct {
	order []string
	vals  map[string]*string
}

func CreateSecretPersist() *SecretPersist {
	return &SecretPersist{vals: map[string]*string{}}
}

// Mark records that this ref has a value the keychain does not hold yet.
// A nil value is an explicit revocation, not a delete of the pending row.
func (s *SecretPersist) Mark(ref string, value *string) {
	if _, ok := s.vals[ref]; !ok {
		s.order = append(s.order, ref)
	}
	s.vals[ref] = value
}

// Confirmed means the desktop stored (or deleted) the ref; nothing is pending for it.
func (s *SecretPersist) Confirmed(ref string) {
	if _, ok := s.vals[ref]; !ok {
		return
	}
	delete(s.vals, ref)
	next := s.order[:0]
	for _, item := range s.order {
		if item != ref {
			next = append(next, item)
		}
	}
	s.order = next
}

func (s *SecretPersist) List() []SecretPersistRequest {
	out := make([]SecretPersistRequest, 0, len(s.order))
	for _, ref := range s.order {
		out = append(out, SecretPersistRequest{Ref: ref, Value: s.vals[ref]})
	}
	return out
}
