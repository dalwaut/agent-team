https://n8n.boutabyte.com/workflow/pgvwWyZIczK8neEL
1) concept
2) sketch
3) build / test loop
4) webapp / frontend (where to place)

# Concept
the goal is to design a lead generation tool that could be used by us to find new clients.
it quickly dual purposed as a lead generation tool I could make and publish on my site for anyone to use to get a better understanding of SEO / GEO and their presence.
I started with Gemini researching the project then moved quickly into implementation over on n8n.

# Sketch
normally done with Excalidraw, I wanted to challenge myself and not sketch the project out in order to get this done in the slowest amount of time (and prep this, my first video/post... notes, lots of notes). I opted to give the n8n cloud AI a prompt and this is the result it gave me:

Prompt: "create a workflow that we can submit a website address to to have gemini research the company to provide us with 2 sets of information from 2 potential inputs.  
Inputs: webhook, or form  
information sets:

1. for customer: what they are missing and what is wrong with their website curated in a way that doesn't give away the fix but also provides information on what is wrong with the site and their outreach/advertising.
2. collected information about the submitted company/website for our records with technical information and an automatic (email) notice if a business submits their information and the company score is extremely low, meaning they are a likely customer. we want to automatically reach out to them by email (must be collected at time of url submission) regarding the services we can assist them with."

n8n AI

Categorizing prompt

Getting best practices

Searching nodes

Getting node details

Adding nodes

Connecting nodes

Updating node parameters

Validating workflow

**⚙️ How to Setup**

1. **Workflow Configuration node**: Set your internal email address for receiving high-priority lead alerts (replace the placeholder)
    
2. **Google Gemini Model node**: Add your Google API credentials to enable the AI analysis
    
3. **Gmail nodes** (both Send Lead Alert Email and Send Customer Report Email): Connect your Gmail account for sending emails
    
4. **Store Company Data node**: The workflow will automatically create a data table named `website_analysis_leads` to store all submissions with their analysis results
    
5. **Form fields**: The form collects three fields - you may want to mark them as required in the Form Submission node settings:
    
    - Website URL
    - Email Address
    - Company Name
6. **Webhook URL**: For the webhook option, the endpoint will be available at: `https://n8n.boutabyte.com/webhook/website-analysis`
    

Let me know if you'd like to adjust anything.
# Build
Original Workflow Framework - nothing set up ![[Pasted image 20260115135342.png]]
Logic: we would need a script/ way to do complete research on a website (==All pages + content... or could I just leave this up to Gemini since it already is the one going the suggesting?==)
following the steps i set up the google sheets and prepared for the original test run
original headers: 
we let google sheets automatically set the headers then organized the sheet for our liking

This automation does preform from the get go like we want. the only errors were the Gmail sending at the end.
we altered the Expression to be:
```
`<h2>Website Analysis Report for {{ $json.companyName }}</h2>
<p>Thank you for submitting your website for analysis. We have completed a comprehensive review of <a href="{{ $json.websiteUrl }}">{{ $json.websiteUrl }}</a>.</p>

<h3>Key Issues Identified:</h3>
<ul>
{{ JSON.parse($json.customerReport).issues ? JSON.parse($json.customerReport).issues.map(issue => `<li>${issue}</li>`).join("") : "" }}
</ul>

<h3>Recommendations:</h3>
<ul>
{{ JSON.parse($json.customerReport).recommendations ? JSON.parse($json.customerReport).recommendations.map(rec => `<li>${rec}</li>`).join("") : "" }}
</ul>

<p>These findings represent opportunities to enhance your online presence and reach more customers effectively.</p>
<p>If you would like to discuss how we can help address these areas and improve your website performance, please reply to this email.</p>
<p>Best regards,<br>Your Website Analysis Team</p>`
```

of course we connected and set up our accounts but the rest was easy.

the email sent perfectly after with the correct headings and all
![[Pasted image 20260115143735.png]]
we tapered up the spelling and removed things like the n8n attribution and the closing line.
- Pro might be better for this than Flash for developing the output.
we setup an agent account to send the emails out of to reduce exposing our internal accounts. 

# Frontend
we are placing this app in 2 places
1) Wautersedge.com our website - use the webhook input to allow the automation to run. 

2) Boutabyte.com also our website - to be able to use without a frontend app. (only Automation for now). 