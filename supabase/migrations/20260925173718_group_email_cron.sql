select cron.schedule('email-event-dispatch','* * * * *','select sms_private.dispatch_email_edge()');
