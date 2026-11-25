package graph

type SecretPersistRequest struct {
	Ref   string  `json:"ref"`
	Value *string `json:"value"`
}

type SecretPersist struct {
	order []string
	vals  map[string]*string
}

func CreateSecretPersist() *SecretPersist {
	return &SecretPersist{vals: map[string]*string{}}
}

func (s *SecretPersist) Mark(ref string, value *string) {
	if _, ok := s.vals[ref]; !ok {
		s.order = append(s.order, ref)
	}
	s.vals[ref] = value
}

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
