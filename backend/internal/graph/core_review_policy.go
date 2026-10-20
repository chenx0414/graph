package graph

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"
)

// PublishedSubject is an exact published artifact a review cites.
type PublishedSubject struct {
	ArtifactId string `json:"artifactId"`
	Version    int    `json:"version"`
	Digest     string `json:"digest"`
}

// ReviewJudgment is one pass, fail, or unresolved finding.
type ReviewJudgment struct {
	Verdict  string             `json:"verdict"`
	Reason   string             `json:"reason"`
	Evidence []PublishedSubject `json:"evidence"`
	Files    []string           `json:"files,omitempty"`
}

// ReviewDecision is the verification output of a generated review module.
type ReviewDecision struct {
	Kind       string             `json:"kind"`
	Outcome    string             `json:"outcome"`
	Subjects   []PublishedSubject `json:"subjects"`
	Reports    []string           `json:"reports"`
	Blockers   []any              `json:"blockers"`
	ReviewText []any              `json:"reviewText"`
	Unowned    []string           `json:"unowned,omitempty"`
	Ranking    []any              `json:"ranking,omitempty"`
	Winner     *string            `json:"winner,omitempty"`
}

// evaluatePolicySource is evaluatePolicy.toString() after Node type stripping.
// TODO(port): policy JSON in the generated module uses encoding/json key order, not JavaScript insertion order.
const evaluatePolicySource = "function evaluatePolicy(config              , inputs                      , previousState      ) {\n  let waiting = false;\n  const decision                 = { kind: 'verification', outcome: 'pass', subjects: [], reports: config.reports, blockers: [], reviewText: [] };\n  const object = (value         )                                   => Boolean(value && typeof value === 'object' && !Array.isArray(value));\n  const text = (value         )                  => typeof value === 'string' && Boolean(value.trim());\n  const invalid = (reason        )        => { throw new Error(reason); };\n  const subject = (value         )                   => {\n    if (!object(value) || !text(value.artifactId) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)) invalid('Review requires an exact published artifact reference');\n    const item = value                    ; return { artifactId: item.artifactId, version: item.version, digest: item.digest };\n  };\n  const remember = (item                  ) => { if (!decision.subjects.some(held => held.artifactId === item.artifactId && held.version === item.version && held.digest === item.digest)) decision.subjects.push(item); };\n  const checkedSubject = (input        , value         ) => {\n    const current = subject(inputs[input]); const reviewed = subject(value);\n    if (config.staleReview === 'wait' && current.artifactId === reviewed.artifactId && reviewed.version < current.version) {\n      waiting = true; invalid('Waiting for review of the current published artifact version');\n    }\n    if (current.artifactId !== reviewed.artifactId || current.version !== reviewed.version || current.digest !== reviewed.digest) invalid('Review does not apply to the current published artifact version');\n    return current;\n  };\n  const judgment = (value         )                 => {\n    if (!object(value) || !['pass', 'fail', 'unresolved'].includes(String(value.verdict)) || !text(value.reason) || !Array.isArray(value.evidence) || !value.evidence.length) invalid('Review judgments require verdict, reason and published evidence');\n    const item = value                             ; item.evidence.forEach(subject);\n    if (item.files !== undefined && (!Array.isArray(item.files) || !item.files.length || item.files.some(path => !text(path) || path.startsWith('/') || path.split('/').includes('..')))) invalid('Review files must be nonempty repository-relative paths');\n    return item;\n  };\n  const block = (id        , item                ) => decision.blockers.push({ id, reason: item.reason, evidence: item.evidence, ...(item.files ? { files: item.files } : {}) });\n  const summarize = (report        , items                  ) => {\n    const selected = items.find(item => item.verdict !== 'pass') ?? items[0]; if (!selected) return;\n    const files = [...new Set(items.flatMap(item => item.files ?? []))];\n    decision.reviewText.push({ report, verdict: selected.verdict, reason: selected.reason, ...(files.length ? { files } : {}) });\n  };\n  try {\n    const reports = config.reports.map(name => {\n      const value = inputs[name];\n      if (!object(value) || value.schemaVersion !== 1 || !object(value.body) || value.body.kind !== config.kind) invalid(`Missing or malformed review report from ${name}`);\n      const report = value                                                                  ;\n      return { name, subject: report.subject, body: report.body };\n    });\n    if (config.kind === 'multiview') {\n      for (const report of reports) {\n        remember(checkedSubject(config.subject, report.subject));\n        if (!object(report.body.dimensions)) invalid('Review dimensions are required');\n        const dimensions = report.body.dimensions                           ; const judged                   = [];\n        for (const item of config.dimensions.filter(item => item.report === report.name)) {\n          if (dimensions[item.id] === undefined && !item.required) continue;\n          const checked = judgment(dimensions[item.id]); judged.push(checked);\n          if (item.required && checked.verdict !== 'pass') block(item.id, checked);\n        }\n        summarize(report.name, judged);\n      }\n    } else if (config.kind === 'adversarial') {\n      const checks                          = Object.create(null); const counterexamples            = [];\n      for (const report of reports) {\n        remember(checkedSubject(config.subject, report.subject));\n        if (!object(report.body.checks) || !Array.isArray(report.body.counterexamples)) invalid('Adversarial review requires checks and counterexamples');\n        Object.assign(checks, report.body.checks); counterexamples.push(...report.body.counterexamples             );\n        summarize(report.name, Object.values(report.body.checks                           ).map(judgment));\n      }\n      for (const id of config.criteria) { const checked = judgment(checks[id]); if (checked.verdict !== 'pass') block(id, checked); }\n      const seen = new Set        ();\n      for (const raw of counterexamples) {\n        if (!object(raw) || !text(raw.id) || seen.has(raw.id) || !text(raw.acceptanceId) || !config.criteria.includes(raw.acceptanceId)\n          || typeof raw.impactsAcceptance !== 'boolean' || !['valid', 'invalid', 'unresolved'].includes(String(raw.validity)) || !['open', 'resolved'].includes(String(raw.resolution))) invalid('Counterexamples require unique IDs, configured criteria, validity, resolution and acceptance impact');\n        const item = raw                           ; seen.add(item.id          ); const checked = judgment(item.judgment);\n        if (item.impactsAcceptance && item.resolution === 'open' && item.validity !== 'invalid') block(item.id          , checked);\n      }\n    } else {\n      const entries = new Map                                                                                           ();\n      for (const report of reports) {\n        if (!Array.isArray(report.body.candidates)) invalid('Jury report requires candidates');\n        for (const raw of report.body.candidates             ) {\n          if (!object(raw) || !text(raw.id) || entries.has(raw.id)) invalid('Jury report must include each candidate once');\n          const item = raw                           ; const candidate = config.candidates.find(spec => spec.id === item.id);\n          if (!candidate || !object(item.hard) || !object(item.scores)) invalid('Jury candidates require configured IDs, hard judgments and scores');\n          const artifact = checkedSubject(candidate .subject, item.artifact); const hard = item.hard                           ; const rawScores = item.scores                           ;\n          const eligible = config.hard.map(id => judgment(hard[id])).every(item => item.verdict === 'pass'); const scores                         = {};\n          for (const criterion of config.ranking) {\n            const rawScore = rawScores[criterion.id];\n            if (!object(rawScore) || typeof rawScore.value !== 'number' || !Number.isFinite(rawScore.value) || rawScore.value < criterion.min || rawScore.value > criterion.max) invalid('Jury scores must fall within the configured bounds');\n            const score = rawScore                                                                   ; judgment({ ...score, verdict: 'pass' }); scores[criterion.id] = score.value;\n          }\n          entries.set(item.id          , { artifact, eligible, scores });\n        }\n      }\n      const ranked = config.candidates.map(candidate => {\n        const entry = entries.get(candidate.id); if (!entry) invalid('Jury report must include every candidate');\n        const score = config.ranking.reduce((total, criterion) => total + criterion.weight * (entry .scores[criterion.id]  - criterion.min) / (criterion.max - criterion.min), 0);\n        return { candidateId: candidate.id, score, ...entry  };\n      });\n      decision.ranking = ranked.map(({ candidateId, score, eligible }) => ({ candidateId, score, eligible }));\n      const eligible = ranked.filter(item => item.eligible).sort((left, right) => {\n        if (right.score !== left.score) return right.score - left.score;\n        for (const id of config.tieOrder) { const difference = right.scores[id]  - left.scores[id] ; if (difference) return difference; }\n        return left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0;\n      });\n      const winner = eligible[0];\n      if (!winner) decision.blockers.push({ id: 'winner', reason: 'No candidate satisfies the hard criteria', evidence: [] });\n      else { decision.winner = winner.candidateId; remember(winner.artifact); }\n    }\n  } catch (error) {\n    if (waiting) return { state: previousState, outputs: {}, diagnostics: ['Waiting for review of the current published artifact version'] };\n    decision.blockers.push({ id: 'invalid_evidence', reason: error instanceof Error ? error.message : String(error), evidence: [] });\n    // Invalid evidence must not leave a partial jury winner looking accepted.\n    delete decision.winner;\n  }\n  decision.outcome = decision.blockers.length ? 'rework' : 'pass';\n  const unowned = [...new Set(decision.blockers.flatMap(item => item.files ?? []))].filter(path => !(config.owned ?? []).some(scope => path === scope || path.startsWith(scope.endsWith('/') ? scope : `${scope}/`)));\n  if (unowned.length) decision.unowned = unowned;\n  return { state: { decision }, outputs: { [decision.outcome === 'pass' ? 'approved' : 'rework']: decision }, diagnostics: [`${config.kind}: ${decision.outcome}`] };\n}"

func reviewInvalid(reason string) { Raise("invalid_definition", reason) }

func reviewRecord(config any) map[string]any {
	if record, ok := config.(map[string]any); ok {
		return record
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		panic(err)
	}
	var record map[string]any
	if err := json.Unmarshal(encoded, &record); err != nil {
		reviewInvalid("Unknown review policy")
	}
	return record
}

func reviewStrings(value any) ([]string, bool) {
	switch typed := value.(type) {
	case []string:
		return typed, true
	case []any:
		out := make([]string, len(typed))
		for i, item := range typed {
			text, ok := item.(string)
			if !ok {
				return nil, false
			}
			out[i] = text
		}
		return out, true
	default:
		return nil, false
	}
}

func reviewUnique(value any, name string) []string {
	items, ok := reviewStrings(value)
	if !ok || len(items) == 0 {
		reviewInvalid(name + " must be unique and nonempty")
	}
	seen := map[string]bool{}
	for _, item := range items {
		if strings.TrimSpace(item) == "" || seen[item] {
			reviewInvalid(name + " must be unique and nonempty")
		}
		seen[item] = true
	}
	return items
}

func reviewObjects(value any) ([]map[string]any, bool) {
	items, ok := value.([]any)
	if !ok {
		return nil, false
	}
	out := make([]map[string]any, len(items))
	for i, item := range items {
		record, ok := item.(map[string]any)
		if !ok || record == nil {
			return nil, false
		}
		out[i] = record
	}
	return out, true
}

func reviewFinite(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, !math.IsNaN(typed) && !math.IsInf(typed, 0)
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	default:
		return 0, false
	}
}

func validateReviewPolicy(config any) map[string]any {
	if config == nil {
		reviewInvalid("Unknown review policy")
	}
	record := reviewRecord(config)
	kind, _ := record["kind"].(string)
	if kind != "multiview" && kind != "adversarial" && kind != "jury" {
		reviewInvalid("Unknown review policy")
	}
	reports := reviewUnique(record["reports"], "Review input names")
	if _, ok := record["staleReview"]; ok {
		stale, _ := record["staleReview"].(string)
		if stale != "rework" && stale != "wait" {
			reviewInvalid("staleReview must be rework or wait")
		}
	}
	if _, ok := record["owned"]; ok {
		owned, isArray := reviewStrings(record["owned"])
		if !isArray {
			reviewInvalid("Owned scopes must be repository-relative paths")
		}
		for _, path := range owned {
			if strings.TrimSpace(path) == "" || strings.HasPrefix(path, "/") || strings.Contains("/"+path+"/", "/../") || path == ".." || strings.HasPrefix(path, "../") || strings.HasSuffix(path, "/..") {
				reviewInvalid("Owned scopes must be repository-relative paths")
			}
			for _, part := range strings.Split(path, "/") {
				if part == ".." {
					reviewInvalid("Owned scopes must be repository-relative paths")
				}
			}
		}
	}
	if kind == "multiview" {
		dimensions, ok := reviewObjects(record["dimensions"])
		if !ok {
			reviewInvalid("Dimensions must be objects")
		}
		ids := make([]any, len(dimensions))
		for i, item := range dimensions {
			ids[i] = item["id"]
		}
		reviewUnique(ids, "Dimension IDs")
		for _, item := range dimensions {
			report, _ := item["report"].(string)
			_, isBool := item["required"].(bool)
			if !containsString(reports, report) || !isBool {
				reviewInvalid("Every dimension must declare a listed report and whether it is required")
			}
		}
	} else if kind == "adversarial" {
		reviewUnique(record["criteria"], "Acceptance criteria")
	} else if kind == "jury" {
		candidates, ok := reviewObjects(record["candidates"])
		if !ok {
			reviewInvalid("Candidates must be objects")
		}
		ranking, ok := reviewObjects(record["ranking"])
		if !ok {
			reviewInvalid("Ranking criteria must be objects")
		}
		candidateIDs := make([]any, len(candidates))
		subjects := make([]any, len(candidates))
		for i, item := range candidates {
			candidateIDs[i] = item["id"]
			subjects[i] = item["subject"]
		}
		reviewUnique(candidateIDs, "Candidate IDs")
		reviewUnique(subjects, "Candidate subject inputs")
		reviewUnique(record["hard"], "Hard criteria")
		rankIDs := make([]any, len(ranking))
		for i, item := range ranking {
			rankIDs[i] = item["id"]
		}
		reviewUnique(rankIDs, "Ranking criteria")
		tie := reviewUnique(record["tieOrder"], "Tie order")
		if len(tie) != len(ranking) {
			reviewInvalid("Tie order must be a permutation of ranking criteria")
		}
		for _, id := range tie {
			found := false
			for _, item := range ranking {
				if item["id"] == id {
					found = true
				}
			}
			if !found {
				reviewInvalid("Tie order must be a permutation of ranking criteria")
			}
		}
		for _, item := range ranking {
			weight, weightOK := reviewFinite(item["weight"])
			min, minOK := reviewFinite(item["min"])
			max, maxOK := reviewFinite(item["max"])
			if !weightOK || !minOK || !maxOK || min >= max {
				reviewInvalid("Ranking weights and bounds must be finite with min < max")
			}
			_ = weight
		}
	} else {
		reviewInvalid("Unknown review policy")
	}
	var subjects []string
	if kind == "jury" {
		candidates, _ := reviewObjects(record["candidates"])
		for _, item := range candidates {
			text, _ := item["subject"].(string)
			subjects = append(subjects, text)
		}
	} else {
		text, _ := record["subject"].(string)
		subjects = []string{text}
	}
	reviewUnique(stringAny(subjects), "Subject input names")
	for _, name := range subjects {
		if containsString(reports, name) {
			reviewInvalid("Subject and review input names must be distinct")
		}
	}
	return record
}

func stringAny(values []string) []any {
	out := make([]any, len(values))
	for i, value := range values {
		out[i] = value
	}
	return out
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// ReviewPolicyInputs lists the command-module inputs this policy reads.
func ReviewPolicyInputs(config any) []string {
	record := validateReviewPolicy(config)
	kind, _ := record["kind"].(string)
	var subjects []string
	if kind == "jury" {
		candidates, _ := reviewObjects(record["candidates"])
		for _, item := range candidates {
			text, _ := item["subject"].(string)
			subjects = append(subjects, text)
		}
	} else {
		text, _ := record["subject"].(string)
		subjects = []string{text}
	}
	reports, _ := reviewStrings(record["reports"])
	return append(subjects, reports...)
}

// ReviewPolicyCode generates the isolated evaluate module for one policy.
func ReviewPolicyCode(config any) string {
	validateReviewPolicy(config)
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(config); err != nil {
		panic(err)
	}
	encoded := strings.TrimRight(buf.String(), "\n")
	return "const policy = " + encoded + ";\nexport function evaluate(environment) { return (" + evaluatePolicySource + ")(policy, environment.inputs, environment.state); }\n"
}
