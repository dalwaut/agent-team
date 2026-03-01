# Report: health

The full codebase health audit is complete. The most urgent items are:

1. **P0 #1-2**: The 27 exposed `.env` files with live Stripe keys, SSH passwords, and Discord tokens need immediate `.gitignore` protection and credential rotation.
2. **P0 #3**: The SQL/command injection in `n8n_provisioner.py` is exploitable.
3. **P0 #4-7**: The orchestrator has unhandled promise rejections and uncleaned intervals that can crash or corrupt state on shutdown.

Would you like me to start implementing any of the P0 fixes?