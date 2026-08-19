# Build a static binary, ship it on a distroless base: one port, no shell,
# no package manager, nothing to patch (§7).
FROM golang:1.24-alpine AS build

WORKDIR /src

# Dependencies first, so a code change does not re-download the module graph.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/maestro-server ./cmd/maestro-server

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/maestro-server /maestro-server

EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/maestro-server"]
