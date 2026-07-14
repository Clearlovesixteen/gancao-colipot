# Computer Use V3 Readiness

## Current Stage

The project is currently in the V3 core stabilization stage.

V2 now has:

- Phase-based `ComputerUseRunner`.
- Search tasks converted into the unified phase runner: `open_site -> search -> select_collection_item`.
- Semantic collections for search results, menus, file lists, tables, cards, and generic lists.
- `TargetResolver` between semantic targets and executable DOM targets.
- Centralized phase completion checks.
- Trace-based Chat task card.

V3 core can be considered usable when Gate 1 and Gate 2 are green. V3 business closure requires Gate 3.

## V2.5 Gates

### Gate 1: Search Reliability

Required scenarios:

- Open Baidu or Google, search a keyword, click result 1.
- Open Baidu or Google, search a keyword, click result 2.
- Open Baidu or Google, search a keyword, click result 3.
- Search result selection must not click top navigation, hot search, hao123, ads, or related search.
- If the click does not leave the search results page, the task must fail with a clear reason.

Status: search is now routed through the unified phase runner. `pageContextBuilder` turns `get_search_results` into a `search_results` collection, and `TargetResolver` resolves the requested ordinal before action execution. Automated tests cover requested result indexes. Manual Google/Baidu/YouTube verification is still required.

### Gate 2: Business Navigation Reliability

Required scenarios:

- Same leaf menu under different parent modules, such as `颗粒剂管理 > 库存预警` and `饮片管理 > 库存预警`.
- Parent menu collapsed, then child menu appears.
- Parent menu active but child page not opened.
- Missing child menu or permission-limited menu.

Expected result:

- The runner must use parent path context.
- It must not click the wrong same-name menu.
- It must not mark a phase as complete without active navigation, URL/title evidence, or target page text.

Status: semantic target resolution and phase completion are implemented. Manual WMS verification is still required.

### Gate 3: Download And File Center

Required scenarios:

- Target page has a real export/download button.
- Export button is inside a "more/actions" menu.
- Download succeeds and can be saved to the document center.
- Download succeeds but cannot be read back by the extension.
- Download fails or times out.
- File center contains the downloaded filename.

Expected result:

- Export/download tasks must prefer real download actions over table extraction.
- Partial download must be marked as partial, not full failure.
- File center click must prove the file opened or became active.

Status: download result handling exists. More manual verification is required.

### Gate 4: Cross-Feature Health

Required scenarios:

- Page diagnosis can gather page info, console errors, structured data, and observation.
- Document QA can list, search, and read documents.
- AI request failures show an actionable error, not a raw `Failed to fetch`.
- Login-required paths are blocked when unauthenticated.

Status: auth gates are in place. AI network/model failure messaging has been improved in both the LLM client and Chat UI. Manual verification is required.

## When V3 Can Move To Larger Feature Work

Larger V3 feature work can start when:

- Gate 1 and Gate 2 pass in manual verification.
- `tsc --noEmit`, `vitest`, and `vite build` pass.
- No current P0 bug remains where the task says completed but no real action happened.
- No current P0 bug remains where a semantic target selects the wrong same-name item.
- Page diagnosis and document QA can reach the model or fail with a clear network/model error.

## Recommended V3 Scope

Once ready, V3 should focus on:

- Workflow replay from successful traces.
- More robust semantic collections, especially table rows, file rows, cards, and forms.
- Local fixture-based browser evaluation for repeatable regression tests.
- Complex control support: AntD Select, virtual tables, modals, iframe, shadow DOM.
- Unified task center for Computer Use, page diagnosis, document QA, OCR, and long AI replies.

Avoid in the first V3 slice:

- Stagehand rewrite.
- Local visual model integration.
- New backend service.
- System-level computer use outside the current browser tab.

## V3.1 Automated Acceptance Matrix

V3.1 adds a real Chromium extension gate in addition to the existing unit tests. The test environment loads the unpacked `dist` extension and operates a local business fixture, so it does not depend on a production WMS account.

| Capability | Unit gate | Chromium extension gate | Completion evidence |
| --- | --- | --- | --- |
| Duplicate nested menus | `collectionBuilder` + `targetResolver` | Select the requested parent and leaf | Active leaf and matching business route |
| Form fields | `collectionBuilder` + `verifyComputerUseStep` | Select subsystem and type user alias | Observed values equal requested values |
| Table row actions | `targetResolver` | Download the first result row | Resolved `table_row_group` ordinal and download event |
| Real export | `verifyComputerUseStep` + runner tests | Click delayed export button | Completed or partial Chrome download |
| Page context | `pageContextHub` + agent tests | Diagnosis smoke test | Shared page signals and collection summaries |

Commands:

```bash
pnpm test:e2e
pnpm test:e2e:headed
pnpm verify
```

The deterministic Computer Use mode is a test-only storage flag used by the extension E2E harness to bypass external LLM availability. It does not change the normal user path.
