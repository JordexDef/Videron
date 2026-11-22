package syncserver

import (
	"os"
	"sync"
)

// A rename takes effect even if syncing its directory subsequently fails.
// Keep the live index consistent with the rename, and retry that barrier
// before acknowledging the change or allowing another mutation.
// The enclosing write lock serializes publications. Concurrent readers
// under its read lock may retry the same failed sync.
type directoryBarrier struct {
	mu      sync.Mutex
	pending string
	syncDir func(*os.Root, string) error
}

func (b *directoryBarrier) publish(root *os.Root, dir string) error {
	b.pending = dir
	return b.retry(root)
}

func (b *directoryBarrier) retry(root *os.Root) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pending == "" {
		return nil
	}
	sync := b.syncDir
	if sync == nil {
		sync = syncDirectory
	}
	if err := sync(root, b.pending); err != nil {
		return err
	}
	b.pending = ""
	return nil
}
