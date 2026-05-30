# Interaction Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the Warp tabs list opportunistically when the user changes selection in the Vicinae list, without spawning overlapping SQLite/Python reloads.

**Architecture:** Keep `loadWarpTabs` and existing manual `reload` action. Add a small interaction-refresh path in `src/warp-tabs.tsx` that listens to `List.onSelectionChange`, assigns stable item ids, throttles refreshes to at most once per second, and skips refresh if another reload is already running. Manual Ctrl+R stays an immediate forced reload with user-visible errors.

**Tech Stack:** TypeScript, React hooks, `@vicinae/api` `List.onSelectionChange`, Node/Vicinae extension runtime.

---

## File Structure

- Modify `src/warp-tabs.tsx`
  - Import `useRef` from React.
  - Add `INTERACTION_REFRESH_INTERVAL_MS` constant.
  - Split reload into a silent/forced reload helper.
  - Add overlap guard and throttle refs in `Command`.
  - Add `onSelectionChange` to the main `List`.
  - Add stable `id` to each `List.Item`.
  - Keep Ctrl+R manual reload intact.

No new source files are needed. The behavior is localized to the existing command component.

---

### Task 1: Add interaction-refresh plumbing

**Files:**
- Modify: `src/warp-tabs.tsx:22`
- Modify: `src/warp-tabs.tsx:990-1106`

- [ ] **Step 1: Write the failing behavior check**

Because this repo has no test runner and this change is a UI hook integration, first make the desired compile-time/API behavior fail by adding the intended `List` and `List.Item` props before adding the refs/helper implementation:

```typescript
<List
  isLoading={isLoading}
  isShowingDetail={showingDetail}
  searchBarPlaceholder="Search Warp tabs..."
  onSelectionChange={handleSelectionChange}
  actions={...}
>
```

and:

```typescript
<List.Item
  id={`${tab.windowId}-${tab.id}`}
  key={`${tab.windowId}-${tab.id}`}
  title={tab.title}
  ...
/>
```

- [ ] **Step 2: Run check to verify it fails**

Run:

```bash
npm run lint
```

Expected: `tsc --noEmit` fails because `handleSelectionChange` is not defined.

- [ ] **Step 3: Add minimal implementation**

Update the React import:

```typescript
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
```

Add the throttle constant near the other constants:

```typescript
const INTERACTION_REFRESH_INTERVAL_MS = 1000;
```

Replace the existing `reload` callback in `Command` with guarded reload helpers:

```typescript
  const reloadInFlightRef = useRef(false);
  const lastInteractionRefreshAtRef = useRef(0);

  const reload = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (reloadInFlightRef.current) return;

      reloadInFlightRef.current = true;
      setIsLoading(true);
      setError(undefined);
      try {
        setNow(Date.now());
        setTabs(await loadWarpTabs(preferences));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setTabs([]);
        if (!silent) {
          await showToast({ style: Toast.Style.Failure, title: "Could not load Warp tabs", message });
        }
      } finally {
        setIsLoading(false);
        reloadInFlightRef.current = false;
      }
    },
    [preferences],
  );

  const forceReload = useCallback(() => {
    void reload();
  }, [reload]);

  const refreshFromInteraction = useCallback(() => {
    const nowMs = Date.now();
    if (nowMs - lastInteractionRefreshAtRef.current < INTERACTION_REFRESH_INTERVAL_MS) return;
    lastInteractionRefreshAtRef.current = nowMs;
    void reload({ silent: true });
  }, [reload]);

  const handleSelectionChange = useCallback(() => {
    refreshFromInteraction();
  }, [refreshFromInteraction]);
```

Change mount reload to avoid a floating promise:

```typescript
  useEffect(() => {
    void reload();
  }, [reload]);
```

Wire manual reload actions to `forceReload`, preserving Ctrl+R:

```typescript
<Action title="Reload" icon={Icon.ArrowClockwise} onAction={forceReload} />
```

```typescript
<Action title="Reload" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["ctrl"], key: "r" }} onAction={forceReload} />
```

Wire the list selection handler:

```typescript
    <List
      isLoading={isLoading}
      isShowingDetail={showingDetail}
      searchBarPlaceholder="Search Warp tabs..."
      onSelectionChange={handleSelectionChange}
      actions={...}
    >
```

Add stable item ids:

```typescript
<List.Item
  id={`${tab.windowId}-${tab.id}`}
  key={`${tab.windowId}-${tab.id}`}
  title={tab.title}
  ...
/>
```

Keep tab action prop usage valid by passing the forced manual reload:

```typescript
actions={<TabActions tab={tab} onSwitch={handleSwitch} onClose={handleClose} onReload={forceReload} />}
```

- [ ] **Step 4: Run check to verify it passes**

Run:

```bash
npm run lint
```

Expected: `tsc --noEmit` passes.

- [ ] **Step 5: Commit**

```bash
git add src/warp-tabs.tsx docs/superpowers/plans/2026-05-30-interaction-refresh.md
git commit -m "feat: refresh warp tabs on selection"
```

---

## Self-Review

- Spec coverage: implements selection-triggered refresh with stable item ids, throttle, overlap guard, silent interaction errors, and preserves manual Ctrl+R.
- Placeholder scan: no TBD/TODO/fill-in-later placeholders.
- Type consistency: `reload`, `forceReload`, `refreshFromInteraction`, and `handleSelectionChange` names are defined before use; `List.onSelectionChange` accepts `(id: string) => void`, and a no-arg callback is assignable because it ignores the id.
