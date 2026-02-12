# Email Agent System Implementation Plan

## Goal
Create an n8n workflow that allows sending emails as the user to anyone they dictate or from their Google Contacts list. The system should be able to send the WordPress 404 report to internal team members.

## User Review Required
> [!IMPORTANT]
> **Authentication Requirements**:
> - Gmail API credentials (OAuth2)
> - Google Contacts API credentials  
> - n8n instance URL (Cloud-based per user preferences)
>
> **Workflow Trigger**:
> - Should this be triggered via webhook, manual button, or another method?
> - Do you want the report auto-generated and attached, or manually provided?

## Proposed Changes

### n8n Workflow Architecture
1. **Trigger**: Webhook or Manual trigger
2. **Input Processing**: Extract recipient (name or email) and message body
3. **Contact Lookup**: Query Google Contacts API if recipient is a name
4. **Email Composition**: Format email with user's signature
5. **Send Email**: Use Gmail API to send as user
6. **Confirmation**: Return success/failure status

### Workflow Components

#### [NEW] [email-agent-workflow.json](file:///d:/SD/Home/OPAI/Library/n8n/Workflows/email-agent-workflow.json)
- Complete n8n workflow JSON with:
  - Webhook trigger accepting `{recipient, subject, body, attachment?}`
  - Google Contacts node for recipient lookup
  - Gmail node for sending emails
  - Error handling and logging

#### [NEW] [workflow-setup-guide.md](file:///d:/SD/Home/OPAI/reports/workflow-setup-guide.md)
- Step-by-step setup instructions
- Required API credentials and scopes
- Testing procedures

---

### Integration Points
- **Google Contacts API**: Search by name, return email
- **Gmail API**: Send email with attachments
- **WordPress MCP**: Generate and retrieve reports (already done)

## Verification Plan

### Manual Testing
1. Import workflow JSON into n8n
2. Configure Gmail and Google Contacts credentials
3. Test with sample email to yourself
4. Test sending the 404 report to a team member
