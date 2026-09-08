# Release 14 user validation walkthrough

Use the application address printed at startup or supplied by your operator. A restart may select a different available port.

This walkthrough uses separate administrator, learner and mentor accounts. Do not share sessions or credentials between roles. Use fictional validation content only.

## 1. Administrator: confirm the release and accounts

1. Sign in with the practice administrator account.
2. Confirm the left navigation shows **Portfolio**, **Engagements**, **Templates**, **Ontology**, **Company practice**, **Training**, **Knowledge**, **Team** and **Sample data**.
3. Open **Team**. Create separate member accounts for the learner and mentor if suitable test accounts do not already exist. Record which account has each role for this validation.
4. Open **Company practice**. Confirm **Author company challenges** is visible only to the administrator.

## 2. Administrator: publish a fictional company challenge

You may use one of the supplied fictional challenges or create a new fictional challenge. Do not enter client, employee, production or confidential data.

For a supplied challenge:

1. Select **Import challenge** if it has not been imported.
2. Select **Publish challenge** for its draft.
3. Select **Import private mentor guide**.
4. Review the displayed private guide, enter the **Publication rationale**, select **Confirm this reviewer guide is ready for mentors**, and select **Publish private mentor guide**.

For a custom challenge:

1. Expand **Create custom challenge** under **Author company challenges**.
2. Enter the challenge key, name, purpose, fictional company situation, learner audience and constraints.
3. Under **Datasets**, enter a dataset key, CSV filename and field descriptions, then select a bounded fictional CSV file. All CSV files in one exercise must remain within the displayed 2 MiB total limit.
4. Select **Create challenge draft**. Reopen the draft and use **Save challenge draft** if a correction is needed.
5. Select **Publish challenge version** after review.
6. Expand **Private reviewer guide authoring**. Create and review the separate mentor-only guide, including acceptable alternatives and rubric criteria. Publish it using **Publication rationale**, the confirmation checkbox and **Publish private guide**.

To validate version preservation, reopen a published challenge or guide, enter the displayed reason for a new version, and create a new draft. Confirm the earlier published version remains listed and unchanged. Publishing the new version must not move existing assignments off their pinned version.

## 3. Learner: start and investigate the challenge

1. Sign out, then sign in with the learner account.
2. Open **Company practice**. Confirm **Author company challenges**, **Private mentor view** and **Reviewer reference** are absent.
3. Choose the published fictional challenge and select **Start this challenge**.
4. Under **My challenge work**, open the new assignment.
5. Review **Company constraints** and **Available company data**. Select **Download CSV** and confirm the downloaded file matches the fictional dataset description.
6. Optionally expand **Add output evidence** and add either one safe link or one attachment within 2 MiB.
7. Add a **Reflection or progress note** under **Running learning log**.
8. Expand **Submit my proposal**. Record the learner's own selected problem, rationale, investigation questions, proposed approach, proposed outputs and success criteria. Select **Submit proposal**.
9. Confirm the new entry appears in **Proposal history**. The application should preserve the learner's words and must not supply a prescribed answer.

## 4. Administrator: assign the mentor

1. Sign out and sign back in as the practice administrator.
2. Open **Company practice**, then select the learner's entry under **My challenge work**.
3. Under **Assign mentor**, choose the separate mentor account and select **Assign mentor**.

## 5. Mentor: review without changing learner work

1. Sign out, then sign in with the mentor account.
2. Open **Company practice** and select the assigned learner under **My challenge work**.
3. Confirm **Private mentor view** and **Reviewer reference** are visible. Confirm the learner's proposal and evidence are readable.
4. Expand **Compare latest proposal**. For each rubric criterion, choose the observed result and write feedback. Use **Valid alternative** only when the learner proposed a reasonable alternative that the private reference should recognize.
5. Enter **Overall feedback** and select **Save comparison**.
6. Confirm the comparison appears for the learner without exposing the private reviewer reference.

## 6. Learner: confirm feedback and history

1. Sign out and sign back in as the learner.
2. Open the assignment and confirm **Mentor feedback** is visible while **Private mentor view** remains absent.
3. Submit a revised proposal if you want to validate history. Confirm the earlier proposal and feedback remain visible and the earlier comparison says **Feedback applies to an earlier proposal.**

## 7. Broader release checks

1. As the administrator, open **Templates** and confirm a draft can be edited with the visual designer before publication. Create a new version from a published template and confirm existing engagements remain pinned to their original version.
2. Open an assigned engagement. Confirm checklist updates, notes, evidence and **Readiness review** are available only to authorized members or administrators.
3. Open **Training** and confirm **My learning** and **Training sets** appear as readable horizontal tabs. A published generic training set can create a new draft version; an existing draft can be corrected and reordered before publication.
4. Open **Knowledge**, **Ontology** and **Portfolio**. Confirm published knowledge is readable, the ontology exposes schema descriptions rather than private guide content, and portfolio filters show only authorized engagement records.
5. Sign out. Confirm protected application endpoints and records require authentication.

Record any unexpected behavior with the account role, page heading, action label and time. Do not include passwords, session tokens, database connection strings, private reviewer-guide text or confidential data in validation notes.
