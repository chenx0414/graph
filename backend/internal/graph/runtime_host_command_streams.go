package graph

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"hash"
	"io"
	"os"
	"path/filepath"

	"sync"
)

const maxHostOutputBytes = 32 * 1024 * 1024

type hostOutputStream struct {
	path  string
	file  *os.File
	bytes int64
	hash  hash.Hash
}

type hostCommandBuffer struct {
	mutex  sync.Mutex
	chunks [][]byte
	bytes  int
}

func (buffer *hostCommandBuffer) keep(chunk []byte, state *hostCommandState) {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	if buffer.bytes >= maxHostOutputBytes {
		state.markTruncated()
		return
	}
	room := len(chunk)
	if remaining := maxHostOutputBytes - buffer.bytes; room > remaining {
		room = remaining
	}
	buffer.chunks = append(buffer.chunks, chunk[:room])
	if room < len(chunk) {
		state.markTruncated()
	}
	buffer.bytes += room
}

func (state *hostCommandState) markTruncated() {
	state.mutex.Lock()
	defer state.mutex.Unlock()
	state.truncated = true
}

func (buffer *hostCommandBuffer) String() string {
	buffer.mutex.Lock()
	defer buffer.mutex.Unlock()
	return string(bytes.Join(buffer.chunks, nil))
}

func hostCommandNumber(value any) bool {
	switch value.(type) {
	case float64, int, int64:
		return true
	}
	return false
}

func hostCommandTimeoutMarker(timeoutMs int) string {
	return "Process terminated by SIGKILL: it exceeded the " + itoa(timeoutMs) + "ms timeout"
}

func hostCommandOutputStreams(directory string) map[string]HostCommandOutputFile {
	files := map[string]HostCommandOutputFile{}
	for _, name := range []string{"stdout", "stderr"} {
		path := filepath.Join(directory, name+".log")
		content, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		sum := sha256.Sum256(content)
		files[name] = HostCommandOutputFile{Path: path, Bytes: int64(len(content)), Digest: hex.EncodeToString(sum[:])}
	}
	return files
}

type preservedStream struct {
	reader io.Reader
	file   *os.File
}

func (stream preservedStream) Read(chunk []byte) (int, error) {
	read, err := stream.reader.Read(chunk)
	if read > 0 && stream.file != nil {
		if _, writeErr := stream.file.Write(chunk[:read]); writeErr != nil {
			stream.file = nil
		}
	}
	return read, err
}

func (state *hostCommandState) readStream(reader io.Reader, name string) {
	buffer := make([]byte, 64*1024)
	for {
		read, err := reader.Read(buffer)
		if read > 0 {
			chunk := buffer[:read]
			state.preserve(name, chunk)
			if name == "stdout" {
				state.stdout.keep(chunk, state)
			} else {
				state.stderr.keep(chunk, state)
			}
		}
		if err != nil {
			return
		}
	}
}

func (state *hostCommandState) preserve(name string, chunk []byte) {
	stream, ok := state.streams[name]
	if !ok {
		return
	}
	offset := 0
	for offset < len(chunk) {
		written, err := stream.file.Write(chunk[offset:])
		if err != nil {
			state.killTree()
			return
		}
		offset += written
	}
	stream.hash.Write(chunk)
	stream.bytes += int64(len(chunk))
}
