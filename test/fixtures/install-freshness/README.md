Lock pairs for the install-freshness guard (R3-628).

`project.lock.json` + `installed.fresh.json` are a REAL pair: `npm install` of one tiny
dependency (`leven@4.0.0`) in a throwaway directory, with the `package-lock.json` and
the `node_modules/.package-lock.json` npm wrote beside it copied in verbatim. The shape
under test is npm's, not a hand-written approximation of it (implementation_standards
R2).

`installed.stale.json` is that same installed tree with exactly ONE edit: `leven` rolled
back to `3.1.0`, which is what a checkout that has not been reinstalled looks like.

They are stored under these names rather than as real `node_modules/` directories
because `node_modules` is gitignored — a fixture git refuses to track is a fixture that
vanishes on clone. The test materialises them into a temp directory at the paths npm
would use.

Frozen on purpose (ways_of_working §4): the test must not reach the network, and these
bytes only need regenerating if npm changes the hidden-lockfile format.
