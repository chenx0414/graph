package graph

// errorString is a constant error, so a panic site needs no import.
type errorString string

func (e errorString) Error() string { return string(e) }
