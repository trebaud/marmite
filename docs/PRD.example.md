# TodoApp — Specification

## Overview

TodoApp is a simple full-stack todo list application. Users can create, list, complete, and delete tasks from a web UI backed by a REST API. State is held in-memory for the lifetime of the server process (no database).

This spec is the human-authored input to the Marmite pipeline. Run `/ralph` over this file to produce `prd.json`, then `bun cook` to drive the build loop.

## Goals

- End-to-end working demo of a React + Express stack in a single repo.
- Exercise the full CRUD surface (create, read, update, delete).
- Ship with integration tests so regressions are caught by the verifier.

## Non-goals

- Persistence across restarts (no database, no file storage).
- Authentication, multi-user support, or authorization.
- Deployment, Docker, or CI configuration.
- Styling beyond what's needed to make the UI usable.

## Stack

- **Server:** Express + TypeScript, listening on port 3000.
- **Client:** React + Vite, dev server on port 5173, proxying `/api/*` to the server.
- **Layout:** Monorepo with `server/` and `client/` workspaces under a root `package.json`.
- **Tests:** Integration tests for the API, runnable via `npm test` from the root.

## Data model

A todo has three fields:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Server-generated, unique per process |
| `title` | string | Non-empty, trimmed |
| `completed` | boolean | Defaults to `false` on creation |

## API

All endpoints are served under `/api` and return JSON.

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| `GET` | `/api/health` | — | `200 { ok: true }` | — |
| `GET` | `/api/todos` | — | `200 Todo[]` | — |
| `POST` | `/api/todos` | `{ title }` | `201 Todo` | `400` on empty/missing title |
| `PATCH` | `/api/todos/:id` | `{ completed }` | `200 Todo` | `404` if id unknown |
| `DELETE` | `/api/todos/:id` | — | `204` | `404` if id unknown |

## Client behavior

- On mount, fetch `GET /api/todos` and render the list.
- An input + "Add" button posts a new todo; empty submissions are blocked client-side.
- Each row has a checkbox (toggles `completed` via `PATCH`) and a delete button (`DELETE`).
- The UI re-renders from server responses — no optimistic updates required.

## Milestones

Each milestone below maps to one user story in `prd.json`. They are ordered: later stories depend on earlier ones passing.

1. **Initialize monorepo structure** — `server/` and `client/` directories, root workspaces, tsconfigs, Vite config.
2. **Express server entry point** — `GET /api/health` returning `{ ok: true }` on port 3000.
3. **Vite + React client app** — root `App` component, dev server on 5173, API proxy to Express.
4. **In-memory todo store and REST API** — full CRUD with validation as specified above.
5. **Todo list UI** — load, add, toggle, delete wired to the API.
6. **API integration tests** — cover CRUD happy paths and the 400 validation case; `npm test` green.

## Acceptance gates

Every story must satisfy:

- Typecheck passes (`tsc --noEmit` across both workspaces).
- Tests pass (once the test story lands).
- No code outside `app/` (Marmite convention — in this example the monorepo is rooted at `app/`).
