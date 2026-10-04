PIPELINE_PHASE: SETUP
PIPELINE_RISK: LOCAL_ONLY

# Codex QA task

Replace this example with the acceptance/exploratory QA scope Codex should test.

Codex is testing only:
- no source edits
- no SQL/migration edits
- no commits/push/deploys
- no production business-data writes without a separate human-approved gate

Test both correctness and user confusion. End with the required PIPELINE_* verdict lines.
