# TodoApp — Specification

## Overview

TodoApp is a simple full-stack todo list application. Users can create, list, complete, and delete tasks from a web UI backed by a REST API. State is held in-memory for the lifetime of the server process (no database).

This spec is the human-authored input to the Marmite pipeline. 

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

A todo has four fields:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Server-generated, unique per process |
| `title` | string | Non-empty, trimmed |
| `completed` | boolean | Defaults to `false` on creation |
| `starred` | boolean | Defaults to `false` on creation; starred todos sort to the top |
| `createdAt` | string | ISO 8601 timestamp set by the server at creation; never updated |

## API

All endpoints are served under `/api` and return JSON.

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| `GET` | `/api/health` | — | `200 { ok: true }` | — |
| `GET` | `/api/todos` | — | `200 Todo[]` | — |
| `POST` | `/api/todos` | `{ title }` | `201 Todo` | `400` on empty/missing title |
| `PATCH` | `/api/todos/:id` | `{ completed?, starred? }` | `200 Todo` | `404` if id unknown |
| `DELETE` | `/api/todos/:id` | — | `204` | `404` if id unknown |
| `GET` | `/api/graveyard` | — | `200 Tombstone[]` | — |

Deleting a todo that is **not yet completed** automatically adds a tombstone to the in-memory graveyard before removing it. Deleting an already-completed todo leaves no tombstone — you earned that clean exit.

A `Tombstone` has three fields:

| Field | Type | Notes |
|---|---|---|
| `id` | string | The original todo's id |
| `title` | string | The original todo's title |
| `abandonedAt` | string | ISO 8601 timestamp of when the delete was received |

## Client behavior

- On mount, fetch `GET /api/todos` and render the list.
- An input + "Add" button posts a new todo; empty submissions are blocked client-side.
- Each row has a checkbox (toggles `completed` via `PATCH`), a star button (toggles `starred` via `PATCH`), and a delete button (`DELETE`).
- Starred todos always appear above non-starred todos regardless of creation order.
- The star button renders filled (★) when `starred` is true and outlined (☆) otherwise.
- Each incomplete todo displays its age next to the title (e.g. `· 2d`, `· 3h`). Completed todos show no age.
- Todos that have been incomplete for **3 or more days** are considered "neglected" and the age label is styled distinctly (e.g. a muted red) as a gentle guilt-trip.
- The UI re-renders from server responses — no optimistic updates required.
- A collapsed "⚰ Abandoned (N)" section sits below the main list. Clicking it expands to show tombstones — each displaying the title struck-through and a relative timestamp (e.g. `· abandoned 2h ago`). The count updates whenever a todo is deleted incomplete.

## Milestones

Each milestone below maps to one user story in `prd.json`. They are ordered: later stories depend on earlier ones passing.

1. **Initialize monorepo structure** — `server/` and `client/` directories, root workspaces, tsconfigs, Vite config.
2. **Express server entry point** — `GET /api/health` returning `{ ok: true }` on port 3000.
3. **Vite + React client app** — root `App` component, dev server on 5173, API proxy to Express.
4. **In-memory todo store and REST API** — full CRUD with validation as specified above.
5. **Todo list UI** — load, add, toggle, delete, and star wired to the API; starred todos sort to top; age label and neglected styling on incomplete todos; collapsible graveyard section.
6. **API integration tests** — cover CRUD happy paths, the 400 validation case, starring behaviour, and graveyard tombstone creation; `npm test` green.

## Acceptance gates

Every story must satisfy:

- Typecheck passes (`tsc --noEmit` across both workspaces).
- Tests pass (once the test story lands).
- No code outside `app/` (Marmite convention — in this example the monorepo is rooted at `app/`).
