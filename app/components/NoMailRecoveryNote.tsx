import { Text } from "@mantine/core";

/**
 * What a locked-out visitor sees in place of an email-delivered recovery
 * button on deployments with no mail transport (`mailEnabled` in
 * `auth.server.ts`).
 *
 * A "reset my password" button that silently mails nothing is worse than no
 * button: the person waits for a message that never comes and assumes the site
 * is broken rather than asking a human. The real recovery path here is an
 * officer-issued link, delivered out-of-band on purpose
 * (`plans/password-recovery.md`), so say that plainly and inline — no hover,
 * no dead end.
 */
export function NoMailRecoveryNote() {
  return (
    <Text size="sm" c="dimmed" ta="center">
      Forgot your password? This site doesn&rsquo;t send email, so there&rsquo;s
      no automatic reset. Ask an officer of your camp to generate a recovery
      link for you — that&rsquo;s how you get back in.
    </Text>
  );
}
