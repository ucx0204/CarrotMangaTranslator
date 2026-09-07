# v0.4.1 · Japanese target readability

Preregistered after discovery-004 candidate 1 ended and its persisted 14-page
report finished. This is candidate 2 on the same sealed chapter, not a new
generalization sample. No previous response is reused as model input.

Observed failure: v0.4.0 instructed Astra to declare any unreadable owned
lettering a page failure. Astra correctly identified the Japanese dialogue,
title and effects but returned unreadable because a tiny English logo line
could not be transcribed. That logo was already represented as keep with an
empty transcript. The prompt's global instruction contradicted the user's
Japanese-only translation scope. No erasure, font or image stage was reached.

Change only the initial reading instruction: ownedReadability covers Japanese
translation targets, including meaningful Japanese logos, tiny handwriting and
furigana. Confirmed non-Japanese, Korean, digits and punctuation are preserved;
their illegibility cannot make readable Japanese targets fail. A protected keep
box may have an empty transcript. Uncertain script or unreadable Japanese still
returns unreadable; the validator never coerces a failed response to readable.

Native geometry, wire schemas, fonts, chapter grouping, actual erasure previews,
image registration, layout/review and repair budgets remain v0.4.0. The seven
actual schema preflight results apply only because these schemas are unchanged.
No new model fallback, registration threshold or source-mask algorithm is added.

Success at the regression boundary means readable Japanese proceeds while the
English logo is protected. It does not imply translation-quality success.
Whole-chapter final persistence, all original hashes and native pixels, actual
images, font/linebreak/background quality and cumulative usage must still be
audited. Failed or unresolved regions are not successful translations. Retain
the five-candidate chapter limit and page 6's existing 1/10 usage.
