// Package clock implements the server clock, the single source of temporal
// truth of the whole system.
package clock

import "time"

// Monotonic is a clock that never steps back. It reads the wall clock once at
// startup and advances with the monotonic reading of time.Since, so an NTP
// correction — or a laptop waking from sleep — cannot make musical time jump
// backwards for every connected client at once.
type Monotonic struct {
	originWallMs int64
	origin       time.Time
}

// NewMonotonic anchors the clock on the current instant.
func NewMonotonic() *Monotonic {
	now := time.Now()
	return &Monotonic{originWallMs: now.UnixMilli(), origin: now}
}

// NowMs returns the current server time in milliseconds.
func (c *Monotonic) NowMs() int64 {
	return c.originWallMs + time.Since(c.origin).Milliseconds()
}
