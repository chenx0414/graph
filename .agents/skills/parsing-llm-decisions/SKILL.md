---
name: parsing-llm-decisions
created-by: graph-agent
description: Use when designing, debugging, or verifying the parser and trigger loop for structured decisions emitted by an LLM (JSON actions, sediment/review verdicts, metadata), including extracting an object out of free-form prose and guarding large payload views.
---

# Parsing structured decisions out of LLM prose

An LLM reply is prose that *contains* a decision, not a document that *is* one. The parser's job
is to find the decision without letting the surrounding text move its boundaries.

## 1. Extract the object by brace balancing, never by first-`{`-to-last-`}`

The tempting fix — take everything from the first `{` to the last `}` — is silently lossy: any
literal brace snippet inside the prose (an example action, a quoted payload) becomes part of the
"JSON", so a perfectly valid decision fails to parse and is discarded whole.

Instead scan forward from the first `{`, tracking depth, and return the object at the depth that
closes it:

- `{` increments, `}` decrements.
- Braces inside a JSON string are content, not structure: while inside a quoted string, ignore
  braces and honour `\` escapes (including `\"`).
- Stop at the first depth-0 close; that is the decision. Everything after it is prose, not payload.

Keep the previous shapes readable. A parser change must be additive: old, newline-formatted
metadata lines and fenced replies still parse exactly as before, guarded by the tests that already
exist for them.

## 2. Fences and bodies

- Strip the fence **only when it is closed**. An unclosed fence is not a body delimiter — treat it
  as unparsed content. This rule is usually already asserted by an existing test, so run the suite
  before believing a rewrite: a first implementation that "fixes" the unclosed-fence case will be
  caught by that test, which is the test doing its job.
- When there is **no fence**, the text following the metadata line is the body. That is the
  common shape in production and the one most likely to be missing from the parser's happy path.

## 3. Record the shape of what failed to parse

Every review pass should persist a small shape signature of the reply it read — which metadata
line matched, fence state (none / open / closed), total character count, and a tail excerpt — into
the review record. Cheap, and the next "reply was unreadable" incident then arrives with its own
shape instead of requiring a re-derivation of the same root cause.

## 4. Pagination cursors: omit the parameter, don't pass zero

When a read API has an `after` / `since` / cursor parameter, the server's `after=0` branch is
usually "start from the earliest item", not "default". Passing `0` unconditionally therefore
silently returns the *oldest* window when the caller wanted the newest.

Rule: **only send the cursor when it is > 0**. No cursor = latest window; cursor > 0 = continue
from there. Apply this at every call site, including the ones that default the cursor to zero.

## 5. Cap the first view of anything that reads a whole corpus

Any tool that returns an entire conversation, transcript, or manifest in one call has an unbounded
reply. Give it a first-view character cap, expressed in the same units and next to the other caps
in the system (shell output, system manifest, …), and when the cap is exceeded return a summary
plus a handle (a file path or id) the caller can use to read further. Do not special-case one tool
— the number belongs in the shared table so the limits stay comparable.

## 6. Verify by live self-observation, and mind the code-generation lag

A good end-to-end verification exercises two things in one call — e.g. read the *current session's
own transcript* and check both the response (cap + summary + handle returned, not the raw
payload) and the window boundaries (first returned sequence is near the latest, not the earliest).

Caveat: a review artefact for a turn is written when that turn is finalised, so a self-check run
inside the same turn inspects the *previous* build's behaviour. Verify next turn, and say so
explicitly rather than reporting a value you cannot yet observe.

## 7. Tests to require

- Unit: no-fence reply yields a body; prose containing a brace snippet does not shift the metadata
  boundary; previously supported shapes still parse.
- End-to-end: a no-fence reply actually produces the persisted artefact (a skill, a verdict, a
  ticket) rather than merely passing a unit-level assertion.
- Cursor behaviour: no cursor returns the latest window; a cursor returns a continued window.
