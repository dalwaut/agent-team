#### Export all from cloud
- curl -X GET "https://YOUR-N8N-CLOUD-URL/api/v1/workflows" \
	-H "X-N8N-API-KEY: YOUR_API_KEY" > all_workflows.json
	
#### Import to Self-Hosted
-  curl -X POST "https://n8n.boutabyte.com/api/v1/workflows" \
	-H "X-N8N-API-KEY: YOUR_NEW_API_KEY" \
	-H "Content-Type: application/json" \
	-d @workflow.json