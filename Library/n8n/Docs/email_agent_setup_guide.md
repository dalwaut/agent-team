# Email Agent - Setup & Usage Guide

## Overview
This n8n workflow allows you to send emails as yourself via Gmail with Google Contacts integration. It supports both direct email addresses and contact name lookups.

## Setup Instructions

### 1. Import Workflow
1. Open your n8n instance
2. Go to **Workflows** → **Import from File** or **Import from URL**
3. Import `Email-Agent-Send-as-User.json`

### 2. Configure Credentials

#### Gmail OAuth2
1. In the "Send Gmail" node, click on the credential dropdown
2. Create new **Gmail OAuth2** credential
3. Follow the Google OAuth setup:
   - Go to [Google Cloud Console](https://console.cloud.google.com)
   - Enable **Gmail API**
   - Create OAuth 2.0 credentials
   - Add scopes: `https://www.googleapis.com/auth/gmail.send`

#### Google Contacts OAuth2
1. In the "Lookup Google Contact" node, click on the credential dropdown
2. Create new **Google Contacts OAuth2** credential
3. In Google Cloud Console:
   - Enable **People API** (Google Contacts API)
   - Use the same OAuth credentials or create new ones
   - Add scope: `https://www.googleapis.com/auth/contacts.readonly`

### 3. Activate Workflow
1. Click **Active** toggle in the top-right corner
2. Copy the webhook URL from the "Webhook Trigger" node
3. Save the webhook URL for API calls

---

## Usage

### Webhook Endpoint
**URL**: `https://n8n.boutabyte.com/webhook/send-email`  
**Method**: `POST`  
**Content-Type**: `application/json`

### Request Body Format

#### Example 1: Send to Email Address
\`\`\`json
{
  "recipient": "john@example.com",
  "subject": "Website 404 Report",
  "message": "Hi John,\\n\\nPlease review the attached 404 report.",
  "include_404_report": true
}
\`\`\`

#### Example 2: Send to Contact Name
\`\`\`json
{
  "recipient": "John Smith",
  "subject": "Quick Update",
  "message": "Hey John, just wanted to give you a quick update on the project.",
  "include_404_report": false
}
\`\`\`

### Request Parameters
| Parameter | Type | Required | Description |
|---|---|---|---|
| `recipient` | string | Yes | Email address OR contact name from Google Contacts |
| `subject` | string | No | Email subject (defaults to "No Subject") |
| `message` | string | No | Email body text |
| `include_404_report` | boolean | No | Attach the WordPress 404 report (defaults to `false`) |

### Response Format

#### Success
\`\`\`json
{
  "success": true,
  "message": "Email sent successfully",
  "to": "john@example.com",
  "subject": "Website 404 Report"
}
\`\`\`

#### Error
\`\`\`json
{
  "success": false,
  "error": "Contact not found"
}
\`\`\`

---

## Testing

### cURL Example
\`\`\`bash
curl -X POST https://n8n.boutabyte.com/webhook/send-email \\
  -H "Content-Type: application/json" \\
  -d '{
    "recipient": "your-email@example.com",
    "subject": "Test Email",
    "message": "This is a test email from the Email Agent workflow.",
    "include_404_report": false
  }'
\`\`\`

### PowerShell Example
\`\`\`powershell
$body = @{
    recipient = "your-email@example.com"
    subject = "Test Email"
    message = "This is a test email from the Email Agent workflow."
    include_404_report = $false
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://n8n.boutabyte.com/webhook/send-email" `
  -Method POST `
  -Body $body `
  -ContentType "application/json"
\`\`\`

---

## Workflow Logic

1. **Webhook Trigger**: Receives POST request
2. **Parse Input**: Extracts recipient, subject, message, and report flag
3. **Check if Email**: Determines if recipient is an email or name
   - **Email**: Proceeds directly
   - **Name**: Looks up in Google Contacts
4. **Merge Recipient**: Combines the resolved email
5. **Load 404 Report**: Prepares the report content
6. **Include Report?**: Checks if report should be appended
7. **Merge Body**: Combines message with optional report
8. **Send Gmail**: Sends the email
9. **Response**: Returns success/error to webhook caller

---

## Troubleshooting

### "Contact not found"
- Ensure the contact exists in your Google Contacts
- Try using the exact name as it appears in Google Contacts
- Use the email address directly as a fallback

### "Authentication failed"
- Re-authenticate your Gmail/Google Contacts credentials
- Verify API scopes in Google Cloud Console
- Check that APIs are enabled

### No email received
- Check spam/junk folder
- Verify Gmail credentials have send permissions
- Test with your own email first

---

## Next Steps
- Customize the 404 report content in the "Load 404 Report" node
- Add CC/BCC recipients in the "Send Gmail" node options
- Add HTML formatting support by changing `emailType` to `html`
- Set up error notifications to Slack/Discord
