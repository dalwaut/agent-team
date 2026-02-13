### Instructions (for AI)
- Read the Context portion of this document to understand the project, review the related/mentioned pages as well.
- Add more entries to the Folder/file rundown list as we add them to this research project (review the folder/file contents and generate an entry below in the list to keep up to date on the current structure).
- #### Folder/file rundown: 
  - MISC - folder for images, files, etc that are referenced but are placed in the MISC folder to de-clutter the workspace.
  - Routing Schematics - proposed high level routing schematics of the apps more detailed functions.

### Context
**Goal**: move BoutaByte (local) to a production environment with all services connected and working.
**About**: BB2.0 currently lives in a localhost environment with access to supabase for it's database and file storage(s3) with n8n .cloud handling the automations portion. 
**Details**:
- we need it to be moved up to Netlify and route it's services to our server on hostinger. 
- we will be housing n8n entirely on Hostinger (already active) and we will be running the automations from it's library as well, 
- Supabase will handle the database for BoutaByte still but will loose the larger file storage as that will move to hostinger server.
- File API will be ran on hostinger for file storage and delivery purposed.
- app.boutabyte.com will be location users are taken to to see a webapp when one is opened.
- 
**Constraints**: 
	 Concurrent user usage and File delivery
Hardware:
- **4** vCPU Core
- **16 GB** RAM
- **200 GB** NVMe Disk Space
- **16 TB** Bandwidth
- **1** Snapshot
- **Weekly** Backups
- **Dedicated** IP Address
- **Full** Root Access

**Proposed Routing**: [[Routing Schematics]]

**Expense list and times:**
- KVM4
	- Price:
	- Renewal date:
- Domain: [boutabyte.cloud](https://boutabyte.cloud/)
	- Price:
	- Renewal Date: 2026-12-21


#### User Questions:
- Can offloading the Plugin delivery methods to the official wordpress plugin marketplace while still offering direct downloads for specific plugins alleviate most of the potential for multiple concurrent downloads lagging down the website? 

