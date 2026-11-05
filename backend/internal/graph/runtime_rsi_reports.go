package graph

import (
	"encoding/json"
	"strings"

	"bytes"
)

// rsiJSONString encodes one JSON string the way JSON.stringify does.
func rsiJSONString(value string) string {
	buffer := &bytes.Buffer{}
	encoder := json.NewEncoder(buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		panic(err)
	}
	return strings.TrimRight(buffer.String(), "\n")
}

// rsiJSONStringOrNull encodes a string that may be absent.
func rsiJSONStringOrNull(value *string) string {
	if value == nil {
		return "null"
	}
	return rsiJSONString(*value)
}

// rsiFailureReport is the report of a change that could not be applied.
func rsiFailureReport(input RsiChangeInput, root *string, errorText string, validation []RsiValidationResult) string {
	target := "不可用"
	if root != nil {
		target = *root
	}
	lines := []string{
		"### RSI 变更失败：" + input.Title,
		"",
		"- 问题：" + input.Problem,
		"- 目标：" + target,
		"- 原因：" + errorText,
	}
	if len(validation) > 0 {
		lines = append(lines, "- 验证：")
		for _, item := range validation {
			lines = append(lines, "  - "+item.Command+": "+item.Status)
		}
		lines = append(lines, FailureDigest(validation)...)
	}
	return strings.Join(lines, "\n")
}

// rsiChecksFailedReport is the report of a change whose checks failed.
func rsiChecksFailedReport(input RsiChangeInput, receipt RsiReceipt) string {
	branch := "unknown"
	if receipt.Branch != nil {
		branch = *receipt.Branch
	}
	pending := strings.Join(receipt.PendingFiles, ", ")
	if pending == "" {
		pending = "（无文件改动）"
	}
	lines := []string{
		"### RSI 检查未通过，改动已保留：" + input.Title,
		"",
		"- 问题：" + input.Problem,
	}
	if input.Diagnosis != nil && *input.Diagnosis != "" {
		lines = append(lines, "- 诊断："+*input.Diagnosis)
	}
	lines = append(lines,
		"- 分支："+branch,
		"- 保留文件："+pending,
		"- 验证：",
	)
	for _, item := range receipt.Validation {
		lines = append(lines, "  - "+item.Command+": "+item.Status)
	}
	lines = append(lines, FailureDigest(receipt.Validation)...)
	lines = append(lines, "",
		"改动仍在工作区、尚未提交，也不会触发重载。继续修复后再次调用 apply_rsi_change 即可（可用 changes: [] 只重跑检查）。")
	return strings.Join(lines, "\n")
}

// rsiDryRunReport is the report of a rehearsal: the verdict, without the delivery.
func rsiDryRunReport(input RsiChangeInput, receipt RsiReceipt, failed bool) string {
	lines := []string{
		"### RSI 演练：" + input.Title,
		"",
		"- 问题：" + input.Problem,
	}
	if input.Evidence != nil && *input.Evidence != "" {
		lines = append(lines, "- 证据："+*input.Evidence)
	}
	if input.Diagnosis != nil && *input.Diagnosis != "" {
		lines = append(lines, "- 诊断："+*input.Diagnosis)
	}
	if input.Impact != nil && *input.Impact != "" {
		lines = append(lines, "- 影响："+*input.Impact)
	}
	if input.Risk != nil && *input.Risk != "" {
		lines = append(lines, "- 风险："+*input.Risk)
	}
	lines = append(lines, "- 文件："+strings.Join(receipt.Files, ", "), "- 验证：")
	for _, item := range receipt.Validation {
		lines = append(lines, "  - "+item.Command+": "+item.Status)
	}
	if receipt.OutputPath != nil && *receipt.OutputPath != "" {
		lines = append(lines, "- 完整日志："+*receipt.OutputPath)
	}
	lines = append(lines, FailureDigest(receipt.Validation)...)
	if failed {
		lines = append(lines, "- 结论：有检查未通过。这是演练：改动已从工作区恢复，没有留下任何东西，也没有提交。")
	} else {
		lines = append(lines, "- 结论：检查全部通过。这是演练：改动已从工作区恢复，没有提交，也不会重载。需要真正交付时去掉 dryRun 再来一次。")
	}
	return strings.Join(lines, "\n")
}

// rsiUnavailableReport is the report of a change that could not run at all.
func rsiUnavailableReport(input RsiChangeInput, root *string, reason string) string {
	target := "未找到"
	if root != nil {
		target = *root
	}
	return strings.Join([]string{
		"### RSI 不可用：" + input.Title,
		"",
		"- 问题：" + input.Problem,
		"- 目标：" + target,
		"- 原因：" + reason,
	}, "\n")
}

// rsiSuccessReport is the report of a change that was committed.
func rsiSuccessReport(input RsiChangeInput, receipt RsiReceipt, activationNote string) string {
	branch := "unknown"
	if receipt.Branch != nil {
		branch = *receipt.Branch
	}
	commit := "unknown"
	if receipt.Commit != nil {
		commit = *receipt.Commit
	}
	lines := []string{
		"### RSI 已提交：" + input.Title,
		"",
		"- 问题：" + input.Problem,
	}
	if input.Evidence != nil && *input.Evidence != "" {
		lines = append(lines, "- 证据："+*input.Evidence)
	}
	if input.Diagnosis != nil && *input.Diagnosis != "" {
		lines = append(lines, "- 诊断："+*input.Diagnosis)
	}
	if input.Impact != nil && *input.Impact != "" {
		lines = append(lines, "- 影响："+*input.Impact)
	}
	if input.Risk != nil && *input.Risk != "" {
		lines = append(lines, "- 风险："+*input.Risk)
	}
	lines = append(lines,
		"- 分支："+branch,
		"- 提交："+commit,
		"- 文件："+strings.Join(receipt.Files, ", "),
		"- 验证：",
	)
	if len(receipt.Adopted) > 0 {
		lines = append(lines, "- 其中提交前已在工作区（内容以磁盘上的为准）："+strings.Join(receipt.Adopted, ", "))
	}
	for _, item := range receipt.Validation {
		lines = append(lines, "  - "+item.Command+": "+item.Status)
	}
	if receipt.OutputPath != nil && *receipt.OutputPath != "" {
		lines = append(lines, "- 完整日志："+*receipt.OutputPath)
	}
	lines = append(lines, FailureDigest(receipt.Validation)...)
	lines = append(lines, "- 激活："+activationNote)
	if receipt.AppInstall != nil {
		if receipt.AppInstall.State == "installed" {
			lines = append(lines, "- Graph.app：已安装本次构建的包；**退出并重开 Graph.app 才会用到它**。")
		} else {
			lines = append(lines, "- Graph.app：没有更新（"+receipt.AppInstall.Note+"）；此时重开 Graph.app 也不会带上这次改动。")
		}
	}
	if receipt.RestartRequired {
		lines = append(lines, "- 当前回合已结束；等待宿主重载确认后才能报告“已生效”。")
	}
	if receipt.Diff != nil && *receipt.Diff != "" {
		lines = append(lines, "", "```diff", *receipt.Diff, "```")
	}
	return strings.Join(lines, "\n")
}
