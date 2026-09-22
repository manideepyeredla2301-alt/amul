# Customer, stock and invoice updates

Close FrostFlow and reopen the desktop launcher after updating application files.

- Inventory now sorts stocked Amul batches first. Search and Next/Previous cover the entire local copy.
- POS searches the full Amul catalogue on the server, rather than filtering only the initial page.
- Customer accounts have Add, Edit, ledger and WhatsApp chat actions. Amul customer edits stay in the local database.
- Invoices have View / edit items. Local invoices recalculate GST; Amul corrections accept explicit line tax and discount/charge adjustments and retain original header adjustments. Review these amounts before saving.
- Quantity corrections adjust local stock atomically. Original invoice details and correction reasons remain in audit history. Amul corrections survive sync.
- Local invoices with returns require the returns workflow. An invoice cannot be reduced below allocated payments; walk-in corrections must retain the fully paid total.

# WhatsApp connection and invoice reminders

Open Settings → Configure WhatsApp connection. Settings contain connection details only; saving settings never sends a message.

Enter your Meta phone number ID, supported Graph API version, approved template name, language and access token. Tokens are held in memory only; enter again after restarting, or provide FROSTFLOW_WHATSAPP_TOKEN to the app process. Tokens are excluded from settings responses, database backups and logs.

The approved template must have four positional body text parameters, in this order:

1. Customer name
2. Invoice number
3. Outstanding rupees
4. Due date

Open Invoices to send reminders. Use Send payment reminder beside one unpaid invoice, or Send reminder to all unpaid for all local and Amul invoices, including records on other pages. Partially paid invoices use the remaining amount; fully paid or removed invoices are skipped. Balances are checked again immediately before each send. Customer numbers come from saved invoice/customer details. Invoices not yet overdue are included, so use a matching approved template with neutral due-date wording. There is no automatic schedule.

Reminder results and Reminder history are on Invoices. Missing numbers, reminders already accepted today, and attempts held for review are skipped and counted. Internet is required to send; core business functions continue offline.

The history distinguishes ACCEPTED (Meta accepted the message) from FAILED and UNKNOWN. Acceptance is not proof of delivery. Delivery webhooks require a reachable HTTPS endpoint, which this local-only application does not expose. Failed or uncertain invoices are held to prevent repeated sending; inspect Meta before any manual resend.

No live Meta message is sent during automated tests. Account credentials and an approved matching template are required to verify live delivery.

Meta reference: https://www.postman.com/meta/whatsapp-business-platform/request/o65u5m5/send-message-template-text
