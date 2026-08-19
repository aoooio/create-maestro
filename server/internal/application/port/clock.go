package port

// Clock is the single source of temporal truth of the server. NowMs must be
// monotonic: the whole synchronisation protocol assumes it never steps back.
type Clock interface {
	NowMs() int64
}
