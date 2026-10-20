package graph

// PickModelInput selects a configured model for one node spec.
type PickModelInput struct {
	Spec        NodeSpec
	Models      func() []ModelEntry
	Catalog     *Catalog
	Preferences map[ModelGrade][]string
}

// PickModel reads the recipe grade when a definition is published and otherwise keeps the requested model.
func PickModel(input PickModelInput) *ModelEntry {
	directory := input.Models()
	definition := DefinitionSpec{RecommendedGrade: "medium"}
	if input.Spec.DefinitionVersion != nil && *input.Spec.DefinitionVersion != "" && input.Catalog != nil {
		func() {
			defer func() { _ = recover() }()
			definition = input.Catalog.Definition(*input.Spec.DefinitionVersion).DefinitionSpec
		}()
	}
	requested := ""
	if input.Spec.Model != nil {
		requested = *input.Spec.Model
	}
	return SelectModel(SelectModelInput{
		Requested:   requested,
		Grade:       definition.RecommendedGrade,
		Directory:   directory,
		Preferences: input.Preferences,
	})
}
