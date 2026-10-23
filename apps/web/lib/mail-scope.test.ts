import { describe, expect, it } from 'vitest';
import { FULL_MAIL_ACCESS_EMAILS, mailboxScopeSql } from './mail-scope';

describe('mailboxScopeSql', () => {
  it('lets the founders and the Mailvin agent see every message', () => {
    expect(FULL_MAIL_ACCESS_EMAILS).toEqual(['ari@rebattery.io', 'alex@rebattery.io', 'mailvin-agent@rebattery.io']);
    const sql = mailboxScopeSql('m', '$2');
    expect(sql).toContain("full_access_user.id = $2::uuid");
    for (const email of FULL_MAIL_ACCESS_EMAILS) { expect(sql).toContain(`'${email}'`); }
    expect(sql).not.toContain("'sean@rebattery.io'");
    expect(sql.startsWith('(exists (select 1 from crm_users full_access_user')).toBe(true);
  });
});
