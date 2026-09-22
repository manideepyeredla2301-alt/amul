let reminderPoll=null;
async function refreshReminderProgress() {
 try {
  const job=await api('/api/whatsapp/send-status');
  const banner=$('#reminder-progress');
  if(banner && job.total!==undefined) {
   banner.hidden=false;
   banner.textContent=(job.running?'Sending reminders: ':'Reminder result: ')+
    job.processed+'/'+job.total+' checked · '+job.accepted+' accepted by WhatsApp · '+
    job.skippedPaid+' paid/removed skipped · '+job.skippedMissing+' missing numbers · '+
    job.skippedDuplicate+' already reminded today · '+job.skippedHeld+' held for review · '+
    job.failed+' failed · '+job.unknown+' uncertain'+(job.error?' · '+job.error:'');
  }
  $$('[data-action="payment-reminder"],[data-action="payment-reminder-all"]').forEach(b=>b.disabled=!!job.running);
  clearTimeout(reminderPoll);
  if(job.running)reminderPoll=setTimeout(refreshReminderProgress,1500);
 } catch(error) {clearTimeout(reminderPoll);toast('Could not refresh reminder status. Open Reminder history before trying again.','error');}
}
async function sendPaymentReminder(input) {
 if(!input.all){
  const p=await api('/api/whatsapp/preview',{method:'POST',body:input});
  if(p.outstandingPaise<=0){toast('This invoice is paid. No reminder sent.');return;}
  if(!p.recipient){toast('Add a valid WhatsApp/mobile number to this customer first.','error');return;}
  if(!confirm(`Send payment reminder ONLY to ${p.customer}\n+${p.recipient}\nInvoice: ${p.invoiceNumber}\nOutstanding: ${money(p.outstandingPaise)}?`))return;
  input={...input,expectedRecipient:p.recipient};
 }
 if(input.all && !confirm('Send a WhatsApp payment reminder for every unpaid or partially paid invoice? Paid invoices will be ignored. This includes invoices that are not yet overdue.'))return;
 const result=await api('/api/whatsapp/send',{method:'POST',body:input});
 if(result.skippedHeld){toast('NOT SENT: a previous attempt is held. Open Reminder history to review and retry a confirmed failure.','error');await refreshReminderProgress();return;}
 if(result.skippedDuplicate){toast('NOT SENT: already reminded today. Check Reminder history.');await refreshReminderProgress();return;}
 toast(input.all?'Bulk reminder request started. Paid invoices are skipped.':'Reminder requested for this invoice’s customer only. Paid invoices are skipped.');
 await refreshReminderProgress();
}
