**RSI change-shape hint: the missing path**

`rsiChangeShapeHint` (`src/runtime/rsi.ts`) answers the model's own `changes[]` mistakes before the
SDK schema check. It used to cover only nesting mistakes; it now also names an entry that dropped
`path`, because that measured as the most frequent mistake and the SDK's wording
(`changes[0].path: must have required properties path`) never says which entry or what shape to use.

- Fixes the entry by index and shows the three accepted shapes.
- A blank (present but empty) `path` is a different mistake and stays the schema's business.
- `tests/console/rsi-change-shape.test.ts` pins both, plus that a well-formed call passes untouched.
