package idgen

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestIdentifiersAreUniqueAndSortable(t *testing.T) {
	g := New()
	seen := make(map[string]bool, 1000)
	previous := ""
	for range 1000 {
		id := string(g.NewSessionID())
		if seen[id] {
			t.Fatalf("duplicate session id %s", id)
		}
		seen[id] = true
		// ULIDs sort by creation time, which is what makes logs readable.
		if id < previous {
			t.Fatalf("%s sorts before %s", id, previous)
		}
		previous = id
	}
	if g.NewParticipantID() == "" || g.NewMessageID() == "" {
		t.Fatal("every generator must produce something")
	}
}

func TestJoinCodeShape(t *testing.T) {
	g := New()
	counts := map[rune]int{}
	for range 500 {
		code := string(g.NewJoinCode())
		if len(code) != JoinCodeLen {
			t.Fatalf("code %q has %d characters, want %d", code, len(code), JoinCodeLen)
		}
		for _, r := range code {
			if !strings.ContainsRune(joinCodeAlphabet, r) {
				t.Fatalf("code %q uses %q, which is not in the alphabet", code, r)
			}
			counts[r]++
		}
	}
	// The alphabet exists to remove the characters people misread.
	for _, banned := range "IOSL01" {
		if strings.ContainsRune(joinCodeAlphabet, banned) {
			t.Fatalf("%q is too easy to misread to be in a join code", banned)
		}
	}
	if len(counts) < len(joinCodeAlphabet)/2 {
		t.Fatalf("only %d distinct characters came out of 2000 draws", len(counts))
	}
}

func TestTokenIsAFullLengthSecret(t *testing.T) {
	g := New()
	first, err := g.NewToken()
	if err != nil {
		t.Fatalf("NewToken: %v", err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(string(first))
	if err != nil {
		t.Fatalf("the token must be base64url: %v", err)
	}
	if len(raw) != TokenBytes {
		t.Fatalf("token carries %d bytes, want %d", len(raw), TokenBytes)
	}
	second, err := g.NewToken()
	if err != nil {
		t.Fatalf("NewToken: %v", err)
	}
	if first == second {
		t.Fatal("two tokens must never be equal")
	}
}
