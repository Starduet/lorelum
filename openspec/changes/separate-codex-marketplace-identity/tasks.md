## 1. Public distribution metadata and contract

- [x] 1.1 Change `.agents/plugins/marketplace.json` to the `lorelum-plugins` namespace while preserving the sole `lorelum` entry; the current source root is `./plugins/codex/lorelum` under the successor layout change. Verify the marketplace JSON resolves to exactly one Plugin source.
- [x] 1.2 Update the current Codex artifact's `marketplace-config.test.ts` to assert `lorelum@lorelum-plugins` and the unchanged manifest ID/display name/current source directory; revert the earlier root-alias guidance and its assertions; verify the focused configuration test passes.
- [x] 1.3 Apply the reviewed `plugin-distribution` delta to the current spec during the approved OpenSpec sync/archive step; verify the resulting current requirement has all three migration scenarios.

## 2. Alpha migration documentation

- [x] 2.1 Replace every public install and update selector in `README.md` and the English/Chinese site Codex pages; add the one-time removal of legacy `lorelum` source before installing `lorelum@lorelum-plugins`; verify `rg 'lorelum@lorelum'` finds only explicitly labelled legacy-migration text.
- [x] 2.2 Update `docs/development/plugins.md` and `plugins/README.md` so checkout-backed development uses the new marketplace name and cannot instruct maintainers to configure old and new Lorelum sources together; verify the documented local cachebuster reinstall path uses `lorelum@lorelum-plugins`.
- [x] 2.3 Add an alpha release-note entry that labels the selector rename as breaking and points users to the migration commands; verify the release-note location is linked from the relevant installation documentation.

## 3. Installation and recovery verification

- [x] 3.1 In a clean disposable Codex configuration, execute the documented legacy-to-new migration and verify `codex plugin marketplace list` contains one Lorelum source and `codex plugin list` reports `lorelum@lorelum-plugins` as installed and enabled.
- [ ] 3.2 Inspect the resulting installed Skill location and begin a new task; verify the host loads the Lorelum Skill from a marketplace namespace distinct from the `lorelum` Plugin ID without claiming a specific host-managed cache layout as a product contract.
- [x] 3.3 Run the plugin validator when its Python dependency is available, the focused Codex artifact tests, the relevant documentation/site checks, and `git diff --check`; record any unavailable validation dependency separately from product-test results.
