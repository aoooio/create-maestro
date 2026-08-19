package session

import "testing"

func testGroups(n int) []*Group {
	groups := make([]*Group, 0, n)
	for i := range n {
		groups = append(groups, newGroup(GroupID(i+1), DefaultGroupLabels[i%len(DefaultGroupLabels)]))
	}
	return groups
}

func TestBalancedStrategyFillsTheSmallestGroup(t *testing.T) {
	groups := testGroups(2)
	strategy := BalancedStrategy{}

	want := []GroupID{1, 2, 1, 2, 1}
	for i, expected := range want {
		p := NewParticipant(ParticipantID(string(rune('a'+i))), "", RoleMusician, 0)
		got := strategy.Assign(groups, p)
		if got != expected {
			t.Fatalf("participant %d assigned to group %d, want %d", i, got, expected)
		}
		groups[got-1].add(p.ID)
	}

	// A departure from group 1 must make it the next target again.
	groups[0].remove("a")
	if got := strategy.Assign(groups, NewParticipant("z", "", RoleMusician, 0)); got != 1 {
		t.Fatalf("after a departure the smallest group is 1, got %d", got)
	}
}

func TestRoundRobinStrategyAlternatesStrictly(t *testing.T) {
	groups := testGroups(3)
	strategy := &RoundRobinStrategy{}
	want := []GroupID{1, 2, 3, 1, 2}
	for i, expected := range want {
		if got := strategy.Assign(groups, nil); got != expected {
			t.Fatalf("call %d gave group %d, want %d", i, got, expected)
		}
	}
	// Unlike the balanced policy, departures do not change the rotation.
	groups[0].remove("nobody")
	if got := strategy.Assign(groups, nil); got != 3 {
		t.Fatalf("rotation broke: got %d, want 3", got)
	}
}

func TestManualStrategyParksEveryoneInItsDefault(t *testing.T) {
	groups := testGroups(2)
	strategy := ManualStrategy{Default: 2}
	for range 3 {
		if got := strategy.Assign(groups, nil); got != 2 {
			t.Fatalf("got group %d, want 2", got)
		}
	}
	// An unknown default falls back to the first group rather than failing.
	if got := (ManualStrategy{Default: 9}).Assign(groups, nil); got != 1 {
		t.Fatalf("fallback gave group %d, want 1", got)
	}
}

func TestStrategyByName(t *testing.T) {
	for name, want := range map[string]string{
		"":            "balanced",
		"balanced":    "balanced",
		"round_robin": "round_robin",
		"manual":      "manual",
	} {
		got, err := StrategyByName(name)
		if err != nil {
			t.Fatalf("StrategyByName(%q): %v", name, err)
		}
		if got.Name() != want {
			t.Fatalf("StrategyByName(%q) = %s, want %s", name, got.Name(), want)
		}
	}
	if _, err := StrategyByName("chaos"); CodeOf(err) != CodeInvalidPayload {
		t.Fatalf("want invalid_payload, got %v", err)
	}
}

func TestParameterTargetRoundTrip(t *testing.T) {
	tests := []struct {
		in   string
		want ParameterTarget
	}{
		{"", TargetAll()},
		{"all", TargetAll()},
		{"group:1", TargetGroup(1)},
		{"group:12", TargetGroup(12)},
	}
	for _, tc := range tests {
		got, err := ParseTarget(tc.in)
		if err != nil {
			t.Fatalf("ParseTarget(%q): %v", tc.in, err)
		}
		if got != tc.want {
			t.Fatalf("ParseTarget(%q) = %+v, want %+v", tc.in, got, tc.want)
		}
		if again, err := ParseTarget(got.String()); err != nil || again != got {
			t.Fatalf("round trip of %q broke: %+v, %v", tc.in, again, err)
		}
	}
	for _, bad := range []string{"group:", "group:0", "group:abc", "group:999", "everyone"} {
		if _, err := ParseTarget(bad); CodeOf(err) != CodeInvalidPayload {
			t.Fatalf("ParseTarget(%q) should have failed, got %v", bad, err)
		}
	}
}
