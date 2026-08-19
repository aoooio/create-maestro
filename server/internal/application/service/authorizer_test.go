package service

import (
	"testing"

	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

func TestAuthorize(t *testing.T) {
	var auth Authorizer
	tests := []struct {
		action  Action
		role    session.Role
		allowed bool
	}{
		{ActionSetTransport, session.RoleMaestro, true},
		{ActionSetTransport, session.RoleMusician, false},
		{ActionSetParameter, session.RoleMaestro, true},
		{ActionSetParameter, session.RoleMusician, false},
		{ActionSetPattern, session.RoleMaestro, true},
		{ActionSetPattern, session.RoleMusician, false},
		{ActionAssignGroup, session.RoleMaestro, true},
		{ActionAssignGroup, session.RoleMusician, false},
		{ActionTrigger, session.RoleMusician, true},
		{ActionTrigger, session.RoleMaestro, false},
		{ActionRequestState, session.RoleMusician, true},
		{ActionRequestState, session.RoleMaestro, true},
		{ActionSyncTime, session.RoleMusician, true},
	}
	for _, tc := range tests {
		err := auth.Authorize(tc.role, tc.action)
		if tc.allowed && err != nil {
			t.Fatalf("%s should be allowed to %s: %v", tc.role, tc.action, err)
		}
		if !tc.allowed && session.CodeOf(err) != session.CodeForbiddenRole {
			t.Fatalf("%s must not be allowed to %s, got %v", tc.role, tc.action, err)
		}
	}
	if err := auth.Authorize(session.RoleMaestro, "fly"); session.CodeOf(err) != session.CodeInvalidPayload {
		t.Fatalf("an unknown action must be rejected, got %v", err)
	}
}
