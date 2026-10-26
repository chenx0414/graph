package graph

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// usageGrokCredential resolves the Grok credential.
func usageGrokCredential(home string, env map[string]string) (*usageCredential, error) {
	envToken := usageSelectedCredential(env, UsageProviderGrok, []string{"GRAPH_GROK_ACCESS_TOKEN", "GROK_ACCESS_TOKEN"}, usageDefaultBaseURLs[UsageProviderGrok])
	if envToken != nil {
		return envToken, nil
	}
	path := strings.TrimSpace(env["GRAPH_GROK_AUTH_PATH"])
	if path == "" {
		path = filepath.Join(home, ".grok", "auth.json")
	}
	raw, err := readUsageJSONSafe(path)
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, nil
	}
	root := usageRecord(raw)
	if root == nil {
		return nil, errors.New("Grok auth.json 根节点不是对象")
	}
	scopes := make([]string, 0, len(root))
	for scope := range root {
		scopes = append(scopes, scope)
	}
	sort.Strings(scopes)
	type entry struct {
		scope string
		value map[string]any
	}
	entries := []entry{}
	for _, scope := range scopes {
		if value := usageRecord(root[scope]); value != nil {
			entries = append(entries, entry{scope: scope, value: value})
		}
	}
	var selected *entry
	for index := range entries {
		if strings.HasPrefix(entries[index].scope, "https://auth.x.ai::") && usageText(entries[index].value["key"]) != nil {
			selected = &entries[index]
			break
		}
	}
	if selected == nil {
		for index := range entries {
			if strings.Contains(entries[index].scope, "/sign-in") && usageText(entries[index].value["key"]) != nil {
				selected = &entries[index]
				break
			}
		}
	}
	if selected == nil {
		return nil, errors.New("Grok auth.json 中没有可用的 access token")
	}
	accessToken := usageText(selected.value["key"])
	return &usageCredential{
		ID: string(UsageProviderGrok), SecretRef: usageSubscriptionSecretRefs[UsageProviderGrok],
		Configured: true, Value: *accessToken, Source: "Grok CLI 登录",
		BaseURL: usageDefaultBaseURLs[UsageProviderGrok],
	}, nil
}

// usageProtoField is one fixed32 field of a protobuf scan.
type usageProtoField struct {
	Path  []int
	Value float64
	Order int
}

// usageProtoVarint is one varint field of a protobuf scan.
type usageProtoVarint struct {
	Path  []int
	Value float64
}

// usageProtoScan collects the fields of a protobuf reply.
type usageProtoScan struct {
	Fixed32 []usageProtoField
	Varint  []usageProtoVarint
}

// usageReadVarint reads one protobuf varint.
func usageReadVarint(data []byte, cursor *int) (float64, bool) {
	value := 0.0
	shift := 0
	for *cursor < len(data) && shift < 64 {
		current := data[*cursor]
		*cursor++
		value += float64(current&0x7f) * math.Pow(2, float64(shift))
		if current&0x80 == 0 {
			return value, true
		}
		shift += 7
	}
	return 0, false
}

// usageScanProtobuf walks a protobuf reply and collects its fields.
func usageScanProtobuf(data []byte, depth int, path []int, order *int, scan *usageProtoScan) {
	cursor := 0
	for cursor < len(data) {
		fieldStart := cursor
		key, ok := usageReadVarint(data, &cursor)
		if !ok || key == 0 {
			cursor = fieldStart + 1
			continue
		}
		fieldNumber := int(key) / 8
		wireType := int(key) % 8
		fieldPath := append(append([]int{}, path...), fieldNumber)
		switch wireType {
		case 0:
			value, read := usageReadVarint(data, &cursor)
			if !read {
				cursor = fieldStart + 1
				continue
			}
			scan.Varint = append(scan.Varint, usageProtoVarint{Path: fieldPath, Value: value})
		case 1:
			cursor += 8
		case 2:
			length, read := usageReadVarint(data, &cursor)
			if !read || length < 0 || cursor+int(length) > len(data) {
				cursor = fieldStart + 1
				continue
			}
			if depth < 4 {
				usageScanProtobuf(data[cursor:cursor+int(length)], depth+1, fieldPath, order, scan)
			}
			cursor += int(length)
		case 5:
			if cursor+4 > len(data) {
				return
			}
			value := float64(math.Float32frombits(binary.LittleEndian.Uint32(data[cursor : cursor+4])))
			scan.Fixed32 = append(scan.Fixed32, usageProtoField{Path: fieldPath, Value: value, Order: *order})
			*order++
			cursor += 4
		default:
			cursor = fieldStart + 1
		}
	}
}

// usageGrpcFrames splits a gRPC-web reply into its message frames.
func usageGrpcFrames(data []byte) [][]byte {
	frames := [][]byte{}
	cursor := 0
	for cursor < len(data) {
		if cursor+5 > len(data) {
			return [][]byte{}
		}
		flags := data[cursor]
		length := binary.BigEndian.Uint32(data[cursor+1 : cursor+5])
		start := cursor + 5
		end := start + int(length)
		if end > len(data) || end < start {
			return [][]byte{}
		}
		if flags&0x80 == 0 {
			frames = append(frames, data[start:end])
		}
		cursor = end
	}
	return frames
}

// usageGrokUsage is the Grok quota the billing reply reports.
type usageGrokUsage struct {
	UsedPercent float64
	ResetAt     *int64
}

// usageParseGrokBilling reads the Grok billing reply.
func usageParseGrokBilling(data []byte, now int64) (usageGrokUsage, error) {
	payloads := usageGrpcFrames(data)
	if len(payloads) == 0 && len(data) > 0 && (data[0]>>3) > 0 {
		switch int(data[0] & 7) {
		case 0, 1, 2, 5:
			payloads = [][]byte{data}
		}
	}
	if len(payloads) == 0 {
		return usageGrokUsage{}, errors.New("Grok 账单响应没有可解析的 protobuf 数据")
	}
	scan := &usageProtoScan{}
	order := 0
	for _, payload := range payloads {
		usageScanProtobuf(payload, 0, nil, &order, scan)
	}
	candidates := []usageProtoField{}
	for _, field := range scan.Fixed32 {
		if len(field.Path) == 0 || field.Path[len(field.Path)-1] != 1 {
			continue
		}
		if math.IsNaN(field.Value) || math.IsInf(field.Value, 0) {
			continue
		}
		if field.Value < 0 || field.Value > 100 {
			continue
		}
		candidates = append(candidates, field)
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		if len(candidates[left].Path) != len(candidates[right].Path) {
			return len(candidates[left].Path) < len(candidates[right].Path)
		}
		return candidates[left].Order < candidates[right].Order
	})
	var percent *float64
	if len(candidates) > 0 {
		value := candidates[0].Value
		percent = &value
	}
	resetCandidates := []usageProtoVarint{}
	for _, field := range scan.Varint {
		if field.Value < 1_700_000_000 || field.Value > 2_100_000_000 {
			continue
		}
		if field.Value*1000 <= float64(now) {
			continue
		}
		resetCandidates = append(resetCandidates, field)
	}
	var resetAt *int64
	for _, field := range resetCandidates {
		if usageJoinProtoPath(field.Path) == "1.5.1" {
			value := int64(field.Value * 1000)
			resetAt = &value
			break
		}
	}
	if resetAt == nil && len(resetCandidates) > 0 {
		sorted := append([]usageProtoVarint{}, resetCandidates...)
		sort.SliceStable(sorted, func(left, right int) bool { return sorted[left].Value < sorted[right].Value })
		value := int64(sorted[0].Value * 1000)
		resetAt = &value
	}
	hasPeriod := false
	for _, field := range scan.Varint {
		if len(field.Path) >= 2 && field.Path[0] == 1 && field.Path[1] == 6 {
			hasPeriod = true
			break
		}
	}
	if !hasPeriod {
		for _, field := range scan.Varint {
			if usageJoinProtoPath(field.Path) == "1.8.1" && (field.Value == 1 || field.Value == 2) {
				hasPeriod = true
				break
			}
		}
	}
	if percent == nil && !(resetAt != nil && hasPeriod && len(scan.Fixed32) == 0) {
		return usageGrokUsage{}, errors.New("Grok 账单响应中未找到用量百分比")
	}
	used := 0.0
	if percent != nil {
		used = *percent
	}
	return usageGrokUsage{UsedPercent: used, ResetAt: resetAt}, nil
}

// usageJoinProtoPath renders a protobuf field path.
func usageJoinProtoPath(path []int) string {
	parts := make([]string, 0, len(path))
	for _, value := range path {
		parts = append(parts, strconv.Itoa(value))
	}
	return strings.Join(parts, ".")
}

// usageGrokWindowLabel names a Grok quota window.
func usageGrokWindowLabel(resetAt *int64, now int64) string {
	if resetAt == nil {
		return "额度"
	}
	days := int(math.Round(float64(*resetAt-now) / 86_400_000))
	if days >= 4 && days <= 12 {
		return "本周"
	}
	if days >= 20 && days <= 45 {
		return "本月"
	}
	return "额度"
}

// usageFetchGrok reads the Grok quota.
func usageFetchGrok(credential *usageCredential, now int64, prices []ModelPrice) (UsagePlan, error) {
	status, header, raw, err := usageFetch("POST", usageGrokBillingURL, map[string]string{
		"authorization": "Bearer " + credential.Value, "origin": "https://grok.com",
		"referer": "https://grok.com/?_s=usage", "accept": "*/*",
		"content-type": "application/grpc-web+proto", "x-grpc-web": "1",
		"x-user-agent": "connect-es/2.1.1", "user-agent": "Graph",
	}, []byte{0, 0, 0, 0, 0}, usageRequestTimeoutMs)
	if err != nil {
		return UsagePlan{}, err
	}
	if status == 401 || status == 403 {
		return UsagePlan{}, errors.New("Grok 登录凭据已过期，请重新执行 grok login")
	}
	if status == 408 {
		return UsagePlan{}, errors.New("Grok 账单服务暂时超时")
	}
	if status < 200 || status >= 300 {
		return UsagePlan{}, fmt.Errorf("Grok 账单 HTTP %d", status)
	}
	grpcStatus := header.Get("grpc-status")
	if grpcStatus != "" && grpcStatus != "0" {
		return UsagePlan{}, fmt.Errorf("Grok 账单 gRPC %s", grpcStatus)
	}
	usage, err := usageParseGrokBilling(raw, now)
	if err != nil {
		return UsagePlan{}, err
	}
	windows := []UsageWindow{usagePercentWindow("credits", usageGrokWindowLabel(usage.ResetAt, now), usage.UsedPercent, usage.ResetAt, usageWindowDetails{})}
	discovered := usageDiscoverOpenAiCompatible(UsageProviderGrok, credential, prices)
	models := discovered
	if len(models) == 0 {
		keys := []string{}
		for _, price := range prices {
			lowered := strings.ToLower(price.ModelID)
			if strings.HasPrefix(lowered, "grok-") || strings.HasPrefix(lowered, "grokbuild") {
				keys = append(keys, price.ModelID)
			}
		}
		baseURL := credential.BaseURL
		if baseURL == "" {
			baseURL = usageDefaultBaseURLs[UsageProviderGrok]
		}
		models = usageFallbackModels(keys, UsageProviderGrok, baseURL, prices)
	}
	plan := usageBasePlan(UsageProviderGrok, true, usageStatusFor(windows))
	plan.Plan = providerStringPointer("SuperGrok")
	plan.CredentialSource = providerStringPointer(credential.Source)
	info := usageCredentialInfo(credential)
	plan.Credential = &info
	plan.Windows = windows
	plan.Models = models
	return plan, nil
}
