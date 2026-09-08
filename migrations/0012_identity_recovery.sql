ALTER TABLE identity_audit_events DROP CONSTRAINT identity_audit_events_event_type_check;
ALTER TABLE identity_audit_events ADD CONSTRAINT identity_audit_events_event_type_check CHECK (event_type IN ('practice_admin_bootstrapped', 'account_created', 'password_reset'));
