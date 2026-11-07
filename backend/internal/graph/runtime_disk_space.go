package graph

import (
	"math"

	"fmt"

	"golang.org/x/sys/unix"
)

const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024

func FormatBytes(bytes int64) string {
	if bytes >= 1024*1024*1024 {
		return fmt.Sprintf("%.1f GiB", float64(bytes)/float64(1024*1024*1024))
	}
	if bytes >= 1024*1024 {
		return fmt.Sprintf("%d MiB", int64(math.Round(float64(bytes)/float64(1024*1024))))
	}
	if bytes >= 1024 {
		return fmt.Sprintf("%d KiB", int64(math.Round(float64(bytes)/float64(1024))))
	}
	return fmt.Sprintf("%d B", bytes)
}

func FreeBytesAt(path string) int64 {
	var stats unix.Statfs_t
	if err := unix.Statfs(path, &stats); err != nil {
		panic(err)
	}
	return int64(stats.Bavail) * int64(stats.Bsize)
}

func DiskSpaceWarning(freeBytes int64, neededBytes ...int64) *string {
	needed := int64(MIN_FREE_BYTES)
	if len(neededBytes) > 0 {
		needed = neededBytes[0]
	}
	if freeBytes >= needed {
		return nil
	}
	message := fmt.Sprintf("app:build 只剩 %s 可用空间，打包约需 %s；dmg 步骤很可能以「设备上无剩余空间」失败。\n先回收再重跑：~/.agent-browser/tmp（最大可回收项，GB 量级）、.stage、旧的 dist/app。", FormatBytes(freeBytes), FormatBytes(needed))
	return &message
}
