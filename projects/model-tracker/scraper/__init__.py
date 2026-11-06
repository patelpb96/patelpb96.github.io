"""English-only scraper for the model tracker (dry-run core; see ../PLAN.md).

Pure, stdlib-only modules. Anything that talks to the outside world (Exa, page fetch, Jev, an extraction
agent) is passed in as an object or callable, so a run is deterministic in tests and a dry run needs no
network, no AWS and no secrets.
"""
