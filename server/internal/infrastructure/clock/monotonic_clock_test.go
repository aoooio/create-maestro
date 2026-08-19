package clock

import (
	"testing"
	"time"
)

func TestNowMsIsWallClockAnchoredAndNeverGoesBack(t *testing.T) {
	c := NewMonotonic()

	first := c.NowMs()
	wall := time.Now().UnixMilli()
	if diff := first - wall; diff > 1000 || diff < -1000 {
		t.Fatalf("the clock must start on wall time: %d vs %d", first, wall)
	}

	previous := first
	for range 1000 {
		now := c.NowMs()
		if now < previous {
			t.Fatalf("the clock went backwards: %d after %d", now, previous)
		}
		previous = now
	}

	time.Sleep(20 * time.Millisecond)
	if elapsed := c.NowMs() - first; elapsed < 15 {
		t.Fatalf("the clock barely moved in 20 ms: %d", elapsed)
	}
}
