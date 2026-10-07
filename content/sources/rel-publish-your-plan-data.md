---
title: Publish your plan data
url: https://www.gov.uk/government/publications/publish-your-plan-data/publish-your-plan-data
published: 2026-04-16T17:28:03+01:00
updated: 2026-08-13T16:35:09+01:00
publisher: Ministry of Housing, Communities and Local Government
---

### For plans under the legacy plan-making system

If you are submitting your plan under the legacy system, use the [create or update a local plan legacy system guidance](https://www.gov.uk/government/collections/create-or-update-a-local-plan-using-the-legacy-system).

The legacy system covers plans to be adopted under the Planning and Compulsory Purchase Act 2004 (excluding the amendments made by the Levelling-up and Regeneration Act 2023) and [The Town and Country Planning (Local Planning) (England) Regulations 2012](https://www.legislation.gov.uk/uksi/2012/767).

You must [follow this approved data standard](https://www.gov.uk/government/publications/publish-your-plan-data/publish-your-plan-data#approved-data-standard) to publish your plan timetables and your housing requirement data, so that you meet the requirements of the Planning Data (England) Regulations 2026. This will help you to meet the requirements of the [Town and Country Planning (Local Planning) (England) Regulations 2026](https://www.legislation.gov.uk/uksi/2026/186/contents/made?).

To meet the timetable requirements, you must publish both your [plan dataset](#plan-dataset) and [plan timetable dataset](#plan-timetable-dataset). The housing requirement data is part of the plan dataset.

This applies to the following plans that you create or update using the [new plan-making system](https://www.gov.uk/government/collections/create-or-update-a-local-plan-using-the-new-system):

-   local plans
-   minerals and waste plans
-   supplementary plans

Following the approved data standard will make sure that:

-   files open correctly across most software tools
-   everyone uses consistent formatting, which is more efficient for data analysis
-   government open data is easier for people to use
-   it is easier for government to work transparently

For each dataset, you should follow the [government tabular data standard](https://www.gov.uk/government/publications/recommended-open-standards-for-government/tabular-data-standard) and the [Open Government Licence](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).

## What you need to publish

You must publish both your [plan dataset](#plan-dataset) and [plan timetable dataset](#plan-timetable-dataset) separately. You should publish these as CSV files.

You should also publish a user-friendly version of your timetable alongside your datasets. This makes it easy for everyone to understand your key milestone dates for plan-making.

## When you need to publish

You must publish both datasets before or on the same day as you publish your [notice of intention to commence plan preparation](https://www.gov.uk/guidance/giving-notice-of-your-plan-making).

## How to get your data ready to publish

You should follow these steps to publish your data.

### 1\. Download your existing data

If you are preparing a local plan, use the [check and provide service](https://provide.planning.data.gov.uk/) to download the data that we already have for your authority.

You should download a CSV file for your local plan dataset and plan timetable dataset. The CSV includes legacy local plan system data from:

-   data you provided in the past
-   information on your website from plans under the legacy system
-   open data from public sources

The check and provide service does not have existing data for minerals and waste plans or supplementary plans.

### 2\. Prepare your data

You must [follow the approved data standard](https://www.gov.uk/government/publications/publish-your-plan-data/publish-your-plan-data#approved-data-standard) to make sure that you include all of the fields that are relevant to your plan and timetables.

If you are preparing a local plan, review and update the existing data in the CSV file that you downloaded from the check and provide service. Each file contains pre-populated rows that you need to complete, so that you meet the approved data standard.

If you are preparing a minerals and waste plan or supplementary plan, you should [use a template](https://www.gov.uk/government/publications/plan-and-plan-timetable-template) to create your plan dataset and plan timetable dataset.

You can make changes using a spreadsheet or other editing software. If there are optional fields in the CSV that do not apply to your timetable, you need to delete the rows.

If you downloaded a CSV file from the check and provide service, it will include information and dates from your legacy system plan timetable. You need to delete this information.

### 3\. Check your data meets the standard

For all plans, you should use the check and provide service to [check that your data meets the approved data standard](https://provide.planning.data.gov.uk/). The service will show you if your data is ready to publish or if you need to make any changes.

### 4\. Publish your data

You must publish both datasets on your planning authority’s website. You can choose to publish each dataset on separate pages or on a single page with separate anchor links.

On the page, you should include a:

-   link to each dataset (called your endpoint URL)
-   description of the data
-   statement to confirm that you published the data under the [Open Government Licence](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)

You only need to update your data at your endpoint URL. Do not create a new URL each time you make changes.

### 5\. Provide your data

After you publish, you should [provide your data to the Planning Data Platform](https://provide.planning.data.gov.uk/).

Providing your data will help us to maintain and improve your data quality.

You only need to provide your endpoint URL once. After you provide it, you only need to update your data at your endpoint URL and planning.data.gov.uk will update automatically.

## Meet the approved data standard

### Datasets

For local plans, minerals and waste plans and supplementary plans, you must provide 2 datasets:

-   [plan](#plan-dataset)
-   [plan timetable](#plan-timetable-dataset)

### Field names

You can use a field name with uppercase, lowercase and any punctuation characters. For example, you can use any of the following names for the start-date field in your data:

-   StartDate
-   Start Date
-   START\_DATE
-   start.date

### Reference values

Each dataset has a reference field. Reference values are important to help people find and link to your data. If you do not have a reference value for an item, you will need to create one that:

-   is unique within your data
-   does not change when the data is updated

A good reference is something you already use. If your reference is not unique, you can make them unique by adding the year or full date. Great references are:

-   short
-   easy to read
-   easy to pronounce and remember

### Date values

All dates must be in the format YYYY-MM-DD as set out in the guidance for [formatting dates and times in date](https://www.gov.uk/government/publications/open-standards-for-government/date-times-and-time-stamps-standard).

## Plan dataset

### Mandatory fields

Your plan data must contain the following fields:

-   reference
-   name
-   dataset
-   description
-   period-start-date
-   period-end-date
-   documentation-url
-   document-url
-   entry-date

#### reference

Give each plan a unique reference. For example:

-   LP-BRX-2024
-   barnet-local-plan-2021-2036
-   hertfordshire-minerals-and-waste-plan
-   essex-minerals-plan
-   essex-waste-plan
-   county-durham-supplementary-plan

For minerals and waste plans with multiple documents, give each minerals and waste plan document a unique reference.

The ‘reference’ in your plan dataset must match the ‘plan’ field from your plan timetable dataset.

#### name

Use the title of the plan. For example:

-   York Local Plan
-   Plymouth and South West Devon Joint Local Plan

#### dataset

Enter one of the following values to show the type of plan or plan document:

-   local-plan
-   supplementary-plan
-   minerals-plan
-   waste-plan

If your plan includes multiple types, enter the list of types and separate each of them with a semi-colon. For example:

-   minerals-plan;waste-plan
-   local-plan;minerals-plan
-   local-plan;minerals-plan;waste-plan

#### description

Enter a short description of the matters that the plan is to deal with.

#### period-start-date

Enter the start of the plan period. This is usually just a year in YYYY format. For example:

-   2026
-   2030

#### period-end-date

Enter the end of the plan period. This is usually just a year in YYYY format. For example:

-   2038
-   2040

If you do not have a plan document on the day you publish your data, leave this field blank.

#### documentation-url

Enter the URL of the webpage which links to your main or core plan document.

If there are several plans listed on a single webpage, you can use an anchor link (fragment identifier) to make the document-url value for each plan unique. For example:

-   https://eastcambs.gov.uk/planning-and-building-control/planning-policy-and-guidance/adopted-local-plan/local-plan
-   https://example.com/local-plans/#example-local-plan-2027

#### document-url

Enter the URL for the relevant plan document, which is usually a PDF file. For example, https://eastcambs.gov.uk/sites/default/files/2024-10/Local%20Plan%20adopted%2019%20October%202023%20-%20final%20with%20cover.pdf.

#### entry-date

Enter the date you created or modified the data.

### Conditional fields

Your plan data must also contain the following fields where they apply:

-   local-planning-authorities
-   minerals-and-waste-planning-authorities
-   required-housing
-   document-count

#### local-planning-authorities

Enter the GSS code for the [local planning authority](https://www.planning.data.gov.uk/dataset/local-planning-authority) area that this local or supplementary plan covers. For a joint plan, enter the list of references and separate each of them with a semi-colon. For example:

-   E60000001
-   E60000132;E60000133;E60000135;E60000136

#### minerals-and-waste-planning-authorities

Enter the GSS code for the [minerals and waste planning authority](https://www.planning.data.gov.uk/dataset/local-planning-authority) area that this minerals and waste plan document or supplementary plan covers. For a joint minerals and waste plan document, enter the list of references and separate each of them with a semi-colon. For example:

-   E47000001
-   E60000331;E60000225

#### required-housing

Enter the minimum number of homes that the plan expects to provide during the plan period.

You must provide your required-housing when you launch your consultation on your proposed local plan. You must update your required-housing when you:

-   submit your plan for examination
-   publish the examiner’s recommendations and reasons
-   publish your adopted local plan

For example:

-   10852
-   10012

#### document-count

Enter the number of documents which collectively form the plan. This field is only required for a minerals and waste plan.

### Optional fields

Your plan data may also contain the notes field.

#### notes

You may provide notes on how you made this data to help users differentiate the plan from others with a similar name. For example, Barnsley’s Local Plan as adopted by Full Council on 3 January 2019.

##  Plan timetable dataset

Record the key events in the timetable when producing your plan, these are sometimes also called ‘milestones’.

Your timetable must include an event-date for when you intend to meet the plan-event. [Find out when you need to update the entry](https://www.gov.uk/guidance/creating-a-plan-timetable) to include the actual date in the actual-date field.

For local plans or minerals and waste plans, your timetable must include an entry for each of the following plan-event field values:

-   publish-notice-intention-commence
-   scoping-consultation-start
-   scoping-consultation-end
-   gateway-1-self-assessment
-   plan-content-evidence-consultation-start
-   plan-content-evidence-consultation-end
-   gateway-2-advice-sought
-   proposed-plan-consultation-start
-   proposed-plan-consultation-end
-   gateway-3-advice-sought
-   examination-submitted
-   adopted

For minerals and waste plans with multiple documents, your timetable must include an entry for each of the plan-event field values for each minerals and waste plan document.

For supplementary plans, your local plan timetable or minerals and waste plan timetable must also include rows with an actual-date when any of the following events happen:

-   gateway-2-advice-published
-   gateway-3-advice-published
-   examination-recommendations-published
-   main-modification-consultation-start
-   main-modification-consultation-end
-   examination-pause-start
-   examination-pause-end
-   additional-consultation-start
-   additional-consultation-end
-   withdrawn
-   revoked

If you repeat Gateway 3, you must include these events in your timetable:

-   gateway-3-further-advice-sought
-   gateway-3-further-advice-published

### Mandatory fields

Your plan timetable data must include the following fields:

-   reference
-   plan
-   plan-event
-   event-date

#### reference

Give each event a unique reference. For example:

-   LP1-public-consultation
-   LP1-public-consultation-2025

#### plan

Enter the reference of the plan for which this event forms part of its timetable. For example:

-   LP-BRX-2024
-   central-lincolnshire

The ‘plan’ field in your plan timetable dataset must match the ‘reference’ field from your plan dataset.

#### plan-event

Enter a plan event reference for each key event or key milestone. For example:

-   commenced
-   publish-notice-intention-commence
-   examination-submitted
-   adopted

#### event-date

Enter the date when this event will happen. For example, 2027-01-01.

#### entry-date

Enter the date you created or modified the data.

### Conditional fields

Your plan timetable data must also contain the actual-date field if it applies.

#### actual-date

Enter the date when the timetable event happened. Leave this field blank when the event is in the future.

### Optional fields

Your plan timetable data may also contain the notes field.

#### notes

Enter any notes or commentary which helps to understand this data.