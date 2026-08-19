BINARY := bin/maestro-server
PKG    := ./...

.DEFAULT_GOAL := check

## build: compile a static binary into bin/
.PHONY: build
build:
	CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o $(BINARY) ./cmd/maestro-server

## run: start the server with development-friendly logs
.PHONY: run
run:
	LOG_FORMAT=text LOG_LEVEL=debug go run ./cmd/maestro-server

## test: the whole suite, with the race detector and coverage
.PHONY: test
test:
	go test -race -cover $(PKG)

## cover: write and summarise a coverage profile
.PHONY: cover
cover:
	go test -coverprofile=coverage.out $(PKG)
	go tool cover -func=coverage.out | tail -n 1

## vet: go vet plus formatting check
.PHONY: vet
vet:
	go vet $(PKG)
	@unformatted=$$(gofmt -l .); \
	if [ -n "$$unformatted" ]; then echo "gofmt needed on:"; echo "$$unformatted"; exit 1; fi

## tidy: prune and verify the module graph
.PHONY: tidy
tidy:
	go mod tidy
	go mod verify

## check: what CI runs
.PHONY: check
check: vet test

## docker: build the deployment image
.PHONY: docker
docker:
	docker build -t maestro-server .

## clean: remove build artefacts
.PHONY: clean
clean:
	rm -rf bin coverage.out

## help: list the targets
.PHONY: help
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## //'
