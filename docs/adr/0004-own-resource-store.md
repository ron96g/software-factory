# ADR-0004: Own resource store instead of a Kubernetes cluster

- **Status:** Accepted
- **Date:** 2026-11-11

## Context
We model everything as custom resources, but running a real cluster plus CRDs and controllers is heavy for local development and for the UI.

## Decision
- We implement our own store behind the `ResourceStore` ports. SQLite (`node:sqlite`, no native build) holds runtime
  objects now. Postgres comes later (M8) behind the same ports.
- Definitions are loaded read-only from the Git checkout (`DefinitionLoader`). A composite store routes requests by kind scope.
- The shapes stay CRD-compatible, so a move to Kubernetes remains possible.

## Consequences
Simple local setup. We re-implement a small part of Kubernetes semantics: resourceVersion, watch, owner cascade, and the status subresource.

## Alternatives considered
A real cluster (kind/k3s) with CRDs: too heavy right now. A plain relational schema: loses the uniform model.
