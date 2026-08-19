// Package service holds the small policies shared by several use cases.
package service

import "github.com/aoooio/create-maestro/server/internal/domain/session"

// Action is a protocol-level intent. Keeping the spelling of the wire message
// makes the mapping obvious at the call site.
type Action string

const (
	ActionSetTransport Action = "transport.set"
	ActionSetParameter Action = "param.set"
	ActionSetPattern   Action = "pattern.set"
	ActionAssignGroup  Action = "group.assign"
	ActionTrigger      Action = "trigger"
	ActionRequestState Action = "state.request"
	ActionSyncTime     Action = "time.ping"
)

// Authorizer answers "may this role do this?". The session aggregate enforces
// the same rules on its own state; this is the early gate that lets the
// transport layer reject a command before it reaches the aggregate.
type Authorizer struct{}

// Authorize returns a domain error when the role may not perform the action.
func (Authorizer) Authorize(role session.Role, action Action) error {
	switch action {
	case ActionSetTransport, ActionSetParameter, ActionSetPattern, ActionAssignGroup:
		if role != session.RoleMaestro {
			return session.ErrForbiddenRole
		}
	case ActionTrigger:
		// Triggers come from the audience: the maestro plays its own machine.
		if role != session.RoleMusician {
			return session.ErrForbiddenRole
		}
	case ActionRequestState, ActionSyncTime:
		// Open to everyone.
	default:
		return session.Invalidf("unknown action %q", action)
	}
	return nil
}
