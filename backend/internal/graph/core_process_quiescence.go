package graph

import (
	"bytes"
	"encoding/json"

	"golang.org/x/sys/unix"
)

// ProcessQuiescenceReceipt is a supervisor's durable proof that its command has closed.
type ProcessQuiescenceReceipt struct {
	Path  string `json:"path"`
	Nonce string `json:"nonce"`
}

// HasProcessQuiescence reads the receipt without following a symlink.
func HasProcessQuiescence(receipt ProcessQuiescenceReceipt) bool {
	fd, err := unix.Open(receipt.Path, unix.O_RDONLY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return false
	}
	defer unix.Close(fd)
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return false
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Size > 1024 {
		return false
	}
	buf := make([]byte, stat.Size)
	read := 0
	for read < len(buf) {
		n, err := unix.Read(fd, buf[read:])
		if n > 0 {
			read += n
		}
		if err != nil || n == 0 {
			break
		}
	}
	if read != len(buf) {
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(buf))
	var value map[string]any
	if err := dec.Decode(&value); err != nil || dec.More() {
		return false
	}
	nonce, _ := value["nonce"].(string)
	quiescent, _ := value["quiescent"].(bool)
	return nonce == receipt.Nonce && quiescent
}
