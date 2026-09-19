const normalizeAddress = (value) => {
  const address = String(value ?? '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(address)) throw new Error('Email address is invalid');
  return address;
};

export function configureEmailAccount(db, input) {
  if (input.readOnly === false) throw new Error('Email accounts are read-only in this release');
  if (input.secret !== undefined || input.password !== undefined || input.token !== undefined) throw new Error('Do not provide inline secrets; use secretRef');
  const provider = String(input.provider ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) throw new Error('Email provider is invalid');
  const address = normalizeAddress(input.address);
  const id = `${provider}:${address}`;
  db.prepare(`INSERT INTO email_accounts (id, provider, address, read_only, secret_ref)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET secret_ref=excluded.secret_ref, read_only=1`)
    .run(id, provider, address, input.secretRef ?? null);
  return listEmailAccounts(db).find((item) => item.id === id);
}

export function listEmailAccounts(db) {
  return db.prepare(`SELECT id, provider, address, read_only readOnly, secret_ref secretRef,
    cursor, last_attempt_at lastAttemptAt, last_success_at lastSuccessAt, error
    FROM email_accounts ORDER BY id`).all().map((item) => ({ ...item, readOnly: Boolean(item.readOnly) }));
}

export function disconnectEmailAccount(db, id) {
  return Boolean(db.prepare('DELETE FROM email_accounts WHERE id = ?').run(id).changes);
}

