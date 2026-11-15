-- Only password sessions from now on. NOT VALID: rows written before are not scanned (sign-in rejects and deletes them).
ALTER TABLE admin_sessions ADD CONSTRAINT admin_sessions_auth_method_check CHECK (auth_method IN ('password')) NOT VALID;
