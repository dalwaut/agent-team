1 call a day Internal loop via sub workflow executions
- uses an internal loop ques to kick off once a day
- calls on BB2.0 Supabase for the n8n_executions table for entries with the "New" status
- updates internal n8n database for record keeping and to keep calls down
- used a control workflow and an app/n8n form to manage database.

## Databases
### Supabase 
- n8n_executions - list of executions and status of Boutabyte webapp based requests executed 
- n8n_automations - supabase database of automatons (n8n workflows mainly (and others)) with n8n id for relation
### n8n Data Table
- Workflows Database - n8n list of workflows with supabase id for relation
- Daily Que - running que (jd:job ID, status: messages for the user) of what is active / log of daily jobs
- Execution Database - history and log on n8n for devops
  
## Terms

## Links & ToDo
- [Sync n8n Workflows to BB2.0 Supabase Catalog](https://dpwfl.app.n8n.cloud/workflow/7ADcjhgocdakHcyb/debug/6998) Control workflow, needs to be finished / tweaked to work properly ( currently not the best at updating, creating works great )
	- 
- [BB2.0 | daily Loop](https://dpwfl.app.n8n.cloud/workflow/V7Z64q3QsAJuwtqq) main simple 24hr loop that only calls for the Supabase DB check or for the n8n que to start jobs.
	-  needs the calling worked out, loop is there.
- [BB2.0 | check Status and que](https://dpwfl.app.n8n.cloud/workflow/0Z4pD4gtDWILiB6y) Retrieves the SB Execution entries and adds the NEW ones to the Que.
	- need SB updater?
  
