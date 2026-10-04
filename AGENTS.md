# AGENTS.md — RhinoView

Instructions for every AI agent that works in this repository: the orchestrator, workers,
reviewers, and scheduled cloud routines. `CLAUDE.md` imports this file.

## Required reading

Read these files before you change code:

1. `docs/AGENT_BRIEF.md` — file ownership, commands, code standards, known traps.
2. `docs/CONTRACT.md` — the HTTP contract between client and proxy. Frozen.
3. `shared/types.ts` — the contract types. Frozen.
4. The plan for the current phase, for example `docs/PHASE5_PLAN.md`.

## Output style: ASD-STE100 Simplified Technical English

**Write all text for the human user in ASD-STE100 style.** This rule applies to:

- Replies and reports to the user in a chat or terminal session.
- Pull request titles, descriptions, and review comments.
- Commit messages.
- Reports in the repository that are for the user, for example `docs/PHASE5_REPORT.md`.

This rule does not apply to code, identifiers, file paths, command lines, API field names,
test names, or quoted logs and error messages. Do not change those to follow STE.
Messages between agents (for example, a worker report to the orchestrator) can use
normal English. The orchestrator must write its output for the user in STE.

### Word rules

1. Use simple, approved words. Use each word with one meaning only.
2. Use the same word for the same thing every time. Do not change words for variety.
3. You can use technical names and technical verbs of this domain, for example
   *repository*, *endpoint*, *cache*, *commit*, *merge*, *deploy*, *typecheck*.
4. Do not use phrasal verbs. Write "configure", not "set up". Write "do", not "carry out".
5. Do not use the -ing form of a verb as a verb. Do not use progressive tenses.
   Write "the test fails", not "the test is failing".
6. Use only these tenses: simple present, simple past, and simple future.
7. Use the active voice.
8. Do not use contractions. Write "do not", not "don't".

### Sentence rules

1. Keep instructions to 20 words or fewer. Keep descriptions to 25 words or fewer.
2. Write one instruction in each sentence. Write instructions in the imperative.
3. Write one topic in each sentence.
4. Do not remove articles or verbs to make a sentence shorter.
5. Do not use more than three nouns in a row.
6. Write one topic in each paragraph. Use six sentences or fewer in each paragraph.
7. Use vertical lists for steps, sequences, and complex data.
8. Put a warning before the instruction that it applies to. Start the warning with a
   clear command.

### Examples

| Do not write | Write |
|---|---|
| Commence the migration prior to merging. | Start the migration before you merge. |
| It should be ensured that the tests are being run. | Make sure that you run the tests. |
| Utilize the cache to facilitate faster loading. | Use the cache. The cache makes the load faster. |
| Set up the environment and carry out the checks. | Configure the environment. Then do the checks. |
| Caching was implemented and is working fine. | We added a cache. The cache works correctly. |

### Structure for a pull request description

Use these sections, in this order:

1. **Summary** — Two or three short sentences. Tell what changed and why.
2. **Changes** — A vertical list. Use one change in each item.
3. **Verification** — A vertical list. For each check, tell what you did and the result.
4. **Not verified** — A vertical list. Tell what you did not check, and why.
5. **Risks** — A vertical list of known problems and open decisions.

Be honest in the **Verification** and **Not verified** sections. Do not write "it works"
if you did not do a check. A statement such as "I did not do a check in a browser" is
correct and useful.
