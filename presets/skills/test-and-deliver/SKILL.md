---
name: test-and-deliver
description: Run the confirmed checks, organize artifacts and assemble acceptance evidence for delivery.
---

# Test and deliver

- Execute exactly the confirmed check commands; do not substitute easier ones.
- Record commands, exit codes, stdout/stderr excerpts and artifact digests.
- Report partial results honestly; a skipped check is not a pass.
- Keep generated artifacts in the task workspace and reference them by digest.
- Hand off a concise delivery summary with links to the evidence records.
