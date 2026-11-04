# ADR-0064 — A run left alone is finished for the learner, and the promise matches what the evidence can support

**Status** Accepted · M8 Track I, M8-36 to M8-40 · Records DEC-M8-22, DEC-M8-23 and DEC-M8-24 (docs/IMPLEMENTATION-DECISIONS.md) · Closes D116, D117 and D38; registers D118 and D119 (docs/DEBT.md)

## Context

Track H found three things the next track had to act on. A practice run that is put down and never picked up recorded nothing, because evidence is made when a submitted run is scored and nothing submitted a run (D116). The home screen named a weakest topic in words the map would not use for the
same topic (D117). And the first acceptance criterion of M8 asked for something a first sitting cannot give. The stack the beta would run on had also never been built: the Compose file named three build contexts that did not exist.

## Decision

**A run left alone is submitted for the learner by the sweep** (DEC-M8-22), after forty-eight hours without a word from it, by the path a learner's own finishing takes. One path produces a score record, evidence and the events, and it is already proved; scoring an unsubmitted run would have been a second
scoring path and a second truth about what a finished run is. The event is the practice one, so a run reaches the consumer for runs and a mock the consumer for papers in the same sweep. A run is said once, by how it ended: completed, or abandoned.

**The criterion is reworded, and the bar is not lowered** (DEC-M8-23). An asserted standing needs eight responses on a topic and a strong one two sessions; a breadth-first diagnostic leaves a few answers on each topic. M8's first line now asks for a first named *recommendation*, and the home screen says "so far" for a topic whose standing is not stated.
A second, lower confidence rule would have been a number reporting on a smaller sample and read as the same fact; a diagnostic concentrated on a few topics would have broken FR-STU-03's first rule and still failed the sessions rule.

**The stack is built and booted in CI** (DEC-M8-24). The API image holds a bundle and no dependencies; the learner app and Studio are served by nginx with the API at the same address; a migrator records what it applied; the services nothing uses are out of the default set. The `compose` job builds the images, starts the stack with `--wait`, migrates, seeds and runs the journey over HTTP,
and the time it prints is the claim F8 makes. Terraform targets another deployment and is left as it stands (D118).

## What is not claimed

A production process has no mail provider (D119), so the stack runs in development mode; the learner app has no sign-in screen, so the journey is run over HTTP and not in a browser. The measured journey is one learner on one machine with no person reading: a floor on the machine's share of the ten minutes.
