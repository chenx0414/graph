package main

import (
	"context"
	"fmt"
	"path/filepath"
	"time"

	"graph/verification/internal/mygoauto"
)

// motionCommand drives the isolated window through MyGo's own automation
// socket: semantics from the app's accessibility tree, no screen-recording or
// accessibility permission, and an `idle` wait instead of a sleep.
func motionCommand(p paths, flags flags) int {
	if len(flags.rest) == 0 {
		return failEnvelope("ui.motion", "motion", codeUsage, "a motion verb is required",
			"verify-graph ui motion open|tree|press|shot|close --run <id>").print()
	}
	verb := flags.rest[0]
	meta, err := readRunMeta(p, flags.value("run", ""))
	if err != nil {
		return failEnvelope("ui.motion", "motion", codeNoRun, err.Error(), "run: verify-graph launch").print()
	}
	options := motionOptions(p, meta)
	outDir := filepath.Join(p.EvidenceRoot, meta.RunID, "ui-motion")
	timeout := time.Duration(flags.number("timeout", 120)) * time.Second
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	switch verb {
	case "open":
		if flags.has("dry-run") {
			data := map[string]any{"runId": meta.RunID, "binary": options.RunDir + "/bin/graph-verify-ui",
				"socket": options.RunDir + "/automation.sock", "dryRun": true}
			result := okEnvelope("ui.motion.open", "motion", data)
			result.RunID = meta.RunID
			return result.print()
		}
		options.ForceBuild = flags.has("rebuild")
		session, err := mygoauto.StartWindow(ctx, options)
		if err != nil {
			return failEnvelope("ui.motion.open", "motion", codeDaemonDown, err.Error(),
				"run: verify-graph launch --run "+meta.RunID+" then retry").print()
		}
		record, err := session.SaveWindow()
		if err != nil {
			return failEnvelope("ui.motion.open", "motion", codeUsage, err.Error(), "check that verification/.run is writable").print()
		}
		if err := session.SaveBaseline(); err != nil {
			return failEnvelope("ui.motion.open", "motion", codeUsage, err.Error(), "check that verification/.run is writable").print()
		}
		nodes, evidence, err := session.SaveTree(ctx, filepath.Join(outDir, "tree-open.json"))
		if err != nil {
			return failEnvelope("ui.motion.open", "motion", codeScenarioFailed, err.Error(),
				"read "+filepath.Join(meta.Logs, "app.log")+" and retry").print()
		}
		result := okEnvelope("ui.motion.open", "motion", map[string]any{
			"windowId": record.WindowID, "appPid": record.AppPID, "socket": record.Socket,
			"buildSha256": record.BuildSHA, "elements": nodes,
		})
		result.RunID = meta.RunID
		if evidence != "" {
			result.add(fileArtifact("json", filepath.Join(outDir, "tree-open.json"), "accessibility tree after the window opened"))
		}
		return result.next("verify-graph ui motion press --run %s --label 洞察", meta.RunID).print()
	case "tree":
		session, err := mygoauto.Attach(ctx, options)
		if err != nil {
			return failEnvelope("ui.motion.tree", "motion", codeNoRun, err.Error(), "run: verify-graph ui motion open --run "+meta.RunID).print()
		}
		tree, err := session.Tree(ctx)
		if err != nil {
			return failEnvelope("ui.motion.tree", "motion", codeScenarioFailed, err.Error(), "run: verify-graph ui motion open --run "+meta.RunID).print()
		}
		name := flags.value("out", "tree.json")
		evidence, err := session.SaveEvidence(name, tree)
		if err != nil {
			return failEnvelope("ui.motion.tree", "motion", codeUsage, err.Error(), "check verification/evidence permissions").print()
		}
		result := okEnvelope("ui.motion.tree", "motion", map[string]any{
			"elements": len(tree), "labels": tree.Labels(),
		})
		result.RunID = meta.RunID
		result.add(fileArtifact("json", filepath.Join(options.EvidenceDir(), name), "accessibility tree"))
		_ = evidence
		return result.print()
	case "press":
		selector, err := motionSelector(flags)
		if err != nil {
			return failEnvelope("ui.motion.press", "motion", codeUsage, err.Error(), "pass --label <visible name>, e.g. --label 洞察").print()
		}
		session, err := mygoauto.Attach(ctx, options)
		if err != nil {
			return failEnvelope("ui.motion.press", "motion", codeNoRun, err.Error(), "run: verify-graph ui motion open --run "+meta.RunID).print()
		}
		before, err := session.Tree(ctx)
		if err != nil {
			return failEnvelope("ui.motion.press", "motion", codeScenarioFailed, err.Error(), "run: verify-graph ui motion tree --run "+meta.RunID).print()
		}
		node, err := session.Press(ctx, selector)
		if err != nil {
			return failEnvelope("ui.motion.press", "motion", codeLabelNotFound, err.Error(),
				"list the labels with: verify-graph ui motion tree --run "+meta.RunID).print()
		}
		after, err := session.Tree(ctx)
		if err != nil {
			return failEnvelope("ui.motion.press", "motion", codeScenarioFailed, err.Error(), "retry once; the window may be redrawing").print()
		}
		added, removed := mygoauto.Diff(before, after)
		if _, err := session.SaveEvidence("tree-after-press.json", after); err != nil {
			return failEnvelope("ui.motion.press", "motion", codeUsage, err.Error(), "check verification/evidence permissions").print()
		}
		result := okEnvelope("ui.motion.press", "motion", map[string]any{
			"pressed": map[string]any{"role": node.Role, "label": node.Label, "id": node.ID},
			"added":   motionNodes(added), "removed": motionNodes(removed),
			"changed": len(added) + len(removed),
		})
		result.RunID = meta.RunID
		result.add(fileArtifact("json", filepath.Join(options.EvidenceDir(), "tree-after-press.json"), "accessibility tree after the press"))
		if len(added)+len(removed) == 0 {
			result.Warnings = append(result.Warnings, fmt.Sprintf(
				"pressing %q changed nothing in the accessibility tree; that is expected when the control is already in that state", node.Label))
			if flags.has("expect-change") {
				result.OK = false
				result.Error = &cliError{Code: codeLabelNotFound,
					Message: fmt.Sprintf("pressing %q changed nothing in the accessibility tree", node.Label),
					Hint:    "the control may be disabled; run: verify-graph ui motion tree --run " + meta.RunID}
				return result.print()
			}
		}
		return result.next("verify-graph ui motion shot --run %s --name %s", meta.RunID, motionSlug(node.Label)).print()
	case "shot":
		session, err := mygoauto.Attach(ctx, options)
		if err != nil {
			return failEnvelope("ui.motion.shot", "motion", codeNoRun, err.Error(), "run: verify-graph ui motion open --run "+meta.RunID).print()
		}
		name := flags.value("name", "window") + ".png"
		path := filepath.Join(options.EvidenceDir(), name)
		rect, frontmost, err := session.Screenshot(path)
		if err != nil {
			return failEnvelope("ui.motion.shot", "motion", codeScenarioFailed, err.Error(),
				"bring the window on screen and retry; the capture is /usr/sbin/screencapture -x -R").print()
		}
		result := okEnvelope("ui.motion.shot", "motion", map[string]any{
			"path": path, "width": rect.Width, "height": rect.Height, "windowFrontmost": frontmost,
		})
		result.RunID = meta.RunID
		result.add(fileArtifact("png", path, "window capture"))
		if !frontmost && !flags.has("allow-occluded") {
			result.OK = false
			result.Error = &cliError{Code: codeIsolation,
				Message: "another app is in front of the verification window, so the PNG shows that app, not Graph",
				Hint:    "focus the GraphVerify window and retry, or pass --allow-occluded to keep a partial artifact"}
			return result.print()
		}
		return result.print()
	case "global":
		session, err := mygoauto.Attach(ctx, options)
		if err != nil {
			return failEnvelope("ui.motion.global", "motion", codeNoRun, err.Error(), "run: verify-graph ui motion open --run "+meta.RunID).print()
		}
		report := session.GlobalReport()
		if _, err := session.SaveGlobalReport(); err != nil {
			return failEnvelope("ui.motion.global", "motion", codeUsage, err.Error(), "check verification/evidence permissions").print()
		}
		result := okEnvelope("ui.motion.global", "motion", map[string]any{
			"unchanged": report.Unchanged, "changes": report.Changes, "launchctlCalls": report.LaunchctlLog,
		})
		result.RunID = meta.RunID
		result.add(fileArtifact("json", filepath.Join(options.EvidenceDir(), "global.json"), "user Graph fingerprint before and after the run"))
		if !report.Unchanged {
			result.OK = false
			result.Error = &cliError{Code: codeIsolation,
				Message: fmt.Sprintf("the run changed the user's Graph state: %d change(s)", len(report.Changes)),
				Hint:    "read data.changes and the shim log at " + report.ShimLog}
			return result.print()
		}
		return result.print()
	case "close":
		record, err := mygoauto.ReadWindow(options)
		if err != nil {
			return failEnvelope("ui.motion.close", "motion", codeNoRun, err.Error(), "nothing to close").print()
		}
		if err := mygoauto.StopWindow(record); err != nil {
			return failEnvelope("ui.motion.close", "motion", codeIsolation, err.Error(), "inspect the pid with: ps -p <pid>").print()
		}
		result := okEnvelope("ui.motion.close", "motion", map[string]any{"stopped": record.AppPID, "evidenceKept": true})
		result.RunID = meta.RunID
		return result.print()
	default:
		return failEnvelope("ui.motion", "motion", codeUsage, "unknown motion verb "+verb,
			"use: verify-graph ui motion open|tree|press|shot|global|close").print()
	}
}

func motionOptions(p paths, meta runMeta) mygoauto.Options {
	return mygoauto.Options{
		RunDir:     filepath.Join(p.RunRoot, meta.RunID),
		RepoRoot:   p.Repo,
		SourceRoot: p.Repo,
		ShortID:    meta.RunID,
		Evidence:   filepath.Join(p.EvidenceRoot, meta.RunID, "ui-motion"),
	}
}

func motionSelector(flags flags) (mygoauto.Sel, error) {
	label := flags.value("label", "")
	if label == "" {
		return mygoauto.Sel{}, fmt.Errorf("--label is required")
	}
	nth := 0
	if raw := flags.value("nth", ""); raw != "" {
		if _, err := fmt.Sscanf(raw, "%d", &nth); err != nil {
			return mygoauto.Sel{}, fmt.Errorf("--nth must be a number, got %q", raw)
		}
	}
	role := flags.value("role", "")
	if role == "" {
		role = "button"
	}
	return mygoauto.Sel{Role: role, Label: label, Under: flags.value("under", ""), Nth: nth}, nil
}

func motionNodes(nodes []mygoauto.Node) []map[string]any {
	out := make([]map[string]any, 0, len(nodes))
	for _, node := range nodes {
		if node.Label == "" {
			continue
		}
		out = append(out, map[string]any{"role": node.Role, "label": node.Label})
		if len(out) == 20 {
			break
		}
	}
	return out
}

func motionSlug(value string) string {
	slug := ""
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char > 127 {
			slug += string(char)
		}
	}
	if slug == "" {
		return "window"
	}
	return slug
}
