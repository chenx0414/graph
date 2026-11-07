package graph

// PickModelInput selects a configured model for one node spec.
type PickModelInput struct {
	Spec   NodeSpec
	Models func() []ModelEntry
}

// PickModel keeps the model a node names, and otherwise takes the first configured one.
func PickModel(input PickModelInput) *ModelEntry {
	requested := ""
	if input.Spec.Model != nil {
		requested = *input.Spec.Model
	}
	return SelectModel(SelectModelInput{
		Requested: requested,
		Directory: input.Models(),
	})
}
