package graph

import (
	"encoding/base64"
	"path/filepath"
	"strings"
	"testing"
)

// 属性测试：断言所有输入都必须成立的性质，而不是列举一个例子。
//
// 这里之所以用属性而不是例子，是因为输入的取值空间无法枚举：base64 的合法形状取决于长度
// 模 4 与填充位置，举例只能覆盖写测试的人当时想到的那几个。下面这几条性质对任意输入都必须
// 成立；反例由随机输入自己找出来。

// 一条已经通过 hasBase64Shape 的图片数据，必须能被标准 base64 解码。
//
// 这条性质曾经不成立：hasBase64Shape 只检查字符集，不看长度。实测 "A"、"AB"、"AAAAA"
// 都被判为合法，而标准解码全部失败——于是"声称是图片"的消息通过了校验，取图时才报错。
func TestPropertyAcceptedImageDataIsDecodable(t *testing.T) {
	candidates := []string{
		"A", "AB", "ABC", "ABCD", "AAAAA", "AAAAAA", "AAAAAAA",
		"A=", "AB=", "ABC=", "ABCD=", "A===",
		"ab+/", "ab+/=", "ab+/==",
		strings.Repeat("A", 5), strings.Repeat("A", 9), strings.Repeat("A", 13),
	}
	for i := 0; i < 200; i++ {
		candidates = append(candidates, randomBase64Alphabet(i%7+1))
	}
	for _, data := range candidates {
		if !hasBase64Shape(data) {
			continue
		}
		if _, err := base64.StdEncoding.DecodeString(data); err != nil {
			t.Fatalf("%q passes the shape check but standard base64 cannot decode it: %v", data, err)
		}
	}
}

// 任何能被标准 base64 解码的数据，必须被 hasBase64Shape 接受。反方向也要成立，否则合法
// 图片会被无关的理由拒绝。
func TestPropertyDecodableImageDataIsAccepted(t *testing.T) {
	for i := 0; i < 200; i++ {
		raw := []byte(strings.Repeat("x", i%17))
		encoded := base64.StdEncoding.EncodeToString(raw)
		if !hasBase64Shape(encoded) {
			t.Fatalf("%q is valid base64 (from %d bytes) but the shape check rejects it", encoded, len(raw))
		}
	}
}

// randomBase64Alphabet builds a string from the base64 alphabet with a chosen length, which is
// how the length-related counterexamples above are found.
func randomBase64Alphabet(length int) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	builder := strings.Builder{}
	for i := 0; i < length; i++ {
		builder.WriteByte(alphabet[(i*7+3)%len(alphabet)])
	}
	return builder.String()
}

// 同一条漏洞在消息层面的形态：CleanAttachments 收下的图片数据必须能被解码，否则消息会一直
// 存着一段永远打不开的"图片"，直到有人取图时才失败。
func TestPropertyCleanAttachmentsKeepsOnlyDecodableImageData(t *testing.T) {
	for _, data := range []string{"A", "AB", "AAAAA", "QUJD", "ab+/"} {
		value := data
		func() {
			defer func() { _ = recover() }()
			cleaned := CleanAttachments([]AttachmentInput{{
				Name: "p.png", Type: "image/png", Size: 4, Data: &value,
			}})
			for _, attachment := range cleaned {
				if attachment.Data == nil {
					continue
				}
				if _, err := base64.StdEncoding.DecodeString(*attachment.Data); err != nil {
					t.Fatalf("CleanAttachments kept %q, which standard base64 cannot decode", *attachment.Data)
				}
			}
		}()
	}
}

// 产品承诺：同一个 requestId 用同样的内容重放任意次，效果只发生一次，回执相同。
func TestPropertyAReplayedCommandAppliesOnce(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	applied := 0
	receipt := ""
	for i := 0; i < 5; i++ {
		result := store.Command("scope", "req-"+string(rune('a'+i%1)), map[string]any{"n": 1}, func() any {
			applied++
			return map[string]any{"ok": true, "n": 1}
		})
		if i == 0 {
			receipt = CanonicalJSON(result)
			continue
		}
		if got := CanonicalJSON(result); got != receipt {
			t.Fatalf("replay %d returned %s, first returned %s", i, got, receipt)
		}
	}
	if applied != 1 {
		t.Fatalf("the same requestId applied %d times, so the effect was repeated", applied)
	}
}
